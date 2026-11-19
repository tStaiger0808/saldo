/**
 * Bank logos from Enable Banking's bank list, or the site icon of a provider without one, fetched by the server and
 * cached in `settings`, so the browser never contacts a third party. Misses are cached too, so an unreachable logo is
 * not retried on every page view.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { settings } from "../../db/schema.ts";

export type BankLogo = { contentType: string; data: Buffer };

type CachedLogo = {
  contentType: string | null;
  /** Base64; null records that the bank has no usable logo. */
  data: string | null;
  fetchedAt: string;
  /** Last failed refresh of a stored logo; the old one is served until the next attempt. */
  failedAt?: string;
};

export type LogoDeps = {
  fetch: typeof fetch;
  now: () => Date;
  /** The logo address from the bank list; `undefined` when the bank is not listed. */
  lookup: () => Promise<string | null | undefined>;
};

const DAY_MS = 86_400_000;
const LOGO_TTL_MS = 30 * DAY_MS;
const RETRY_MS = DAY_MS;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);

/** A provider's own website, the only hosts its icon is fetched from. */
export type Site = { key: string; origin: string; hosts: readonly string[] };

export const SITES = {
  givve: { key: "givve", origin: "https://givve.com", hosts: ["givve.com", "www.givve.com"] },
  trade_republic: {
    key: "trade_republic",
    origin: "https://traderepublic.com",
    hosts: ["traderepublic.com", "www.traderepublic.com", "assets.traderepublic.com"],
  },
} as const satisfies Record<string, Site>;

type HostCheck = (host: string) => boolean;

const enableBankingHost: HostCheck = (host) => host === "enablebanking.com" || host.endsWith(".enablebanking.com");

export function logoCacheKey(country: string, name: string): string {
  return `bank_logo:${country}:${name}`;
}

export function allowedLogoUrl(value: string, allowed: HostCheck = enableBankingHost): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return allowed(host) ? url : null;
}

/** With `truncate`, a longer body is cut instead of rejected: an icon link sits in the page's head. */
async function readLimited(response: Response, truncate = false): Promise<Buffer | null> {
  if (!truncate && Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      if (!truncate) return null;
      chunks.push(value.subarray(0, value.byteLength - (size - MAX_BYTES)));
      break;
    }
    chunks.push(value);
  }
  return size > 0 ? Buffer.concat(chunks) : null;
}

type Fetched = { url: URL; contentType: string; data: Buffer };

