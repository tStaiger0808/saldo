import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt } from "../../crypto.ts";
import { db } from "../../db/index.ts";
import {
  accountGroups,
  accounts,
  aiAnalyses,
  aiProviders,
  aiUsage,
  auditEvents,
  categories,
  rules,
  ruleTags,
  settings,
  tags,
  transactions,
  transactionTags,
} from "../../db/schema.ts";
import { UserError } from "../../errors.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import { type Viewer, visibleAccountIds } from "../access/index.ts";
import { listRules } from "../catalog/index.ts";
import { reclassifyAll } from "../classification/index.ts";
import { listNotifications, savePreferences } from "../notifications/index.ts";
import { createDemoData } from "../seed/demo.ts";
import { cancelTask, listTasks, resetTasksForTests, type TaskView } from "../tasks/index.ts";
import { importBookings, patchTransaction } from "../transactions/index.ts";
import { updateUser } from "../users/index.ts";
import { MAX_TOOL_ROUNDS, RESULT_LIMIT, RESULTS_BUDGET } from "./chat.ts";
import {
  aiStatus,
  categorize,
  categorizeNewBookings,
  chat,
  createProvider as createProviderRaw,
  createSuggestedTags,
  getAiSettings,
  listAnalyses,
  listProviders,
  providerModels,
  recategorize,
  recategorizePreview,
  rememberCategory,
  resetPriceCatalogForTests,
  resetToolSupportForTests,
  runAnalysis,
  saveAiSettings,
  startAnalysis,
  startCategorize,
  startRecategorize,
  suggestCategory,
  testProvider,
  updateProvider as updateProviderRaw,
  usageSummary,
} from "./index.ts";

type Call = { url: string; init: RequestInit; body: { model?: string; messages: { role: string; content: string }[] } };

function mockFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return calls;
}

const authed = (call: Call) => {
  const headers = call.init.headers as Record<string, string> | undefined;
  return Boolean(headers?.Authorization || headers?.["x-api-key"]);
};

// Saving runs a live connection test; by default the mocked provider wants a key and answers with one model.
beforeEach(() => {
  resetPriceCatalogForTests();
  resetToolSupportForTests();
  mockFetch((call) =>
    authed(call) ? Response.json({ data: [{ id: "chat-small" }] }) : Response.json({ error: "no key" }, { status: 401 }),
  );
});
const createProvider = async (...args: Parameters<typeof createProviderRaw>) => (await createProviderRaw(...args)).provider;
const updateProvider = async (...args: Parameters<typeof updateProviderRaw>) => (await updateProviderRaw(...args)).provider;

/** The raw messages of a call, including tool turns. */
const sentMessages = <T>(call: Call | undefined) => (call?.body.messages ?? []) as unknown as T[];
const sentTools = (call: Call | undefined) => Object.hasOwn(call?.body ?? {}, "tools");

const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const reply = (content: string, usage: object | null = { prompt_tokens: 100, completion_tokens: 20 }) =>
  Response.json({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

const OPENAI = { name: "OpenAI", kind: "openai" as const, apiKey: "sk-test" };
const ISO_TODAY = new Date().toISOString().slice(0, 10);
const WINDOW = { dateFrom: "2026-01-01", dateTo: ISO_TODAY > "2026-12-31" ? ISO_TODAY : "2026-12-31" };

async function setup() {
  await resetDb();
  const admin = await makeUser("admin", "superuser");
  await createDemoData(db(), new Date("2026-11-15T12:00:00Z"));
  const groups = await db().select().from(accountGroups);
  const mine = groups.find((g) => g.name === "Meine Konten")?.id ?? -1;
  const shared = groups.find((g) => g.name === "Gemeinschaftskonto")?.id ?? -1;
  const member = await makeUser("partnerin", "member", [shared], { aiAllowed: true });
  return { admin, member, mine, shared };
}

async function readyProvider(admin: Viewer, extra: object = {}) {
  const created = await createProvider(db(), admin, OPENAI);
  return updateProvider(db(), admin, created.id, { ...OPENAI, apiKey: null, model: "chat-small", ...extra });
}

describe("AI providers", () => {
  let admin: Viewer;
  let member: Viewer;
  beforeEach(async () => ({ admin, member } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("stores the key encrypted, never returns it and activates the first provider", async () => {
    const created = await createProvider(db(), admin, OPENAI);
    expect(created).toMatchObject({ hasApiKey: true, isActive: true, baseUrl: "https://api.openai.com/v1" });
    expect(JSON.stringify(await listProviders(db(), admin))).not.toContain("sk-test");
    const [row] = await db().select().from(aiProviders).where(eq(aiProviders.id, created.id));
    expect(row?.apiKeyCiphertext).not.toContain("sk-test");
    expect(decrypt(row?.apiKeyCiphertext ?? "")).toBe("sk-test");
    const second = await createProvider(db(), admin, { ...OPENAI, name: "Zweiter" });
    expect(second.isActive).toBe(false);
    await expect(listProviders(db(), member)).rejects.toMatchObject({ status: 403 });
    await expect(createProvider(db(), member, OPENAI)).rejects.toMatchObject({ status: 403 });
  });

  it("never sends the stored key to a changed address or wire format", async () => {
    const { id } = await createProvider(db(), admin, OPENAI);
    const moved = { ...OPENAI, apiKey: null, baseUrl: "https://attacker.example/v1" };
    await expect(updateProvider(db(), admin, id, moved)).rejects.toMatchObject({ status: 400 });
    await expect(updateProvider(db(), admin, id, { ...OPENAI, apiKey: null, kind: "anthropic" })).rejects.toMatchObject({ status: 400 });
    const calls = mockFetch(() => Response.json({ data: [{ id: "chat-small" }] }));
    await providerModels(db(), admin, { id });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(await updateProvider(db(), admin, id, { ...moved, apiKey: "sk-new" })).toMatchObject({ baseUrl: "https://attacker.example/v1" });
    await providerModels(db(), admin, { id });
    expect(calls.at(-1)?.url).toBe("https://attacker.example/v1/models");
    expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer sk-new" });
  });

  it("lists models live, filters non-chat models and follows no redirects", async () => {
    const { id } = await createProvider(db(), admin, OPENAI);
    const calls = mockFetch(() =>
      Response.json({ data: [{ id: "text-embedding-3" }, { id: "chat-small" }, { id: "whisper-1" }, { id: "tts-1" }, { id: "chat-big" }] }),
    );
    expect((await providerModels(db(), admin, { id })).map((m) => m.id)).toEqual(["chat-big", "chat-small"]);
    expect(await providerModels(db(), admin, { id, includeAll: true })).toHaveLength(5);
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk-test" });

    const anthropic = await createProvider(db(), admin, { name: "Claude", kind: "anthropic", apiKey: "ak-test" });
    const anthropicCalls = mockFetch(() => Response.json({ data: [{ id: "claude-x" }] }));
    expect((await providerModels(db(), admin, { id: anthropic.id })).map((m) => m.id)).toEqual(["claude-x"]);
    expect(anthropicCalls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(anthropicCalls[0]?.init.headers).toMatchObject({ "x-api-key": "ak-test", "anthropic-version": "2023-06-01" });

    mockFetch(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await expect(providerModels(db(), admin, { id })).rejects.toMatchObject({ status: 502 });
  });

  it("tests the connection on save and stores nothing when it fails", async () => {
    const saved = await createProviderRaw(db(), admin, { ...OPENAI, model: "chat-small" });
    expect(saved.test).toMatchObject({ ok: true, modelOffered: true, message: "Verbindung erfolgreich, 1 Modell gefunden." });
    mockFetch(() => Response.json({ error: { message: "invalid api key" } }, { status: 401 }));
    await expect(createProviderRaw(db(), admin, { ...OPENAI, name: "Falsch" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("invalid api key"),
    });
    expect((await listProviders(db(), admin)).map((p) => p.name)).toEqual(["OpenAI"]);
    await expect(updateProviderRaw(db(), admin, saved.provider.id, { ...OPENAI, apiKey: "sk-wrong" })).rejects.toMatchObject({
      status: 400,
    });
    const [row] = await db().select().from(aiProviders).where(eq(aiProviders.id, saved.provider.id));
    expect(decrypt(row?.apiKeyCiphertext ?? "")).toBe("sk-test");
    mockFetch(() => Response.json({ data: [{ id: "other" }] }));
    expect(await testProvider(db(), admin, saved.provider.id)).toMatchObject({ modelOffered: false });
  });

  it("reports the connection test and nested provider errors in the admin's language", async () => {
    const english = { ...admin, locale: "en" as const };
    const saved = await createProviderRaw(db(), english, { ...OPENAI, model: "chat-small" });
    expect(saved.test.message).toBe("Connection successful, 1 model found.");
    mockFetch(() => Response.json({ error: { message: "invalid api key" } }, { status: 401 }));
    const error = await createProviderRaw(db(), english, { ...OPENAI, name: "Falsch" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toContain("Verbindung fehlgeschlagen");
    expect((error as UserError).localized("en")).toBe(
      "Connection failed, nothing saved. The AI provider responded with 401: invalid api key",
    );
  });

  it("proves the key with a one-token request when the model list is public (OpenCode)", async () => {
    const opencode = {
      name: "OpenCode Go",
      kind: "openai" as const,
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "oc-wrong",
    };
    const calls = mockFetch((call) =>
      call.url.endsWith("/models")
        ? Response.json({ data: [{ id: "glm-5.3" }] })
        : Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );
    await expect(createProviderRaw(db(), admin, opencode)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Schlüssel abgelehnt"),
    });
    expect(calls.at(-1)).toMatchObject({
      url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
      body: { model: "glm-5.3", max_tokens: 1 },
    });
    expect(await listProviders(db(), admin)).toEqual([]);

    mockFetch((call) => (call.url.endsWith("/models") ? Response.json({ data: [{ id: "glm-5.3" }] }) : reply("p")));
    const saved = await createProviderRaw(db(), admin, { ...opencode, apiKey: "oc-right" });
    expect(saved.test).toMatchObject({ warning: false, message: "Verbindung erfolgreich, 1 Modell gefunden. Schlüssel bestätigt." });

    mockFetch((call) =>
      call.url.endsWith("/models") ? Response.json({ data: [{ id: "glm-5.3" }] }) : new Response("busy", { status: 503 }),
    );
    const unclear = await createProviderRaw(db(), admin, { ...opencode, name: "Go 2", apiKey: "oc-maybe" });
    expect(unclear.test).toMatchObject({ warning: true, message: expect.stringContaining("nicht eindeutig prüfen") });
  });

  it("works without a key for local servers such as Ollama and sends no credential header", async () => {
    const calls = mockFetch(() => Response.json({ data: [{ id: "llama3.2" }] }));
    const saved = await createProviderRaw(db(), admin, { name: "Ollama", kind: "openai", baseUrl: "http://host.docker.internal:11434/v1" });
    expect(saved.provider).toMatchObject({ hasApiKey: false, baseUrl: "http://host.docker.internal:11434/v1" });
    expect(calls[0]?.url).toBe("http://host.docker.internal:11434/v1/models");
    expect(calls[0]?.init.headers).not.toHaveProperty("Authorization");
    expect(await providerModels(db(), admin, { id: saved.provider.id })).toEqual([
      { id: "llama3.2", price: { inputPerMtok: 0, outputPerMtok: 0, currency: "USD" } },
    ]);
  });

  it("tells members only whether the assistant is ready", async () => {
    expect(await aiStatus(db(), member)).toEqual({ ready: false, allowed: true });
    const { id } = await createProvider(db(), admin, OPENAI);
    expect(await aiStatus(db(), member)).toEqual({ ready: false, allowed: true });
    await updateProvider(db(), admin, id, { ...OPENAI, apiKey: null, model: "chat-small" });
    expect(await aiStatus(db(), member)).toEqual({ ready: true, allowed: true });
  });
});

describe("AI categorization", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  beforeEach(async () => ({ admin, member, mine } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("sends only names, direction and amount and creates exact AI rules", async () => {
    await readyProvider(admin);
    const mapping: Record<string, string> = {
      "Gasthof Hirsch": "Restaurant & Café",
      "Bergsport Oberstdorf": "Freizeit & Sport",
      "Cafe Kult": "Erfunden",
    };
    const calls = mockFetch((call) => {
      const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number; name: string }[];
      return reply(JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: mapping[i.name] ?? null })) }));
    });
    const result = await categorize(db(), admin, { groupId: mine });
    expect(result).toMatchObject({ counterpartiesAssigned: 2, rulesCreated: 2, unreadableBatches: 0 });
    expect(result.transactionsCategorized).toBeGreaterThan(2);

    const sent = calls.map((c) => JSON.stringify(c.body)).join("\n");
    expect(sent).not.toMatch(/DE02|Kartenzahlung|Hausverwaltung/);
    expect(calls[0]?.body).toMatchObject({ response_format: { type: "json_object" } });
    const item = JSON.parse(calls[0]?.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]")[0];
    expect(Object.keys(item).sort()).toEqual(["betrag_eur", "id", "name", "richtung"]);

    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => r.pattern).sort()).toEqual(["Bergsport Oberstdorf", "Gasthof Hirsch"]);
    expect(aiRules.every((r) => r.field === "counterparty")).toBe(true);
    const [restaurant] = await db().select().from(categories).where(eq(categories.name, "Restaurant & Café"));
    const gasthof = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirsch"));
    expect(gasthof.length).toBeGreaterThan(0);
    expect(gasthof.every((t) => t.categoryId === restaurant?.id)).toBe(true);

    // Exact matching: a longer name containing the pattern stays uncategorized.
    const [dkb] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    await importBookings(
      db(),
      dkb?.id ?? -1,
      [
        {
          bookingDate: "2026-11-14",
          amountCents: -500,
          currency: "EUR",
          counterparty: "Gasthof Hirschgarten",
          counterpartyIban: null,
          purpose: "x",
        },
      ],
      "test",
    );
    await reclassifyAll(db());
    const [garten] = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirschgarten"));
    expect(garten?.categoryId).toBeNull();
  });

  it("keeps the readable batches when one answer is unreadable and meters both calls", async () => {
    await readyProvider(admin);
    const [dkb] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    const extra = Array.from({ length: 100 }, (_, i) => ({
      bookingDate: "2026-11-10",
      amountCents: -1000 - i,
      currency: "EUR",
      counterparty: `Händler ${String(i).padStart(3, "0")}`,
      counterpartyIban: null,
      purpose: "Einkauf",
    }));
    await importBookings(db(), dkb?.id ?? -1, extra, "test");
    mockFetch((call, index) => {
      if (index === 0) return reply("Leider kann ich das nicht als JSON liefern.", { prompt_tokens: 900, completion_tokens: 15 });
      const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number }[];
      return reply(JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: "Sonstiges" })) }));
    });
    const result = await categorize(db(), admin, {});
    expect(result.counterpartiesSent).toBeGreaterThan(80);
    expect(result).toMatchObject({ unreadableBatches: 1, counterpartiesAssigned: result.counterpartiesSent - 80 });
    expect(result.rulesCreated).toBe(result.counterpartiesAssigned);
    const usage = await db().select().from(aiUsage);
    expect(usage.map((u) => [u.purpose, u.inputTokens])).toEqual([
      ["categorize", 900],
      ["categorize", 100],
    ]);
  });

  it("fails when every batch is unreadable and is admin only", async () => {
    await readyProvider(admin);
    mockFetch(() => reply("kein json"));
    await expect(categorize(db(), admin, {})).rejects.toMatchObject({ status: 502 });
    expect(await db().select().from(rules).where(eq(rules.source, "ai"))).toHaveLength(0);
    await expect(categorize(db(), member, {})).rejects.toMatchObject({ status: 403 });
  });
});

