import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountGroupMembers, accountGroups, accounts, categories, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { listTransactions } from "./index.ts";

type Booking = Partial<typeof transactions.$inferInsert> & { amountCents: number };

async function account(name: string, ownerUserId: string) {
  const [row] = await db()
    .insert(accounts)
    .values({ name, bank: "Testbank", kind: "checking", ownerUserId })
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

async function book(accountId: number, list: Booking[]) {
  await db()
    .insert(transactions)
    .values(
      list.map((b, i) => ({
        externalId: `t-${accountId}-${i}`,
        source: "test",
        bookingDate: "2026-11-10",
        counterparty: "Laden",
        isUnread: false,
        ...b,
        accountId,
      })),
    );
}

describe("booking totals and quick filter counts", () => {
  let admin: Viewer;
  let member: Viewer;
  let ids: { giro: number; savings: number; joint: number };
  let household: number;
  let joint: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    const giro = await account("Giro", admin.id);
    const savings = await account("Tagesgeld", admin.id);
    const jointAccount = await account("Gemeinsam", admin.id);
    ids = { giro, savings, joint: jointAccount };
    household = await group("Haushalt", [giro, savings]);
    joint = await group("Gemeinschaft", [jointAccount]);
    member = await makeUser("kind", "member", [joint]);
    const [category] = await db().select({ id: categories.id }).from(categories).limit(1);
    const categoryId = category?.id ?? null;
    await book(giro, [
      { amountCents: 1000_00, counterparty: "Arbeitgeber", isUnread: true, bookingDate: "2026-11-01" },
      { amountCents: -200_00, categoryId, categorySource: "manual" },
      { amountCents: -50_00, categoryId, categorySource: "ai", isUnread: true },
      { amountCents: -300_00, isTransfer: true, transferAccountId: savings, purpose: "Sparen" },
    ]);
    await book(savings, [{ amountCents: 300_00, isTransfer: true, transferAccountId: giro, purpose: "Sparen" }]);
    await book(jointAccount, [{ amountCents: -80_00, categoryId, categorySource: "rule", bookingDate: "2026-10-20" }]);
  });

  it("sums all matching bookings, not only the page, and leaves internal transfers out like the statistics", async () => {
    const page = await listTransactions(db(), admin, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.totals).toEqual({
      count: 6,
      incomeCents: 1000_00,
      expenseCents: -330_00,
      sumCents: 670_00,
      internalTransfers: 2,
    });
  });

  it("follows the filters: period, search, direction and account", async () => {
    const november = await listTransactions(db(), admin, { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    expect(november.totals).toMatchObject({ count: 5, expenseCents: -250_00 });
    const salary = await listTransactions(db(), admin, { q: "arbeitgeber" });
    expect(salary.totals).toMatchObject({ count: 1, incomeCents: 1000_00, expenseCents: 0, sumCents: 1000_00 });
    const outgoing = await listTransactions(db(), admin, { maxAmountCents: -1 });
    expect(outgoing.totals).toMatchObject({ count: 4, incomeCents: 0, expenseCents: -330_00, internalTransfers: 1 });
    const giro = await listTransactions(db(), admin, { accountId: ids.giro });
    expect(giro.totals).toMatchObject({ count: 4, incomeCents: 1000_00, expenseCents: -250_00, internalTransfers: 1 });
  });

  it("counts a transfer leaving the selected group as an expense", async () => {
    const view = await listTransactions(db(), admin, { groupId: joint });
    expect(view.totals).toMatchObject({ count: 1, expenseCents: -80_00, internalTransfers: 0 });
    const own = await listTransactions(db(), admin, { groupId: household });
    expect(own.totals).toMatchObject({ count: 5, incomeCents: 1000_00, expenseCents: -250_00, internalTransfers: 2 });
    const onlyGiro = await group("Nur Giro", [ids.giro]);
    const leaving = await listTransactions(db(), admin, { groupId: onlyGiro });
    expect(leaving.totals).toMatchObject({ count: 4, incomeCents: 1000_00, expenseCents: -550_00, internalTransfers: 0 });
  });

  it("only sums what the viewer may see", async () => {
    const visible = await listTransactions(db(), member, {});
    expect(visible.totals).toEqual({ count: 1, incomeCents: 0, expenseCents: -80_00, sumCents: -80_00, internalTransfers: 0 });
    expect(visible.quick).toEqual({ all: 1, unread: 0, uncategorized: 0, aiSuggested: 0 });
    await expect(listTransactions(db(), member, { groupId: household })).rejects.toMatchObject({ status: 404 });
  });

  it("counts the quick filters with the other filters applied and filters by AI suggestions", async () => {
    const all = await listTransactions(db(), admin, {});
    expect(all.quick).toEqual({ all: 6, unread: 2, uncategorized: 1, aiSuggested: 1 });
    // The active quick filter does not change the counts of the others.
    const unread = await listTransactions(db(), admin, { unread: true });
    expect(unread.total).toBe(2);
    expect(unread.quick).toEqual(all.quick);
    const ai = await listTransactions(db(), admin, { aiSuggested: true });
    expect(ai.items.map((t) => t.amountCents)).toEqual([-50_00]);
    const inOctober = await listTransactions(db(), admin, { dateTo: "2026-10-31" });
    expect(inOctober.quick).toEqual({ all: 1, unread: 0, uncategorized: 0, aiSuggested: 0 });
  });
});
