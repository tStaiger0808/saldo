import { MAX_NEW_TAGS_PER_RUN, monthKey, monthsBetween } from "@saldo/core";
import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale, msg, t } from "../../../i18n/index.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import { boundedDate } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import { aiProviders, aiUsage, settings, user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { mayUseAi, requireSuperuser, type Viewer } from "../access/index.ts";
import { failureReason, record, recordEvent } from "../audit/index.ts";
import {
  type Completion,
  type CompletionRequest,
  checkKey,
  complete,
  DEFAULT_BASE_URLS,
  listModels,
  type ModelOption,
  modelsArePublic,
  type ProviderConfig,
  type Usage,
} from "./client.ts";
import { withPrices } from "./prices.ts";
import { rememberContextWindow } from "./tokens.ts";

const price = z.number().min(0).max(100_000).nullish();

export const providerInput = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(["openai", "anthropic"]),
  baseUrl: z
    .url({ protocol: /^https?$/, error: "ai.errors.urlProtocol" })
    .refine((url) => {
      const parsed = new URL(url);
      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    }, "ai.errors.urlParts")
    .nullish(),
  apiKey: z.string().trim().min(1).max(1000).nullish(),
  model: z.string().trim().min(1).max(200).nullish(),
  priceInputPerMtok: price,
  priceOutputPerMtok: price,
  priceCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "ai.errors.currencyCode")
    .default("USD"),
});

export type ProviderRow = typeof aiProviders.$inferSelect;

export type ProviderOut = {
  id: number;
  name: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  model: string | null;
  isActive: boolean;
  hasApiKey: boolean;
  priceInputPerMtok: number | null;
  priceOutputPerMtok: number | null;
  priceCurrency: string;
};

function out(p: ProviderRow): ProviderOut {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    isActive: p.isActive,
    hasApiKey: p.apiKeyCiphertext !== "",
    priceInputPerMtok: p.priceInputPerMtok,
    priceOutputPerMtok: p.priceOutputPerMtok,
    priceCurrency: p.priceCurrency,
  };
}

const baseUrlOf = (kind: ProviderRow["kind"], url: string | null | undefined) => (url || DEFAULT_BASE_URLS[kind]).replace(/\/+$/, "");
const providerTarget = (p: { id: number }) => ({ type: "ai_provider", id: p.id });

async function getProvider(db: Db, id: number): Promise<ProviderRow> {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
  if (!row) throw new NotFound(msg("ai.errors.providerNotFound"));
  return row;
}

function configOf(p: ProviderRow): ProviderConfig {
  return { kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKeyCiphertext ? decrypt(p.apiKeyCiphertext) : "", model: p.model };
}

export type ConnectionTest = { ok: true; message: string; models: string[]; modelOffered: boolean | null; warning: boolean };

/** Saving only succeeds when the provider answers for exactly these settings and, where it can be told, accepts the key. */
async function testConnection(cfg: ProviderConfig, locale: Locale): Promise<ConnectionTest> {
  let options: ModelOption[];
  try {
    options = await listModels(cfg);
  } catch (error) {
    const reason = error instanceof UserError ? error.text : msg("ai.errors.unknown");
    throw new UserError(msg("ai.errors.connectionFailed", { reason }), 400);
  }
  const models = options.map((m) => m.id);
  const modelOffered = cfg.model ? models.includes(cfg.model) : null;
  const found = t(locale, "ai.test.models", { count: models.length });
  let keyNote = "";
  let warning = modelOffered === false;
  if (await modelsArePublic(cfg)) {
    const probe = modelOffered ? cfg.model : (options.find((m) => !m.trainsOnData) ?? options[0])?.id;
    const check = probe ? await checkKey(cfg, probe) : { result: "unknown" as const, detail: msg("ai.errors.noModelToCheck") };
    if (check.result === "rejected") throw new UserError(msg("ai.errors.keyRejected", { reason: check.detail }), 400);
    if (check.result === "valid" && check.detail) {
      keyNote = t(locale, "ai.test.keyConfirmedModelUnusable", { model: probe ?? "", detail: check.detail });
      warning = true;
    } else if (check.result === "valid") keyNote = t(locale, "ai.test.keyConfirmed");
    else {
      keyNote = t(locale, "ai.test.keyUnclear", { detail: check.detail });
      warning = true;
    }
  }
  const message =
    modelOffered === false
      ? t(locale, "ai.test.okModelMissing", { found, model: cfg.model ?? "", keyNote })
      : t(locale, "ai.test.ok", { found, keyNote });
  return { ok: true, message, models, modelOffered, warning };
}