describe("AI analysis and chat", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  let shared: number;
  beforeEach(async () => ({ admin, member, mine, shared } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("stores analyses per user and group and sends only the view's aggregates", async () => {
    await readyProvider(admin);
    const calls = mockFetch(() => reply("## Einordnung\nAlles im Rahmen."));
    const created = await runAnalysis(db(), member, { groupId: shared, dateFrom: "2026-08-01", dateTo: "2026-10-31" });
    expect(created).toMatchObject({ groupId: shared, model: "chat-small", content: "## Einordnung\nAlles im Rahmen." });
    const prompt = calls[0]?.body.messages[1]?.content ?? "";
    expect(prompt).toContain("wiederkehrende_zahlungen");
    expect(prompt).toContain("Hausverwaltung Sonnenhalde");
    expect(prompt).not.toContain("Muster GmbH");
    const [row] = await db().select().from(aiAnalyses);
    expect(row?.userId).toBe(member.id);

    expect((await listAnalyses(db(), member, {})).map((a) => a.id)).toEqual([created.id]);
    expect(await listAnalyses(db(), member, { groupId: shared })).toHaveLength(1);
    expect(await listAnalyses(db(), member, { groupId: null })).toHaveLength(0);
    expect(await listAnalyses(db(), admin, {})).toHaveLength(0);
    await expect(listAnalyses(db(), member, { groupId: mine })).rejects.toMatchObject({ status: 404 });
    await expect(runAnalysis(db(), member, { groupId: mine, dateFrom: "2026-08-01", dateTo: "2026-10-31" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("asks for answers in the viewer's language", async () => {
    await readyProvider(admin);
    const calls = mockFetch(() => reply("Answer"));
    const range = { groupId: shared, dateFrom: "2026-08-01", dateTo: "2026-10-31" };
    await runAnalysis(db(), member, range);
    await runAnalysis(db(), { ...member, locale: "en" }, range);
    await chat(db(), { ...member, locale: "fr" }, { question: "Hallo?" });
    const system = (index: number) => calls[index]?.body.messages[0]?.content ?? "";
    expect(system(0)).toContain("auf Deutsch");
    expect(system(1)).toContain("auf Englisch (English)");
    expect(system(1)).not.toContain("auf Deutsch");
    expect(system(2)).toContain("auf Französisch (français)");
  });

  it("lets the model query only the view through tools, without IBANs or notes, and meters every call", async () => {
    await readyProvider(admin);
    const [joint] = await db().select().from(accounts).where(eq(accounts.bank, "comdirect"));
    const [dkb] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    await db()
      .update(transactions)
      .set({ note: "GEHEIMNOTIZ", purpose: "Miete DE89 3704 0044 0532 0130 00 Sonnenhalde" })
      .where(eq(transactions.accountId, joint?.id ?? -1));
    const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };
    const calls = mockFetch((_call, index) =>
      index === 0
        ? Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    toolCall("a", "search_transactions", { limit: 20, sort: "largest_expense" }),
                    toolCall("b", "category_totals", { dateFrom: "2026-10-01", dateTo: "2026-10-31" }),
                    toolCall("c", "search_transactions", { accountId: dkb?.id }),
                  ],
                },
              },
            ],
            usage,
          })
        : reply("Antwort", usage),
    );
    const question = "Wofür geben wir am meisten aus?";
    const answer = await chat(db(), member, { question });

    expect(answer).toMatchObject({ reply: "Antwort", mode: "tools", model: "chat-small" });
    expect(answer.usage).toMatchObject({ inputTokens: 240, outputTokens: 60, cachedInputTokens: 40, purpose: "chat", calls: 2 });
    expect(answer.lookups).toEqual([
      expect.objectContaining({ tool: "search_transactions", dateFrom: null, count: expect.any(Number) }),
      { tool: "category_totals", dateFrom: "2026-10-01", dateTo: "2026-10-31", count: expect.any(Number), kind: "expense" },
    ]);
    expect(answer.lookups[0]?.count).toBeGreaterThan(0);
    const first = calls[0]?.body as unknown as { tools: { function: { name: string } }[]; tool_choice: string };
    expect(first.tool_choice).toBe("auto");
    expect(first.tools.map((t) => t.function.name)).not.toContain("list_groups");
    expect(first.tools.map((t) => t.function.name)).toContain("search_transactions");
    expect(calls[0]?.body.messages[0]?.content).toContain("Werkzeuge");

    const second = sentMessages<{ role: string; tool_call_id?: string; content: string; tool_calls?: unknown[] }>(calls[1]);
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "tool"]);
    expect(second[2]?.tool_calls).toHaveLength(3);
    const result = (id: string) => second.find((m) => m.tool_call_id === id)?.content ?? "";
    const found = JSON.parse(result("a")) as { items: { amountCents: number; accountId: number }[] };
    expect(found.items.every((t) => t.accountId === joint?.id)).toBe(true);
    expect(found.items.map((t) => t.amountCents)).toEqual(found.items.map((t) => t.amountCents).sort((x, y) => x - y));
    expect(result("c")).toBe("Account not found");
    const sent = JSON.stringify(calls.map((c) => c.body));
    expect(sent).not.toMatch(/DE89|DE02|GEHEIMNOTIZ|Muster GmbH|"note"|balanceDate/);
    expect(sent).toContain("Sonnenhalde");

    expect(await db().select().from(aiUsage)).toHaveLength(2);
    const events = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.chat")).orderBy(auditEvents.id);
    expect(events.map((e) => e.details.tools)).toEqual([["search_transactions", "category_totals"], undefined]);
    expect(JSON.stringify(events.map((e) => e.details))).not.toMatch(/largest_expense|2026-10-01|Sonnenhalde/);

    await expect(chat(db(), member, { groupId: mine, question })).rejects.toMatchObject({ status: 404 });
    await expect(chat(db(), member, { question: "  " })).rejects.toThrow(/ai.errors.questionRequired/);
    expect(calls).toHaveLength(2);
  });

  it("speaks the Anthropic tool format", async () => {
    const created = await createProvider(db(), admin, { name: "Claude", kind: "anthropic", apiKey: "ak-test" });
    await updateProvider(db(), admin, created.id, { name: "Claude", kind: "anthropic", apiKey: null, model: "chat-small" });
    const period = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
    const calls = mockFetch((_call, index) =>
      Response.json(
        index === 0
          ? {
              content: [
                { type: "text", text: "Ich schaue nach." },
                { type: "tool_use", id: "tu_1", name: "summary", input: period },
              ],
              usage: { input_tokens: 50, output_tokens: 10 },
            }
          : { content: [{ type: "text", text: "Fertig" }], usage: { input_tokens: 80, output_tokens: 5 } },
      ),
    );
    const answer = await chat(db(), member, { groupId: shared, question: "Wie war der Oktober?" });
    expect(answer).toMatchObject({ reply: "Fertig", mode: "tools", usage: { inputTokens: 130, outputTokens: 15, calls: 2 } });
    expect(answer.lookups).toEqual([{ tool: "summary", ...period, count: null, kind: null }]);
    const first = calls[0]?.body as unknown as { tools: { name: string; input_schema: { type: string } }[]; tool_choice: unknown };
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect(first.tools.find((t) => t.name === "summary")?.input_schema.type).toBe("object");
    const [, assistant, results] = sentMessages<{ role: string; content: Record<string, unknown>[] }>(calls[1]);
    expect(assistant?.content).toEqual([
      { type: "text", text: "Ich schaue nach." },
      { type: "tool_use", id: "tu_1", name: "summary", input: period },
    ]);
    expect(results?.role).toBe("user");
    expect(results?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(String(results?.content[0]?.content)).toContain("expensesCents");
  });

  it("asks for a text answer after the round cap", async () => {
    await readyProvider(admin);
    const calls = mockFetch((call) =>
      (call.body as unknown as { tool_choice?: string }).tool_choice === "none"
        ? reply("Genug gefragt")
        : Response.json({ choices: [{ message: { content: "", tool_calls: [toolCall("x", "list_categories", {})] } }] }),
    );
    const answer = await chat(db(), member, { question: "Welche Kategorien gibt es?" });
    expect(answer.reply).toBe("Genug gefragt");
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(answer.lookups).toHaveLength(MAX_TOOL_ROUNDS);
    expect(answer.usage.calls).toBe(MAX_TOOL_ROUNDS + 1);
  });

  it("cuts large tool results and stops querying once the data budget is used", async () => {
    await readyProvider(admin);
    const search = (id: string) => toolCall(id, "search_transactions", { limit: 200 });
    const calls = mockFetch((call) =>
      (call.body as unknown as { tool_choice?: string }).tool_choice === "none"
        ? reply("Zusammenfassung")
        : Response.json({ choices: [{ message: { content: "", tool_calls: ["a", "b", "c", "d", "e"].map(search) } }] }),
    );
    await chat(db(), admin, { question: "Alles?" });
    expect(calls).toHaveLength(2);
    const results = sentMessages<{ role: string; content: string }>(calls[1]).filter((m) => m.role === "tool");
    expect(results).toHaveLength(5);
    expect(results[0]?.content).toContain("[Truncated:");
    for (const r of results) expect(r.content.length).toBeLessThanOrEqual(RESULT_LIMIT + 200);
    expect(results.reduce((sum, r) => sum + r.content.length, 0)).toBeLessThanOrEqual(RESULTS_BUDGET + 5 * 200);
    expect(results.at(-1)?.content).toContain("budget");
  });

  it("falls back to an attached overview when the provider rejects tools, and remembers it", async () => {
    await readyProvider(admin);
    const calls = mockFetch((call) =>
      sentTools(call) ? Response.json({ error: { message: "model does not support tools" } }, { status: 400 }) : reply("Ohne Werkzeuge"),
    );
    const question = "Was war los?";
    const answer = await chat(db(), member, { question });
    expect(answer).toMatchObject({ reply: "Ohne Werkzeuge", mode: "attached", usage: { calls: 1 } });
    expect(answer.lookups.map((l) => l.tool)).toEqual(["summary", "category_totals", "search_transactions"]);
    expect(calls).toHaveLength(2);
    const [system, data, last] = calls[1]?.body.messages ?? [];
    expect(system?.content).toContain("keine Werkzeuge");
    expect(data?.content).toContain("<daten>");
    expect(data?.content).toContain("Hausverwaltung Sonnenhalde");
    expect(data?.content).not.toContain("Muster GmbH");
    expect(last).toEqual({ role: "user", content: question });
    const events = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.chat")).orderBy(auditEvents.id);
    expect(events.map((e) => [e.outcome, e.details.withoutTools])).toEqual([
      ["failed", undefined],
      ["ok", true],
    ]);

    await chat(db(), member, { question });
    expect(calls).toHaveLength(3);
    expect(sentTools(calls[2])).toBe(false);
  });

  it("skips tools for models whose listing says they cannot call them", async () => {
    const provider = await readyProvider(admin);
    mockFetch(() => Response.json({ data: [{ id: "chat-small", capabilities: { tools: { supported: false } } }] }));
    await providerModels(db(), admin, { id: provider.id });
    const calls = mockFetch(() => reply("Antwort"));
    expect((await chat(db(), member, { question: "Hallo?" })).mode).toBe("attached");
    expect(calls).toHaveLength(1);
    expect(sentTools(calls[0])).toBe(false);
  });

  it("records usage per call and prices earlier calls once prices are set", async () => {
    const provider = await readyProvider(admin);
    mockFetch(() => reply("Hi", { prompt_tokens: 1000, completion_tokens: 200 }));
    for (let i = 0; i < 2; i++) await chat(db(), member, { question: "Hi" });
    await expect(usageSummary(db(), member, WINDOW)).rejects.toMatchObject({ status: 403 });
    const before = await usageSummary(db(), admin, WINDOW);
    expect(before.totals).toMatchObject({ calls: 2, inputTokens: 2000, costs: [], unpricedCalls: 2 });

    await updateProvider(db(), admin, provider.id, {
      ...OPENAI,
      apiKey: null,
      model: "chat-small",
      priceInputPerMtok: 2.5,
      priceOutputPerMtok: 10,
      priceCurrency: "usd",
    });
    const after = await usageSummary(db(), admin, WINDOW);
    expect(after.totals).toMatchObject({
      costs: [{ currency: "USD", micro: 2 * (1000 * 2.5 + 200 * 10) }],
      unpricedCalls: 0,
      maxInputTokens: 1000,
    });
    expect(after.byModel[0]?.label).toBe("OpenAI · chat-small");
    expect(after.byPurpose[0]?.key).toBe("chat");
    expect(after.recent[0]).toMatchObject({ purpose: "chat", username: "partnerin", costMicro: 4500 });
    expect(after.byMonth.reduce((s, m) => s + m.calls, 0)).toBe(2);

    // Without a usage block the call is still recorded, as unreported and unpriced.
    mockFetch(() => reply("Hi", null));
    await chat(db(), member, { question: "Hi" });
    expect((await usageSummary(db(), admin, WINDOW)).recent[0]).toMatchObject({ reported: false, costMicro: null });
  });
});

