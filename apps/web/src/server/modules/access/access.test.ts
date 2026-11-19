import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../crypto.ts";
import { db } from "../../db/index.ts";
import { accounts, bankConnections, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import {
  accountBookings,
  accountDetail,
  accountsOverview,
  createAccount,
  createGroup,
  listAccounts,
  listGroups,
  setAccountSharing,
  updateGroup,
} from "../accounts/index.ts";
import { chat, createProvider, runAnalysis, suggestCategory, updateProvider } from "../ai/index.ts";
import { connectionLogo, resetJobsForTests } from "../banking/index.ts";
import { startJob } from "../banking/jobs.ts";
import { createToken, handleMcpRequest } from "../mcp/index.ts";
import { listNotifications, notifyAfterSync, savePreferences } from "../notifications/index.ts";
import { balances, categoryTotals, summary } from "../stats/index.ts";
import { listTasks, resetTasksForTests } from "../tasks/index.ts";
import { exportCsv, importBookings, listTransactions } from "../transactions/index.ts";
import { checkAccounts, resolveView, type Viewer, visibleAccountIds } from "./index.ts";

const RANGE = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };
const color = "#1f6f5c";

/**
 * One household with every kind of account; the matrix checks each path data can leave through. Every account has
 * one booking whose payee names it and whose amount identifies it.
 */
type Key = "household" | "loose" | "m1Private" | "m2Private" | "direct" | "viaGroup";
const AMOUNTS: Record<Key, number> = {
  household: -1_111,
  loose: -2_222,
  m1Private: -3_333,
  m2Private: -4_444,
  direct: -5_555,
  viaGroup: -6_666,
};
const KEYS = Object.keys(AMOUNTS) as Key[];
const payee = (key: Key) => `PAYEE-${key}`;
/** The amount as the AI prompts write it (euros as a JSON number). */
const promptAmount = (key: Key) => String(-AMOUNTS[key] / 100);

type Role = "su" | "fa" | "m1" | "m2" | "m3";
type World = Record<Role, Viewer> & {
  ids: Record<Key, number>;
  txns: Record<Key, number>;
  familie: number;
  kinder: number;
  /** A FinTS connection of m2 linked to m2's private account (no logo source, so no network). */
  m2Connection: number;
};

async function world(): Promise<World> {
  await resetDb();
  const su = await makeUser("chef", "superuser");
  const fa = await makeUser("mama", "familyAdmin");
  const familie = await createGroup(db(), su, { name: "Familie" });
  const kinder = await createGroup(db(), su, { name: "Kinder" });
  const m1 = await makeUser("lena", "member", [familie], { aiAllowed: true });
  const m2 = await makeUser("max", "member", [kinder]);
  const m3 = await makeUser("oma", "member");
  const account = (viewer: Viewer, name: string, groupIds: number[] = []) =>
    createAccount(db(), viewer, { name, bank: "bank", kind: "checking", color, groupIds });
  const ids: Record<Key, number> = {
    household: await account(su, "Haushalt", [familie]),
    loose: await account(su, "Haushalt ohne Gruppe"),
    m1Private: await account(m1, "Lenas Konto"),
    m2Private: await account(m2, "Max Konto"),
    direct: await account(m2, "Max an Lena"),
    viaGroup: await account(m3, "Oma an Familie"),
  };
  await setAccountSharing(db(), m2, { accountId: ids.direct, userIds: [m1.id] });
  // Oma has no group herself; a superuser shares her account into the family group for her.
  await setAccountSharing(db(), su, { accountId: ids.viaGroup, groupIds: [familie] });
  const txns = {} as Record<Key, number>;
  for (const key of KEYS) {
    const booking = {
      bookingDate: "2026-06-10",
      amountCents: AMOUNTS[key],
      currency: "EUR",
      counterparty: payee(key),
      counterpartyIban: null,
      purpose: "",
    };
    txns[key] = (await importBookings(db(), ids[key], [booking], "test", "2026-06-10")).ids[0] ?? -1;
    await db().update(accounts).set({ balanceCents: 100, balanceDate: "2026-06-10" }).where(eq(accounts.id, ids[key]));
  }
  const [connection] = await db()
    .insert(bankConnections)
    .values({
      name: "Max Bank",
      provider: "fints",
      bank: "bank",
      status: "active",
      ciphertext: encrypt("{}"),
      ownerUserId: m2.id,
      visibility: "private",
    })
    .returning({ id: bankConnections.id });
  const m2Connection = connection?.id ?? -1;
  await db().update(accounts).set({ connectionId: m2Connection }).where(eq(accounts.id, ids.m2Private));
  return { su, fa, m1, m2, m3, ids, txns, familie, kinder, m2Connection };
}

