import { generateKeyPairSync } from "node:crypto";
import type { FinTSAccess, FinTSClientLike, TanMethod } from "@saldo/banking";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/index.ts";
import { encrypt } from "../../crypto.ts";
import { db } from "../../db/index.ts";
import {
  accountGroupMembers,
  accounts,
  auditEvents,
  bankConnections,
  categories,
  pendingTransactions,
  settings,
  transactions,
} from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createAccount, createGroup, renameAccount } from "../accounts/index.ts";
import { createProvider, saveAiSettings, updateProvider } from "../ai/index.ts";
import * as notifications from "../notifications/index.ts";
import { listTasks, resetTasksForTests } from "../tasks/index.ts";
import * as banking from "./index.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "00000000-1111-4222-8333-444455556666";
const NOW = new Date("2026-11-15T12:00:00Z");
const IBAN = "DE02120300000000202051";

type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown };

/** A stand-in for api.enablebanking.com; nothing leaves the process. */
function fakeEnableBanking() {
  const calls: Call[] = [];
  const state = {
    active: true,
    rejectKey: false,
    sessionGone: false,
    sessions: [{ id: "sess-1", uid: "uid-1" }],
    sessionIndex: 0,
    sessionError: null as { status: number; body: unknown } | null,
    /** The consent covers no account, as with a restricted app whose control panel does not list the bank's accounts. */
    noAccounts: false,
    /** The status of the entry "p": announced first, booked later. */
    pStatus: "PDNG",
    /** Holds every bookings request until resolved, so a sync stays running. */
    gate: null as Promise<void> | null,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const txn = (ref: string, amount: string, indicator = "DBIT", day = "2026-11-10") => ({
    entry_reference: ref,
    transaction_amount: { amount, currency: "EUR" },
    credit_debit_indicator: indicator,
    status: "BOOK",
    booking_date: day,
    creditor: { name: "Gasthof Hirsch" },
    debtor: { name: "Muster GmbH" },
    remittance_information: ["Abendessen"],
  });
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (state.rejectKey) return json({ error: "UNAUTHORIZED", message: "Invalid JWT" }, 401);
    const session = state.sessions[state.sessionIndex] ?? { id: "x", uid: "x" };
    switch (`${method} ${url.pathname}`) {
      case "GET /application":
        return json({
          name: "Saldo",
          environment: "PRODUCTION",
          active: state.active,
          redirect_urls: ["https://saldo.test/bank/callback"],
        });
      case "GET /aspsps":
        return json({
          aspsps: [
            { name: "ING", country: "DE" },
            { name: "DKB", country: "DE", maximum_consent_validity: 15_552_000 },
            { name: "Ärzte- und Apothekerbank", country: "DE" },
            { name: "comdirect", country: "DE" },
            { name: "Bank 11", country: "DE" },
            { name: "Bank 2", country: "DE" },
          ],
        });
      case "POST /auth":
        return json({ url: "https://bank.example/login", authorization_id: "auth-1" });
      case "POST /sessions":
        if (state.sessionError) return json(state.sessionError.body, state.sessionError.status);
        return json({
          session_id: session.id,
          access: { valid_until: "2027-05-10T00:00:00Z" },
          accounts: state.noAccounts ? [] : [{ uid: session.uid, account_id: { iban: IBAN }, name: "Girokonto", currency: "EUR" }],
        });
      case `DELETE /sessions/${state.sessions[0]?.id}`:
        return json({});
      case `GET /accounts/${session.uid}/balances`:
        if (state.sessionGone) return json({ error: "EXPIRED_SESSION", message: "Session expired" }, 401);
        return json({
          balances: [{ balance_type: "CLBD", balance_amount: { amount: "1234.56", currency: "EUR" }, reference_date: "2026-11-14" }],
        });
      case `GET /accounts/${session.uid}/transactions`:
        await state.gate;
        if (state.sessionGone) return json({ error: "EXPIRED_SESSION", message: "Session expired" }, 401);
        return url.searchParams.get("continuation_key")
          ? json({ transactions: [txn("t3", "3520.00", "CRDT", "2026-10-28")], continuation_key: null })
          : json({
              transactions: [txn("t1", "40.00"), txn("t2", "12.50"), { ...txn("p", "1.00"), status: state.pStatus }],
              continuation_key: "k",
            });
      default:
        return json({ error: "NOT_FOUND", message: `${method} ${url.pathname}` }, 404);
    }
  }) as typeof fetch;
  return { calls, state, fetch: fetchFn };
}

type BankingInformation = FinTSClientLike["config"]["bankingInformation"];
type BankAccount = NonNullable<BankingInformation["upd"]>["bankAccounts"][number];

/** Behaves like lib-fints: UPD only after a TAN method is chosen, statements behind a TAN or app approval. */
function fakeFinTS() {
  const state = {
    pinWrong: false,
    pendingPolls: 2,
    tans: [] as (string | undefined)[],
    syncs: 0,
    versions: [] as (string | undefined)[],
    withDepot: false,
    depotValue: 1500,
  };
  const methods: TanMethod[] = [
    { id: 999, name: "Einschritt", version: 6, isDecoupled: false, activeTanMedia: [], activeTanMediaCount: 0, tanMediaRequirement: 0 },
    { id: 900, name: "iTAN", version: 6, isDecoupled: false, activeTanMedia: [], activeTanMediaCount: 0, tanMediaRequirement: 0 },
    {
      id: 902,
      name: "Banking to go App",
      version: 6,
      isDecoupled: true,
      activeTanMedia: [],
      activeTanMediaCount: 0,
      tanMediaRequirement: 0,
    },
  ];
  const account = { accountNumber: "137075030", iban: "DE02500105170137075030", currency: "EUR", product: "Girokonto" } as BankAccount;
  const depot = {
    accountNumber: "5544332211",
    currency: "EUR",
    product: "Direkt-Depot",
    accountType: "SecuritiesAccount",
  } as unknown as BankAccount;
  const base = { dialogId: "1", bankingInformationUpdated: false, bankAnswers: [] };
  const factory = (access: FinTSAccess): FinTSClientLike => {
    state.versions.push(access.productVersion);
    const info: BankingInformation = access.bankingInformation
      ? structuredClone(access.bankingInformation)
      : ({ systemId: "0", bankMessages: [] } as BankingInformation);
    let selected = methods.find((m) => m.id === access.tanMethodId);
    let polls = 0;
    const challenge = () => ({
      ...base,
      success: true,
      requiresTan: true,
      tanReference: "ref",
      tanChallenge: selected?.isDecoupled ? "" : "TAN eingeben",
    });
    const approved = (tan: string | undefined) => {
      state.tans.push(tan);
      if (selected?.isDecoupled && polls++ < state.pendingPolls) return challenge();
      return null;
    };
    return {
      config: {
        bankingInformation: info,
        get availableTanMethods() {
          return info.bpd ? methods : [];
        },
        get selectedTanMethod() {
          return selected;
        },
      },
      selectTanMethod(id) {
        selected = methods.find((m) => m.id === id);
      },
      selectTanMedia() {},
      async synchronize() {
        state.syncs++;
        if (state.pinWrong || access.pin !== "geheim") {
          return { ...base, success: false, requiresTan: false, bankAnswers: [{ code: 9942, text: "PIN falsch" }] };
        }
        info.bpd = { bankName: "ING" } as BankingInformation["bpd"];
        if (selected) {
          info.upd = { version: 1, usage: 0, bankAccounts: state.withDepot ? [account, depot] : [account] } as BankingInformation["upd"];
        }
        return { ...base, success: true, requiresTan: false };
      },
      async synchronizeWithTan() {
        throw new Error("not used");
      },
      canGetAccountBalance: () => true,
      async getAccountBalance() {
        return { ...base, success: true, requiresTan: false, balance: { date: new Date("2026-11-15"), currency: "EUR", balance: 12500 } };
      },
      async getAccountBalanceWithTan() {
        throw new Error("not used");
      },
      canGetAccountStatements: () => true,
      async getAccountStatements() {
        return { ...challenge(), statements: [] };
      },
      async getAccountStatementsWithTan(_ref, tan) {
        const pending = approved(tan);
        if (pending) return { ...pending, statements: [] };
        const t = (amount: number, day: number, remoteName: string, purpose: string) => ({
          valueDate: new Date(2026, 10, day),
          entryDate: new Date(2026, 10, day),
          amount,
          remoteName,
          purpose,
          fundsCode: "",
          transactionType: "",
          customerReference: "NONREF",
          bankReference: "",
        });
        return {
          ...base,
          success: true,
          requiresTan: false,
          statements: [
            {
              openingBalance: { date: new Date(), currency: "EUR", value: 0 },
              closingBalance: { date: new Date(), currency: "EUR", value: 0 },
              transactions: [t(-19.99, 2, "Spotify AB", "Spotify Premium"), t(200, 5, "Ich selbst", "Übertrag")],
            },
          ],
        };
      },
      canGetPortfolio: (a) => String(a?.accountType) === "SecuritiesAccount",
      async getPortfolio() {
        return {
          ...base,
          success: true,
          requiresTan: false,
          portfolioStatement: {
            currency: "EUR",
            holdings: [
              {
                isin: "IE00B4L5Y983",
                name: "iShares Core MSCI World",
                amount: 10,
                price: state.depotValue / 10,
                value: state.depotValue,
                currency: "EUR",
                acquisitionPrice: 100,
              },
              { isin: "DE0005190003", name: "BMW", amount: 5, price: 100, value: 500, currency: "EUR" },
            ],
          },
        };
      },
      async getPortfolioWithTan() {
        throw new Error("not used");
      },
      canGetCreditCardStatements: () => false,
      async getCreditCardStatements() {
        throw new Error("not used");
      },
      async getCreditCardStatementsWithTan() {
        throw new Error("not used");
      },
    };
  };
  return { state, factory };
}