describe("model prices", () => {
  let admin: Viewer;
  beforeEach(async () => ({ admin } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  const catalog = {
    openai: { models: { "chat-small": { cost: { input: 0.15, output: 0.6, cache_read: 0.075 } }, "chat-odd": { cost: {} } } },
    anthropic: { models: { "claude-x": { cost: { input: 3, output: 15 } } } },
  };

  it("takes prices from an OpenCode-style model list and asks no catalog", async () => {
    const opencode = { name: "Zen", kind: "openai" as const, baseUrl: "https://opencode.ai/zen/v1", apiKey: "oc" };
    const listing = {
      data: [
        { id: "glm-5.3", cost: { text: { input: { price: 0.6, cache: { read: 0.1 } }, output: { price: 2.2 } } } },
        { id: "big-pickle", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
        { id: "no-cost" },
      ],
    };
    mockFetch((call) => (call.url.endsWith("/models") ? Response.json(listing) : reply("p")));
    const { provider } = await createProviderRaw(db(), admin, opencode);
    const calls = mockFetch(() => Response.json(listing));
    expect(await providerModels(db(), admin, { id: provider.id })).toEqual([
      { id: "big-pickle", price: { inputPerMtok: 0, outputPerMtok: 0, currency: "USD" } },
      { id: "glm-5.3", price: { inputPerMtok: 0.6, outputPerMtok: 2.2, currency: "USD" } },
      { id: "no-cost", price: null },
    ]);
    expect(calls.map((c) => c.url)).toEqual(["https://opencode.ai/zen/v1/models"]);
  });

  it("prices first-party models from models.dev once a day, without credentials, and survives its failure", async () => {
    const { id } = await createProvider(db(), admin, OPENAI);
    const calls = mockFetch((call) =>
      call.url === "https://models.dev/api.json"
        ? Response.json(catalog)
        : Response.json({ data: [{ id: "chat-small" }, { id: "chat-odd" }, { id: "chat-new" }] }),
    );
    const expected = [
      { id: "chat-new", price: null },
      { id: "chat-odd", price: null },
      { id: "chat-small", price: { inputPerMtok: 0.15, outputPerMtok: 0.6, currency: "USD" } },
    ];
    expect(await providerModels(db(), admin, { id })).toEqual(expected);
    expect(await providerModels(db(), admin, { id })).toEqual(expected);
    const catalogCalls = calls.filter((c) => c.url === "https://models.dev/api.json");
    expect(catalogCalls).toHaveLength(1);
    expect(JSON.stringify(catalogCalls[0]?.init)).not.toMatch(/sk-test|Authorization|chat-/);
    expect(catalogCalls[0]?.init.body).toBeUndefined();

    resetPriceCatalogForTests();
    mockFetch((call) =>
      call.url === "https://models.dev/api.json" ? new Response("down", { status: 503 }) : Response.json({ data: [{ id: "chat-small" }] }),
    );
    expect(await providerModels(db(), admin, { id })).toEqual([{ id: "chat-small", price: null }]);
  });

  it("leaves custom addresses unpriced and never asks the catalog for them", async () => {
    const { id } = await createProvider(db(), admin, { ...OPENAI, baseUrl: "https://llm.example/v1" });
    const calls = mockFetch(() => Response.json({ data: [{ id: "chat-small" }] }));
    expect(await providerModels(db(), admin, { id })).toEqual([{ id: "chat-small", price: null }]);
    expect(calls.map((c) => c.url)).toEqual(["https://llm.example/v1/models"]);
  });
});

const dkbId = async () => (await db().select().from(accounts).where(eq(accounts.bank, "dkb")))[0]?.id ?? -1;
const categoryId = async (name: string) => (await db().select().from(categories).where(eq(categories.name, name)))[0]?.id ?? -1;
const sentNames = (calls: Call[]) =>
  calls.flatMap((c) => (JSON.parse(c.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { name: string }[]).map((i) => i.name));
const answerWith = (mapping: Record<string, string>) => (call: Call) => {
  const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number; name: string }[];
  return reply(JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: mapping[i.name] ?? null })) }));
};