/** Superusers see all, family admins the household and group shares, members their own, shares and their groups. */
const EXPECTED: Record<Role, Key[]> = {
  su: ["household", "loose", "m1Private", "m2Private", "direct", "viaGroup"],
  fa: ["household", "loose", "viaGroup"],
  m1: ["household", "m1Private", "direct", "viaGroup"],
  m2: ["m2Private", "direct"],
  m3: ["viaGroup"],
};
const ROLES = Object.keys(EXPECTED) as Role[];
const hidden = (role: Role) => KEYS.filter((k) => !EXPECTED[role].includes(k));
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("access matrix", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => {
    resetJobsForTests();
    resetTasksForTests();
    vi.restoreAllMocks();
  });

  it.each(ROLES)("%s: account list, overview, groups and balances hold exactly the visible accounts", async (role) => {
    const viewer = w[role];
    const want = sorted(EXPECTED[role].map((k) => w.ids[k]));
    expect(await visibleAccountIds(db(), viewer)).toEqual(want);
    expect(sorted((await listAccounts(db(), viewer)).map((a) => a.id))).toEqual(want);
    const overview = await accountsOverview(db(), viewer, null);
    expect(sorted(overview.accounts.map((a) => a.id))).toEqual(want);
    expect(overview.totalCents).toBe(want.length * 100);
    for (const g of await listGroups(db(), viewer)) for (const id of g.accountIds) expect(want).toContain(id);
    expect(sorted((await balances(db(), viewer, null)).accounts.map((a) => a.accountId))).toEqual(want);
  });

  it.each(ROLES)("%s: detail, bookings, stats and CSV export answer for visible accounts, 404 for the others", async (role) => {
    const viewer = w[role];
    for (const key of EXPECTED[role]) {
      const id = w.ids[key];
      await expect(accountDetail(db(), viewer, { accountId: id, ...RANGE })).resolves.toMatchObject({ account: { id } });
      expect((await accountBookings(db(), viewer, { accountId: id })).total).toBe(1);
    }
    for (const key of hidden(role)) {
      const id = w.ids[key];
      await expect(accountDetail(db(), viewer, { accountId: id, ...RANGE })).rejects.toMatchObject({ status: 404 });
      await expect(accountBookings(db(), viewer, { accountId: id })).rejects.toMatchObject({ status: 404 });
      await expect(summary(db(), viewer, { ...RANGE, accountIds: [id] })).rejects.toMatchObject({ status: 404 });
      await expect(listTransactions(db(), viewer, { accountId: id })).rejects.toMatchObject({ status: 404 });
      await expect(exportCsv(db(), viewer, { accountId: id })).rejects.toMatchObject({ status: 404 });
    }
    expect((await summary(db(), viewer, RANGE)).expensesCents).toBe(EXPECTED[role].reduce((sum, k) => sum - AMOUNTS[k], 0));
    const categories = JSON.stringify(await categoryTotals(db(), viewer, RANGE, "expense"));
    const csv = await exportCsv(db(), viewer, {});
    const list = JSON.stringify(await listTransactions(db(), viewer, { limit: 100 }));
    for (const key of hidden(role)) for (const text of [csv, list, categories]) expect(text).not.toContain(payee(key));
    for (const key of EXPECTED[role]) expect(csv).toContain(payee(key));
  });

  it("MCP tools answer with the token owner's visibility", async () => {
    const { token } = await createToken(db(), w.m1, { name: "Claude" });
    const call = async (name: string, args: object = {}) => {
      const request = new Request("https://saldo.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await (await handleMcpRequest(db(), request, "10.1.0.1")).json()) as { result: { content: { text: string }[] } };
      return body.result.content[0]?.text ?? "";
    };
    const accountList = await call("list_accounts");
    const search = await call("search_transactions", { query: "PAYEE", limit: 200 });
    const top = await call("top_counterparties", RANGE);
    for (const key of hidden("m1")) for (const text of [search, top]) expect(text).not.toContain(payee(key));
    for (const key of EXPECTED.m1) expect(search).toContain(payee(key));
    expect(accountList).not.toContain("Max Konto");
    expect(accountList).toContain("Max an Lena");
  });

  it("the AI only ever receives what the requesting user sees, also through its chat tools", async () => {
    const bodies: string[] = [];
    const toolCall = (id: string, name: string, args: object) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    let chatCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      if (!body.includes('"tools"')) return Response.json({ data: [{ id: "chat-small" }], choices: [{ message: { content: "Antwort" } }] });
      chatCalls += 1;
      if (chatCalls > 1) return Response.json({ choices: [{ message: { content: "Antwort" } }] });
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                toolCall("a", "search_transactions", { query: "PAYEE", limit: 200 }),
                toolCall("b", "top_counterparties", RANGE),
                toolCall("c", "list_accounts", {}),
                toolCall("d", "search_transactions", { accountId: w.ids.m2Private }),
                toolCall("e", "list_groups", {}),
              ],
            },
          },
        ],
      });
    });
    const created = (await createProvider(db(), w.su, { name: "OpenAI", kind: "openai", apiKey: "sk-test" })).provider;
    await updateProvider(db(), w.su, created.id, { name: "OpenAI", kind: "openai", apiKey: null, model: "chat-small" });
    bodies.length = 0;
    const answer = await chat(db(), w.m1, { question: "Was ist offen?" });
    expect(answer.lookups.map((l) => l.tool)).toEqual(["search_transactions", "top_counterparties", "list_accounts"]);
    const results = (
      JSON.parse(bodies[1] ?? "{}") as { messages: { role: string; tool_call_id?: string; content: string }[] }
    ).messages.filter((m) => m.role === "tool");
    expect(results.find((m) => m.tool_call_id === "d")?.content).toBe("Account not found");
    expect(results.find((m) => m.tool_call_id === "e")?.content).toBe("Unknown tool: list_groups");
    await runAnalysis(db(), w.m1, RANGE);
    const sent = bodies.join("\n");
    for (const key of hidden("m1")) {
      expect(sent).not.toContain(payee(key));
      expect(sent).not.toContain(promptAmount(key));
      expect(sent).not.toContain(String(AMOUNTS[key]));
    }
    expect(sent).not.toContain("Max Konto");
    for (const key of EXPECTED.m1) expect(sent).toContain(payee(key));
    await expect(suggestCategory(db(), w.m1, { id: w.txns.m2Private })).rejects.toMatchObject({ status: 404 });
  });

  it("notifications only reach people who can see the account", async () => {
    for (const role of ROLES) {
      await savePreferences(db(), w[role], {
        preferences: [
          { kind: "large_expense", enabled: true, push: false, email: false, threshold: 100 },
          { kind: "low_balance", enabled: true, push: false, email: false, threshold: 1_000 },
        ],
      });
    }
    await notifyAfterSync(db(), { jobId: "job-1", transactionIds: Object.values(w.txns) });
    const names = new Map((await db().select().from(accounts)).map((a) => [a.id, a.name]));
    for (const role of ROLES) {
      const text = JSON.stringify((await listNotifications(db(), w[role], { limit: 100 })).items);
      for (const key of hidden(role)) {
        expect(text).not.toContain(payee(key));
        expect(text).not.toContain(names.get(w.ids[key]));
      }
      for (const key of EXPECTED[role]) {
        expect(text).toContain(payee(key));
        expect(text).toContain(names.get(w.ids[key]));
      }
    }
  });

  it("bank logos and bank tasks stay with those who see the connection", async () => {
    await expect(connectionLogo(db(), w.m1, { id: w.m2Connection })).rejects.toMatchObject({ status: 404 });
    await expect(connectionLogo(db(), w.fa, { id: w.m2Connection })).rejects.toMatchObject({ status: 404 });
    expect(await connectionLogo(db(), w.m2, { id: w.m2Connection })).toBeNull();
    expect(await connectionLogo(db(), w.su, { id: w.m2Connection })).toBeNull();

    startJob(w.m2Connection, "sync", { name: "Max Bank", startedBy: null }, async () => undefined, true);
    const tasks = async (viewer: Viewer) => (await listTasks(db(), viewer)).length;
    expect([await tasks(w.m2), await tasks(w.su), await tasks(w.m1), await tasks(w.fa)]).toEqual([1, 1, 0, 0]);
  });

  it("transfers to an account the viewer cannot see stay anonymous", async () => {
    await db()
      .update(transactions)
      .set({ isTransfer: true, transferAccountId: w.ids.m2Private })
      .where(eq(transactions.id, w.txns.household));
    const [row] = (await listTransactions(db(), w.m1, { accountId: w.ids.household })).items;
    expect(row?.transferAccountId).toBeNull();
    expect(row?.transferLabel).not.toContain("Max Konto");
    expect(JSON.stringify(await categoryTotals(db(), w.m1, RANGE, "expense"))).not.toContain("Max Konto");
    // Seen from a group without the target, the superuser still learns its name.
    const [seen] = (await listTransactions(db(), w.su, { groupId: w.familie, accountId: w.ids.household })).items;
    expect(seen?.transferLabel).toContain("Max Konto");
  });

  it("rejects groups and accounts outside the viewer's access with 404", async () => {
    await expect(resolveView(db(), w.m1, w.kinder)).rejects.toMatchObject({ status: 404 });
    const view = await resolveView(db(), w.m1, w.familie);
    expect(sorted(view.accountIds)).toEqual(sorted([w.ids.household, w.ids.viaGroup]));
    expect(() => checkAccounts(view, [w.ids.m2Private])).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("group edits by a family admin keep shares they cannot see or decide about", async () => {
    await setAccountSharing(db(), w.m1, { accountId: w.ids.m1Private, groupIds: [w.familie] });
    await updateGroup(db(), w.fa, w.familie, { name: "Familie", accountIds: [w.ids.household, w.ids.loose] });
    const familie = (await listGroups(db(), w.su)).find((g) => g.id === w.familie);
    expect(sorted(familie?.accountIds ?? [])).toEqual(sorted([w.ids.household, w.ids.loose, w.ids.viaGroup, w.ids.m1Private]));
    // Someone else's private account cannot be put into a group by a family admin, even when they see it.
    await expect(updateGroup(db(), w.fa, w.kinder, { name: "Kinder", accountIds: [w.ids.viaGroup] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(createGroup(db(), w.m1, { name: "Hack" })).rejects.toMatchObject({ status: 403 });
  });
});