export type SavedProvider = { provider: ProviderOut; test: ConnectionTest };

export async function listProviders(db: Db, viewer: Viewer): Promise<ProviderOut[]> {
  requireSuperuser(viewer);
  return (await db.select().from(aiProviders).orderBy(asc(aiProviders.name), asc(aiProviders.id))).map(out);
}

export async function createProvider(db: Db, viewer: Viewer, input: z.input<typeof providerInput>): Promise<SavedProvider> {
  requireSuperuser(viewer);
  const data = providerInput.parse(input);
  const baseUrl = baseUrlOf(data.kind, data.baseUrl);
  const test = await testConnection(
    { kind: data.kind, baseUrl, apiKey: data.apiKey ?? "", model: data.model ?? null },
    viewer.locale ?? DEFAULT_LOCALE,
  );
  const [active] = await db.select({ id: aiProviders.id }).from(aiProviders).where(eq(aiProviders.isActive, true));
  const [row] = await db
    .insert(aiProviders)
    .values({
      name: data.name,
      kind: data.kind,
      baseUrl,
      apiKeyCiphertext: data.apiKey ? encrypt(data.apiKey) : "",
      model: data.model ?? null,
      isActive: !active,
      priceInputPerMtok: data.priceInputPerMtok ?? null,
      priceOutputPerMtok: data.priceOutputPerMtok ?? null,
      priceCurrency: data.priceCurrency,
    })
    .returning();
  if (!row) throw new UserError(msg("ai.errors.createFailed"));
  await record(db, {
    action: "settings.aiProviderCreated",
    actor: viewer,
    target: providerTarget(row),
    details: { name: row.name, model: row.model },
  });
  return { provider: out(row), test };
}

export async function updateProvider(db: Db, viewer: Viewer, id: number, input: z.input<typeof providerInput>): Promise<SavedProvider> {
  requireSuperuser(viewer);
  const data = providerInput.parse(input);
  const current = await getProvider(db, id);
  const baseUrl = baseUrlOf(data.kind, data.baseUrl);
  // The stored key must never be sent to a different endpoint than the one it was entered for.
  if ((baseUrl !== current.baseUrl || data.kind !== current.kind) && !data.apiKey) {
    // Unless the provider needs none: an empty key field then means "no key".
    if (current.apiKeyCiphertext !== "") throw new UserError(msg("ai.errors.reenterKey"));
  }
  const apiKey = data.apiKey ?? (baseUrl === current.baseUrl && data.kind === current.kind ? configOf(current).apiKey : "");
  const test = await testConnection({ kind: data.kind, baseUrl, apiKey, model: data.model ?? null }, viewer.locale ?? DEFAULT_LOCALE);
  const [row] = await db
    .update(aiProviders)
    .set({
      name: data.name,
      kind: data.kind,
      baseUrl,
      model: data.model ?? null,
      priceInputPerMtok: data.priceInputPerMtok ?? null,
      priceOutputPerMtok: data.priceOutputPerMtok ?? null,
      priceCurrency: data.priceCurrency,
      apiKeyCiphertext: apiKey ? encrypt(apiKey) : "",
    })
    .where(eq(aiProviders.id, id))
    .returning();
  if (!row) throw new NotFound(msg("ai.errors.providerNotFound"));
  await priceUnpricedCalls(db, row);
  await record(db, {
    action: "settings.aiProviderUpdated",
    actor: viewer,
    target: providerTarget(row),
    details: { name: row.name, model: row.model, keyChanged: Boolean(data.apiKey) },
  });
  return { provider: out(row), test };
}

