import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountBalanceEntries, accountGroupMembers, accountGroups, accounts, bankConnections, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { balanceTimeline, changePoints, dailyBalances, sumBalances, TIMELINE_DAYS, type Timeline } from "./index.ts";

const NOW = new Date("2026-11-16T10:00:00");

/** The dense end-of-day balance per date, carried forward from the change points. */
function byDate(timeline: Timeline): Map<string, number> {
  const out = new Map<string, number>();
  const start = Date.parse(`${timeline.start}T00:00:00Z`);
  let current: number | undefined;
  let next = 0;
  for (let day = 0; day < timeline.days; day++) {
    const point = timeline.balance[next];
    if (point && point[0] === day) {
      current = point[1];
      next++;
    }
    if (current !== undefined) out.set(new Date(start + day * 86_400_000).toISOString().slice(0, 10), current);
  }
  return out;
}

describe("daily balances", () => {
  const first = Date.parse("2026-11-01T00:00:00Z") / 86_400_000;

  it("derives the balance backwards and forwards from the stored balance and the bookings", () => {
    const values = dailyBalances(
      {
        type: "bookings",
        balance: { cents: 10_000, date: "2026-11-04" },
        days: [
          { date: "2026-11-03", cents: -2_000 },
          { date: "2026-11-05", cents: 500 },
        ],
      },
      first,
      6,
    );
    // Known from the day before the first booking; 2026-11-01 is before that.
    expect([...values]).toEqual([Number.NaN, 12_000, 10_000, 10_000, 10_500, 10_500]);
  });

  it("counts bookings before the first day into the start balance", () => {
    const values = dailyBalances(
      { type: "bookings", balance: { cents: 0, date: "2026-11-02" }, days: [{ date: "2026-10-01", cents: 300 }] },
      first,
      2,
    );
    expect([...values]).toEqual([0, 0]);
  });

  it("carries hand-entered balances forward and knows nothing before the first entry", () => {
    const values = dailyBalances(
      {
        type: "entries",
        entries: [
          { date: "2026-11-04", balanceCents: 900 },
          { date: "2026-11-02", balanceCents: 1_000 },
        ],
      },
      first,
      5,
    );
    expect([...values]).toEqual([Number.NaN, 1_000, 1_000, 900, 900]);
  });

  it("sums the known accounts per day and keeps only the changes", () => {
    const total = sumBalances([Float64Array.from([Number.NaN, 5, 5, 7]), Float64Array.from([1, 1, Number.NaN, 1])], 4);
    expect([...total]).toEqual([1, 6, 5, 8]);
    expect(changePoints(Float64Array.from([Number.NaN, 3, 3, 4, 4]))).toEqual([
      [1, 3],
      [3, 4],
    ]);
  });
});

