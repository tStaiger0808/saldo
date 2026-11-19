import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BookingFilter, bookingFilterQuery, listFilters, parseBookingFilterQuery, serverSort } from "../../../lib/booking-filter.ts";
import { db } from "../../db/index.ts";
import {
  accountGroups,
  accounts,
  aiProviders,
  aiUsage,
  auditEvents,
  categories,
  chatConversations,
  chatMessages,
  user,
} from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { tick } from "../scheduler/index.ts";
import { createDemoData } from "../seed/demo.ts";
import { listTransactions } from "../transactions/index.ts";
import { HISTORY_BUDGET, TURN_LIMIT, titleOf } from "./history.ts";
import {
  chat,
  createProvider,
  deleteAllConversations,
  deleteConversation,
  getChatRetention,
  getConversation,
  listConversations,
  pruneChatHistory,
  renameConversation,
  resetContextWindowsForTests,
  setChatRetention,
  updateProvider,
} from "./index.ts";

type Body = { messages: { role: string; content: string | null; tool_call_id?: string }[]; tools?: unknown[] };
type Call = { body: Body };

function mockFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const call: Call = { body: init?.body ? JSON.parse(String(init.body)) : { messages: [] } };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return calls;
}

const reply = (content: string) =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const toolReply = (name: string, args: object) =>
  Response.json({
    choices: [
      { message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  });
/** The first request of a question calls `name`, the request with the tool result gets a text answer. */
const withTool =
  (name: string, args: object, text = "Erledigt") =>
  (call: Call) =>
    call.body.messages.at(-1)?.role === "tool" ? reply(text) : toolReply(name, args);
const toolResult = (call: Call | undefined) => call?.body.messages.find((m) => m.role === "tool")?.content ?? "";

const OPENAI = { name: "OpenAI", kind: "openai" as const, apiKey: "sk-test" };

async function setup() {
  await resetDb();
  const admin = await makeUser("admin", "superuser");
  await createDemoData(db(), new Date("2026-11-15T12:00:00Z"));
  const groups = await db().select().from(accountGroups);
  const mine = groups.find((g) => g.name === "Meine Konten")?.id ?? -1;
  const shared = groups.find((g) => g.name === "Gemeinschaftskonto")?.id ?? -1;
  const member = await makeUser("partnerin", "member", [shared], { aiAllowed: true });
  mockFetch(() => Response.json({ data: [{ id: "chat-small" }] }));
  const created = (await createProvider(db(), admin, OPENAI)).provider;
  await updateProvider(db(), admin, created.id, { ...OPENAI, apiKey: null, model: "chat-small" });
  vi.restoreAllMocks();
  return { admin, member, mine, shared };
}

const viewingAs = (viewer: Viewer): Viewer => ({
  ...viewer,
  impersonation: { actorId: "x", actorName: "admin", expiresAt: new Date(Date.now() + 60_000).toISOString() },
});

describe("AI chat history", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  let shared: number;
  beforeEach(async () => ({ admin, member, mine, shared } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("saves each question with its answer, titled after the first question, private to its owner", async () => {
    mockFetch(() => reply("Die **Miete**."));
    const first = await chat(db(), member, { question: "  Was war die größte\nAusgabe im Oktober?  " });
    expect(first.conversation).toEqual({ id: expect.any(Number), title: "Was war die größte Ausgabe im Oktober?" });
    const id = first.conversation?.id ?? -1;
    await chat(db(), member, { conversationId: id, question: "Und im September?" });

    expect(await listConversations(db(), member)).toEqual([
      expect.objectContaining({ id, title: "Was war die größte Ausgabe im Oktober?" }),
    ]);
    const opened = await getConversation(db(), member, { id });
    expect(opened.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Was war die größte\nAusgabe im Oktober?"],
      ["assistant", "Die **Miete**."],
      ["user", "Und im September?"],
      ["assistant", "Die **Miete**."],
    ]);
    expect(opened.messages[1]?.usage).toMatchObject({ providerName: "OpenAI", model: "chat-small", mode: "tools", calls: 1 });

    // Superusers see every account, but never someone else's chats.
    expect(await listConversations(db(), admin)).toEqual([]);
    await expect(getConversation(db(), admin, { id })).rejects.toMatchObject({ status: 404 });
    await expect(renameConversation(db(), admin, { id, title: "Meins" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteConversation(db(), admin, { id })).rejects.toMatchObject({ status: 404 });
    await expect(chat(db(), admin, { conversationId: id, question: "Weiter?" })).rejects.toMatchObject({ status: 404 });
    expect(await deleteAllConversations(db(), admin)).toBe(0);
    expect(await db().select().from(chatConversations)).toHaveLength(1);

    expect(await renameConversation(db(), member, { id, title: " Oktober " })).toMatchObject({ title: "Oktober" });
    await expect(renameConversation(db(), member, { id, title: " " })).rejects.toThrow(/ai.history.errors.titleRequired/);
    expect(titleOf("x".repeat(100))).toHaveLength(80);

    await deleteConversation(db(), member, { id });
    expect(await db().select().from(chatMessages)).toEqual([]);
    for (const question of ["Eins?", "Zwei?"]) {
      mockFetch(() => reply("Ja."));
      await chat(db(), member, { question });
    }
    expect(await deleteAllConversations(db(), member)).toBe(2);
    expect(await listConversations(db(), member)).toEqual([]);

    const events = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.chatDeleted")).orderBy(auditEvents.id);
    expect(events.map((e) => e.details)).toEqual([{ conversations: 1 }, { conversations: 2 }]);
    expect(JSON.stringify(await db().select().from(auditEvents))).not.toMatch(/Oktober|Eins|Miete/);
  });

  it("keeps the tokens of every round and the context window with the answer, and reopening only reads them", async () => {
    resetContextWindowsForTests();
    const [provider] = await db().select().from(aiProviders);
    mockFetch(() => Response.json({ data: [{ id: "chat-small", context_length: 128_000 }] }));
    await updateProvider(db(), admin, provider?.id ?? -1, { ...OPENAI, apiKey: null, model: "chat-small" });
    const used = (prompt: number, completion: number) => ({ usage: { prompt_tokens: prompt, completion_tokens: completion } });
    mockFetch((call) =>
      call.body.messages.at(-1)?.role === "tool"
        ? Response.json({ choices: [{ message: { content: "Die Miete." } }], ...used(1_500, 80) })
        : Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "c1", type: "function", function: { name: "summary", arguments: "{}" } }],
                },
              },
            ],
            ...used(1_000, 20),
          }),
    );
    const answer = await chat(db(), member, { question: "Was war die größte Ausgabe?" });
    const expected = {
      providerName: "OpenAI",
      model: "chat-small",
      mode: "tools",
      inputTokens: 2_500,
      outputTokens: 100,
      calls: 2,
      maxInputTokens: 1_500,
      reported: true,
      contextWindow: { tokens: 128_000, estimated: false },
    };
    expect(answer.tokens).toEqual(expected);

    const before = {
      conversations: await db().select().from(chatConversations),
      messages: await db().select().from(chatMessages),
      usage: await db().select().from(aiUsage),
      audit: await db().select().from(auditEvents),
    };
    const opened = await getConversation(db(), member, { id: answer.conversation?.id ?? -1 });
    expect(opened.messages.map((m) => m.usage)).toEqual([null, expected]);
    expect({
      conversations: await db().select().from(chatConversations),
      messages: await db().select().from(chatMessages),
      usage: await db().select().from(aiUsage),
      audit: await db().select().from(auditEvents),
    }).toEqual(before);
    expect(before.usage.map((u) => [u.purpose, u.inputTokens, u.outputTokens])).toEqual([
      ["chat", 1_000, 20],
      ["chat", 1_500, 80],
    ]);
    resetContextWindowsForTests();
  });

  it("sends the earlier turns of a continued chat, newest first within the budget", async () => {
    mockFetch(() => reply("Erste Antwort"));
    const { conversation } = await chat(db(), member, { question: "Erste Frage" });
    const id = conversation?.id ?? -1;
    const calls = mockFetch(() => reply("Zweite Antwort"));
    await chat(db(), member, { conversationId: id, question: "Zweite Frage" });
    expect(calls[0]?.body.messages.map((m) => [m.role, m.content])).toEqual([
      ["system", expect.any(String)],
      ["user", "Erste Frage"],
      ["assistant", "Erste Antwort"],
      ["user", "Zweite Frage"],
    ]);

    const long = "x".repeat(TURN_LIMIT * 2);
    for (let i = 0; i < 8; i++) {
      await db()
        .insert(chatMessages)
        .values([
          { conversationId: id, role: "user", content: `Frage ${i}` },
          { conversationId: id, role: "assistant", content: long },
        ]);
    }
    const capped = mockFetch(() => reply("Dritte Antwort"));
    await chat(db(), member, { conversationId: id, question: "Dritte Frage" });
    const sent = capped[0]?.body.messages.slice(1, -1) ?? [];
    expect(sent[0]?.role).toBe("user");
    expect(sent.at(-1)?.content).toBe(`${"x".repeat(TURN_LIMIT)} […]`);
    expect(sent.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)).toBeLessThanOrEqual(HISTORY_BUDGET);
    expect(sent.some((m) => m.content === "Erste Frage")).toBe(false);

    const events = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.chat")).orderBy(auditEvents.id);
    expect(events.map((e) => e.details.history)).toEqual([undefined, 2, sent.length]);
  });

  it("saves, lists and reads nothing while a superuser views Saldo as the owner", async () => {
    mockFetch(() => reply("Antwort"));
    const own = await chat(db(), member, { question: "Meine Frage" });
    const id = own.conversation?.id ?? -1;
    const viewed = viewingAs(member);

    const calls = mockFetch(() => reply("Antwort beim Ansehen"));
    const answer = await chat(db(), viewed, { question: "Frage beim Ansehen" });
    expect(answer).toMatchObject({ reply: "Antwort beim Ansehen", conversation: null });
    expect(calls[0]?.body.messages.map((m) => m.content)).not.toContain("Meine Frage");
    expect(await listConversations(db(), viewed)).toEqual([]);
    await expect(getConversation(db(), viewed, { id })).rejects.toMatchObject({ status: 404 });
    await expect(chat(db(), viewed, { conversationId: id, question: "Weiter?" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteConversation(db(), viewed, { id })).rejects.toMatchObject({ status: 404 });
    expect(await deleteAllConversations(db(), viewed)).toBe(0);

    expect(await db().select().from(chatConversations)).toHaveLength(1);
    expect((await db().select().from(chatMessages)).map((m) => m.content)).toEqual(["Meine Frage", "Antwort"]);
  });

  it("deletes chats once their owner's retention has passed, in the daily run", async () => {
    expect(await getChatRetention(db(), member)).toEqual({ days: 90 });
    await setChatRetention(db(), member, { days: 30 });
    await setChatRetention(db(), admin, { days: null });
    await expect(setChatRetention(db(), member, { days: 7 as 30 })).rejects.toThrow();
    expect(await getChatRetention(db(), admin)).toEqual({ days: null });

    const now = new Date(2026, 10, 17, 8, 0);
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const add = (owner: Viewer, title: string, updatedAt: Date) =>
      db().insert(chatConversations).values({ userId: owner.id, title, updatedAt }).returning();
    await add(member, "alt", daysAgo(31));
    await add(member, "frisch", daysAgo(29));
    await add(admin, "uralt", daysAgo(4000));
    const [kept] = await add(member, "weitergeführt", daysAgo(40));
    await db()
      .update(chatConversations)
      .set({ updatedAt: daysAgo(1) })
      .where(eq(chatConversations.id, kept?.id ?? -1));

    await tick(db(), now);
    expect((await db().select().from(chatConversations)).map((c) => c.title).sort()).toEqual(["frisch", "uralt", "weitergeführt"]);
    const [event] = await db().select().from(auditEvents).where(eq(auditEvents.action, "ai.chatPruned"));
    expect(event).toMatchObject({ userId: null, details: { conversations: 1 } });

    await db().update(user).set({ chatRetentionDays: 90 }).where(eq(user.id, admin.id));
    expect(await pruneChatHistory(db(), now)).toBe(1);
  });
});

