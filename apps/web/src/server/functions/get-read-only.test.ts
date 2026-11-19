import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, db, schema } from "../db/index.ts";
import { chatConversations, transactions } from "../db/schema.ts";
import { env } from "../env.ts";
import type { Viewer } from "../modules/access/index.ts";
import {
  accountBookings,
  accountDetail,
  accountsOverview,
  balanceTimeline,
  createAccount,
  createGroup,
  getAccountSharing,
  listAccounts,
  listGroups,
} from "../modules/accounts/index.ts";
import {
  aiStatus,
  getAiSettings,
  getChatRetention,
  getConversation,
  listAnalyses,
  listConversations,
  listProviders,
  providerPresets,
  usageSummary,
} from "../modules/ai/index.ts";
import { listAuditEvents } from "../modules/audit/index.ts";
import { avatarUrlOf, readAvatar, setAvatar } from "../modules/avatars/index.ts";
import { getBackupOverview, listTargetArchives } from "../modules/backup/index.ts";
import { getBankingSettings, getJobView, listConnections, listEnableBankingBanks } from "../modules/banking/index.ts";
import * as catalog from "../modules/catalog/index.ts";
import {
  contractDraftFromBooking,
  contractForecast,
  contractSuggestionOverview,
  contractsOverview,
  contractViewShareCoverage,
  getContract,
  listContractViews,
  saveContract,
  unseenDueCount,
} from "../modules/contracts/index.ts";
import { listDashboards } from "../modules/dashboards/index.ts";
import { listTokens, mcpInfo } from "../modules/mcp/index.ts";
import { getMailSettings, getNotificationSettings, listNotifications, unreadNotificationCount } from "../modules/notifications/index.ts";
import { listSavedFilters } from "../modules/saved-filters/index.ts";
import * as stats from "../modules/stats/index.ts";
import { listTasks } from "../modules/tasks/index.ts";
import { listPendingBookings, listTransactions } from "../modules/transactions/index.ts";
import { listPeople, listUsers } from "../modules/users/index.ts";
import { makeUser, resetDb } from "../test-helpers.ts";

/** Every GET server function declared in this folder, read from the source so a new one cannot be left out below. */
function declaredGetFunctions(): string[] {
  const dir = new URL(".", import.meta.url);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) => [
      ...readFileSync(new URL(file, dir), "utf8").matchAll(/export const (\w+) = createServerFn\(\{ method: "GET" \}\)/g),
    ])
    .map((match) => match[1] ?? "")
    .sort();
}

type Fixture = { accountId: number; groupId: number; transactionId: number; contractId: number; conversationId: number };
type Case = (db: Db, viewer: Viewer, f: Fixture) => Promise<unknown>;

const RANGE = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };

/** The module call behind each GET server function, with a typical input. */
const CASES: Record<string, Case> = {
  getAccounts: (db, v) => listAccounts(db, v),
  getGroups: (db, v) => listGroups(db, v),
  getAccountsOverviewFn: (db, v) => accountsOverview(db, v, null),
  getAccountDetailFn: (db, v, f) => accountDetail(db, v, { accountId: f.accountId }),
  getBalanceTimelineFn: (db, v, f) => balanceTimeline(db, v, { accountId: f.accountId }),
  getAccountBookingsFn: (db, v, f) => accountBookings(db, v, { accountId: f.accountId }),
  getAccountSharingFn: (db, v, f) => getAccountSharing(db, v, f.accountId),
  getAiProviders: (db, v) => listProviders(db, v),
  getAiPresets: async (_db, v) => providerPresets(v.locale ?? "de"),
  getAiUsage: (db, v) => usageSummary(db, v, RANGE),
  getAiStatus: (db, v) => aiStatus(db, v),
  getAnalyses: (db, v) => listAnalyses(db, v, {}),
  getAiSettingsFn: (db, v) => getAiSettings(db, v),
  getChatConversationsFn: (db, v) => listConversations(db, v),
  getChatConversationFn: (db, v, f) => getConversation(db, v, { id: f.conversationId }),
  getChatRetentionFn: (db, v) => getChatRetention(db, v),
  getAuditEventsFn: (db, v) => listAuditEvents(db, v, {}),
  getBackupOverviewFn: (db, v) => getBackupOverview(db, v),
  getBackupArchivesFn: (db, v) => listTargetArchives(db, v, { targetId: 999_999 }),
  getBankingSettingsFn: (db, v) => getBankingSettings(db, v),
  getEnableBankingBanksFn: (db, v) => listEnableBankingBanks(db, v, { country: "DE" }),
  getBankConnectionsFn: (db, v) => listConnections(db, v),
  getBankJobFn: (db, v) => getJobView(db, v, { jobId: "unknown" }),
  getCategories: (db) => catalog.listCategories(db),
  getTags: (db) => catalog.listTags(db),
  getTagOverview: (db, v) => catalog.tagOverview(db, v),
  getRules: (db, v) => catalog.listRules(db, v),
  getContractsFn: (db, v) => contractsOverview(db, v, {}),
  getContractSuggestionsFn: (db, v) => contractSuggestionOverview(db, v, {}),
  getContractViewsFn: (db, v) => listContractViews(db, v),
  getContractViewShareCoverageFn: (db, v) => contractViewShareCoverage(db, v, { accountIds: [] }),
  getUnseenDueCountFn: (db, v) => unseenDueCount(db, v),
  getContractFn: (db, v, f) => getContract(db, v, f.contractId),
  getContractDraftFn: (db, v, f) => contractDraftFromBooking(db, v, f.transactionId),
  getContractForecastFn: (db, v) => contractForecast(db, v, RANGE),
  getDashboards: (db, v) => listDashboards(db, v),
  getMcpInfo: async () => mcpInfo(),
  getMcpTokens: (db, v) => listTokens(db, v),
  getNotificationSettingsFn: (db, v) => getNotificationSettings(db, v),
  getNotificationsFn: (db, v) => listNotifications(db, v, {}),
  getUnreadNotificationCountFn: (db, v) => unreadNotificationCount(db, v),
  getMailSettingsFn: (db, v) => getMailSettings(db, v),
  getSavedFiltersFn: (db, v) => listSavedFilters(db, v, { scope: "transactions" }),
  getSessionState: (db, v) => Promise.all([listGroups(db, v), avatarUrlOf(db, v.id)]),
  getSummary: (db, v) => stats.summary(db, v, RANGE),
  getMonthly: (db, v) => stats.monthly(db, v, RANGE),
  getCategoryTotals: (db, v) => stats.categoryTotals(db, v, RANGE, "expense"),
  getSeries: (db, v) => stats.series(db, v, RANGE, "category", []),
  getTopCounterparties: (db, v) => stats.topCounterparties(db, v, RANGE, 10),
  getRecurring: (db, v) => stats.recurringPayments(db, v, RANGE),
  getBalances: (db, v) => stats.balances(db, v, null),
  getTasksFn: (db, v) => listTasks(db, v),
  getTransactions: (db, v) => listTransactions(db, v, {}),
  getPendingBookingsFn: (db, v, f) => listPendingBookings(db, v, { accountId: f.accountId }),
  getUsers: (db, v) => listUsers(db, v),
  getPeopleFn: (db, v) => listPeople(db, v),
};

