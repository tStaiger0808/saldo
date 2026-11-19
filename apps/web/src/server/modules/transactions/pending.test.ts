import type { RawPendingBooking } from "@saldo/banking";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountGroupMembers, accountGroups, accounts, categories, pendingTransactions, tags, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { accountBookings, accountDetail, accountsOverview, balanceTimeline } from "../accounts/index.ts";
import { contractSuggestions, listContracts } from "../contracts/index.ts";
import * as stats from "../stats/index.ts";
import { toolsFor } from "../tools/index.ts";
import { dropPendingBookings, exportCsv, listPendingBookings, listTransactions, replacePendingBookings } from "./index.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const FETCHED = new Date("2026-11-15T07:00:00Z");

const pending = (amountCents: number, counterparty: string, extra: Partial<RawPendingBooking> = {}): RawPendingBooking => ({
  bookingDate: "2026-11-14",
  valueDate: null,
  amountCents,
  currency: "EUR",
  counterparty,
  purpose: "Kartenzahlung",
  ...extra,
});

async function account(name: string, ownerUserId: string, visibility: "household" | "private" = "household") {
  const [row] = await db()
    .insert(accounts)
    .values({ name, bank: "Testbank", kind: "checking", ownerUserId, visibility, balanceCents: 1000_00, balanceDate: "2026-11-14" })
    .returning({ id: accounts.id });
  return row?.id ?? -1;
}

async function group(name: string, accountIds: number[]) {
  const [row] = await db().insert(accountGroups).values({ name, position: 0 }).returning({ id: accountGroups.id });
  const id = row?.id ?? -1;
  await db()
    .insert(accountGroupMembers)
    .values(accountIds.map((accountId) => ({ accountId, groupId: id })));
  return id;
}