describe("AI categorization after a sync", () => {
  let admin: Viewer;
  let member: Viewer;
  beforeEach(async () => ({ admin, member } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  async function importNew() {
    const booking = (counterparty: string, amountCents: number) => ({
      bookingDate: "2026-11-14",
      amountCents,
      currency: "EUR",
      counterparty,
      counterpartyIban: null,
      purpose: "Kartenzahlung",
    });
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [booking("Neuer Laden", -1234), booking("REWE Markt GmbH", -2500), booking("Cafe Kult", -800)],
      "test",
    );
    await reclassifyAll(db());
    return ids;
  }

  it("is off by default, admin only, and then calls nobody", async () => {
    await readyProvider(admin);
    expect(await getAiSettings(db(), admin)).toEqual({ autoCategorize: false, assignTags: false, createTags: false, maxNewTags: null });
    await expect(getAiSettings(db(), member)).rejects.toMatchObject({ status: 403 });
    await expect(saveAiSettings(db(), member, { autoCategorize: true })).rejects.toMatchObject({ status: 403 });
    const calls = mockFetch(() => reply("{}"));
    const ids = await importNew();
    expect(await categorizeNewBookings(db(), ids)).toBeNull();
    expect(calls).toHaveLength(0);
    const [rewe] = await db()
      .select()
      .from(transactions)
      .where(and(inArray(transactions.id, ids), eq(transactions.counterparty, "REWE Markt GmbH")));
    expect(rewe).toMatchObject({ categoryId: await categoryId("Lebensmittel"), categorySource: "rule" });
  });

  it("lets the AI answer win over a rule, keeps it through reclassification and learns a directed rule", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { autoCategorize: true });
    const ids = await importNew();
    const drugstore = await categoryId("Drogerie & Gesundheit");
    mockFetch(answerWith({ "REWE Markt GmbH": "Drogerie & Gesundheit", "Neuer Laden": "Gehalt" }));
    // An income category for a payment is no answer.
    expect(await categorizeNewBookings(db(), ids)).toMatchObject({ counterpartiesAssigned: 1, rulesCreated: 1 });
    await reclassifyAll(db());
    const fresh = await db().select().from(transactions).where(inArray(transactions.id, ids));
    expect(fresh.find((t) => t.counterparty === "REWE Markt GmbH")).toMatchObject({ categoryId: drugstore, categorySource: "ai" });
    expect(fresh.find((t) => t.counterparty === "Neuer Laden")).toMatchObject({ categoryId: null });
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => [r.pattern, r.field, r.direction, r.categoryId])).toEqual([
      ["REWE Markt GmbH", "counterparty", "out", drugstore],
    ]);
    expect(await db().select().from(aiUsage)).toHaveLength(1);
  });

  it("sends every new booking, also rule-matched ones, and meters one call per sync without a user", async () => {
    await readyProvider(admin);
    expect(await saveAiSettings(db(), admin, { autoCategorize: true })).toMatchObject({ autoCategorize: true, assignTags: false });
    const [stored] = await db().select().from(settings).where(eq(settings.key, "ai_auto_categorize"));
    expect(stored?.value).toBe(true);
    const ids = await importNew();
    const calls = mockFetch(answerWith({ "Neuer Laden": "Sonstiges", "Cafe Kult": "Restaurant & Café" }));
    const result = await categorizeNewBookings(db(), ids);
    expect(sentNames(calls).sort()).toEqual(["Cafe Kult", "Neuer Laden", "REWE Markt GmbH"]);
    expect(result).toMatchObject({ counterpartiesSent: 3, counterpartiesAssigned: 2, rulesCreated: 2 });
    const fresh = await db().select().from(transactions).where(inArray(transactions.id, ids));
    expect(fresh.filter((t) => t.counterparty !== "REWE Markt GmbH").every((t) => t.categorySource === "ai")).toBe(true);
    // No answer for REWE: the rule's category stays.
    expect(fresh.find((t) => t.counterparty === "REWE Markt GmbH")).toMatchObject({
      categoryId: await categoryId("Lebensmittel"),
      categorySource: "rule",
    });
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => r.pattern).sort()).toEqual(["Cafe Kult", "Neuer Laden"]);
    // The rule also reaches older bookings of the same counterparty.
    const cafe = await db().select().from(transactions).where(eq(transactions.counterparty, "Cafe Kult"));
    expect(cafe.length).toBeGreaterThan(1);
    expect(cafe.every((t) => t.categoryId !== null)).toBe(true);
    const usage = await db().select().from(aiUsage);
    expect(usage.map((u) => [u.purpose, u.userId])).toEqual([["categorize", null]]);
  });

  it("categorizes bookings of a private account but learns no household rule or tag from them", async () => {
    const parent = await makeUser("eltern", "familyAdmin");
    const kid = await makeUser("kind", "member", [], { aiAllowed: true });
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { autoCategorize: true, assignTags: true, createTags: true });
    const [own] = await db()
      .insert(accounts)
      .values({ name: "Privat", bank: "x", kind: "checking", ownerUserId: kid.id, visibility: "private" })
      .returning();
    const accountId = own?.id ?? -1;
    const { ids } = await importBookings(
      db(),
      accountId,
      [
        {
          bookingDate: "2026-11-14",
          amountCents: -5000,
          currency: "EUR",
          counterparty: "Praxis Dr. Dummy",
          counterpartyIban: null,
          purpose: "Rechnung",
        },
      ],
      "test",
    );
    expect(await visibleAccountIds(db(), parent)).not.toContain(accountId);
    mockFetch((call) => {
      const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number }[];
      return reply(
        JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: "Drogerie & Gesundheit", tags: ["Arztbesuch"] })) }),
      );
    });
    expect(await categorizeNewBookings(db(), ids)).toMatchObject({ counterpartiesAssigned: 1, rulesCreated: 0, tagsCreated: 0 });
    const [booking] = await db().select().from(transactions).where(inArray(transactions.id, ids));
    expect(booking).toMatchObject({ categoryId: await categoryId("Drogerie & Gesundheit"), categorySource: "ai" });
    expect((await listRules(db(), parent)).map((r) => r.pattern)).not.toContain("Praxis Dr. Dummy");
    expect(await db().select().from(tags).where(eq(tags.name, "Arztbesuch"))).toHaveLength(0);
  });

  it("never throws when the provider fails and tells admins who follow bank problems", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { autoCategorize: true });
    await savePreferences(db(), admin, {
      preferences: [{ kind: "bank_problem", enabled: true, push: false, email: false, threshold: 14 }],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ids = await importNew();
    mockFetch(() => Response.json({ error: { message: "overloaded" } }, { status: 529 }));
    expect(await categorizeNewBookings(db(), ids)).toBeNull();
    expect(await db().select().from(rules).where(eq(rules.source, "ai"))).toHaveLength(0);
    expect(info.mock.calls.flat().join(" ")).not.toMatch(/Neuer Laden|overloaded/);
    const { items } = await listNotifications(db(), admin);
    expect(items.map((i) => i.title)).toEqual(["Automatische KI-Kategorisierung fehlgeschlagen"]);
    expect(items[0]?.body).toContain("529");

    await db().delete(aiProviders);
    expect(await categorizeNewBookings(db(), ids)).toBeNull();
  });
});