/** Refused for a superuser, too, without touching the database: no bank access is set up, the job or target does not exist. */
const REJECTS = new Set(["getEnableBankingBanksFn", "getBankJobFn", "getBackupArchivesFn"]);

/** PostgreSQL's "cannot execute … in a read-only transaction", possibly wrapped by Drizzle. */
function wroteSomething(error: unknown): boolean {
  let e: unknown = error;
  while (e && typeof e === "object") {
    if ((e as { code?: unknown }).code === "25006") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

describe("GET server functions", () => {
  // Every statement on this connection runs in a read-only transaction, so any INSERT, UPDATE or DELETE fails.
  const client = postgres(env().DATABASE_URL, { max: 1, onnotice: () => {}, connection: { default_transaction_read_only: true } });
  const readOnly: Db = drizzle(client, { schema });
  let superuser: Viewer;
  let member: Viewer;
  let fixture: Fixture;

  beforeAll(async () => {
    await resetDb();
    superuser = { ...(await makeUser("admin", "superuser")), locale: "de" };
    const groupId = await createGroup(db(), superuser, { name: "Haushalt" });
    member = { ...(await makeUser("kind", "member", [groupId])), locale: "de" };
    const accountId = await createAccount(db(), superuser, {
      name: "Giro",
      bank: "dkb",
      kind: "checking",
      color: "#1f6f5c",
      groupIds: [groupId],
    });
    const [booking] = await db()
      .insert(transactions)
      .values({ accountId, externalId: "x-1", source: "test", bookingDate: "2026-11-03", amountCents: -1_299, counterparty: "Netflix" })
      .returning({ id: transactions.id });
    const contractId = await saveContract(db(), superuser, {
      name: "Netflix",
      direction: "expense",
      amountCents: 1_299,
      interval: "monthly",
      nextDue: "2026-12-03",
      accountId,
      matchPayee: "netflix",
      tolerancePercent: 5,
    });
    const [conversation] = await db()
      .insert(chatConversations)
      .values({ userId: superuser.id, title: "Netflix?" })
      .returning({ id: chatConversations.id });
    fixture = { accountId, groupId, transactionId: booking?.id ?? -1, contractId, conversationId: conversation?.id ?? -1 };
  });

  afterAll(() => client.end({ timeout: 5 }));

  it("are all covered here", () => {
    expect(Object.keys(CASES).sort()).toEqual(declaredGetFunctions());
  });

  it("the read-only connection refuses writes", async () => {
    await expect(
      readOnly
        .insert(transactions)
        .values({ accountId: fixture.accountId, externalId: "x-2", source: "test", bookingDate: "2026-11-04", amountCents: 1 }),
    ).rejects.toSatisfy(wroteSomething);
  });

  it("the picture route never writes", async () => {
    await setAvatar(db(), member, member.id, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
    for (const viewer of [superuser, member]) {
      await expect(readAvatar(readOnly, viewer, member.id)).resolves.toMatchObject({ contentType: "image/png" });
      await expect(readAvatar(readOnly, viewer, superuser.id)).rejects.toMatchObject({ status: 404 });
    }
  });

  it.each(Object.keys(CASES))("%s never writes, even for someone without dashboards or a push key yet", async (name) => {
    const run = CASES[name] as Case;
    for (const viewer of [superuser, member]) {
      const outcome = await run(readOnly, viewer, fixture).then(
        () => null,
        (error: unknown) => error,
      );
      expect(wroteSomething(outcome), `${name} as ${viewer.role}: ${String(outcome)}`).toBe(false);
      if (viewer === superuser && !REJECTS.has(name)) expect(outcome, `${name} as superuser`).toBeNull();
    }
  });
});
