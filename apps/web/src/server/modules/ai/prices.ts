/**
 * Model prices per million tokens (USD) for the model picker: from the provider's own model list where it carries
 * them (OpenCode), else from the public models.dev catalog; local servers cost nothing. The catalog also names the
 * context window of the first-party models.
 */
import { DEFAULT_BASE_URLS, isPrice, type ModelOption, type ModelPrice, type ProviderConfig } from "./client.ts";
import { listedContextWindow } from "./tokens.ts";

const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 3600_000;
// After a failed download the picker works without prices for a while instead of waiting for every list again.
const CATALOG_RETRY_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 20_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);
const FREE: ModelPrice = { inputPerMtok: 0, outputPerMtok: 0, currency: "USD" };

const OLLAMA_PORT = "11434";

function isLocal(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost") || url.port === OLLAMA_PORT;
  } catch {
    return false;
  }
}

/** Only the two first-party APIs map onto a models.dev provider; any other address may price the same id differently. */
function catalogProvider(cfg: Pick<ProviderConfig, "kind" | "baseUrl">): string | null {
  const url = cfg.baseUrl.replace(/\/+$/, "");
  if (cfg.kind === "openai" && url === DEFAULT_BASE_URLS.openai) return "openai";
  if (cfg.kind === "anthropic" && url === DEFAULT_BASE_URLS.anthropic) return "anthropic";
  return null;
}

type CatalogEntry = { price: ModelPrice | null; contextWindow: number | null };
type Catalog = Map<string, Map<string, CatalogEntry>>;
const WANTED = ["openai", "anthropic"];
let cached: { at: number; catalog: Catalog | null } | null = null;
let loading: Promise<Catalog | null> | null = null;

export function resetPriceCatalogForTests(): void {
  cached = null;
  loading = null;
}

async function downloadCatalog(): Promise<Catalog | null> {
  try {
    const response = await fetch(CATALOG_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as Record<string, { models?: Record<string, { cost?: { input?: unknown; output?: unknown } }> }>;
    const catalog: Catalog = new Map();
    for (const provider of WANTED) {
      const entries = new Map<string, CatalogEntry>();
      for (const [id, model] of Object.entries(body?.[provider]?.models ?? {})) {
        const { input, output } = model?.cost ?? {};
        const price: ModelPrice | null =
          isPrice(input) && isPrice(output) ? { inputPerMtok: input, outputPerMtok: output, currency: "USD" } : null;
        const contextWindow = listedContextWindow(model);
        if (price || contextWindow) entries.set(id, { price, contextWindow });
      }
      catalog.set(provider, entries);
    }
    return catalog;
  } catch (error) {
    console.info(`Model price catalog unavailable: ${error instanceof Error ? error.message : typeof error}`);
    return null;
  }
}

async function priceCatalog(): Promise<Catalog | null> {
  if (cached && Date.now() - cached.at < (cached.catalog ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) return cached.catalog;
  loading ??= downloadCatalog()
    .then((catalog) => {
      cached = { at: Date.now(), catalog };
      return catalog;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Fills missing prices and windows; the catalog request is a plain GET that carries nothing about this instance. */
export async function withPrices(cfg: Pick<ProviderConfig, "kind" | "baseUrl">, models: ModelOption[]): Promise<ModelOption[]> {
  if (isLocal(cfg.baseUrl)) return models.map((m) => ({ ...m, price: m.price ?? FREE }));
  const provider = catalogProvider(cfg);
  if (!provider || models.every((m) => m.price && m.contextWindow)) return models;
  const entries = (await priceCatalog())?.get(provider);
  if (!entries) return models;
  return models.map((m) => {
    const entry = entries.get(m.id);
    const contextWindow = m.contextWindow ?? entry?.contextWindow ?? undefined;
    return { ...m, price: m.price ?? entry?.price ?? null, ...(contextWindow ? { contextWindow } : {}) };
  });
}