describe("AI re-categorization", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  beforeEach(async () => ({ admin, member, mine } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  async function arrange() {
    await readyProvider(admin);
    const other = await categoryId("Sonstiges");
    const restaurant = await categoryId("Restaurant & Café");
    const sport = await categoryId("Freizeit & Sport");
    const ai = (pattern: string, categoryId: number) => ({
      pattern,
      field: "counterparty" as const,
      categoryId,
      priority: 50,
      source: "ai" as const,
    });
    const [gasthofRule, foreignRule] = await db()
      .insert(rules)
      .values([ai("Gasthof Hirsch", other), ai("Hausverwaltung Sonnenhalde", other)])
      .returning();
    await db()
      .insert(rules)
      .values({ pattern: "Cafe Kult", field: "counterparty", categoryId: restaurant, priority: 100, source: "manual" });
    await reclassifyAll(db());
    const [manual] = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirsch"));
    await db()
      .update(transactions)
      .set({ categoryId: sport, categorySource: "manual" })
      .where(eq(transactions.id, manual?.id ?? -1));
    return { gasthofRule, foreignRule, manual, restaurant, sport, other };
  }

  it("replaces only the AI rules of the asked counterparties and leaves manual decisions alone", async () => {
    const { gasthofRule, foreignRule, manual, restaurant, sport } = await arrange();
    const preview = await recategorizePreview(db(), admin, { groupId: mine });
    expect(preview.payees).toBeGreaterThan(1);
    const calls = mockFetch(answerWith({ "Gasthof Hirsch": "Restaurant & Café" }));
    const result = await recategorize(db(), admin, { groupId: mine });
    const sent = sentNames(calls);
    expect(sent).toEqual(expect.arrayContaining(["Gasthof Hirsch", "Bergsport Oberstdorf", "Pizzeria Da Mario"]));
    expect(sent).not.toEqual(expect.arrayContaining(["Cafe Kult"]));
    expect(sent.some((name) => /Cafe Kult|Hausverwaltung|REWE|Netflix/.test(name))).toBe(false);
    expect(sent).toHaveLength(preview.payees);

    const gasthof = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirsch"));
    expect(result).toMatchObject({ payeesAssigned: 1, categoriesChanged: 1, bookingsChanged: gasthof.length - 1, unreadableBatches: 0 });
    expect(gasthof.find((t) => t.id === manual?.id)).toMatchObject({ categoryId: sport, categorySource: "manual" });
    expect(gasthof.filter((t) => t.id !== manual?.id).every((t) => t.categoryId === restaurant && t.categorySource === "ai")).toBe(true);
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => [r.pattern, r.categoryId]).sort()).toEqual(
      [
        ["Gasthof Hirsch", restaurant],
        ["Hausverwaltung Sonnenhalde", foreignRule?.categoryId],
      ].sort(),
    );
    expect(aiRules.find((r) => r.pattern === "Hausverwaltung Sonnenhalde")?.id).toBe(foreignRule?.id);
    expect(aiRules.some((r) => r.id === gasthofRule?.id)).toBe(false);
  });

  it("with target 'uncategorized' sends only bookings without a category, never what the AI or a rule already decided", async () => {
    await arrange();
    const everything = await recategorizePreview(db(), admin, { groupId: mine, target: "includeAi" });
    const uncategorized = await recategorizePreview(db(), admin, { groupId: mine, target: "uncategorized" });
    expect(uncategorized.bookings).toBeLessThan(everything.bookings);
    const calls = mockFetch(answerWith({}));
    await recategorize(db(), admin, { groupId: mine, target: "uncategorized" });
    const sent = sentNames(calls);
    expect(sent).toHaveLength(uncategorized.payees);
    // Gasthof Hirsch is categorized by an AI rule, Cafe Kult by a manual rule: neither goes out.
    expect(sent.some((name) => /Gasthof Hirsch|Cafe Kult/.test(name))).toBe(false);
    const open = await db().select().from(transactions).where(isNull(transactions.categoryId));
    expect(sent.every((name) => open.some((t) => t.counterparty === name || t.purpose.includes(name)))).toBe(true);
  });

  it("keeps the old AI rules when the model gives no usable answer, limits the period and is admin only", async () => {
    const { gasthofRule, other } = await arrange();
    mockFetch(() => reply("kein json"));
    await expect(recategorize(db(), admin, { groupId: mine })).rejects.toMatchObject({ status: 502 });
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => r.id)).toContain(gasthofRule?.id);
    const gasthof = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirsch"));
    expect(gasthof.filter((t) => t.categorySource === "rule").every((t) => t.categoryId === other)).toBe(true);

    const all = await recategorizePreview(db(), admin, { groupId: mine });
    const month = await recategorizePreview(db(), admin, { groupId: mine, dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    expect(month.bookings).toBeLessThan(all.bookings);
    expect(await recategorizePreview(db(), admin, { groupId: mine, dateFrom: "2030-01-01", dateTo: null })).toEqual({
      payees: 0,
      bookings: 0,
    });
    await expect(recategorizePreview(db(), admin, { dateFrom: "2026-12-01", dateTo: "2026-11-01" })).rejects.toThrow();
    await expect(recategorize(db(), member, {})).rejects.toMatchObject({ status: 403 });
    await expect(recategorizePreview(db(), member, {})).rejects.toMatchObject({ status: 403 });
  });
});

describe("AI categorization of payment service bookings", () => {
  let admin: Viewer;
  beforeEach(async () => ({ admin } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  const paypal = (amountCents: number, purpose: string, counterparty = "PayPal Europe S.a.r.l. et Cie S.C.A") => ({
    bookingDate: "2026-11-14",
    amountCents,
    currency: "EUR",
    counterparty,
    counterpartyIban: null,
    purpose,
  });
  const itemsOf = (call: Call) =>
    JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number; name: string; zweck?: string }[];

  it("asks per merchant, keeps directed purpose rules and never a PayPal rule, so a refund rule misses later payments", async () => {
    await readyProvider(admin);
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [
        paypal(2_599, "1043567891234 PP.1234.PP . Zalando SE, Ihr Einkauf bei Zalando SE"),
        paypal(-1_250, "1043567891235 PP.1235.PP . Thalia, Ihr Einkauf bei Thalia", "PayPal (Europe) S.à r.l. et Cie, SCA"),
        paypal(-4_999, "PayPal Zahlung 4711 DE89370400440532013000", "PAYPAL"),
      ],
      "test",
    );
    const [refund, thalia, unknown] = ids as [number, number, number];
    const mapping: Record<string, string> = { "Zalando SE": "Erstattungen", Thalia: "Shopping", PAYPAL: "Freizeit & Sport" };
    const calls = mockFetch((call) =>
      reply(JSON.stringify({ zuordnungen: itemsOf(call).map((i) => ({ id: i.id, kategorie: mapping[i.name] ?? null })) })),
    );
    await categorize(db(), admin, {});
    const items = calls.flatMap(itemsOf);
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(["Zalando SE", "Thalia", "PAYPAL"]));
    expect(items.some((i) => /PayPal Europe|S\.à r\.l/.test(i.name))).toBe(false);
    // Without a merchant the booking goes alone, with its purpose but never an IBAN.
    expect(items.find((i) => i.name === "PAYPAL")?.zweck).toBe("PayPal Zahlung 4711");
    const content = calls[0]?.body.messages[1]?.content ?? "";
    expect(content.split("Kategorien für Eingang")[0]).not.toMatch(/Erstattungen|Gehalt/);

    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    const patterns = aiRules.map((r) => [r.pattern, r.field, r.direction]);
    expect(patterns).toEqual(
      expect.arrayContaining([
        ["Zalando SE", "purpose", "in"],
        ["Thalia", "purpose", "out"],
      ]),
    );
    expect(aiRules.some((r) => /paypal/i.test(r.pattern))).toBe(false);
    const rows = new Map((await db().select().from(transactions).where(inArray(transactions.id, ids))).map((t) => [t.id, t]));
    expect(rows.get(refund)).toMatchObject({ categoryId: await categoryId("Erstattungen"), categorySource: "rule" });
    expect(rows.get(thalia)).toMatchObject({ categoryId: await categoryId("Shopping"), categorySource: "rule" });
    expect(rows.get(unknown)).toMatchObject({ categoryId: await categoryId("Freizeit & Sport"), categorySource: "ai" });

    // The next sync brings an outgoing PayPal payment to the same shop: the refund rule must not make it income.
    const next = await importBookings(db(), await dkbId(), [paypal(-1_000, "PP.9999.PP . Zalando SE, Ihr Einkauf bei Zalando SE")], "test");
    await reclassifyAll(db());
    const [payment] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.id, next.ids[0] ?? -1));
    // The seed rule "zalando" makes it Shopping; before, the AI rule learned from the refund made it "Erstattungen".
    expect(payment).toMatchObject({ categoryId: await categoryId("Shopping"), categorySource: "rule" });
  });

  it("remembers a category for a PayPal booking by its merchant and direction only", async () => {
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [paypal(-1_250, "PP.1235.PP . Thalia, Ihr Einkauf bei Thalia"), paypal(-4_999, "PayPal Zahlung 4711")],
      "test",
    );
    const [thalia, unknown] = ids as [number, number];
    const shopping = await categoryId("Shopping");
    await expect(rememberCategory(db(), admin, { id: thalia, categoryId: await categoryId("Erstattungen") })).rejects.toMatchObject({
      status: 400,
    });
    await expect(rememberCategory(db(), admin, { id: unknown, categoryId: shopping })).rejects.toMatchObject({ status: 400 });
    await rememberCategory(db(), admin, { id: thalia, categoryId: shopping });
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => [r.pattern, r.field, r.direction, r.categoryId])).toEqual([["Thalia", "purpose", "out", shopping]]);
  });
});

