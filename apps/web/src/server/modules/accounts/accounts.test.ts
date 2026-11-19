import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountGroupMembers, accountGroups, accounts, bankConnections, transactions, user } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { accountBookings, accountDetail, accountsOverview, connectionAttention } from "./index.ts";

const NOW = new Date("2026-11-16T10:00:00Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

/** Owned by the first user unless said otherwise. */
async function account(values: Partial<typeof accounts.$inferInsert> & { name: string }) {
  const [owner] = await db().select({ id: user.id }).from(user).limit(1);
  const [row] = await db()
    .insert(accounts)
    .values({ bank: "Testbank", kind: "checking", ownerUserId: owner?.id ?? "", ...values })
    .returning({ id: accounts.id });
  return row?.id ?? -1;
}

async function group(name: string, position: number, accountIds: number[]) {
  const [row] = await db().insert(accountGroups).values({ name, position }).returning({ id: accountGroups.id });
  const id = row?.id ?? -1;
  await db()
    .insert(accountGroupMembers)
    .values(accountIds.map((accountId) => ({ accountId, groupId: id })));
  return id;
}

async function bookings(accountId: number, list: [date: string, cents: number, counterparty?: string][]) {
  await db()
    .insert(transactions)
    .values(
      list.map(([bookingDate, amountCents, counterparty = "Laden"], i) => ({
        accountId,
        externalId: `t-${accountId}-${i}`,
        source: "test",
        bookingDate,
        amountCents,
        counterparty,
      })),
    );
}

describe("accounts overview", () => {
  let admin: Viewer;
  let ids: { giro: number; joint: number; savings: number; card: number; cash: number };
  let groups: { mine: number; shared: number };
  let connection: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    const [c] = await db()
      .insert(bankConnections)
      .values({
        name: "DKB",
        provider: "enable_banking",
        bank: "dkb",
        status: "active",
        ciphertext: "x",
        consentValidUntil: inDays(5),
        ownerUserId: admin.id,
      })
      .returning({ id: bankConnections.id });
    connection = c?.id ?? -1;
    ids = {
      giro: await account({
        name: "Giro",
        iban: "DE02120300000000202051",
        balanceCents: 150_000,
        balanceDate: "2026-11-16",
        connectionId: connection,
      }),
      joint: await account({ name: "Gemeinsam", balanceCents: 50_000, balanceDate: "2026-11-15" }),
      savings: await account({ name: "Tagesgeld", kind: "savings", balanceCents: 1_000_000, connectionId: connection }),
      card: await account({ name: "Visa", kind: "credit_card", balanceCents: -30_000 }),
      cash: await account({ name: "Bargeld", kind: "checking" }),
    };
    groups = {
      mine: await group("Meine Konten", 0, [ids.giro, ids.savings, ids.card, ids.joint]),
      shared: await group("Gemeinschaft", 1, [ids.joint]),
    };
  });

  it("sections by group, bank and kind with subtotals, counting shared accounts once in the total", async () => {
    const overview = await accountsOverview(db(), admin, null, NOW);
    expect(overview.totalCents).toBe(150_000 + 50_000 + 1_000_000 - 30_000);
    expect(overview.withoutBalance).toBe(1);
    expect(overview.sections.group.map((s) => [s.type, s.name, s.accountIds.length, s.subtotalCents])).toEqual([
      ["group", "Meine Konten", 4, 1_170_000],
      ["group", "Gemeinschaft", 1, 50_000],
      ["ungrouped", "", 1, 0],
    ]);
    expect(overview.sections.bank.map((s) => [s.type, s.name, s.accountIds.length, s.subtotalCents])).toEqual([
      ["bank", "DKB", 2, 1_150_000],
      ["manual", "", 3, 20_000],
    ]);
    expect(overview.sections.kind.map((s) => [s.name, s.subtotalCents])).toEqual([
      ["checking", 200_000],
      ["savings", 1_000_000],
      ["credit_card", -30_000],
    ]);
    const giro = overview.accounts.find((a) => a.id === ids.giro);
    expect(giro).toMatchObject({ bankName: "DKB", ibanLast4: "2051", connection: { attention: "expiring" } });
    expect(JSON.stringify(overview)).not.toContain("DE02120300000000202051");
  });

  it("limits a group view to that group's section", async () => {
    const overview = await accountsOverview(db(), admin, groups.shared, NOW);
    expect(overview.accounts.map((a) => a.name)).toEqual(["Gemeinsam"]);
    expect(overview.sections.group.map((s) => s.name)).toEqual(["Gemeinschaft"]);
    expect(overview.totalCents).toBe(50_000);
  });

  it("shows members only the accounts of their groups and hides others as 404", async () => {
    const member = await makeUser("partnerin", "member", [groups.shared]);
    const overview = await accountsOverview(db(), member, null, NOW);
    expect(overview.accounts.map((a) => a.id)).toEqual([ids.joint]);
    expect(overview.sections.group.map((s) => s.name)).toEqual(["Gemeinschaft"]);
    await expect(accountsOverview(db(), member, groups.mine, NOW)).rejects.toMatchObject({ status: 404 });
    const range = { dateFrom: "2026-11-01", dateTo: "2026-11-16" };
    await expect(accountDetail(db(), member, { accountId: ids.giro, ...range }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(accountDetail(db(), member, { accountId: 999_999, ...range }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(accountBookings(db(), member, { accountId: ids.giro })).rejects.toMatchObject({ status: 404 });
    expect((await accountDetail(db(), member, { accountId: ids.joint, ...range }, NOW)).account.name).toBe("Gemeinsam");
  });

  it("flags connections that need attention", () => {
    const state = (status: string, days?: number) => ({ status, consentValidUntil: days === undefined ? null : inDays(days) });
    expect(connectionAttention(state("active", 60), NOW)).toBeNull();
    expect(connectionAttention(state("active"), NOW)).toBeNull();
    expect(connectionAttention(state("active", 3), NOW)).toBe("expiring");
    expect(connectionAttention(state("active", -1), NOW)).toBe("expired");
    expect(connectionAttention(state("needs_reauth", 30), NOW)).toBe("expired");
    expect(connectionAttention(state("error", 30), NOW)).toBe("error");
  });

  it("returns the account with its full IBAN on the detail page", async () => {
    const detail = await accountDetail(db(), admin, { accountId: ids.giro }, NOW);
    expect(detail.account.iban).toBe("DE02120300000000202051");
    expect(detail.inView).toBe(true);
  });
});

describe("account bookings", () => {
  let admin: Viewer;
  let giro: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    giro = await account({ name: "Giro", balanceCents: 0 });
    const other = await account({ name: "Anderes" });
    await bookings(giro, [
      ["2026-11-16", -10_00, "Bäckerei Müller"],
      ["2026-11-16", -5_00, "Kiosk"],
      ["2026-11-15", 100_00, "Arbeitgeber"],
      ["2026-11-15", -20_00, "Café Crème"],
      ["2026-11-15", -30_00, "Kiosk"],
      ["2026-11-14", -1_00, "Kiosk"],
    ]);
    await bookings(other, [["2026-11-16", -999_00, "Fremd"]]);
  });

  it("pages newest first and carries the totals of all matching bookings on every page", async () => {
    const first = await accountBookings(db(), admin, { accountId: giro, limit: 3 });
    expect(first.total).toBe(6);
    expect(first.nextOffset).toBe(3);
    expect(first.items.map((t) => t.bookingDate)).toEqual(["2026-11-16", "2026-11-16", "2026-11-15"]);
    const second = await accountBookings(db(), admin, { accountId: giro, limit: 3, offset: first.nextOffset ?? 0 });
    expect(second.nextOffset).toBeNull();
    expect(second.totals).toEqual(first.totals);
    expect(first.totals).toMatchObject({ count: 6, incomeCents: 100_00, expenseCents: -66_00, sumCents: 34_00 });
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((t) => t.id)).size).toBe(6);
    expect(all.every((t) => t.accountId === giro)).toBe(true);
  });

  it("filters by search text and sums only the matching bookings", async () => {
    const kiosk = await accountBookings(db(), admin, { accountId: giro, q: "kiosk" });
    expect(kiosk.total).toBe(3);
    expect(kiosk.totals).toMatchObject({ count: 3, incomeCents: 0, expenseCents: -36_00, sumCents: -36_00 });
  });

  it("sorts by amount in both directions", async () => {
    const largestIncome = await accountBookings(db(), admin, { accountId: giro, sort: "largest_income" });
    const largestExpense = await accountBookings(db(), admin, { accountId: giro, sort: "largest_expense" });
    expect(largestIncome.items.map((t) => t.amountCents)).toEqual([100_00, -1_00, -5_00, -10_00, -20_00, -30_00]);
    expect(largestExpense.items.map((t) => t.amountCents)).toEqual([-30_00, -20_00, -10_00, -5_00, -1_00, 100_00]);
  });

  it("filters incoming or outgoing bookings only", async () => {
    const all = await accountBookings(db(), admin, { accountId: giro, limit: 200 });
    const incoming = await accountBookings(db(), admin, { accountId: giro, minAmountCents: 1, limit: 200 });
    const outgoing = await accountBookings(db(), admin, { accountId: giro, maxAmountCents: -1, limit: 200 });
    const amounts = (page: typeof all) => page.items.map((t) => t.amountCents);
    expect(amounts(incoming).every((c) => c > 0)).toBe(true);
    expect(amounts(outgoing).every((c) => c < 0)).toBe(true);
    expect(incoming.total + outgoing.total).toBe(all.total - amounts(all).filter((c) => c === 0).length);
  });
});

