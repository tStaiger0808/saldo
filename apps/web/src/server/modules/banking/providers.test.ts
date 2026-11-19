import { generateKeyPairSync } from "node:crypto";
import { type FinTSAccess, type FinTSClientLike, GivveClient, type TanMethod } from "@saldo/banking";
import { startFakeTradeRepublic } from "@saldo/banking/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt } from "../../crypto.ts";
import { db } from "../../db/index.ts";
import { accountBalanceEntries, accountHoldings, accounts, auditEvents, bankConnections, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { accountDetail, accountsOverview, balanceTimeline } from "../accounts/index.ts";
import * as notifications from "../notifications/index.ts";
import { resetTasksForTests } from "../tasks/index.ts";
import * as banking from "./index.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "00000000-1111-4222-8333-444455556666";
const TR_IBAN = "DE11100110012620000000";
let now = new Date("2026-11-15T12:00:00Z");

/** Enable Banking with one account whose IBAN is the Trade Republic cash account. */
function fakeEnableBanking() {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = `${init.method ?? "GET"} ${new URL(String(input)).pathname}`;
    if (path === "GET /application") return json({ name: "Saldo", environment: "PRODUCTION", active: true, redirect_urls: [] });
    if (path === "GET /aspsps") return json({ aspsps: [{ name: "Trade Republic", country: "DE" }] });
    if (path === "POST /auth") return json({ url: "https://bank.example/login" });
    if (path === "POST /sessions")
      return json({
        session_id: "s",
        access: { valid_until: "2027-05-10T00:00:00Z" },
        accounts: [{ uid: "tr-1", account_id: { iban: TR_IBAN }, name: "Trade Republic" }],
      });
    if (path === "GET /accounts/tr-1/balances") return json({ balances: [{ balance_type: "CLBD", balance_amount: { amount: "100.00" } }] });
    if (path === "GET /accounts/tr-1/transactions") return json({ transactions: [] });
    return json({ message: path }, 404);
  }) as typeof fetch;
}

type BankingInformation = FinTSClientLike["config"]["bankingInformation"];
type BankAccount = NonNullable<BankingInformation["upd"]>["bankAccounts"][number];

/** ING via FinTS: Girokonto, Extra-Konto and a depot with two positions; no TAN needed. */
function fakeIng(state: { depotValue: number }) {
  const method: TanMethod = {
    id: 902,
    name: "App",
    version: 6,
    isDecoupled: true,
    activeTanMedia: [],
    activeTanMediaCount: 0,
    tanMediaRequirement: 0,
  };
  const base = { dialogId: "1", bankingInformationUpdated: false, bankAnswers: [] };
  const upd = [
    { accountNumber: "1", iban: "DE02500105170137075030", currency: "EUR", product: "Girokonto", accountType: "CheckingAccount" },
    { accountNumber: "2", iban: "DE02500105170648489890", currency: "EUR", product: "Extra-Konto", accountType: "SavingsAccount" },
    { accountNumber: "3", currency: "EUR", product: "Direkt-Depot", accountType: "SecuritiesAccount" },
  ] as unknown as BankAccount[];
  return (access: FinTSAccess): FinTSClientLike => {
    const info = (
      access.bankingInformation ? structuredClone(access.bankingInformation) : { systemId: "0", bankMessages: [] }
    ) as BankingInformation;
    let selected: TanMethod | undefined;
    const ok = { ...base, success: true, requiresTan: false };
    return {
      config: {
        bankingInformation: info,
        get availableTanMethods() {
          return [method];
        },
        get selectedTanMethod() {
          return selected;
        },
      },
      selectTanMethod() {
        selected = method;
      },
      selectTanMedia() {},
      async synchronize() {
        info.bpd = {} as BankingInformation["bpd"];
        if (selected) info.upd = { version: 1, usage: 0, bankAccounts: upd } as BankingInformation["upd"];
        return ok;
      },
      synchronizeWithTan: async () => ok,
      canGetAccountBalance: () => true,
      getAccountBalance: async () => ({ ...ok, balance: { date: new Date("2026-11-15"), currency: "EUR", balance: 10 } }),
      getAccountBalanceWithTan: async () => ok,
      canGetAccountStatements: () => true,
      getAccountStatements: async () => ({ ...ok, statements: [] }),
      getAccountStatementsWithTan: async () => ({ ...ok, statements: [] }),
      canGetPortfolio: (a) => String(a?.accountType) === "SecuritiesAccount",
      getPortfolio: async () => ({
        ...ok,
        portfolioStatement: {
          holdings: [
            {
              isin: "IE00B4L5Y983",
              name: "MSCI World",
              amount: 10,
              price: state.depotValue / 10,
              value: state.depotValue,
              currency: "EUR",
              acquisitionPrice: 100,
            },
            { isin: "DE0005190003", name: "BMW", amount: 5, price: 100, value: 500, currency: "EUR" },
          ],
        },
      }),
      getPortfolioWithTan: async () => ok,
      canGetCreditCardStatements: () => false,
      getCreditCardStatements: async () => ok,
      getCreditCardStatementsWithTan: async () => ok,
    };
  };
}