/** Every model call waits until the test releases it, so a cancel can land between two batches. */
function gatedFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const gates: (() => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    await new Promise<void>((resolve) => gates.push(resolve));
    return respond(calls.at(-1) as Call);
  });
  const release = async (index: number) => {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(index));
    gates[index]?.();
  };
  return { calls, release };
}

const answerAll = (category: string) => (call: Call) => {
  const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number }[];
  return reply(JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: category })) }));
};

async function finished(viewer: Viewer, taskId: string): Promise<TaskView> {
  return vi.waitFor(
    async () => {
      const task = (await listTasks(db(), viewer)).find((t) => t.id === taskId);
      if (!task || task.status === "running") throw new Error(`task ${taskId} still running`);
      return task;
    },
    { timeout: 5000 },
  );
}

const merchants = Array.from({ length: 100 }, (_, i) => `Händler ${String(i).padStart(3, "0")}`);

async function importMerchants() {
  const bookings = merchants.map((counterparty, i) => ({
    bookingDate: "2026-11-10",
    amountCents: -1000 - i,
    currency: "EUR",
    counterparty,
    counterpartyIban: null,
    purpose: "Einkauf",
  }));
  await importBookings(db(), await dkbId(), bookings, "test");
}

describe("AI categorization as a background task", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  let shared: number;
  beforeEach(async () => {
    resetTasksForTests();
    ({ admin, member, mine, shared } = await setup());
  });
  afterEach(() => {
    resetTasksForTests();
    vi.restoreAllMocks();
  });

  it("returns at once, reports each batch and finishes with the summary", async () => {
    await readyProvider(admin);
    await importMerchants();
    const { calls, release } = gatedFetch(answerAll("Sonstiges"));
    const { taskId } = await startCategorize(db(), admin, {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [running] = await listTasks(db(), admin);
    expect(running).toMatchObject({
      id: taskId,
      kind: "aiCategorize",
      status: "running",
      cancellable: true,
      title: "KI-Zuordnung · Alle Konten",
    });
    const total = running?.progress?.total ?? 0;
    expect(running?.progress).toEqual({ done: 0, total, unit: "batch" });
    expect(total).toBeGreaterThan(1);
    // A second categorization would race on the same AI rules.
    await expect(startCategorize(db(), admin, {})).rejects.toMatchObject({ status: 409 });
    await expect(startRecategorize(db(), admin, {})).rejects.toMatchObject({ status: 409 });
    for (let i = 0; i < total; i++) await release(i);
    const task = await finished(admin, taskId);
    // Every batch answered with 100 input and 20 output tokens.
    expect(task).toMatchObject({ status: "done", progress: { done: total, total }, cancellable: false, tokens: 120 * total });
    expect(task.message).toMatch(/Empfänger gesendet, .* zugeordnet, .* Regeln angelegt, .* kategorisiert\./);
    expect(await db().select().from(rules).where(eq(rules.source, "ai"))).not.toHaveLength(0);
  });

  it("stops between batches on cancel and keeps the rules of the batches already answered", async () => {
    await readyProvider(admin);
    await importMerchants();
    const { calls, release } = gatedFetch(answerAll("Sonstiges"));
    const { taskId } = await startCategorize(db(), admin, {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await listTasks(db(), member)).toEqual([]);
    await expect(cancelTask(db(), member, { taskId })).rejects.toMatchObject({ status: 404 });
    await cancelTask(db(), admin, { taskId });
    await release(0);
    const task = await finished(admin, taskId);
    expect(calls).toHaveLength(1);
    expect(task).toMatchObject({ status: "cancelled", progress: { done: 1 } });
    const answered = new Set(sentNames(calls));
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.length).toBeGreaterThan(0);
    expect(aiRules.every((r) => answered.has(r.pattern))).toBe(true);
    expect(task.message).toContain(`${aiRules.length} Regeln angelegt`);
    expect((await db().select().from(aiUsage)).map((u) => u.purpose)).toEqual(["categorize"]);
  });

  it("checks access and provider before starting, so those errors reach the request", async () => {
    await expect(startCategorize(db(), admin, {})).rejects.toMatchObject({ message: "Kein KI-Anbieter aktiv" });
    await expect(startCategorize(db(), member, {})).rejects.toMatchObject({ status: 403 });
    await expect(startRecategorize(db(), member, {})).rejects.toMatchObject({ status: 403 });
    await expect(startAnalysis(db(), member, { groupId: mine, ...WINDOW })).rejects.toMatchObject({ status: 404 });
    expect(await listTasks(db(), admin)).toEqual([]);
  });

  it("never deletes the old AI rules when re-categorization fails in the background", async () => {
    await readyProvider(admin);
    const other = await categoryId("Sonstiges");
    const [old] = await db()
      .insert(rules)
      .values({ pattern: "Gasthof Hirsch", field: "counterparty", categoryId: other, priority: 50, source: "ai" })
      .returning();
    await reclassifyAll(db());
    mockFetch(() => reply("kein json"));
    const { taskId } = await startRecategorize(db(), admin, { groupId: mine });
    const task = await finished(admin, taskId);
    expect(task).toMatchObject({ status: "failed", kind: "aiRecategorize" });
    expect(task.message).toContain("JSON");
    expect((await db().select().from(rules).where(eq(rules.source, "ai"))).map((r) => r.id)).toEqual([old?.id]);
    const gasthof = await db().select().from(transactions).where(eq(transactions.counterparty, "Gasthof Hirsch"));
    expect(gasthof.every((t) => t.categoryId === other)).toBe(true);
  });

  it("replaces on cancel only the AI rules of counterparties already answered", async () => {
    await readyProvider(admin);
    await importMerchants();
    const other = await categoryId("Sonstiges");
    const restaurant = await categoryId("Restaurant & Café");
    const before = await db()
      .insert(rules)
      .values(
        merchants.map((pattern) => ({ pattern, field: "counterparty" as const, categoryId: other, priority: 50, source: "ai" as const })),
      )
      .returning();
    await reclassifyAll(db());
    const { calls, release } = gatedFetch(answerAll("Restaurant & Café"));
    const { taskId } = await startRecategorize(db(), admin, {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await cancelTask(db(), admin, { taskId });
    await release(0);
    expect(await finished(admin, taskId)).toMatchObject({ status: "cancelled", progress: { done: 1 } });
    expect(calls).toHaveLength(1);
    const answered = new Set(sentNames(calls));
    const after = await db().select().from(rules).where(eq(rules.source, "ai"));
    for (const rule of before) {
      const now = after.find((r) => r.pattern === rule.pattern);
      if (answered.has(rule.pattern)) expect(now).toMatchObject({ categoryId: restaurant });
      else expect(now).toMatchObject({ id: rule.id, categoryId: other });
    }
    expect(before.some((rule) => !answered.has(rule.pattern))).toBe(true);
  });

  it("runs a member's analysis as the member's own task", async () => {
    await readyProvider(admin);
    mockFetch(() => reply("## Einordnung\nAlles im Rahmen."));
    const { taskId } = await startAnalysis(db(), member, { groupId: shared, dateFrom: "2026-08-01", dateTo: "2026-10-31" });
    expect(await finished(member, taskId)).toMatchObject({
      kind: "aiAnalysis",
      status: "done",
      cancellable: false,
      startedBy: { name: "partnerin" },
      tokens: 120,
    });
    expect((await listAnalyses(db(), member, {})).map((a) => a.content)).toEqual(["## Einordnung\nAlles im Rahmen."]);
    expect((await listTasks(db(), admin)).map((t) => t.id)).toEqual([taskId]);
  });

  it("lists the categorization after a sync as an automatic task of its own", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { autoCategorize: true });
    await importMerchants();
    const ids = (await db().select({ id: transactions.id }).from(transactions)).map((t) => t.id);
    mockFetch(answerAll("Sonstiges"));
    const result = await categorizeNewBookings(db(), ids);
    const [task] = await listTasks(db(), admin);
    expect(task).toMatchObject({ kind: "aiAutoCategorize", status: "done", startedBy: null, title: "KI-Zuordnung nach dem Abruf" });
    expect(task?.message).toContain(`${result?.rulesCreated} Regeln angelegt`);
    expect(await listTasks(db(), member)).toEqual([]);
  });
});

describe("AI permission per person", () => {
  let admin: Viewer;
  let shared: number;
  beforeEach(async () => ({ admin, shared } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("refuses every AI request of someone a superuser has not allowed, on the server, at once", async () => {
    await readyProvider(admin);
    const calls = mockFetch(() => reply('{"kategorie": null, "begruendung": "x"}'));
    const kind = await makeUser("kind", "member", [shared]);
    const mama = await makeUser("mama", "familyAdmin");
    const [txn] = await db().select().from(transactions).limit(1);
    const question = { question: "Hallo?" };
    expect(await aiStatus(db(), kind)).toEqual({ ready: true, allowed: false });
    for (const viewer of [kind, mama]) {
      await expect(chat(db(), viewer, question)).rejects.toMatchObject({ status: 403 });
      await expect(runAnalysis(db(), viewer, WINDOW)).rejects.toMatchObject({ status: 403 });
      await expect(startAnalysis(db(), viewer, WINDOW)).rejects.toMatchObject({ status: 403 });
    }
    await expect(suggestCategory(db(), mama, { id: txn?.id ?? -1 })).rejects.toMatchObject({ status: 403 });
    await expect(categorize(db(), mama, {})).rejects.toMatchObject({ status: 403 });
    await expect(recategorizePreview(db(), mama, WINDOW)).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);

    // Allowed members chat and analyse, but categorizing writes rules: that stays with the household's admins.
    await updateUser(db(), admin, { id: kind.id, aiAllowed: true });
    await updateUser(db(), admin, { id: mama.id, aiAllowed: true });
    expect((await chat(db(), kind, question)).reply).toBeTruthy();
    await expect(categorize(db(), kind, {})).rejects.toMatchObject({ status: 403 });
    await expect(startCategorize(db(), kind, {})).rejects.toMatchObject({ status: 403 });
    await expect(rememberCategory(db(), kind, { id: txn?.id ?? -1, categoryId: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await recategorizePreview(db(), mama, WINDOW)).payees).toBeGreaterThanOrEqual(0);

    await updateUser(db(), admin, { id: kind.id, aiAllowed: false });
    await expect(chat(db(), kind, question)).rejects.toMatchObject({ status: 403 });
    // Provider settings and usage stay with superusers.
    await expect(listProviders(db(), mama)).rejects.toMatchObject({ status: 403 });
    await expect(usageSummary(db(), mama, WINDOW)).rejects.toMatchObject({ status: 403 });
    await expect(getAiSettings(db(), mama)).rejects.toMatchObject({ status: 403 });
  });
});

describe("AI suggestion for one booking", () => {
  let admin: Viewer;
  let member: Viewer;
  beforeEach(async () => ({ admin, member } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  async function bookings() {
    const [joint] = await db().select().from(accounts).where(eq(accounts.bank, "comdirect"));
    const [own] = await db().select().from(transactions).where(eq(transactions.counterparty, "Vodafone GmbH"));
    const [foreign] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, await dkbId()));
    await db()
      .update(transactions)
      .set({ note: "GEHEIMNOTIZ", counterpartyIban: "DE89370400440532013000" })
      .where(eq(transactions.accountId, joint?.id ?? -1));
    return { own: own?.id ?? -1, foreign: foreign?.id ?? -1 };
  }

  it("sends only payee, purpose, amount, direction and categories and answers in the reader's language", async () => {
    await readyProvider(admin);
    const { own } = await bookings();
    const calls = mockFetch(() => reply(JSON.stringify({ kategorie: "Sonstiges", begruendung: "Internet is a household cost." })));
    const suggestion = await suggestCategory(db(), { ...member, locale: "en" }, { id: own });
    expect(suggestion).toEqual({
      categoryId: await categoryId("Sonstiges"),
      categoryName: "Sonstiges",
      reason: "Internet is a household cost.",
      tags: [],
      newTags: [],
    });
    const [system, data] = calls[0]?.body.messages ?? [];
    expect(system?.content).toContain("Englisch (English)");
    expect(data?.content).toContain("Vodafone GmbH");
    expect(data?.content).toContain('"richtung":"Ausgang"');
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/DE89|GEHEIMNOTIZ|186420|1864\.2|Comdirect/);
    expect((await db().select().from(aiUsage)).map((u) => [u.purpose, u.userId])).toEqual([["suggest", member.id]]);

    mockFetch(() => reply(JSON.stringify({ kategorie: "Erfunden", begruendung: "Unklar." })));
    expect(await suggestCategory(db(), member, { id: own })).toMatchObject({ categoryId: null, reason: "Unklar." });
  });

  it("hides foreign bookings from members and needs a ready provider", async () => {
    const { own, foreign } = await bookings();
    await expect(suggestCategory(db(), member, { id: own })).rejects.toMatchObject({ status: 400 });
    await readyProvider(admin);
    const calls = mockFetch(() => reply("{}"));
    await expect(suggestCategory(db(), member, { id: foreign })).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("lets admins remember a category for every booking of the payee as an AI rule", async () => {
    const { own } = await bookings();
    const other = await categoryId("Sonstiges");
    await expect(rememberCategory(db(), member, { id: own, categoryId: other })).rejects.toMatchObject({ status: 403 });
    await db().insert(rules).values({ pattern: "vodafone gmbh", field: "counterparty", categoryId: null, priority: 50, source: "ai" });
    await rememberCategory(db(), admin, { id: own, categoryId: other });
    const aiRules = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(aiRules.map((r) => [r.pattern, r.categoryId])).toEqual([["Vodafone GmbH", other]]);
    const vodafone = await db().select().from(transactions).where(eq(transactions.counterparty, "Vodafone GmbH"));
    expect(vodafone.length).toBeGreaterThan(1);
    expect(vodafone.every((t) => t.categoryId === other && t.categorySource === "rule")).toBe(true);
    await expect(rememberCategory(db(), admin, { id: own, categoryId: 999_999 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("matching the model's category answer", () => {
  const cats = [{ name: "Reisen" }, { name: "Restaurant & Café" }, { name: "Freizeit & Sport" }];
  it("accepts brackets, case, quotes and 'und' for '&', but does not guess", async () => {
    const { matchCategory } = await import("./assistant.ts");
    expect(matchCategory(cats, "Reisen (expense)")?.name).toBe("Reisen");
    expect(matchCategory(cats, "„reisen“")?.name).toBe("Reisen");
    expect(matchCategory(cats, "Restaurant und Café")?.name).toBe("Restaurant & Café");
    expect(matchCategory(cats, "Urlaub")).toBeNull();
    expect(matchCategory(cats, null)).toBeNull();
  });
});

describe("OpenCode session header", () => {
  it("sends a stable x-opencode-session to OpenCode only, the same for every turn of one call site", async () => {
    const { complete } = await import("./client.ts");
    const calls = mockFetch(() => reply("ok"));
    const opencode = { kind: "openai" as const, baseUrl: "https://opencode.ai/inference/go/openai/v1", apiKey: "k", model: "glm-5.3" };
    await complete(opencode, { system: "s", messages: [{ role: "user", content: "a" }], jsonMode: false, sessionId: "chat-1" });
    await complete(opencode, { system: "s", messages: [{ role: "user", content: "b" }], jsonMode: false, sessionId: "chat-1" });
    await complete(
      { ...opencode, baseUrl: "https://api.openai.com/v1" },
      { system: "s", messages: [], jsonMode: false, sessionId: "chat-1" },
    );
    const header = (i: number) => (calls[i]?.init.headers as Record<string, string> | undefined)?.["x-opencode-session"];
    expect([header(0), header(1)]).toEqual(["chat-1", "chat-1"]);
    expect(header(2)).toBeUndefined();
  });
});

describe("OpenCode model details", () => {
  it("hides models Saldo cannot talk to, flags training and treats a region refusal as a valid key", async () => {
    const { listModels, checkKey } = await import("./client.ts");
    const cfg = { kind: "openai" as const, baseUrl: "https://opencode.ai/inference/go/openai/v1", apiKey: "k", model: null };
    mockFetch(() =>
      Response.json({
        data: [
          { id: "deepseek-x", api: { "chat-completions": {} }, go: { training: false, zdr: false } },
          { id: "muse-x", api: { "chat-completions": {} }, go: { training: true } },
          { id: "kimi-x", api: { "chat-completions": {} }, go: { zdr: true } },
          { id: "gpt-x", api: { responses: {} } },
        ],
      }),
    );
    expect(await listModels(cfg)).toEqual([
      { id: "deepseek-x", price: null },
      { id: "kimi-x", price: null, noRetention: true },
      { id: "muse-x", price: null, trainsOnData: true },
    ]);
    mockFetch(() => Response.json({ error: { message: "This OpenCode Go model is hosted outside Europe" } }, { status: 400 }));
    const regionRefusal = await checkKey(cfg, "deepseek-x");
    expect(regionRefusal.result).toBe("valid");
    expect(JSON.stringify(regionRefusal.detail)).toContain("outside Europe");
    mockFetch(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    expect(await checkKey(cfg, "deepseek-x")).toMatchObject({ result: "rejected" });
  });
});

describe("AI tagging", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  beforeEach(async () => ({ admin, member, mine } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  /** Answers category and tags per sent name; names without an entry get no category. */
  const answerTags = (mapping: Record<string, [category: string, tags: string[]]>) => (call: Call) => {
    const items = JSON.parse(call.body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number; name: string }[];
    return reply(
      JSON.stringify({
        zuordnungen: items.map((i) => ({ id: i.id, kategorie: mapping[i.name]?.[0] ?? null, tags: mapping[i.name]?.[1] ?? [] })),
      }),
    );
  };
  const tagId = async (name: string) => (await db().select().from(tags).where(eq(tags.name, name)))[0]?.id ?? -1;
  const tagsOfPayee = async (counterparty: string) =>
    db()
      .select({ transactionId: transactionTags.transactionId, tag: tags.name, source: transactionTags.source })
      .from(transactionTags)
      .innerJoin(tags, eq(tags.id, transactionTags.tagId))
      .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
      .where(eq(transactions.counterparty, counterparty));

  it("asks for tags in the same call only when tagging is on, with the existing tag names", async () => {
    await readyProvider(admin);
    await db().insert(tags).values({ name: "Auswärts Essen", color: "#123456" });
    const hirsch = { "Gasthof Hirsch": ["Restaurant & Café", ["Auswärts Essen"]] } as Record<string, [string, string[]]>;
    let calls = mockFetch(answerTags(hirsch));
    await categorize(db(), admin, { groupId: mine });
    expect(calls[0]?.body.messages[0]?.content).not.toContain('"tags"');
    expect(calls[0]?.body.messages[1]?.content).not.toContain("Auswärts Essen");
    expect(await tagsOfPayee("Gasthof Hirsch")).toEqual([]);

    await saveAiSettings(db(), admin, { assignTags: true });
    await db().delete(rules).where(eq(rules.source, "ai"));
    await db().update(transactions).set({ categoryId: null, categorySource: null });
    await reclassifyAll(db());
    await db().delete(aiUsage);
    calls = mockFetch(answerTags(hirsch));
    const result = await categorize(db(), admin, { groupId: mine });
    expect(calls).toHaveLength(1);
    expect(await db().select().from(aiUsage)).toHaveLength(1);
    expect(calls[0]?.body.messages[0]?.content).toContain('"tags"');
    expect(calls[0]?.body.messages[0]?.content).toContain("Erfinde keine neuen Tags");
    expect(calls[0]?.body.messages[1]?.content).toContain("Tags:\n- Auswärts Essen");
    expect(result.tagsCreated).toBe(0);
    const tagged = await tagsOfPayee("Gasthof Hirsch");
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((t) => t.tag === "Auswärts Essen")).toBe(true);
  });

  it("creates every new tag the AI proposes when there is no limit", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { assignTags: true, createTags: true, maxNewTags: null });
    mockFetch(
      answerTags({
        "Gasthof Hirsch": ["Restaurant & Café", ["Wirtshaus", "Ausflug"]],
        "Pizzeria Da Mario": ["Restaurant & Café", ["Pizza", "Lieferdienst"]],
        "Bergsport Oberstdorf": ["Freizeit & Sport", ["Hobby", "Outdoor"]],
      }),
    );
    const result = await categorize(db(), admin, { groupId: mine });
    expect(result.tagsCreated).toBe(6);
    expect((await db().select().from(tags)).filter((t) => t.createdBy === "ai")).toHaveLength(6);
    expect(await getAiSettings(db(), admin)).toMatchObject({ maxNewTags: null });
  });

  it("reuses tags by normalized name, creates new ones as the AI's up to the limit and learns them on directed rules", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { assignTags: true, createTags: true, maxNewTags: 2 });
    await db().insert(tags).values({ name: "Auswärts Essen", color: "#123456" });
    const calls = mockFetch(
      answerTags({
        "Gasthof Hirsch": ["Restaurant & Café", ["auswärts-essen", "Wirtshaus", "Restaurant & Café"]],
        "Pizzeria Da Mario": ["Restaurant & Café", ["wirtshaus", "Pizza"]],
        "Bergsport Oberstdorf": ["Freizeit & Sport", ["Hobby", "Outdoor"]],
      }),
    );
    const result = await categorize(db(), admin, { groupId: mine });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.messages[0]?.content).toContain("darfst du neue vorschlagen");

    const all = await db().select().from(tags);
    const created = all.filter((t) => t.createdBy === "ai");
    expect(result.tagsCreated).toBe(2);
    expect(created).toHaveLength(2);
    expect(all.filter((t) => t.name.toLowerCase().includes("essen"))).toHaveLength(1);
    // A category name is never a new tag.
    expect(all.some((t) => t.name === "Restaurant & Café")).toBe(false);
    expect(created.map((t) => t.name)).toContain("Wirtshaus");

    const [audit] = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.categorize"));
    expect(audit?.details).toMatchObject({ tagsCreated: 2 });
    expect(JSON.stringify(audit?.details)).not.toContain("Wirtshaus");

    const [hirschRule] = await db()
      .select()
      .from(rules)
      .where(and(eq(rules.source, "ai"), eq(rules.pattern, "Gasthof Hirsch")));
    expect(hirschRule?.direction).toBe("out");
    const learned = await db()
      .select()
      .from(ruleTags)
      .where(eq(ruleTags.ruleId, hirschRule?.id ?? -1));
    expect(learned.map((l) => l.tagId).sort()).toEqual([await tagId("Auswärts Essen"), await tagId("Wirtshaus")].sort());
    // Later bookings of the payee get the tags from the rule, without asking the AI.
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [
        {
          bookingDate: "2026-11-14",
          amountCents: -4200,
          currency: "EUR",
          counterparty: "Gasthof Hirsch",
          counterpartyIban: null,
          purpose: "x",
        },
      ],
      "test",
    );
    await reclassifyAll(db());
    const fresh = (await tagsOfPayee("Gasthof Hirsch")).filter((t) => t.transactionId === ids[0]);
    expect(fresh.map((t) => [t.tag, t.source]).sort()).toEqual([
      ["Auswärts Essen", "rule"],
      ["Wirtshaus", "rule"],
    ]);
  });

  it("creates no tags while creating is off and never one that looks like personal data", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { assignTags: true, createTags: true });
    await saveAiSettings(db(), admin, { createTags: false });
    expect(await getAiSettings(db(), admin)).toMatchObject({ assignTags: true, createTags: false });
    await importBookings(
      db(),
      await dkbId(),
      [
        {
          bookingDate: "2026-11-14",
          amountCents: -2000,
          currency: "EUR",
          counterparty: "Max Mustermann",
          counterpartyIban: null,
          purpose: "x",
        },
      ],
      "test",
    );
    await reclassifyAll(db());
    const answers = answerTags({ "Max Mustermann": ["Sonstiges", ["Geschenk Mustermann", "DE89 3704 0044 0532", "Geschenke"]] });
    mockFetch(answers);
    expect(await categorize(db(), admin, {})).toMatchObject({ tagsCreated: 0 });
    expect(await db().select().from(tags)).toEqual([]);

    await saveAiSettings(db(), admin, { createTags: true });
    await db().update(transactions).set({ categoryId: null, categorySource: null });
    await db().delete(rules).where(eq(rules.source, "ai"));
    mockFetch(answers);
    expect(await categorize(db(), admin, {})).toMatchObject({ tagsCreated: 1 });
    expect((await db().select().from(tags)).map((t) => [t.name, t.createdBy])).toEqual([["Geschenke", "ai"]]);
  });

  it("never removes manual tags and replaces only its own on a re-run", async () => {
    await readyProvider(admin);
    await saveAiSettings(db(), admin, { autoCategorize: true, assignTags: true, createTags: true });
    const [holiday] = await db().insert(tags).values({ name: "Urlaub", color: "#123456" }).returning();
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [
        {
          bookingDate: "2026-11-14",
          amountCents: -1234,
          currency: "EUR",
          counterparty: "Neuer Laden",
          counterpartyIban: null,
          purpose: "x",
        },
      ],
      "test",
    );
    await reclassifyAll(db());
    const booking = ids[0] ?? -1;
    await patchTransaction(db(), admin, { id: booking, manualTagIds: [holiday?.id ?? -1] });

    mockFetch(answerTags({ "Neuer Laden": ["Sonstiges", ["Einmalig"]] }));
    expect(await categorizeNewBookings(db(), ids)).toMatchObject({ tagsCreated: 1 });
    const first = await tagsOfPayee("Neuer Laden");
    expect(first.map((t) => [t.tag, t.source]).sort()).toEqual([
      ["Einmalig", "ai"],
      ["Urlaub", "manual"],
    ]);
    const [stored] = await db().select().from(transactions).where(eq(transactions.id, booking));
    expect(stored).toMatchObject({ manualTagIds: [holiday?.id], aiTagIds: [await tagId("Einmalig")] });

    mockFetch(answerTags({ "Neuer Laden": ["Sonstiges", ["Testkauf", "Urlaub"]] }));
    await recategorize(db(), admin, {});
    const second = await tagsOfPayee("Neuer Laden");
    expect(second.map((t) => [t.tag, t.source]).sort()).toEqual([
      ["Testkauf", "ai"],
      ["Urlaub", "manual"],
    ]);
    const aiRule = (await db().select().from(rules).where(eq(rules.source, "ai"))).find((r) => r.pattern === "Neuer Laden");
    const ruleTagIds = (
      await db()
        .select()
        .from(ruleTags)
        .where(eq(ruleTags.ruleId, aiRule?.id ?? -1))
    ).map((l) => l.tagId);
    expect(ruleTagIds.sort()).toEqual([holiday?.id, await tagId("Testkauf")].sort());

    // A person's edit takes over: the tags they keep become manual, the AI's own list is cleared.
    await patchTransaction(db(), admin, { id: booking, manualTagIds: [await tagId("Testkauf")] });
    const [edited] = await db().select().from(transactions).where(eq(transactions.id, booking));
    expect(edited).toMatchObject({ manualTagIds: [await tagId("Testkauf")], aiTagIds: [] });
  });

  it("suggests tags for one booking, new ones only to those who may create tags, and creates kept ones on request", async () => {
    await readyProvider(admin);
    await db().insert(tags).values({ name: "Fixkosten", color: "#123456" });
    const [own] = await db().select().from(transactions).where(eq(transactions.counterparty, "Vodafone GmbH"));
    const answer = () => reply(JSON.stringify({ kategorie: "Sonstiges", begruendung: "Internet.", tags: ["fixkosten", "Internet"] }));

    let calls = mockFetch(answer);
    expect(await suggestCategory(db(), admin, { id: own?.id ?? -1 })).toMatchObject({ tags: [], newTags: [] });
    expect(calls[0]?.body.messages[1]?.content).not.toContain("Fixkosten");

    await saveAiSettings(db(), admin, { assignTags: true, createTags: true });
    calls = mockFetch(answer);
    const forMember = await suggestCategory(db(), member, { id: own?.id ?? -1 });
    expect(forMember).toMatchObject({ tags: [{ id: await tagId("Fixkosten"), name: "Fixkosten" }], newTags: [] });
    expect(calls[0]?.body.messages[0]?.content).toContain("Erfinde keine neuen Tags");
    expect(calls[0]?.body.messages[1]?.content).toContain("- Fixkosten");
    expect(calls).toHaveLength(1);

    mockFetch(answer);
    const forAdmin = await suggestCategory(db(), admin, { id: own?.id ?? -1 });
    expect(forAdmin.newTags).toEqual(["Internet"]);
    // Suggesting stores nothing.
    expect(await db().select().from(tags)).toHaveLength(1);

    await expect(createSuggestedTags(db(), member, { names: ["Internet"] })).rejects.toMatchObject({ status: 403 });
    const ids = await createSuggestedTags(db(), admin, { names: ["Internet", "fixkosten"] });
    expect(ids).toEqual([await tagId("Fixkosten"), await tagId("Internet")].sort((a, b) => a - b));
    expect((await db().select().from(tags).where(eq(tags.name, "Internet")))[0]?.createdBy).toBe("ai");

    await saveAiSettings(db(), admin, { createTags: false });
    await expect(createSuggestedTags(db(), admin, { names: ["Neu"] })).rejects.toMatchObject({ status: 403 });
  });
});