describe("unread bookings per account", () => {
  it("counts the new bookings of every visible account and nothing of hidden ones", async () => {
    await resetDb();
    const admin = await makeUser("admin", "superuser");
    const giro = await account({ name: "Giro" });
    const paypal = await account({ name: "PayPal" });
    const hidden = await account({ name: "Privat", visibility: "private" });
    const shared = await group("Haushalt", 0, [giro, paypal]);
    const member = await makeUser("kind", "member", [shared]);
    await bookings(giro, [
      ["2026-11-10", -5_00],
      ["2026-11-11", -6_00],
    ]);
    await bookings(paypal, [["2026-11-12", -7_00]]);
    await bookings(hidden, [["2026-11-12", -8_00]]);
    await db().update(transactions).set({ isUnread: false }).where(eq(transactions.accountId, paypal));

    const unread = (overview: Awaited<ReturnType<typeof accountsOverview>>) =>
      Object.fromEntries(overview.accounts.map((a) => [a.name, a.unreadCount]));
    expect(unread(await accountsOverview(db(), admin, null, NOW))).toEqual({ Giro: 2, PayPal: 0, Privat: 1 });
    expect(unread(await accountsOverview(db(), member, null, NOW))).toEqual({ Giro: 2, PayPal: 0 });
  });
});