describe("pending bookings", () => {
  let admin: Viewer;
  let member: Viewer;
  let owner: Viewer;
  let ids: { giro: number; joint: number; secret: number };
  let household: number;
  let categoryId: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    const giro = await account("Giro", admin.id);
    const joint = await account("Gemeinsam", admin.id);
    household = await group("Haushalt", [giro]);
    const shared = await group("Gemeinschaft", [joint]);
    member = await makeUser("kind", "member", [shared]);
    owner = await makeUser("oma", "member");
    const secret = await account("Omas Konto", owner.id, "private");
    ids = { giro, joint, secret };
    const [category] = await db().select({ id: categories.id }).from(categories).limit(1);
    categoryId = category?.id ?? -1;
    await db()
      .insert(transactions)
      .values([
        { accountId: giro, externalId: "a", source: "test", bookingDate: "2026-11-02", amountCents: 2500_00, counterparty: "Arbeitgeber" },
        {
          accountId: giro,
          externalId: "b",
          source: "test",
          bookingDate: "2026-11-05",
          amountCents: -45_00,
          counterparty: "REWE",
          categoryId,
          categorySource: "manual",
          isUnread: false,
        },
        { accountId: joint, externalId: "c", source: "test", bookingDate: "2026-11-06", amountCents: -900_00, counterparty: "Vermieter" },
      ]);
  });

  async function announce() {
    await replacePendingBookings(
      db(),
      ids.giro,
      [pending(-34_56, "Bio-Laden Sonthofen"), pending(-19_99, "", { purpose: "VISA AMAZON EU", bookingDate: null })],
      FETCHED,
    );
    await replacePendingBookings(db(), ids.joint, [pending(-12_00, "Bäckerei Müller")], FETCHED);
    await replacePendingBookings(db(), ids.secret, [pending(-500_00, "Juwelier")], FETCHED);
  }

  it("keeps exactly the bank's latest list per account and cleans it like bookings", async () => {
    await announce();
    const first = await listPendingBookings(db(), admin, { accountId: ids.giro });
    expect(first).toEqual({
      hidden: 0,
      items: [
        // Undated ones first: the bank has not even dated them yet.
        expect.objectContaining({ bookingDate: null, amountCents: -19_99, counterparty: "", purpose: "VISA AMAZON EU" }),
        expect.objectContaining({ bookingDate: "2026-11-14", amountCents: -34_56, counterparty: "Bio-Laden Sonthofen" }),
      ],
    });
    // Booked meanwhile: the bank lists only the other one, and the next sync replaces the list.
    await replacePendingBookings(
      db(),
      ids.giro,
      [pending(-19_99, "AMAZON", { currency: " eur ", purpose: "  VISA \n AMAZON " }), pending(Number.MAX_SAFE_INTEGER + 2, "Kaputt")],
      FETCHED,
    );
    const second = await listPendingBookings(db(), admin, { accountId: ids.giro });
    expect(second.items).toEqual([
      expect.objectContaining({ amountCents: -19_99, currency: "EUR", counterparty: "AMAZON", purpose: "VISA AMAZON" }),
    ]);
    await replacePendingBookings(db(), ids.giro, [], FETCHED);
    expect((await listPendingBookings(db(), admin, { accountId: ids.giro })).items).toEqual([]);
    // The other accounts' lists stay as they were.
    expect((await listPendingBookings(db(), admin, {})).items.map((p) => p.counterparty)).toEqual(["Juwelier", "Bäckerei Müller"]);
    await dropPendingBookings(db(), [ids.joint, ids.secret]);
    expect(await db().select().from(pendingTransactions)).toEqual([]);
  });

  it("shows only pending bookings of accounts the viewer may see", async () => {
    await announce();
    expect((await listPendingBookings(db(), member, {})).items.map((p) => p.counterparty)).toEqual(["Bäckerei Müller"]);
    await expect(listPendingBookings(db(), member, { accountId: ids.giro })).rejects.toMatchObject({ status: 404 });
    await expect(listPendingBookings(db(), member, { groupId: household })).rejects.toMatchObject({ status: 404 });
    expect((await listPendingBookings(db(), owner, {})).items.map((p) => p.counterparty)).toEqual(["Juwelier"]);
    await expect(listPendingBookings(db(), owner, { accountId: ids.giro })).rejects.toMatchObject({ status: 404 });
    expect((await listPendingBookings(db(), admin, { groupId: household })).items).toHaveLength(2);
    expect((await listPendingBookings(db(), admin, {})).items).toHaveLength(4);
  });

  it("follows search, period and amount filters and steps aside for filters it cannot match", async () => {
    await announce();
    const names = async (filters: Parameters<typeof listPendingBookings>[2]) =>
      (await listPendingBookings(db(), admin, { accountId: ids.giro, ...filters })).items.map((p) => p.amountCents);
    expect(await names({ q: "bio-laden" })).toEqual([-34_56]);
    expect(await names({ q: "amazon" })).toEqual([-19_99]);
    expect(await names({ dateFrom: "2026-11-01", dateTo: "2026-11-30" })).toEqual([-34_56]);
    expect(await names({ absMinCents: 20_00 })).toEqual([-34_56]);
    expect(await names({ minAmountCents: 1 })).toEqual([]);
    expect(await names({ includeTransfers: false })).toEqual([-19_99, -34_56]);
    const [tag] = await db().insert(tags).values({ name: "Urlaub", color: "#123456" }).returning({ id: tags.id });
    for (const filter of [{ categoryId }, { tagId: tag?.id }, { uncategorized: true }, { unread: true }, { aiSuggested: true }]) {
      expect(await listPendingBookings(db(), admin, { accountId: ids.giro, ...filter })).toEqual({ items: [], hidden: 2 });
    }
    expect(await listPendingBookings(db(), admin, { accountId: ids.giro, unread: true, q: "bio" })).toEqual({ items: [], hidden: 1 });
  });

  it("are counted nowhere: balances, totals, unread, timeline, statistics, contracts, export and AI tools stay the same", async () => {
    const range = { dateFrom: "2026-01-01", dateTo: "2026-11-30" };
    const tools = toolsFor("mcp");
    const snapshot = async () => {
      const toolResults: Record<string, unknown> = {};
      for (const tool of tools) {
        toolResults[tool.name] = await tool.run({ db: db(), viewer: admin, audience: "mcp", groupId: null }, {}).then(
          (result) => result.data,
          (error: Error) => error.message,
        );
      }
      return {
        list: await listTransactions(db(), admin, {}),
        giro: await accountBookings(db(), admin, { accountId: ids.giro }),
        detail: await accountDetail(db(), admin, { accountId: ids.giro }, NOW),
        overview: await accountsOverview(db(), admin, null, NOW),
        timeline: await balanceTimeline(db(), admin, {}, NOW),
        giroTimeline: await balanceTimeline(db(), admin, { accountId: ids.giro }, NOW),
        summary: await stats.summary(db(), admin, range),
        monthly: await stats.monthly(db(), admin, range),
        balances: await stats.balances(db(), admin, null),
        counterparties: await stats.topCounterparties(db(), admin, range, 10),
        contracts: await listContracts(db(), admin, {}),
        suggestions: await contractSuggestions(db(), admin, {}),
        csv: await exportCsv(db(), admin, {}),
        tools: toolResults,
      };
    };
    const before = await snapshot();
    await announce();
    expect(await db().select().from(pendingTransactions)).toHaveLength(4);
    expect(await snapshot()).toEqual(before);
    expect(before.list.totals).toMatchObject({ count: 3, incomeCents: 2500_00, expenseCents: -945_00 });
    expect(before.list.unread).toBe(2);
    expect(before.csv).not.toContain("Bio-Laden");
  });
});