describe("show_bookings", () => {
  let admin: Viewer;
  let member: Viewer;
  let mine: number;
  let shared: number;
  beforeEach(async () => ({ admin, member, mine, shared } = await setup()));
  afterEach(() => vi.restoreAllMocks());

  it("is offered to the chat only and checks the filter against what the viewer sees", async () => {
    const [dkb] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    const cases: [object, RegExp][] = [
      [{ groupId: mine }, /group not found/i],
      [{ accountId: dkb?.id }, /account not found/i],
      [{ categoryId: 99_999 }, /unknown category/i],
      [{ tagId: 99_999 }, /unknown tag/i],
      [{ dateFrom: "2026-10-31", dateTo: "2026-10-01" }, /dateFrom is after dateTo/],
      [{ amountMinCents: 500, amountMaxCents: 100 }, /amountMinCents/],
      [{ direction: "sideways" }, /Invalid arguments/],
    ];
    for (const [args, error] of cases) {
      const calls = mockFetch(withTool("show_bookings", args));
      const answer = await chat(db(), member, { question: "Zeig mir das" });
      expect(toolResult(calls[1]), JSON.stringify(args)).toMatch(error);
      expect(answer.bookings).toBeNull();
      const tools = (calls[0]?.body.tools ?? []) as { function: { name: string; parameters: { properties: object } } }[];
      const spec = tools.find((t) => t.function.name === "show_bookings");
      expect(Object.keys(spec?.function.parameters.properties ?? {})).toEqual(expect.arrayContaining(["period", "amountMinCents", "sort"]));
    }
  });

  it("returns the normalized filter with the totals of the bookings page and saves it as the chat's list", async () => {
    const [food] = await db().select().from(categories).where(eq(categories.name, "Lebensmittel"));
    const args = {
      categoryId: food?.id,
      direction: "out",
      period: "last_12_months",
      dateFrom: "2020-01-01",
      unread: false,
      amountMinCents: 1_000,
      sort: "betrag-auf",
    };
    const calls = mockFetch(withTool("show_bookings", args, "41 Buchungen, zusammen 1.234 €."));
    const answer = await chat(db(), member, { question: "Zeig mir die Lebensmittel über 10 €" });

    const filter: BookingFilter = { categoryId: food?.id, direction: "out", period: "last_12_months", amountMinCents: 1_000 };
    const page = await listTransactions(db(), member, { ...listFilters(filter), sort: serverSort("betrag-auf"), limit: 1 });
    const totals = {
      count: page.totals.count,
      incomeCents: page.totals.incomeCents,
      expenseCents: page.totals.expenseCents,
      sumCents: page.totals.sumCents,
    };
    expect(totals.count).toBeGreaterThan(0);
    expect(totals.incomeCents).toBe(0);
    expect(answer.bookings).toEqual({ filter, sort: "betrag-auf", totals });
    expect(JSON.parse(toolResult(calls[1]))).toEqual({ shown: true, filter, sort: "betrag-auf", totals });
    expect(toolResult(calls[1])).not.toMatch(/"items"|counterparty|purpose/);
    expect(answer.lookups).toEqual([expect.objectContaining({ tool: "show_bookings", count: totals.count, bookings: answer.bookings })]);
    expect(parseBookingFilterQuery(bookingFilterQuery(filter))).toEqual(filter);

    const [saved] = await db().select().from(chatConversations);
    expect(saved?.lastViewFilter).toEqual({ filter, sort: "betrag-auf" });
    const opened = await getConversation(db(), member, { id: saved?.id ?? -1 });
    expect(opened.messages[1]?.lookups[0]?.bookings).toEqual(answer.bookings);

    // Admins see the private accounts as well, so the same filter sums more.
    mockFetch(withTool("show_bookings", { groupId: mine }));
    expect((await chat(db(), admin, { question: "Meine Konten" })).bookings?.filter).toEqual({ groupId: mine });
    mockFetch(withTool("show_bookings", {}));
    expect((await chat(db(), member, { groupId: shared, question: "Alles" })).bookings?.filter).toEqual({ groupId: shared });
  });

  it("sends the list on screen as context, and the chat's last list when continued elsewhere", async () => {
    const [food] = await db().select().from(categories).where(eq(categories.name, "Lebensmittel"));
    const onScreen = { filter: { categoryId: food?.id ?? -1, period: "last_month" as const }, sort: "betrag-auf" as const };
    const calls = mockFetch(withTool("show_bookings", { ...onScreen.filter, amountMinCents: 5_000, sort: "betrag-auf" }));
    const first = await chat(db(), member, { question: "Davon nur über 50 €", view: onScreen });
    const context = calls[0]?.body.messages.at(-2)?.content ?? "";
    expect(context).toContain("<buchungsliste>");
    expect(JSON.parse(context.split("<buchungsliste>\n")[1]?.split("\n</buchungsliste>")[0] ?? "{}")).toEqual({
      ...onScreen,
      names: { category: "Lebensmittel" },
    });
    expect(calls[0]?.body.messages.at(-1)).toEqual({ role: "user", content: "Davon nur über 50 €" });
    expect(calls[0]?.body.messages[0]?.content).toContain("show_bookings");
    const refined = { filter: { ...onScreen.filter, amountMinCents: 5_000 }, sort: "betrag-auf" };
    expect(first.bookings).toMatchObject(refined);

    // Asked again from another page: the list the chat showed last is the context.
    const next = mockFetch(() => reply("Im September waren es weniger."));
    await chat(db(), member, { conversationId: first.conversation?.id, question: "Und im September?" });
    expect(next[0]?.body.messages.find((m) => m.content?.includes("<buchungsliste>"))?.content).toContain('"amountMinCents":5000');
    const [stored] = await db().select().from(chatConversations);
    expect(stored?.lastViewFilter).toEqual(refined);

    // A question without a list on screen sends none.
    const plain = mockFetch(() => reply("Hallo"));
    await chat(db(), member, { question: "Hallo?" });
    expect(JSON.stringify(plain[0]?.body.messages)).not.toContain("<buchungsliste>");
  });
});