describe("balance timeline", () => {
  let admin: Viewer;
  let ids: { giro: number; card: number; cash: number; depot: number; none: number };
  let shared: number;

  async function account(values: Partial<typeof accounts.$inferInsert> & { name: string }) {
    const [row] = await db()
      .insert(accounts)
      .values({ bank: "Testbank", kind: "checking", ownerUserId: admin.id, ...values })
      .returning({ id: accounts.id });
    return row?.id ?? -1;
  }

  let booked = 0;
  async function book(accountId: number, list: [date: string, cents: number, transferTo?: number][]) {
    await db()
      .insert(transactions)
      .values(
        list.map(([bookingDate, amountCents, transferTo], i) => ({
          accountId,
          externalId: `tl-${booked + i}`,
          source: "test",
          bookingDate,
          amountCents,
          isTransfer: transferTo !== undefined,
          transferAccountId: transferTo ?? null,
        })),
      );
    booked += list.length;
  }

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    const [connection] = await db()
      .insert(bankConnections)
      .values({ name: "DKB", provider: "enable_banking", bank: "dkb", status: "active", ciphertext: "x", ownerUserId: admin.id })
      .returning({ id: bankConnections.id });
    const linked = connection?.id ?? null;
    ids = {
      giro: await account({ name: "Giro", balanceCents: 100_000, balanceDate: "2026-11-16", connectionId: linked }),
      card: await account({ name: "Visa", kind: "credit_card", balanceCents: -5_000, balanceDate: "2026-11-16", connectionId: linked }),
      cash: await account({ name: "Bargeld", balanceCents: 2_000, balanceDate: "2026-11-10" }),
      depot: await account({ name: "Depot", kind: "brokerage", balanceCents: 300_000, connectionId: linked }),
      none: await account({ name: "Ohne Saldo" }),
    };
    await book(ids.giro, [
      ["2026-11-01", 250_000],
      ["2026-11-05", -40_000],
      ["2026-11-12", -10_000, ids.card],
      ["2026-11-14", -3_000],
    ]);
    await book(ids.card, [["2026-11-12", 10_000, ids.giro]]);
    await db()
      .insert(accountBalanceEntries)
      .values([
        { accountId: ids.cash, date: "2026-11-03", balanceCents: 1_500 },
        { accountId: ids.cash, date: "2026-11-10", balanceCents: 2_000 },
        { accountId: ids.depot, date: "2026-11-08", balanceCents: 290_000 },
        { accountId: ids.depot, date: "2026-11-15", balanceCents: 300_000 },
      ]);
    const [group] = await db().insert(accountGroups).values({ name: "Gemeinsam", position: 0 }).returning({ id: accountGroups.id });
    shared = group?.id ?? -1;
    await db().insert(accountGroupMembers).values({ accountId: ids.giro, groupId: shared });
  });

  it("derives one bank account's history backwards from today's balance, transfers included in its flows", async () => {
    const timeline = await balanceTimeline(db(), admin, { accountId: ids.giro }, NOW);
    expect(timeline).toMatchObject({ start: "2026-10-31", days: 17 });
    const balances = byDate(timeline as Timeline);
    expect(balances.get("2026-10-31")).toBe(-97_000);
    expect(balances.get("2026-11-01")).toBe(153_000);
    expect(balances.get("2026-11-11")).toBe(113_000);
    expect(balances.get("2026-11-16")).toBe(100_000);
    expect(timeline?.flows).toEqual([
      [1, 250_000, 0, 1],
      [5, 0, 40_000, 1],
      [12, 0, 10_000, 1],
      [14, 0, 3_000, 1],
    ]);
  });

  it("uses the entries of hand-kept accounts and depots", async () => {
    const cash = await balanceTimeline(db(), admin, { accountId: ids.cash }, NOW);
    expect(cash).toMatchObject({
      start: "2026-11-03",
      days: 14,
      balance: [
        [0, 1_500],
        [7, 2_000],
      ],
    });
    const depot = await balanceTimeline(db(), admin, { accountId: ids.depot }, NOW);
    expect(depot?.balance).toEqual([
      [0, 290_000],
      [7, 300_000],
    ]);
    expect(await balanceTimeline(db(), admin, { accountId: ids.none }, NOW)).toBeNull();
  });

  it("sums the view's accounts per day with carry-forward and leaves transfers between them out of the flows", async () => {
    const timeline = (await balanceTimeline(db(), admin, {}, NOW)) as Timeline;
    expect(timeline.start).toBe("2026-10-31");
    const balances = byDate(timeline);
    // Giro and Visa (derived from 2026-10-31 and 2026-11-11 on), cash from its first entry, the depot from 2026-11-08.
    expect(balances.get("2026-10-31")).toBe(-97_000);
    expect(balances.get("2026-11-03")).toBe(153_000 + 1_500);
    expect(balances.get("2026-11-08")).toBe(113_000 + 1_500 + 290_000);
    expect(balances.get("2026-11-12")).toBe(103_000 - 5_000 + 2_000 + 290_000);
    expect(balances.get("2026-11-16")).toBe(100_000 - 5_000 + 2_000 + 300_000);
    expect(timeline.flows).toEqual([
      [1, 250_000, 0, 1],
      [5, 0, 40_000, 1],
      [14, 0, 3_000, 1],
    ]);
  });

  it("follows the viewer's visibility: a member sees only the accounts shared with them", async () => {
    const member = await makeUser("partnerin", "member", [shared]);
    await expect(balanceTimeline(db(), member, { accountId: ids.cash }, NOW)).rejects.toMatchObject({ status: 404 });
    const total = (await balanceTimeline(db(), member, {}, NOW)) as Timeline;
    expect(byDate(total).get("2026-11-16")).toBe(100_000);
    // The transfer to the card leaves the member's view, so it counts as an outflow there.
    expect(total.flows.find(([day]) => day === 12)).toEqual([12, 0, 10_000, 1]);
    await expect(balanceTimeline(db(), member, { groupId: 999_999 }, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("caps the history at three years", async () => {
    await book(ids.giro, [["2020-01-15", 1_000]]);
    const timeline = (await balanceTimeline(db(), admin, { accountId: ids.giro }, NOW)) as Timeline;
    expect(timeline.days).toBe(TIMELINE_DAYS);
    expect(byDate(timeline).get("2026-11-16")).toBe(100_000);
  });
});