function lastAuthState(calls: Call[]): string {
  const body = calls.filter((c) => c.path === "/auth").at(-1)?.body as { state?: string } | undefined;
  return body?.state ?? "";
}

async function waitForJob(jobId: string, statuses: banking.JobStatus[], viewer: Viewer): Promise<banking.JobView> {
  for (let i = 0; i < 500; i++) {
    const job = await banking.getJobView(db(), viewer, { jobId });
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not reach ${statuses.join("/")}`);
}

describe("banking", () => {
  let admin: Viewer;
  let member: Viewer;
  let eb: ReturnType<typeof fakeEnableBanking>;
  let fints: ReturnType<typeof fakeFinTS>;

  beforeEach(async () => {
    await resetDb();
    banking.resetJobsForTests();
    resetTasksForTests();
    banking.jobTiming.decoupledPollMs = 1;
    admin = await makeUser("admin", "superuser");
    member = await makeUser("kind", "member");
    eb = fakeEnableBanking();
    fints = fakeFinTS();
    banking.setBankingDepsForTests({ fetch: eb.fetch, fintsClient: fints.factory, now: () => NOW });
  });

  afterEach(() => {
    banking.resetJobsForTests();
    resetTasksForTests();
    banking.setBankingDepsForTests({});
    vi.restoreAllMocks();
  });

  async function setupEnableBanking() {
    return banking.saveEnableBankingSettings(db(), admin, { appId: APP_ID, privateKey: PEM });
  }

  /** Connected and authorized; the sync started by the authorization has finished. */
  async function authorizedConnection() {
    await setupEnableBanking();
    const created = await banking.createConnection(db(), admin, { name: "DKB", enableBanking: { bankName: "DKB", country: "DE" } });
    const state = lastAuthState(eb.calls);
    const result = await banking.completeAuthorization(db(), admin, {
      redirectedUrl: `https://saldo.test/bank/callback?code=the-code&state=${state}`,
    });
    const firstSync = await waitForJob(result.job?.id ?? "", ["done", "error"], admin);
    return { created, state, result, firstSync };
  }

  /** Renews the consent of a connection and waits for the sync the renewal started. */
  async function renew(id: number, code = "code-2") {
    await banking.authorizeConnection(db(), admin, { id });
    const result = await banking.completeAuthorization(db(), admin, { code, state: lastAuthState(eb.calls) });
    if (result.job) await waitForJob(result.job.id, ["done", "error"], admin);
    return result;
  }

  const syncsStarted = async () => (await db().select().from(auditEvents)).filter((e) => e.action === "bank.syncStarted").length;

  describe("Enable Banking credentials", () => {
    it("lists the banks alphabetically, ignoring case and accents and ordering numbers naturally", async () => {
      await setupEnableBanking();
      const names = (await banking.listEnableBankingBanks(db(), admin, { country: "DE" })).map((b) => b.name);
      expect(names).toEqual(["Ärzte- und Apothekerbank", "Bank 2", "Bank 11", "comdirect", "DKB", "ING"]);
    });

    it("stores valid credentials without ever returning the key", async () => {
      const check = await setupEnableBanking();
      expect(check).toMatchObject({ status: "ok", appName: "Saldo", environment: "PRODUCTION", redirectRegistered: true });
      const settingsView = await banking.getBankingSettings(db(), admin);
      expect(settingsView).toMatchObject({
        available: ["enable_banking"],
        redirectUrl: "https://saldo.test/bank/callback",
        enableBanking: { appId: APP_ID, keySet: true, check: { status: "ok" } },
      });
      expect(JSON.stringify(settingsView)).not.toContain("PRIVATE KEY");
      const [stored] = await db().select().from(settings).where(eq(settings.key, "enable_banking_private_key"));
      expect(stored?.ciphertext).toBeTruthy();
      expect(stored?.ciphertext).not.toContain("PRIVATE KEY");
      expect(eb.calls.map((c) => c.path)).toEqual(["/application"]);
    });

    it("stores an app that is not active yet with that status", async () => {
      eb.state.active = false;
      expect((await setupEnableBanking()).status).toBe("inactive");
      expect((await banking.getBankingSettings(db(), admin)).enableBanking).toMatchObject({ appId: APP_ID, check: { status: "inactive" } });
      eb.state.active = true;
      expect((await banking.recheckEnableBanking(db(), admin)).status).toBe("ok");
    });

    it("rejects a malformed app id, a non-RSA key and credentials Enable Banking refuses, storing nothing", async () => {
      await expect(banking.saveEnableBankingSettings(db(), admin, { appId: "app-123", privateKey: PEM })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("UUID"),
      });
      const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await expect(banking.saveEnableBankingSettings(db(), admin, { appId: APP_ID, privateKey: ec })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("RSA"),
      });
      eb.state.rejectKey = true;
      await expect(banking.saveEnableBankingSettings(db(), admin, { appId: APP_ID, privateKey: PEM })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("lehnt"),
      });
      expect(await db().select().from(settings)).toEqual([]);
      expect(eb.calls).toHaveLength(1);
    });
  });

  describe("provider choice", () => {
    it("offers only the providers that are set up and accepts details of exactly one of them", async () => {
      expect(await banking.getBankingSettings(db(), member)).toMatchObject({ available: [], ready: false });
      await expect(
        banking.createConnection(db(), admin, { name: "DKB", enableBanking: { bankName: "DKB", country: "DE" } }),
      ).rejects.toMatchObject({ status: 400, message: "Enable Banking ist auf dieser Instanz nicht eingerichtet." });
      await setupEnableBanking();
      await expect(
        banking.createConnection(db(), admin, { name: "ING", fints: { preset: "ing", login: "1", pin: "geheim" } }),
      ).rejects.toMatchObject({ status: 400, message: "FinTS ist auf dieser Instanz nicht eingerichtet." });
      await expect(
        banking.createConnection(db(), admin, {
          name: "Beides",
          enableBanking: { bankName: "DKB", country: "DE" },
          fints: { preset: "ing", login: "1", pin: "geheim" },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("runs Enable Banking and FinTS side by side without touching existing connections", async () => {
      const { created } = await authorizedConnection();
      const before = await db().select().from(bankConnections);
      await banking.saveFintsSettings(db(), admin, { productId: "TESTPRODUCT123", productVersion: "2.1" });
      const view = await banking.getBankingSettings(db(), admin);
      expect(view).toMatchObject({ available: ["enable_banking", "fints"], fints: { productId: "TESTPRODUCT123", productVersion: "2.1" } });
      expect((await banking.getBankingSettings(db(), member)).fints).toEqual({ productId: null, productVersion: null });

      const fintsCreated = await banking.createConnection(db(), admin, {
        name: "ING",
        fints: { preset: "ing", login: "1", pin: "geheim" },
      });
      const discovered = await waitForJob(fintsCreated.job?.id ?? "", ["done", "error"], admin);
      expect(discovered.status).toBe("done");
      expect((await waitForJob(discovered.next ?? "", ["done", "error"], admin)).status).toBe("done");
      expect(fints.state.versions).toEqual(["2.1", "2.1"]);
      const after = await db().select().from(bankConnections).where(eq(bankConnections.id, created.connection.id));
      expect(after).toEqual(before);
      const job = await banking.syncConnection(db(), admin, { id: created.connection.id });
      expect((await waitForJob(job.id, ["done", "error"], admin)).status).toBe("done");
    });

    it("keeps an existing Enable Banking setup working when the old one-provider setting is still stored", async () => {
      await db().insert(settings).values({ key: "bank_provider", value: "enable_banking" });
      await setupEnableBanking();
      expect((await banking.getBankingSettings(db(), admin)).available).toEqual(["enable_banking"]);
    });

    it("enables an unofficial provider only with the confirmed warning, and only for superusers", async () => {
      await expect(banking.setUnofficialProvider(db(), admin, { provider: "trade_republic", enabled: true })).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        banking.setUnofficialProvider(db(), member, { provider: "trade_republic", enabled: true, acknowledged: true }),
      ).rejects.toMatchObject({ status: 403 });
      await banking.setUnofficialProvider(db(), admin, { provider: "trade_republic", enabled: true, acknowledged: true });
      expect(await banking.getBankingSettings(db(), member)).toMatchObject({
        available: ["trade_republic"],
        unofficial: { trade_republic: true, givve: false },
        ready: true,
      });
      await banking.setUnofficialProvider(db(), admin, { provider: "trade_republic", enabled: false });
      expect((await banking.getBankingSettings(db(), member)).available).toEqual([]);
    });
  });

  describe("Enable Banking flow", () => {
    it("authorizes, creates the bank's account, syncs bookings and balance and deduplicates on resync", async () => {
      await setupEnableBanking();
      const created = await banking.createConnection(db(), admin, { name: "DKB", enableBanking: { bankName: "DKB", country: "DE" } });
      expect(created.url).toBe("https://bank.example/login");
      expect(created.connection).toMatchObject({ provider: "enable_banking", status: "new", bank: "dkb" });
      const auth = eb.calls.find((c) => c.path === "/auth")?.body as Record<string, unknown> & {
        state: string;
        access: { valid_until: string };
      };
      expect(auth).toMatchObject({
        psu_type: "personal",
        redirect_url: "https://saldo.test/bank/callback",
        aspsp: { name: "DKB", country: "DE" },
      });
      // The bank allows 180 days; five minutes are kept as a margin.
      expect(auth.access.valid_until).toBe(new Date(NOW.getTime() + 15_552_000_000 - 300_000).toISOString());
      expect(JSON.stringify(await banking.listConnections(db(), admin))).not.toContain(auth.state);

      const result = await banking.completeAuthorization(
        db(),
        admin,
        { code: "the-code", state: auth.state },
        { "Psu-User-Agent": "Vitest" },
      );
      const completed = result.connection;
      expect(completed).toMatchObject({ status: "active", consentValidUntil: "2027-05-10T00:00:00.000Z" });
      expect(result).toMatchObject({ tone: "ok", message: "„DKB“ ist freigegeben – 1 Konto angelegt, Abruf läuft." });
      expect(result.job).toMatchObject({ kind: "sync", connectionId: completed.id });
      expect(completed.activeJobId).toBe(result.job?.id);
      expect(completed.remoteAccounts).toEqual([
        { ref: "uid-1", iban: IBAN, name: "Girokonto", currency: "EUR", product: null, type: null },
      ]);
      expect(eb.calls.find((c) => c.path === "/sessions")?.body).toEqual({ code: "the-code" });
      await expect(banking.completeAuthorization(db(), admin, { code: "the-code", state: auth.state })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("bereits verwendete"),
      });

      // The bank's account became a Saldo account of the connecting superuser, for the household; no linking step.
      expect(completed.linkedAccounts).toEqual([{ id: expect.any(Number), name: "Girokonto", remoteRef: "uid-1" }]);
      const accountId = completed.linkedAccounts[0]?.id ?? -1;
      // The bookings are fetched right away, with the headers of the person who came back from the bank.
      expect(await waitForJob(result.job?.id ?? "", ["done", "error"], admin)).toMatchObject({
        status: "done",
        newBookings: 3,
        accounts: [{ accountId, name: "Girokonto", newBookings: 3, firstImport: true }],
      });
      const firstCall = eb.calls.find((c) => c.path === "/accounts/uid-1/transactions");
      expect(firstCall?.headers["Psu-User-Agent"]).toBe("Vitest");
      expect(firstCall?.query.get("date_from")).toBe("2025-11-15");
      const [created2] = await db().select().from(accounts).where(eq(accounts.id, accountId));
      expect(created2).toMatchObject({ ownerUserId: admin.id, visibility: "household", kind: "checking", iban: IBAN, bank: "dkb" });
      await renameAccount(db(), admin, { id: accountId, name: "DKB Giro" });
      const group = await createGroup(db(), admin, { name: "Meine Konten", accountIds: [accountId] });
      expect(await db().select().from(accountGroupMembers).where(eq(accountGroupMembers.accountId, accountId))).toEqual([
        { accountId, groupId: group },
      ]);

      const psu = { "Psu-Ip-Address": "192.0.2.10", "Psu-User-Agent": "Vitest" };
      const job = await banking.syncConnection(db(), admin, { id: completed.id }, psu);
      const done = await waitForJob(job.id, ["done", "error"], admin);
      expect(done).toMatchObject({
        status: "done",
        newBookings: 0,
        accountsSynced: 1,
        accounts: [{ accountId, name: "DKB Giro", newBookings: 0, firstImport: false }],
        error: null,
      });
      const txCall = eb.calls.filter((c) => c.path === "/accounts/uid-1/transactions").at(-1);
      expect(txCall?.headers["Psu-Ip-Address"]).toBe("192.0.2.10");

      const [account] = await db().select().from(accounts).where(eq(accounts.id, accountId));
      expect(account).toMatchObject({ balanceCents: 123_456, balanceDate: "2026-11-14", iban: IBAN, bank: "dkb" });
      const stored = await db().select().from(transactions).where(eq(transactions.accountId, accountId));
      expect(stored.map((t) => t.amountCents).sort((a, b) => a - b)).toEqual([-4000, -1250, 352_000]);
      // First import: only the last week counts as new, the booking from 28 October is history.
      expect(stored.filter((t) => t.isUnread).map((t) => t.bookingDate)).toEqual(["2026-11-10", "2026-11-10"]);
      const [connection] = await banking.listConnections(db(), admin);
      expect(connection).toMatchObject({ status: "active", lastError: "", lastSyncAt: NOW.toISOString(), activeJobId: null });

      expect(await db().select().from(transactions)).toHaveLength(3);
    });

    it("replaces the pending bookings on each successful sync, keeps them on a failed one and never counts them", async () => {
      const { created, firstSync } = await authorizedConnection();
      const id = created.connection.id;
      expect(firstSync).toMatchObject({ status: "done", newBookings: 3 });
      const accountId = (await banking.listConnections(db(), admin))[0]?.linkedAccounts[0]?.id ?? -1;
      const pendingRows = () => db().select().from(pendingTransactions);
      expect(await pendingRows()).toEqual([
        expect.objectContaining({
          accountId,
          bookingDate: "2026-11-10",
          amountCents: -100,
          counterparty: "Gasthof Hirsch",
          purpose: "Abendessen",
          fetchedAt: NOW,
        }),
      ]);
      expect(await db().select().from(transactions)).toHaveLength(3);

      eb.state.sessionGone = true;
      const failed = await banking.syncConnection(db(), admin, { id });
      expect((await waitForJob(failed.id, ["done", "error"], admin)).status).toBe("error");
      expect(await pendingRows()).toHaveLength(1);

      // Booked now: it arrives with status BOOK, so it is a booking once and no longer pending.
      eb.state.sessionGone = false;
      eb.state.pStatus = "BOOK";
      await db().update(bankConnections).set({ status: "active" }).where(eq(bankConnections.id, id));
      const booked = await banking.syncConnection(db(), admin, { id });
      expect(await waitForJob(booked.id, ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 1 });
      expect(await pendingRows()).toEqual([]);
      const stored = await db().select().from(transactions).where(eq(transactions.accountId, accountId));
      expect(stored.filter((t) => t.amountCents === -100)).toHaveLength(1);

      const again = await banking.syncConnection(db(), admin, { id });
      expect(await waitForJob(again.id, ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 0 });
      expect(await db().select().from(transactions)).toHaveLength(4);
      expect(await pendingRows()).toEqual([]);
    });

    it("drops pending bookings of an account no bank fetches any more", async () => {
      const { created } = await authorizedConnection();
      const accountId = (await banking.listConnections(db(), admin))[0]?.linkedAccounts[0]?.id ?? -1;
      expect(await db().select().from(pendingTransactions)).toHaveLength(1);
      await banking.unlinkAccount(db(), admin, { connectionId: created.connection.id, accountId });
      expect(await db().select().from(pendingTransactions)).toEqual([]);
    });

    it("rejects completion with a replayed or unknown state and reports a declined consent", async () => {
      const { state } = await authorizedConnection();
      await expect(
        banking.completeAuthorization(db(), admin, { redirectedUrl: `https://saldo.test/bank/callback?code=c&state=${state}` }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(banking.completeAuthorization(db(), admin, { code: "c", state: "made-up" })).rejects.toMatchObject({ status: 400 });
      await expect(
        banking.completeAuthorization(db(), admin, {
          redirectedUrl: "https://saldo.test/bank/callback?error=access_denied&error_description=Abgebrochen",
        }),
      ).rejects.toMatchObject({ message: "Die Bank hat die Freigabe abgelehnt: Abgebrochen" });
      expect(eb.calls.filter((c) => c.path === "/sessions")).toHaveLength(1);
    });

    it("marks the connection for renewal when the consent expired or the bank ended the session", async () => {
      const { created } = await authorizedConnection();
      const id = created.connection.id;
      await banking.linkAccount(db(), admin, { connectionId: id, remoteRef: "uid-1", newAccount: { name: "DKB Giro" } });

      await db()
        .update(bankConnections)
        .set({ consentValidUntil: new Date("2026-11-01T00:00:00Z") })
        .where(eq(bankConnections.id, id));
      const expired = await banking.syncConnection(db(), admin, { id });
      expect(await waitForJob(expired.id, ["done", "error"], admin)).toMatchObject({
        status: "error",
        error: expect.stringContaining("abgelaufen"),
      });
      expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "needs_reauth" });
      // The stored error is our own text, so each reader gets it in their language.
      expect((await banking.listConnections(db(), { ...admin, locale: "fr" }))[0]?.lastError).toBe(
        t("fr", "banking.errors.consentExpired"),
      );

      await db().update(bankConnections).set({ consentValidUntil: null, status: "active" }).where(eq(bankConnections.id, id));
      eb.state.sessionGone = true;
      const gone = await banking.syncConnection(db(), admin, { id });
      expect((await waitForJob(gone.id, ["done", "error"], admin)).status).toBe("error");
      expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "needs_reauth" });
      // Only the first sync after the authorization stored bookings.
      expect(await db().select().from(transactions)).toHaveLength(3);
    });

    it("runs a scheduled sync once per due slot and reports the new bookings", async () => {
      const { created } = await authorizedConnection();
      const id = created.connection.id;
      await banking.linkAccount(db(), admin, { connectionId: id, remoteRef: "uid-1", newAccount: { name: "DKB Giro" } });
      await notifications.savePreferences(db(), admin, {
        preferences: [{ kind: "new_bookings", enabled: true, push: false, email: false, threshold: null }],
      });
      await expect(banking.setSyncSchedule(db(), admin, { enabled: true, times: ["25:00"] })).rejects.toThrow();
      await expect(banking.setSyncSchedule(db(), admin, { enabled: true, times: [] })).rejects.toMatchObject({ status: 400 });
      await expect(banking.setSyncSchedule(db(), member, { enabled: true, times: ["07:00"] })).rejects.toMatchObject({ status: 403 });
      expect(await banking.setSyncSchedule(db(), admin, { enabled: true, times: ["19:30", "07:00", "07:00"] })).toEqual({
        enabled: true,
        times: ["07:00", "19:30"],
      });
      expect((await banking.getBankingSettings(db(), member)).schedule).toEqual({ enabled: true, times: ["07:00", "19:30"] });

      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 6, 59))).toEqual([]);
      const [first, ...others] = await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 3));
      expect(others).toEqual([]);
      expect(await waitForJob(first?.job?.id ?? "", ["done", "error"], admin)).toMatchObject({ status: "done", newBookings: 3 });
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 4))).toEqual([]);
      // A slot missed by more than a quarter of an hour is skipped, the next one runs.
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 19, 50))).toEqual([]);
      const next = await banking.runScheduledSyncs(db(), new Date(2026, 10, 17, 7, 0));
      expect(next).toHaveLength(1);
      // Finished before the test ends, so it does not write while the next test empties the database.
      await waitForJob(next[0]?.job?.id ?? "", ["done", "error"], admin);
      // Without a person present Enable Banking gets no PSU headers.
      expect(eb.calls.filter((c) => c.path === "/accounts/uid-1/transactions").every((c) => !c.headers["Psu-Ip-Address"])).toBe(true);

      const { items } = await notifications.listNotifications(db(), admin);
      // The first import leaves the booking from 28 October read, so it is not announced.
      expect(items.map((i) => i.title)).toEqual(["2 neue Buchungen"]);
      await banking.setSyncSchedule(db(), admin, { enabled: false, times: ["07:00"] });
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 18, 7, 0))).toEqual([]);
      const [changed] = (await db().select().from(auditEvents).orderBy(asc(auditEvents.id))).filter(
        (e) => e.action === "bank.settingsChanged" && (e.details as { setting?: string }).setting === "schedule",
      );
      expect(changed).toMatchObject({ userId: admin.id, details: { setting: "schedule", enabled: true, times: ["07:00", "19:30"] } });
    });

    it("relinks accounts by IBAN on renewal, keeps or removes them when the connection is deleted", async () => {
      const { created } = await authorizedConnection();
      const id = created.connection.id;
      const [linked] = await banking.listConnections(db(), admin);
      eb.state.sessions.push({ id: "sess-2", uid: "uid-2" });
      eb.state.sessionIndex = 1;
      const before = await syncsStarted();
      const renewed = await renew(id);
      expect(renewed.connection.linkedAccounts).toEqual([{ id: linked?.linkedAccounts[0]?.id, name: "Girokonto", remoteRef: "uid-2" }]);
      // The renewal fetches once with the new consent.
      expect(renewed).toMatchObject({ tone: "ok", message: "Freigabe für „DKB“ erneuert, Abruf läuft.", job: { kind: "sync" } });
      expect(await syncsStarted()).toBe(before + 1);
      expect(eb.calls.some((c) => c.method === "DELETE" && c.path === "/sessions/sess-1")).toBe(true);

      await banking.deleteConnection(db(), admin, { id });
      expect(await db().select().from(bankConnections)).toEqual([]);
      const [account] = await db().select().from(accounts);
      expect(account).toMatchObject({ name: "Girokonto", connectionId: null, remoteRef: null });

      // Connected again, the bank's account finds the kept one by IBAN instead of a twin; removed with its connection.
      const again = await authorizedConnection();
      expect(await db().select().from(accounts)).toHaveLength(1);
      await banking.deleteConnection(db(), admin, { id: again.created.connection.id, keepAccounts: false });
      expect(await db().select().from(accounts)).toEqual([]);
    });

    it("explains a consent without accounts and fetches once a renewal brings them", async () => {
      await setupEnableBanking();
      const created = await banking.createConnection(db(), admin, {
        name: "Bank Norwegian",
        enableBanking: { bankName: "DKB", country: "DE" },
      });
      eb.state.noAccounts = true;
      const empty = await banking.completeAuthorization(db(), admin, { code: "c1", state: lastAuthState(eb.calls) });
      expect(empty).toMatchObject({
        job: null,
        tone: "warn",
        message: t("de", "banking.authorizedNoAccounts", { name: "Bank Norwegian" }),
        connection: { status: "no_accounts", remoteAccounts: [], linkedAccounts: [] },
      });
      expect(empty.message).toContain("Link accounts");
      expect(empty.message).not.toContain("zuordnen");
      expect(await syncsStarted()).toBe(0);
      expect(eb.calls.some((c) => c.path.startsWith("/accounts/"))).toBe(false);
      expect(await banking.syncAll(db(), admin)).toEqual([]);

      eb.state.noAccounts = false;
      const renewed = await renew(created.connection.id);
      expect(renewed).toMatchObject({
        tone: "ok",
        message: "„Bank Norwegian“ ist freigegeben – 1 Konto angelegt, Abruf läuft.",
        connection: { status: "active", linkedAccounts: [{ name: "Girokonto", remoteRef: "uid-1" }] },
      });
      expect(await syncsStarted()).toBe(1);
      expect(await db().select().from(transactions)).toHaveLength(3);
    });

    it("joins a sync that is already running instead of starting a second one", async () => {
      const { created } = await authorizedConnection();
      const id = created.connection.id;
      const before = await syncsStarted();
      let release = () => {};
      eb.state.gate = new Promise((resolve) => {
        release = resolve;
      });
      const running = await banking.syncConnection(db(), admin, { id });
      await banking.authorizeConnection(db(), admin, { id });
      const renewed = await banking.completeAuthorization(db(), admin, { code: "code-2", state: lastAuthState(eb.calls) });
      expect(renewed.job?.id).toBe(running.id);
      release();
      await waitForJob(running.id, ["done", "error"], admin);
      expect(await syncsStarted()).toBe(before + 1);
    });

    it("reports a failing first sync like any other, while the authorization itself succeeded", async () => {
      await setupEnableBanking();
      await banking.createConnection(db(), admin, { name: "DKB", enableBanking: { bankName: "DKB", country: "DE" } });
      eb.state.sessionGone = true;
      const result = await banking.completeAuthorization(db(), admin, { code: "c", state: lastAuthState(eb.calls) });
      expect(result.tone).toBe("ok");
      expect(await waitForJob(result.job?.id ?? "", ["done", "error"], admin)).toMatchObject({ status: "error" });
      expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "needs_reauth" });
    });

    it("logs settings, consent, sync and deletion without keys, codes or states", async () => {
      const { created, state } = await authorizedConnection();
      const id = created.connection.id;
      eb.state.sessions.push({ id: "sess-2", uid: "uid-2" });
      eb.state.sessionIndex = 1;
      await renew(id);
      await banking.deleteConnection(db(), admin, { id });

      const events = await db().select().from(auditEvents).orderBy(asc(auditEvents.id));
      expect(events.map((e) => [e.action, e.outcome, e.userId])).toEqual([
        ["bank.settingsChanged", "ok", admin.id],
        ["bank.connectionCreated", "ok", admin.id],
        ["bank.connectionAuthorized", "ok", admin.id],
        ["accounts.created", "ok", admin.id],
        ["bank.syncStarted", "ok", admin.id],
        ["bank.syncFinished", "ok", admin.id],
        ["bank.connectionRenewed", "ok", admin.id],
        ["bank.syncStarted", "ok", admin.id],
        ["bank.syncFinished", "ok", admin.id],
        ["bank.connectionDeleted", "ok", admin.id],
      ]);
      expect(events[0]?.details).toEqual({ setting: "enableBanking", keyChanged: true });
      expect(events[5]?.details).toEqual({ name: "DKB", trigger: "manual", newBookings: 3 });
      const logged = JSON.stringify(events);
      for (const secret of [PEM.slice(40, 80), APP_ID, state, "the-code", "code-2", "sess-1"]) expect(logged).not.toContain(secret);
    });
  });

  it("lists a sync and the AI categorization after it as tasks, for admins only", async () => {
    // Enable Banking goes through the injected fetch; only the AI provider uses the global one.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "chat-small" }] });
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const items = JSON.parse(body.messages[1]?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number }[];
      const answer = JSON.stringify({ zuordnungen: items.map((i) => ({ id: i.id, kategorie: "Sonstiges" })) });
      return Response.json({ choices: [{ message: { content: answer } }] });
    });
    const provider = (await createProvider(db(), admin, { name: "OpenAI", kind: "openai", apiKey: "sk-test" })).provider;
    await updateProvider(db(), admin, provider.id, { name: "OpenAI", kind: "openai", model: "chat-small" });
    await saveAiSettings(db(), admin, { autoCategorize: true });
    const { firstSync: job } = await authorizedConnection();

    // The sync waits for its categorization, so it ends last and is listed first.
    const tasks = await listTasks(db(), admin);
    expect(tasks.map((t) => [t.kind, t.status])).toEqual([
      ["bankSync", "done"],
      ["aiAutoCategorize", "done"],
    ]);
    expect(tasks[1]).toMatchObject({ startedBy: null, progress: { done: 1, total: 1, unit: "batch" } });
    expect(tasks[0]).toMatchObject({
      id: job.id,
      startedBy: { name: "admin" },
      message: "3 neue Buchungen",
      progress: { done: 1, total: 1, unit: "account" },
      cancellable: false,
    });
    expect(await listTasks(db(), member)).toEqual([]);
  });

  describe("schedule", () => {
    const EB_SECRETS = {
      bankName: "DKB",
      country: "DE",
      sessionId: "sess-1",
      pendingState: null,
      pendingStateAt: null,
      pendingValidUntil: null,
    };

    async function connectionRow(name: string, status: string, options: { skip?: boolean; linked?: boolean; owner?: Viewer } = {}) {
      const owner = options.owner ?? admin;
      const [row] = await db()
        .insert(bankConnections)
        .values({
          name,
          provider: "enable_banking",
          bank: "dkb",
          status,
          skipSyncAll: options.skip ?? false,
          ownerUserId: owner.id,
          visibility: owner === admin ? "household" : "private",
          ciphertext: encrypt(JSON.stringify(EB_SECRETS)),
        })
        .returning({ id: bankConnections.id });
      const id = row?.id ?? -1;
      if (options.linked ?? true) {
        await db()
          .insert(accounts)
          .values({ name, bank: "dkb", kind: "checking", connectionId: id, remoteRef: "uid-1", ownerUserId: owner.id });
      }
      return id;
    }

    it("fetches every usable connection once per slot, private ones included, and leaves out manual-only ones", async () => {
      await setupEnableBanking();
      const active = await connectionRow("DKB", "active");
      const failedBefore = await connectionRow("Gemeinschaftskonto", "error");
      const memberOwn = await connectionRow("Meine Bank", "active", { owner: member });
      await connectionRow("Nur manuell", "active", { skip: true });
      await connectionRow("Abgemeldet", "needs_reauth");
      await connectionRow("Angefangen", "new");
      await connectionRow("Bank Norwegian", "no_accounts", { linked: false });
      await connectionRow("Ohne Konten", "active", { linked: false });

      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 0))).toEqual([]);
      await banking.setSyncSchedule(db(), admin, { enabled: true, times: ["07:00"] });
      const started = await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 0));
      expect(started.map((item) => [item.connectionId, item.error])).toEqual([
        [active, null],
        [failedBefore, null],
        [memberOwn, null],
      ]);
      for (const item of started) await waitForJob(item.job?.id ?? "", ["done", "error"], admin);
      expect(await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 7, 5))).toEqual([]);
      const next = await banking.runScheduledSyncs(db(), new Date(2026, 10, 17, 7, 1));
      expect(next).toHaveLength(3);
      for (const item of next) await waitForJob(item.job?.id ?? "", ["done", "error"], admin);
    });
  });

  describe("FinTS", () => {
    async function fintsConnection() {
      await banking.saveFintsSettings(db(), admin, { productId: "TESTPRODUCT123" });
      const created = await banking.createConnection(db(), admin, {
        name: "ING",
        fints: { preset: "ing", login: "1234567890", pin: "geheim" },
      });
      expect(created.job).toMatchObject({ kind: "discover" });
      const done = await waitForJob(created.job?.id ?? "", ["done", "error"], admin);
      expect(done.status).toBe("done");
      expect(await waitForJob(done.next ?? "", ["done", "error"], admin)).toMatchObject({ kind: "sync", status: "done", newBookings: 2 });
      // The approvals of that first sync are not part of the tests below.
      fints.state.tans = [];
      const [connection] = await banking.listConnections(db(), admin);
      if (!connection) throw new Error("connection missing");
      return connection;
    }

    async function linkAndSync(connectionId: number) {
      await banking.linkAccount(db(), admin, { connectionId, remoteRef: "DE02500105170137075030", newAccount: { name: "ING Giro" } });
      return banking.syncConnection(db(), admin, { id: connectionId });
    }

    it("needs the product id before a connection can be created", async () => {
      await expect(
        banking.createConnection(db(), admin, { name: "ING", fints: { preset: "ing", login: "1", pin: "geheim" } }),
      ).rejects.toMatchObject({ status: 400, message: "FinTS ist auf dieser Instanz nicht eingerichtet." });
      expect(await db().select().from(bankConnections)).toEqual([]);
    });

    it("discovers accounts on create and shows a wrong PIN right away", async () => {
      const connection = await fintsConnection();
      expect(connection).toMatchObject({
        status: "active",
        bank: "ing",
        target: { blz: "50010517", server: "https://fints.ing.de/fints/" },
        tanMechanisms: { "900": "iTAN", "902": "Banking to go App" },
        tanMechanism: "902",
        remoteAccounts: [
          { ref: "DE02500105170137075030", iban: "DE02500105170137075030", name: "Girokonto", currency: "EUR", product: "Girokonto" },
        ],
      });
      expect(JSON.stringify(connection)).not.toContain("geheim");

      const wrong = await banking.createConnection(db(), admin, { name: "DKB", fints: { preset: "dkb", login: "x", pin: "falsch" } });
      const failed = await waitForJob(wrong.job?.id ?? "", ["done", "error"], admin);
      expect(failed).toMatchObject({
        status: "error",
        error: expect.stringMatching(/^Die Bank hat Login oder PIN abgelehnt: .+ \(\d{4}\)\. Bitte Zugangsdaten prüfen\.$/),
        next: null,
      });
      const stored = (await banking.listConnections(db(), admin)).find((c) => c.id === wrong.connection.id);
      expect(stored).toMatchObject({ status: "error", lastError: failed.error });
    });

    it("fetches a new connection once right after its discovery, and not again after a later check", async () => {
      const connection = await fintsConnection();
      expect(await syncsStarted()).toBe(1);
      expect((await listTasks(db(), admin)).map((task) => [task.kind, task.status])).toEqual([
        ["bankSync", "done"],
        ["bankDiscover", "done"],
      ]);
      const check = await banking.discoverConnection(db(), admin, { id: connection.id });
      expect(await waitForJob(check.id, ["done", "error"], admin)).toMatchObject({ status: "done", next: null });
      expect(await syncsStarted()).toBe(1);
    });

    it("waits for a typed TAN and imports the statements", async () => {
      const connection = await fintsConnection();
      await banking.updateConnection(db(), admin, { id: connection.id, tanMechanism: "900" });
      const job = await linkAndSync(connection.id);
      const waiting = await waitForJob(job.id, ["tan_required", "done", "error"], admin);
      expect(waiting).toMatchObject({ status: "tan_required", tan: { text: "TAN eingeben", decoupled: false, imageDataUrl: null } });
      expect(await banking.listActiveJobs(db(), admin)).toEqual([
        { id: job.id, connectionId: connection.id, kind: "sync", status: "tan_required" },
      ]);
      // Running tasks come first; the discovery on creation is listed as finished below.
      expect((await listTasks(db(), admin)).slice(0, 1)).toMatchObject([
        {
          id: job.id,
          kind: "bankSync",
          title: "Konten abrufen · ING",
          status: "running",
          waiting: true,
          cancellable: true,
          progress: { done: 0, total: 1, unit: "account" },
          job: { id: job.id, connectionId: connection.id, kind: "sync", status: "tan_required" },
        },
      ]);
      await banking.submitTan(db(), admin, { jobId: job.id, tan: " 123456 " });
      const done = await waitForJob(job.id, ["done", "error"], admin);
      expect(done).toMatchObject({ status: "done", newBookings: 2 });
      expect(await banking.listActiveJobs(db(), admin)).toEqual([]);
      expect(fints.state.tans).toEqual(["123456"]);
      // Stored banking information is reused, so the sync does not synchronize again.
      expect(fints.state.syncs).toBe(2);

      const [account] = await db().select().from(accounts).where(eq(accounts.name, "ING Giro"));
      expect(account).toMatchObject({ balanceCents: 1_250_000, balanceDate: "2026-11-15" });
      const [spotify] = await db().select().from(transactions).where(eq(transactions.counterparty, "Spotify AB"));
      const [abos] = await db().select().from(categories).where(eq(categories.name, "Abos & Medien"));
      expect(spotify).toMatchObject({ amountCents: -1999, bookingDate: "2026-11-02", source: "fints", categoryId: abos?.id });
      await expect(banking.submitTan(db(), admin, { jobId: job.id, tan: "1" })).rejects.toMatchObject({ status: 409 });
    });

    it("polls the bank until the app approval arrives", async () => {
      const connection = await fintsConnection();
      const job = await linkAndSync(connection.id);
      const done = await waitForJob(job.id, ["done", "error"], admin);
      expect(done).toMatchObject({ status: "done", newBookings: 2 });
      expect(fints.state.tans).toEqual([undefined, undefined, undefined]);
    });

    it("cancels an unattended sync that needs a TAN or app approval and tells the admins", async () => {
      const connection = await fintsConnection();
      await banking.linkAccount(db(), admin, {
        connectionId: connection.id,
        remoteRef: "DE02500105170137075030",
        newAccount: { name: "ING Giro" },
      });
      await notifications.savePreferences(db(), admin, {
        preferences: [{ kind: "bank_problem", enabled: true, push: false, email: false, threshold: 14 }],
      });
      await banking.setSyncSchedule(db(), admin, { enabled: true, times: ["08:00"] });
      const imported = (await db().select().from(transactions)).length;
      const [started] = await banking.runScheduledSyncs(db(), new Date(2026, 10, 16, 8, 0));
      const job = await waitForJob(started?.job?.id ?? "", ["cancelled", "done", "error"], admin);
      expect(job).toMatchObject({ status: "cancelled", message: t("de", "banking.job.approvalNeeded"), tan: null });
      expect((await banking.getJobView(db(), { ...admin, locale: "en" }, { jobId: job.id })).message).toBe(
        "Approval needed – please sync manually in Saldo",
      );
      expect(fints.state.tans).toEqual([]);
      expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "active", lastError: "" });
      expect(await db().select().from(transactions)).toHaveLength(imported);
      const { items } = await notifications.listNotifications(db(), admin);
      expect(items).toEqual([
        expect.objectContaining({
          kind: "bank_problem",
          title: `ING: ${t("de", "banking.job.approvalNeeded")}`,
          link: "/einstellungen/bankverbindungen",
        }),
      ]);
      expect((await notifications.listNotifications(db(), member)).items).toEqual([]);

      // A person starting the same sync still gets asked for the approval.
      const manual = await banking.syncConnection(db(), admin, { id: connection.id });
      expect((await waitForJob(manual.id, ["done", "error"], admin)).status).toBe("done");
    });

    it("cancels a job waiting for a TAN without marking the connection as failed", async () => {
      const connection = await fintsConnection();
      await banking.updateConnection(db(), admin, { id: connection.id, tanMechanism: "900" });
      const job = await linkAndSync(connection.id);
      await waitForJob(job.id, ["tan_required"], admin);
      await banking.cancelJob(db(), admin, { jobId: job.id });
      expect((await waitForJob(job.id, ["cancelled", "done", "error"], admin)).status).toBe("cancelled");
      expect((await banking.listConnections(db(), admin))[0]).toMatchObject({ status: "active", lastError: "" });
    });
  });

  it("keeps instance settings with superusers and each connection with those who manage it", async () => {
    const familyAdmin = await makeUser("mama", "familyAdmin");
    const otherMember = await makeUser("bruder", "member");
    const superuserOnly: (() => unknown)[] = [
      () => banking.setUnofficialProvider(db(), member, { provider: "givve", enabled: true, acknowledged: true }),
      () => banking.saveFintsSettings(db(), familyAdmin, { productId: "X1" }),
      () => banking.saveEnableBankingSettings(db(), familyAdmin, { appId: APP_ID, privateKey: PEM }),
      () => banking.recheckEnableBanking(db(), member),
      () => banking.setSyncSchedule(db(), familyAdmin, { enabled: true, times: ["08:00"] }),
    ];
    for (const call of superuserOnly) await expect(Promise.resolve().then(call)).rejects.toMatchObject({ status: 403 });
    const { created } = await authorizedConnection();
    expect((await banking.getBankingSettings(db(), member)).enableBanking).toEqual({ appId: null, keySet: true, check: null });
    expect((await banking.listEnableBankingBanks(db(), member, { country: "DE" })).length).toBeGreaterThan(0);

    // A member connects their own bank: private to them, the superuser sees it, nobody else does.
    const own = await banking.createConnection(db(), member, { name: "Meine Bank", enableBanking: { bankName: "ING", country: "DE" } });
    expect(own.connection).toMatchObject({ visibility: "private", owner: null });
    await expect(
      banking.createConnection(db(), member, { name: "x", visibility: "household", enableBanking: { bankName: "ING", country: "DE" } }),
    ).rejects.toMatchObject({ status: 403 });
    const names = async (viewer: Viewer) => (await banking.listConnections(db(), viewer)).map((c) => c.name).sort();
    expect(await names(member)).toEqual(["Meine Bank"]);
    expect(await names(admin)).toEqual(["DKB", "Meine Bank"]);
    expect(await names(familyAdmin)).toEqual(["DKB"]);
    expect(await names(otherMember)).toEqual([]);
    expect((await banking.listConnections(db(), admin)).find((c) => c.name === "Meine Bank")?.owner).toBe("kind");

    const household = created.connection.id;
    const calls: (() => unknown)[] = [
      () => banking.updateConnection(db(), member, { id: household, name: "x" }),
      () => banking.deleteConnection(db(), member, { id: household }),
      () => banking.authorizeConnection(db(), member, { id: household }),
      () => banking.discoverConnection(db(), member, { id: household }),
      () => banking.linkAccount(db(), member, { connectionId: household, remoteRef: "uid-1", newAccount: { name: "x" } }),
      () => banking.unlinkAccount(db(), member, { connectionId: household, accountId: 1 }),
      () => banking.syncConnection(db(), member, { id: household }),
      () => banking.updateConnection(db(), familyAdmin, { id: own.connection.id, name: "x" }),
      () => banking.syncConnection(db(), otherMember, { id: own.connection.id }),
      () => banking.getJobView(db(), member, { jobId: "x" }),
      () => banking.cancelJob(db(), member, { jobId: "x" }),
    ];
    for (const call of calls) await expect(Promise.resolve().then(call)).rejects.toMatchObject({ status: 404 });
    await expect(banking.submitTan(db(), member, { jobId: "x", tan: "1" })).rejects.toMatchObject({ status: 409 });
    expect(await banking.syncAll(db(), member)).toEqual([]);
    // The family admin manages household connections.
    expect((await banking.updateConnection(db(), familyAdmin, { id: household, name: "DKB Haushalt" })).name).toBe("DKB Haushalt");

    // Only the owner's login completes the owner's connection; the state of someone else's login is unknown here.
    const state = lastAuthState(eb.calls);
    await expect(
      banking.completeAuthorization(db(), otherMember, { redirectedUrl: `https://saldo.test/bank/callback?code=c&state=${state}` }),
    ).rejects.toMatchObject({ status: 400 });
    const own2 = await banking.completeAuthorization(db(), member, {
      redirectedUrl: `https://saldo.test/bank/callback?code=c&state=${state}`,
    });
    // The bank's only account already comes through the household connection, so there is nothing to fetch.
    expect(own2).toMatchObject({
      job: null,
      tone: "ok",
      message: "„Meine Bank“ ist freigegeben. Alle Konten kommen bereits über andere Bankverbindungen.",
    });
    const linked = await banking.linkAccount(db(), member, {
      connectionId: own.connection.id,
      remoteRef: "uid-1",
      newAccount: { name: "Mein Giro" },
    });
    const [account] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.id, linked.linkedAccounts[0]?.id ?? -1));
    expect(account).toMatchObject({ ownerUserId: member.id, visibility: "private" });
  });

  it("keeps a private account on a household connection out of reach of other managers of that connection", async () => {
    const familyAdmin = await makeUser("mama", "familyAdmin");
    const { created } = await authorizedConnection();
    const household = created.connection.id;
    const [giro] = await db().select().from(accounts).where(eq(accounts.connectionId, household));
    const privateId = giro?.id ?? -1;
    await db().update(accounts).set({ visibility: "private" }).where(eq(accounts.id, privateId));

    const view = (await banking.listConnections(db(), familyAdmin)).find((c) => c.id === household);
    expect(view?.linkedAccounts).toEqual([]);
    expect(view?.remoteAccounts).toEqual([]);
    const job = await banking.syncConnection(db(), admin, { id: household });
    const done = await waitForJob(job.id, ["done", "error"], familyAdmin);
    expect(done.accounts).toEqual([]);
    expect(done.message).not.toContain("Girokonto");

    const own = await createAccount(db(), familyAdmin, {
      name: "Mein Konto",
      bank: "x",
      kind: "checking",
      color: "#000000",
      visibility: "private",
    });
    await expect(
      banking.linkAccount(db(), familyAdmin, { connectionId: household, remoteRef: "uid-1", accountId: own }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      banking.linkAccount(db(), familyAdmin, { connectionId: household, remoteRef: "uid-1", newAccount: { name: "Kopie" } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(banking.unlinkAccount(db(), familyAdmin, { connectionId: household, accountId: privateId })).rejects.toMatchObject({
      status: 404,
    });
    const [still] = await db().select().from(accounts).where(eq(accounts.id, privateId));
    expect(still).toMatchObject({ connectionId: household, remoteRef: "uid-1" });
    // The owner still relinks and unlinks as before.
    await banking.unlinkAccount(db(), admin, { connectionId: household, accountId: privateId });
    await banking.linkAccount(db(), admin, { connectionId: household, remoteRef: "uid-1", accountId: privateId });
  });

  it("turns every account the bank delivers into a Saldo account once, reusing an unlinked one with the same IBAN", async () => {
    await setupEnableBanking();
    const created = await banking.createConnection(db(), member, { name: "Meine Bank", enableBanking: { bankName: "ING", country: "DE" } });
    const twinIban = "DE89370400440532013000";
    const [twin] = await db()
      .insert(accounts)
      .values({ name: "Altes Giro", bank: "ing", kind: "checking", iban: twinIban, ownerUserId: member.id, visibility: "private" })
      .returning({ id: accounts.id });
    await db()
      .update(bankConnections)
      .set({
        remoteAccounts: [
          { ref: "r-giro", iban: twinIban, name: "Girokonto", currency: "EUR" },
          { ref: "r-card", iban: null, name: "Konto", currency: "EUR", type: "CARD" },
          { ref: "r-save", iban: "DE02100100100006820101", name: "Extra-Konto Tagesgeld", currency: "EUR" },
        ],
      })
      .where(eq(bankConnections.id, created.connection.id));
    expect(await banking.adoptRemoteAccounts(db(), created.connection.id, member)).toBe(3);
    expect(await banking.adoptRemoteAccounts(db(), created.connection.id, member)).toBe(0);
    const rows = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.connectionId, created.connection.id))
      .orderBy(asc(accounts.remoteRef));
    expect(rows.map((a) => [a.remoteRef, a.name, a.kind, a.ownerUserId === member.id, a.visibility])).toEqual([
      ["r-card", "Meine Bank", "credit_card", true, "private"],
      ["r-giro", "Altes Giro", "checking", true, "private"],
      ["r-save", "Extra-Konto Tagesgeld", "savings", true, "private"],
    ]);
    expect(rows.find((a) => a.remoteRef === "r-giro")?.id).toBe(twin?.id);
  });

  it("explains a bank that the restricted app has not linked yet, and passes other provider errors on", async () => {
    await setupEnableBanking();
    await banking.createConnection(db(), member, { name: "Meine Bank", enableBanking: { bankName: "ING", country: "DE" } });
    eb.state.sessionError = {
      status: 422,
      body: { error: "ACCOUNTS_NOT_LINKED", message: "Accounts have not been linked to the application" },
    };
    const complete = () =>
      banking.completeAuthorization(db(), member, {
        redirectedUrl: `https://saldo.test/bank/callback?code=c&state=${lastAuthState(eb.calls)}`,
      });
    await expect(complete()).rejects.toMatchObject({ message: expect.stringContaining("Link accounts") });
    expect((await banking.listConnections(db(), member))[0]?.lastError).toContain("Control-Panel");

    await banking.authorizeConnection(db(), member, { id: (await banking.listConnections(db(), member))[0]?.id ?? -1 });
    eb.state.sessionError = { status: 400, body: { error: "WRONG_CODE", message: "Authorization code is invalid" } };
    await expect(complete()).rejects.toMatchObject({ message: expect.stringContaining("Authorization code is invalid") });
    await expect(
      banking.completeAuthorization(db(), member, {
        redirectedUrl:
          "https://saldo.test/bank/callback?error=access_denied&error_description=Account%20not%20linked%20to%20this%20application",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Link accounts") });
  });
});

describe("Psu headers", () => {
  const request = (peer: string, forwarded: string) => {
    const r = new Request("https://saldo.test/", { headers: { "x-forwarded-for": forwarded, "user-agent": "UA" } });
    Object.defineProperty(r, "ip", { value: peer });
    return r;
  };
  const off = { fixed: "", lookup: false };
  afterEach(() => {
    banking.resetPsuIpCache();
    banking.setBankingDepsForTests({});
  });

  it("passes a public client address and never a home-network or container address", async () => {
    // The forwarded claim is ignored without a trusted proxy: the socket peer is the client.
    expect(await banking.psuHeaders(request("203.0.113.7", "198.51.100.9"))).toEqual({
      "Psu-Ip-Address": "203.0.113.7",
      "Psu-User-Agent": "UA",
    });
    for (const ip of ["192.168.1.20", "172.18.0.1", "10.1.2.3", "127.0.0.1", "::1", "fd12:3456::1", "::ffff:192.168.65.1"]) {
      expect(await banking.resolvePsuIp(ip, off)).toBeNull();
    }
  });

  it("uses the configured or looked-up public address of the household behind a private one", async () => {
    expect(await banking.resolvePsuIp("192.168.1.20", { fixed: "198.51.100.4", lookup: true })).toBe("198.51.100.4");
    let lookups = 0;
    banking.setBankingDepsForTests({
      fetch: (async () => {
        lookups += 1;
        return new Response("198.51.100.9\n");
      }) as typeof fetch,
    });
    expect(await banking.resolvePsuIp("192.168.1.20", { fixed: "", lookup: true })).toBe("198.51.100.9");
    expect(await banking.resolvePsuIp("10.0.0.1", { fixed: "", lookup: true })).toBe("198.51.100.9");
    expect(lookups).toBe(1);
    banking.resetPsuIpCache();
    banking.setBankingDepsForTests({ fetch: (async () => new Response("10.0.0.1")) as typeof fetch });
    expect(await banking.resolvePsuIp("192.168.1.20", { fixed: "", lookup: true })).toBeNull();
  });
});