export async function activateProvider(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireSuperuser(viewer);
  const provider = await getProvider(db, id);
  await db.transaction(async (tx) => {
    await tx.update(aiProviders).set({ isActive: false }).where(eq(aiProviders.isActive, true));
    await tx.update(aiProviders).set({ isActive: true }).where(eq(aiProviders.id, id));
  });
  await record(db, {
    action: "settings.aiProviderActivated",
    actor: viewer,
    target: providerTarget(provider),
    details: { name: provider.name },
  });
}

export async function deleteProvider(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireSuperuser(viewer);
  const [deleted] = await db.delete(aiProviders).where(eq(aiProviders.id, id)).returning({ id: aiProviders.id, name: aiProviders.name });
  if (!deleted) throw new NotFound(msg("ai.errors.providerNotFound"));
  await record(db, {
    action: "settings.aiProviderDeleted",
    actor: viewer,
    target: providerTarget(deleted),
    details: { name: deleted.name },
  });
}

export const modelsInput = z.object({ id: z.number().int(), includeAll: z.boolean().default(false) });

/** The live model list with a price and context window per model where known (provider list, models.dev, or free when local). */
export async function providerModels(db: Db, viewer: Viewer, input: z.input<typeof modelsInput>): Promise<ModelOption[]> {
  requireSuperuser(viewer);
  const { id, includeAll } = modelsInput.parse(input);
  const cfg = configOf(await getProvider(db, id));
  const models = await withPrices(cfg, await listModels(cfg, includeAll));
  for (const m of models) if (m.contextWindow) rememberContextWindow(cfg, m.id, m.contextWindow);
  return models;
}

export async function testProvider(db: Db, viewer: Viewer, id: number): Promise<ConnectionTest> {
  requireSuperuser(viewer);
  return testConnection(configOf(await getProvider(db, id)), viewer.locale ?? DEFAULT_LOCALE);
}

/** Whether a provider is set up and the viewer may use it; never which provider sits behind it. */
export async function aiStatus(db: Db, viewer: Viewer): Promise<{ ready: boolean; allowed: boolean }> {
  const [active] = await db.select({ model: aiProviders.model }).from(aiProviders).where(eq(aiProviders.isActive, true));
  return { ready: Boolean(active?.model), allowed: await mayUseAi(db, viewer) };
}

// ---- instance settings

const AUTO_CATEGORIZE_KEY = "ai_auto_categorize";
const TAGGING_KEY = "ai_tagging";

const tagging = z.object({
  assignTags: z.boolean().catch(false),
  createTags: z.boolean().catch(false),
  // null: no limit, the AI creates as many tags as it needs.
  maxNewTags: z.number().int().min(1).max(MAX_NEW_TAGS_PER_RUN).nullable().catch(null),
});

/** Every field is optional: a save changes only the settings it names. */
export const aiSettingsInput = z.object({
  autoCategorize: z.boolean().optional(),
  assignTags: z.boolean().optional(),
  createTags: z.boolean().optional(),
  maxNewTags: z.number().int().min(1).max(MAX_NEW_TAGS_PER_RUN).nullable().optional(),
});
export type AiSettings = { autoCategorize: boolean } & z.infer<typeof tagging>;

export async function autoCategorizeEnabled(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, AUTO_CATEGORIZE_KEY));
  return row?.value === true;
}

async function taggingSettings(db: Db): Promise<z.infer<typeof tagging>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, TAGGING_KEY));
  return tagging.parse(row?.value ?? {});
}

/** What the AI may do with tags: assign existing ones, and create new ones (only together with assigning), at most `maxNew` per run (null: no limit). */
export type AiTagging = { assign: boolean; create: boolean; maxNew: number | null };

export async function aiTagging(db: Db): Promise<AiTagging> {
  const { assignTags, createTags, maxNewTags } = await taggingSettings(db);
  return { assign: assignTags, create: assignTags && createTags, maxNew: maxNewTags };
}

export async function getAiSettings(db: Db, viewer: Viewer): Promise<AiSettings> {
  requireSuperuser(viewer);
  return { autoCategorize: await autoCategorizeEnabled(db), ...(await taggingSettings(db)) };
}