/** Follows redirects only within the allowed hosts; anything unexpected is a miss, never an error. */
async function fetchAllowed(
  address: string,
  fetchFn: typeof fetch,
  allowed: HostCheck,
  types: ReadonlySet<string>,
  truncate = false,
): Promise<Fetched | null> {
  let url = allowedLogoUrl(address, allowed);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchFn(url, { redirect: "manual", signal, headers: { Accept: [...types].join(", ") } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        url = location ? allowedLogoUrl(new URL(location, url).href, allowed) : null;
        continue;
      }
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!response.ok || !types.has(contentType)) {
        await response.body?.cancel();
        return null;
      }
      const data = await readLimited(response, truncate);
      return data ? { url, contentType, data } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function fetchLogo(address: string, fetchFn: typeof fetch, allowed: HostCheck = enableBankingHost): Promise<BankLogo | null> {
  const fetched = await fetchAllowed(address, fetchFn, allowed, CONTENT_TYPES);
  return fetched && { contentType: fetched.contentType, data: fetched.data };
}

const HTML = new Set(["text/html"]);
const MAX_DECLARED = 3;
const ICON_RELS = ["apple-touch-icon", "icon", "shortcut icon"];

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** The icons a page declares in `<link rel=…>`, best first; relative addresses resolved against the page. */
export function declaredIcons(html: string, page: URL): string[] {
  const found: { rank: number; href: string }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rank = ICON_RELS.indexOf((attribute(tag, "rel") ?? "").trim().toLowerCase().replace(/\s+/g, " "));
    const href = attribute(tag, "href")?.trim();
    if (rank < 0 || !href) continue;
    try {
      found.push({ rank, href: new URL(href.replaceAll("&amp;", "&"), page).href });
    } catch {
      // An unusable address is skipped like a missing one.
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((icon) => icon.href);
}

/** The site's touch icon, else the first icon its start page declares, else its favicon. */
export async function fetchSiteIcon(site: Site, fetchFn: typeof fetch): Promise<BankLogo | null> {
  const allowed: HostCheck = (host) => site.hosts.includes(host);
  const touch = await fetchLogo(`${site.origin}/apple-touch-icon.png`, fetchFn, allowed);
  if (touch) return touch;
  const page = await fetchAllowed(`${site.origin}/`, fetchFn, allowed, HTML, true);
  if (page) {
    for (const href of declaredIcons(page.data.toString("utf8"), page.url).slice(0, MAX_DECLARED)) {
      const icon = await fetchLogo(href, fetchFn, allowed);
      if (icon) return icon;
    }
  }
  return fetchLogo(`${site.origin}/favicon.ico`, fetchFn, allowed);
}

async function readCache(db: Db, key: string): Promise<CachedLogo | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  const value = row?.value as Partial<CachedLogo> | null | undefined;
  return value && typeof value.fetchedAt === "string" ? (value as CachedLogo) : null;
}

async function writeCache(db: Db, key: string, value: CachedLogo): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

function isFresh(entry: CachedLogo, now: number): boolean {
  const age = (at: string | undefined) => (at ? now - new Date(at).getTime() : Number.POSITIVE_INFINITY);
  if (!entry.data) return age(entry.fetchedAt) < RETRY_MS;
  return age(entry.fetchedAt) < LOGO_TTL_MS || age(entry.failedAt) < RETRY_MS;
}

function asLogo(entry: CachedLogo): BankLogo | null {
  return entry.data && entry.contentType ? { contentType: entry.contentType, data: Buffer.from(entry.data, "base64") } : null;
}

/**
 * The cached logo, refreshed when stale. With `listedOnly`, banks missing from the list are not cached, so the
 * by-name lookup cannot fill the settings with arbitrary keys.
 */
export async function cachedBankLogo(
  db: Db,
  bank: { country: string; name: string },
  deps: LogoDeps,
  listedOnly = false,
): Promise<BankLogo | null> {
  const key = logoCacheKey(bank.country, bank.name);
  const now = deps.now();
  const cached = await readCache(db, key);
  if (cached && isFresh(cached, now.getTime())) return asLogo(cached);

  let address: string | null | undefined;
  try {
    address = await deps.lookup();
  } catch {
    if (listedOnly) return cached ? asLogo(cached) : null;
    address = null;
  }
  if (address === undefined && listedOnly) return null;
  return remember(db, key, cached, address ? await fetchLogo(address, deps.fetch) : null, now);
}

/** Stores a fetched logo, or keeps a stored one after a failed refresh, or records the miss. */
async function remember(db: Db, key: string, cached: CachedLogo | null, logo: BankLogo | null, now: Date): Promise<BankLogo | null> {
  const stamp = now.toISOString();
  if (logo) {
    await writeCache(db, key, { contentType: logo.contentType, data: logo.data.toString("base64"), fetchedAt: stamp });
    return logo;
  }
  if (cached?.data) {
    await writeCache(db, key, { ...cached, failedAt: stamp });
    return asLogo(cached);
  }
  await writeCache(db, key, { contentType: null, data: null, fetchedAt: stamp });
  return null;
}

export function siteIconCacheKey(site: Site): string {
  return `bank_logo:site:${site.key}`;
}

const loading = new Map<string, Promise<BankLogo | null>>();

async function loadSiteIcon(db: Db, key: string, site: Site, deps: Omit<LogoDeps, "lookup">): Promise<BankLogo | null> {
  const now = deps.now();
  const cached = await readCache(db, key);
  if (cached && isFresh(cached, now.getTime())) return asLogo(cached);
  return remember(db, key, cached, await fetchSiteIcon(site, deps.fetch), now);
}

/**
 * The cached site icon, refreshed when stale. Requests arriving together share one cache read and fetch; reading the
 * cache outside it would let a late request miss the icon the first one just stored and fetch it again.
 */
export function cachedSiteIcon(db: Db, site: Site, deps: Omit<LogoDeps, "lookup">): Promise<BankLogo | null> {
  const key = siteIconCacheKey(site);
  let pending = loading.get(key);
  if (!pending) {
    pending = loadSiteIcon(db, key, site, deps).finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** SVG can carry scripts; the policy keeps them inert even when the file is opened directly. */
export function bankLogoResponse(logo: BankLogo): Response {
  return new Response(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.contentType,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

/** A missing logo is remembered by the browser for an hour, so the fallback does not re-request it on every page. */
export function noBankLogoResponse(status: number): Response {
  const cache = status === 404 ? "private, max-age=3600" : "no-store";
  return new Response(null, { status, headers: { "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}