async function waitForJob(jobId: string, statuses: banking.JobStatus[], viewer: Viewer): Promise<banking.JobView> {
  for (let i = 0; i < 1000; i++) {
    const job = await banking.getJobView(db(), viewer, { jobId });
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not reach ${statuses.join("/")}`);
}

const syncsStarted = async (connectionId: number) =>
  (await db().select().from(auditEvents)).filter((e) => e.action === "bank.syncStarted" && e.targetId === String(connectionId)).length;

const linkedOf = async (connectionId: number) =>
  db().select().from(accounts).where(eq(accounts.connectionId, connectionId)).orderBy(accounts.id);

describe("bank providers side by side", () => {
  let admin: Viewer;
  let tr: ReturnType<typeof startFakeTradeRepublic>;
  const ing = { depotValue: 1500 };
  let givveCalls: string[];

  beforeEach(async () => {
    await resetDb();
    banking.resetJobsForTests();
    resetTasksForTests();
    banking.jobTiming.decoupledPollMs = 1;
    now = new Date("2026-11-15T12:00:00Z");
    ing.depotValue = 1500;
    admin = await makeUser("admin", "superuser");
    tr = startFakeTradeRepublic({ iban: TR_IBAN });
    givveCalls = [];
    banking.setBankingDepsForTests({
      fetch: fakeEnableBanking(),
      fintsClient: fakeIng(ing),
      tradeRepublic: () => tr.client(),
      givve: () => new GivveClient({ fetch: fakeGivve(givveCalls), now: () => now }),
      now: () => now,
    });
  });

  afterEach(() => {
    tr.stop();
    banking.resetJobsForTests();
    resetTasksForTests();
    banking.setBankingDepsForTests({});
  });

  async function connectFints() {
    await banking.saveFintsSettings(db(), admin, { productId: "TESTPRODUCT123" });
    const created = await banking.createConnection(db(), admin, { name: "ING", fints: { preset: "ing", login: "1", pin: "geheim" } });
    const discovered = await waitForJob(created.job?.id ?? "", ["done", "error"], admin);
    expect(discovered.status).toBe("done");
    expect(await waitForJob(discovered.next ?? "", ["done", "error"], admin)).toMatchObject({ kind: "sync", status: "done" });
    return created.connection.id;
  }

  async function connectTradeRepublic() {
    await banking.setUnofficialProvider(db(), admin, { provider: "trade_republic", enabled: true, acknowledged: true });
    const created = await banking.createConnection(db(), admin, {
      name: "Trade Republic",
      tradeRepublic: { phone: "0151 12345678", pin: "1234", acknowledged: true },
    });
    const discovered = await waitForJob(created.job?.id ?? "", ["done", "error"], admin);
    expect(discovered).toMatchObject({ status: "done", next: expect.any(String) });
    const firstSync = await waitForJob(discovered.next ?? "", ["done", "error"], admin);
    expect(firstSync).toMatchObject({ kind: "sync", status: "done" });
    expect(await syncsStarted(created.connection.id)).toBe(1);
    return { id: created.connection.id, firstSync };
  }

  async function connectEnableBanking() {
    await banking.saveEnableBankingSettings(db(), admin, { appId: APP_ID, privateKey: PEM });
    await banking.createConnection(db(), admin, { name: "TR über EB", enableBanking: { bankName: "Trade Republic", country: "DE" } });
    const [row] = await db().select().from(bankConnections);
    const state = JSON.parse(decrypt(row?.ciphertext ?? "")).pendingState as string;
    const { connection, job } = await banking.completeAuthorization(db(), admin, { code: "c", state });
    await waitForJob(job?.id ?? "", ["done", "error"], admin);
    return connection.id;
  }

  it("discovers every ING account via FinTS and stores the depot's positions, value and daily history", async () => {
    const id = await connectFints();
    const linked = await linkedOf(id);
    expect(linked.map((a) => [a.name, a.kind])).toEqual([
      ["Girokonto", "checking"],
      ["Extra-Konto", "savings"],
      ["Direkt-Depot", "brokerage"],
    ]);
    const depot = linked.find((a) => a.kind === "brokerage");
    if (!depot) throw new Error("no depot");

    const sync = async () => {
      const job = await banking.syncConnection(db(), admin, { id });
      expect(await waitForJob(job.id, ["done", "error"], admin)).toMatchObject({ status: "done" });
    };
    await sync();
    const [stored] = await db().select().from(accounts).where(eq(accounts.id, depot.id));
    expect(stored).toMatchObject({ balanceCents: 200_000, balanceDate: "2026-11-15" });
    expect(await db().select().from(accountHoldings)).toHaveLength(2);

    now = new Date("2026-11-16T12:00:00Z");
    ing.depotValue = 1600;
    await sync();
    expect(await db().select().from(accountHoldings)).toHaveLength(2);
    expect((await db().select().from(accountBalanceEntries)).map((e) => [e.date, e.balanceCents])).toEqual([
      ["2026-11-15", 200_000],
      ["2026-11-16", 210_000],
    ]);

    const overview = await accountsOverview(db(), admin, null, now);
    expect(overview.accounts.find((a) => a.id === depot.id)?.change).toEqual({ cents: 10_000, since: "2026-11-15" });
    expect(overview.accounts.find((a) => a.kind === "checking")?.change).toBeNull();
    expect(overview.totalCents).toBe(210_000 + 1000 + 1000);

    const detail = await accountDetail(db(), admin, { accountId: depot.id }, now);
    expect(detail.holdings.map((h) => [h.name, h.valueCents, h.costBasisCents])).toEqual([
      ["MSCI World", 160_000, 100_000],
      ["BMW", 50_000, null],
    ]);
    expect((await balanceTimeline(db(), admin, { accountId: depot.id }, now))?.balance.at(-1)).toEqual([1, 210_000]);
    expect(detail.balanceEntries).toEqual([]);
  });

  it("adds only the depot when the Trade Republic cash account already comes through Enable Banking", async () => {
    const ebId = await connectEnableBanking();
    const { id: trId } = await connectTradeRepublic();
    expect(tr.state.rest.slice(0, 1)).toEqual(["POST /api/v2/auth/web/login"]);

    const [view] = (await banking.listConnections(db(), admin)).filter((c) => c.id === trId);
    expect(view).toMatchObject({
      provider: "trade_republic",
      unofficial: true,
      skipSyncAll: true,
      login: "+49 ••• 678",
      target: { service: "trade_republic" },
    });
    expect(view?.remoteAccounts.find((r) => r.ref === "cash")?.coveredBy).toEqual({
      connectionId: ebId,
      name: "TR über EB",
      provider: "enable_banking",
    });
    const linked = await linkedOf(trId);
    expect(linked.map((a) => [a.remoteRef, a.kind])).toEqual([["depot", "brokerage"]]);
    expect((await linkedOf(ebId)).map((a) => a.iban)).toEqual([TR_IBAN]);
    expect(JSON.stringify(view)).not.toContain("1234");
    const [row] = await db().select().from(bankConnections).where(eq(bankConnections.id, trId));
    expect(row?.ciphertext).not.toContain("tr_session");

    const job = await banking.syncConnection(db(), admin, { id: trId });
    expect(await waitForJob(job.id, ["done", "error"], admin)).toMatchObject({ status: "done" });
    expect(tr.state.topics).not.toContain("timelineTransactions");
    expect(await db().select().from(transactions)).toEqual([]);
    const [depot] = linked;
    const [stored] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.id, depot?.id ?? -1));
    expect(stored).toMatchObject({ balanceCents: 155_250, balanceDate: "2026-11-15" });
    // The session was reused: no second login, no second approval.
    expect(tr.state.rest.filter((r) => r.startsWith("POST /api/v2/auth/web/login"))).toHaveLength(1);
    expect(tr.state.rest).toContain("GET /api/v1/auth/web/session");
  });

  it("imports Trade Republic cash bookings when no other connection covers the cash account", async () => {
    const { id, firstSync } = await connectTradeRepublic();
    const linked = await linkedOf(id);
    expect(linked.map((a) => [a.remoteRef, a.kind, a.iban])).toEqual([
      ["cash", "checking", TR_IBAN],
      ["depot", "brokerage", null],
    ]);
    // The first sync runs right after the login, with the session it made: one login, one approval.
    expect(firstSync).toMatchObject({ status: "done", newBookings: 3 });
    expect(tr.state.rest.filter((r) => r === "POST /api/v2/auth/web/login")).toHaveLength(1);
    const again = await banking.syncConnection(db(), admin, { id });
    expect(await waitForJob(again.id, ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 0 });
    const stored = await db().select().from(transactions);
    expect(stored.map((t) => t.externalId).sort()).toHaveLength(3);
    expect(stored.every((t) => t.accountId === linked[0]?.id)).toBe(true);
  });

  it("stops an unattended Trade Republic sync when the session ended, asks for a new login and notifies", async () => {
    const { id } = await connectTradeRepublic();
    await notifications.savePreferences(db(), admin, {
      preferences: [{ kind: "bank_problem", enabled: true, push: false, email: false, threshold: 14 }],
    });
    await banking.setSyncSchedule(db(), admin, { enabled: true, times: ["08:00"] });
    // Unofficial connections are fetched only manually until their owner includes them.
    expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 8, 0))).toEqual([]);
    await banking.setSkipSyncAll(db(), admin, { id, skip: false });
    tr.state.refreshValid = false;
    const [started] = await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 8, 0));
    const job = await waitForJob(started?.job?.id ?? "", ["done", "error", "cancelled"], admin);
    expect(job).toMatchObject({ status: "error", error: expect.stringContaining("Trade Republic") });
    expect(tr.state.rest.filter((r) => r === "POST /api/v2/auth/web/login")).toHaveLength(1);
    const [view] = await banking.listConnections(db(), admin);
    expect(view).toMatchObject({ status: "needs_reauth" });
    const { items } = await notifications.listNotifications(db(), admin);
    expect(items).toEqual([expect.objectContaining({ kind: "bank_problem" })]);

    // A person fetching it logs in again with the stored PIN and the approval in the app.
    tr.state.refreshValid = true;
    tr.state.pendingPolls = 1;
    const manual = await banking.syncConnection(db(), admin, { id });
    expect(await waitForJob(manual.id, ["done", "error"], admin)).toMatchObject({ status: "done" });
    expect(tr.state.rest.filter((r) => r === "POST /api/v2/auth/web/login")).toHaveLength(2);
    expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "active", lastError: "" });
  });

  it("logs in to givve with the code from the e-mail and creates a prepaid account per card", async () => {
    await banking.setUnofficialProvider(db(), admin, { provider: "givve", enabled: true, acknowledged: true });
    const created = await banking.createConnection(db(), admin, {
      name: "givve",
      givve: { email: "ich@example.org", password: "geheim", acknowledged: true },
    });
    const waiting = await waitForJob(created.job?.id ?? "", ["tan_required", "error"], admin);
    expect(waiting.tan).toMatchObject({ decoupled: false, text: expect.stringContaining("E-Mail") });
    await banking.submitTan(db(), admin, { jobId: waiting.id, tan: "123456" });
    const discovered = await waitForJob(waiting.id, ["done", "error"], admin);
    expect(discovered).toMatchObject({ status: "done" });
    const [card] = await linkedOf(created.connection.id);
    expect(card).toMatchObject({ name: "givve Card 6363", kind: "prepaid" });

    // The bookings follow right away, without asking for another code.
    expect(await waitForJob(discovered.next ?? "", ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 2 });
    expect(await syncsStarted(created.connection.id)).toBe(1);
    const job = await banking.syncConnection(db(), admin, { id: created.connection.id });
    expect(await waitForJob(job.id, ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 0 });
    const [stored] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.id, card?.id ?? -1));
    expect(stored?.balanceCents).toBe(4321);
    expect(givveCalls.filter((c) => c === "POST /authorizations")).toHaveLength(2);
  });

  describe("Konten abrufen", () => {
    it("skips connections set to manual only, keeps their own fetch and their schedule, with defaults per provider", async () => {
      const fintsId = await connectFints();
      const { id: trId } = await connectTradeRepublic();
      const views = await banking.listConnections(db(), admin);
      expect(views.find((c) => c.id === fintsId)?.skipSyncAll).toBe(false);
      expect(views.find((c) => c.id === trId)?.skipSyncAll).toBe(true);

      const all = await banking.syncAll(db(), admin);
      expect(all.map((i) => [i.connectionId, Boolean(i.job), i.skipped ?? false])).toEqual([
        [fintsId, true, false],
        [trId, false, true],
      ]);
      for (const item of all) if (item.job) await waitForJob(item.job.id, ["done", "error"], admin);

      await banking.setSkipSyncAll(db(), admin, { id: fintsId, skip: true });
      expect((await banking.syncAll(db(), admin)).every((i) => i.skipped)).toBe(true);
      const manual = await banking.syncConnection(db(), admin, { id: fintsId });
      expect(await waitForJob(manual.id, ["done", "error"], admin)).toMatchObject({ status: "done" });

      // The schedule leaves out what is fetched only manually.
      await banking.setSyncSchedule(db(), admin, { enabled: true, times: ["07:00"] });
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 0))).toEqual([]);
      await banking.setSkipSyncAll(db(), admin, { id: fintsId, skip: false });
      const scheduled = await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 1));
      expect(scheduled).toEqual([expect.objectContaining({ connectionId: fintsId, error: null })]);
      await waitForJob(scheduled[0]?.job?.id ?? "", ["done", "error"], admin);
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 2))).toEqual([]);

      const member = await makeUser("kind", "member");
      await expect(banking.setSkipSyncAll(db(), member, { id: fintsId, skip: false })).rejects.toMatchObject({ status: 404 });
    });

    it("leaves existing connections included after the migration", async () => {
      await connectEnableBanking();
      expect((await db().select().from(bankConnections)).map((c) => c.skipSyncAll)).toEqual([false]);
    });
  });
});

/** givve with one card and the e-mail one-time code step (see the client tests). */
function fakeGivve(calls: string[]): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const token = `h.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.s`;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/authorizations") {
      const body = JSON.parse(String(init.body)) as { otp?: string };
      if (!body.otp) return json({ data: { access_token: null, auth_status: "otp_required" } }, 202);
      return json({ data: { access_token: token, refresh_token: "r", auth_status: "authenticated" } });
    }
    if (path === "/voucher_owners/me/vouchers") return json({ data: [{ id: "v1", number: "521965******6363", balance: { cents: 4321 } }] });
    if (path === "/voucher_owners/me/vouchers/v1") return json({ data: { id: "v1", balance: { cents: 4321 } } });
    if (path === "/voucher_owners/me/vouchers/v1/transaction_groups")
      return json({
        data: [
          {
            id: "g1",
            first_booked_at: "2026-11-10T12:00:00+01:00",
            status: ["ok"],
            category: ["purchase"],
            amount: { cents: -5330 },
            merchant_name: "REWE",
          },
          { id: "g2", first_booked_at: "2026-11-01T08:00:00+01:00", status: ["ok"], category: ["load"], amount: { cents: 5000 } },
        ],
        links: { next: null },
      });
    return json({}, 404);
  }) as typeof fetch;
}