export async function saveAiSettings(db: Db, viewer: Viewer, input: z.input<typeof aiSettingsInput>): Promise<AiSettings> {
  requireSuperuser(viewer);
  const { autoCategorize, ...tagChanges } = aiSettingsInput.parse(input);
  const store = async (key: string, value: unknown) =>
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  if (autoCategorize !== undefined) await store(AUTO_CATEGORIZE_KEY, autoCategorize);
  if (Object.values(tagChanges).some((v) => v !== undefined)) {
    await store(TAGGING_KEY, {
      ...(await taggingSettings(db)),
      ...Object.fromEntries(Object.entries(tagChanges).filter(([, v]) => v !== undefined)),
    });
  }
  await record(db, { action: "settings.aiSettingsChanged", actor: viewer, details: { autoCategorize, ...tagChanges } });
  return getAiSettings(db, viewer);
}

// ---- metered calls

export type ActiveProvider = { row: ProviderRow; cfg: ProviderConfig };

export async function activeProvider(db: Db): Promise<ActiveProvider> {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.isActive, true));
  if (!row) throw new UserError(msg("ai.errors.noActiveProvider"));
  if (!row.model) throw new UserError(msg("ai.errors.chooseModel"));
  return { row, cfg: configOf(row) };
}

export type UsageCall = {
  id: number;
  createdAt: string;
  username: string | null;
  providerName: string;
  model: string;
  purpose: (typeof aiUsage.$inferSelect)["purpose"];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reported: boolean;
  costMicro: number | null;
  currency: string;
};

/** Cost in millionths of the price currency (prices are per million tokens); null while prices are unknown. */
function costMicro(p: Pick<ProviderRow, "priceInputPerMtok" | "priceOutputPerMtok">, usage: Usage): number | null {
  if (!usage.reported || p.priceInputPerMtok == null || p.priceOutputPerMtok == null) return null;
  return Math.round(usage.inputTokens * p.priceInputPerMtok + usage.outputTokens * p.priceOutputPerMtok);
}

/** Prices entered after the fact apply to earlier calls of the same provider and model. */
async function priceUnpricedCalls(db: Db, p: ProviderRow): Promise<void> {
  if (p.priceInputPerMtok == null || p.priceOutputPerMtok == null) return;
  const pending = await db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.providerId, p.id), eq(aiUsage.model, p.model ?? ""), isNull(aiUsage.costMicro), eq(aiUsage.reported, true)));
  for (const row of pending) {
    await db
      .update(aiUsage)
      .set({ costMicro: costMicro(p, row), currency: p.priceCurrency })
      .where(eq(aiUsage.id, row.id));
  }
}

/** What a call is for; the audit log keeps it apart, usage only by purpose. */
export type AiAction = "categorize" | "recategorize" | "autoCategorize" | "analysis" | "chat" | "suggest";

const PURPOSE: Record<AiAction, UsageCall["purpose"]> = {
  categorize: "categorize",
  recategorize: "categorize",
  autoCategorize: "categorize",
  analysis: "analysis",
  chat: "chat",
  suggest: "suggest",
};

/**
 * Calls the active provider and stores a usage row for every answered call, also when the text is unusable later.
 * Each call, answered or not, is also an audit event with provider, model, tokens and cost, never prompt or answer.
 * Unattended runs have no user.
 */
export async function meteredCompletion(
  db: Db,
  userId: string | null,
  provider: ActiveProvider,
  action: AiAction,
  request: CompletionRequest,
): Promise<Completion & { call: UsageCall; auditId: number | null }> {
  const { row: p } = provider;
  const audit = { action: `ai.${action}` as const, actor: userId ? { id: userId } : null };
  const about = { provider: p.name, model: p.model ?? "" };
  let result: Completion;
  try {
    result = await complete(provider.cfg, request);
  } catch (error) {
    await record(db, { ...audit, outcome: "failed", details: { ...about, reason: failureReason(error) } });
    throw error;
  }
  const cost = costMicro(p, result.usage);
  const [stored] = await db
    .insert(aiUsage)
    .values({
      userId,
      providerId: p.id,
      providerName: p.name,
      kind: p.kind,
      model: p.model ?? "",
      purpose: PURPOSE[action],
      ...result.usage,
      costMicro: cost,
      currency: p.priceCurrency,
    })
    .returning();
  const auditId = await recordEvent(db, {
    ...audit,
    details: {
      ...about,
      inputTokens: result.usage.reported ? result.usage.inputTokens : undefined,
      outputTokens: result.usage.reported ? result.usage.outputTokens : undefined,
      costMicro: cost,
      currency: cost === null ? undefined : p.priceCurrency,
    },
  });
  if (!stored) throw new UserError(msg("ai.errors.usageNotSaved"));
  return { ...result, call: { ...callOut(stored), username: null }, auditId };
}

function callOut(row: typeof aiUsage.$inferSelect): Omit<UsageCall, "username"> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    providerName: row.providerName,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reported: row.reported,
    costMicro: row.costMicro,
    currency: row.currency,
  };
}

// ---- usage summary

export const usageInput = z
  .object({ dateFrom: boundedDate, dateTo: boundedDate, limit: z.number().int().min(1).max(200).default(50) })
  .refine((r) => r.dateFrom <= r.dateTo, "ai.errors.startAfterEnd");

export type Cost = { currency: string; micro: number };
export type UsageGroup = {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costs: Cost[];
  unpricedCalls: number;
};
export type UsageSummary = {
  totals: Omit<UsageGroup, "key" | "label"> & { cachedInputTokens: number; maxInputTokens: number };
  byModel: UsageGroup[];
  byPurpose: UsageGroup[];
  byMonth: (Omit<UsageGroup, "key" | "label" | "unpricedCalls"> & { month: string })[];
  recent: UsageCall[];
};

type UsageRow = typeof aiUsage.$inferSelect;

function costs(rows: UsageRow[]): Cost[] {
  const sums = new Map<string, number>();
  for (const r of rows) if (r.costMicro !== null) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.costMicro);
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, micro]) => ({ currency, micro }));
}

function totalsOf(rows: UsageRow[]) {
  return {
    calls: rows.length,
    inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    costs: costs(rows),
    unpricedCalls: rows.filter((r) => r.costMicro === null).length,
  };
}

function groupBy(rows: UsageRow[], keyOf: (r: UsageRow) => [key: string, label: string]): UsageGroup[] {
  const groups = new Map<string, { label: string; rows: UsageRow[] }>();
  for (const r of rows) {
    const [key, label] = keyOf(r);
    const group = groups.get(key) ?? { label, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  return [...groups].map(([key, g]) => ({ key, label: g.label, ...totalsOf(g.rows) }));
}

export async function usageSummary(db: Db, viewer: Viewer, input: z.input<typeof usageInput>): Promise<UsageSummary> {
  requireSuperuser(viewer);
  const { dateFrom, dateTo, limit } = usageInput.parse(input);
  const end = new Date(`${dateTo}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const joined = await db
    .select({ usage: aiUsage, username: user.username })
    .from(aiUsage)
    .leftJoin(user, eq(user.id, aiUsage.userId))
    .where(and(gte(aiUsage.createdAt, new Date(`${dateFrom}T00:00:00Z`)), lt(aiUsage.createdAt, end)))
    .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id));
  const rows = joined.map((j) => j.usage);
  const month = (r: UsageRow) => monthKey(r.createdAt.toISOString());
  return {
    totals: {
      ...totalsOf(rows),
      cachedInputTokens: rows.reduce((s, r) => s + r.cachedInputTokens, 0),
      maxInputTokens: rows.reduce((m, r) => Math.max(m, r.inputTokens), 0),
    },
    byModel: groupBy(rows, (r) => [`${r.providerName}|${r.model}`, r.model ? `${r.providerName} · ${r.model}` : r.providerName]),
    byPurpose: groupBy(rows, (r) => [r.purpose, r.purpose]),
    byMonth: monthsBetween(dateFrom, dateTo).map((m) => {
      const { unpricedCalls: _, ...rest } = totalsOf(rows.filter((r) => month(r) === m));
      return { month: m, ...rest };
    }),
    recent: joined.slice(0, limit).map((j) => ({ ...callOut(j.usage), username: j.username })),
  };
}
