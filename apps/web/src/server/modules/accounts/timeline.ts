import { and, gte, inArray, lte, not, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { isoDate } from "../../../lib/periods.ts";
import type { Db } from "../../db/index.ts";
import { accountBalanceEntries, accounts, transactions } from "../../db/schema.ts";
import { requireVisibleAccount, resolveView, type Viewer } from "../access/index.ts";
import { internalTransferSql } from "../transactions/index.ts";

/** Three years of days: the longest history the timeline carries. */
export const TIMELINE_DAYS = 1096;

export const timelineInput = z.object({ groupId: z.number().int().nullish(), accountId: z.number().int().optional() });

/**
 * End-of-day balances and daily flows from `start` (day 0) to today (day `days - 1`), sent once; the browser pans and
 * zooms through it. `balance` lists only the days the balance changes and carries forward; days before its first point
 * have no known balance. `flows` lists days with bookings: incoming and outgoing cents (both positive) and the count.
 */
export type Timeline = {
  start: string;
  days: number;
  balance: [day: number, cents: number][];
  flows: [day: number, inCents: number, outCents: number, count: number][];
};

const DAY = 86_400_000;
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoOf = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);

export type BalanceSource =
  | { type: "entries"; entries: readonly { date: string; balanceCents: number }[] }
  | { type: "bookings"; balance: { cents: number; date: string }; days: readonly { date: string; cents: number }[] };

/**
 * First day with a known balance: the first entry, or for bookings the day before the earliest one (or the balance date
 * when that is earlier), since the stored balance anchors everything the bookings explain.
 */
export function sourceStart(source: BalanceSource): number | null {
  if (source.type === "entries") {
    const days = source.entries.map((e) => dayNumber(e.date));
    return days.length > 0 ? Math.min(...days) : null;
  }
  const anchor = dayNumber(source.balance.date);
  const bookings = source.days.map((d) => dayNumber(d.date));
  return bookings.length > 0 ? Math.min(anchor, Math.min(...bookings) - 1) : anchor;
}

/** Balance on each of `count` days from day number `first`; NaN where it is not known yet. */
export function dailyBalances(source: BalanceSource, first: number, count: number): Float64Array {
  const out = new Float64Array(count).fill(Number.NaN);
  const start = sourceStart(source);
  if (start === null) return out;
  if (source.type === "entries") {
    const sorted = source.entries.map((e) => [dayNumber(e.date), e.balanceCents] as const).sort((a, b) => a[0] - b[0]);
    let next = 0;
    let current = Number.NaN;
    for (let i = 0; i < count; i++) {
      for (let entry = sorted[next]; entry && entry[0] <= first + i; entry = sorted[++next]) current = entry[1];
      out[i] = current;
    }
    return out;
  }
  const anchor = dayNumber(source.balance.date);
  const byDay = new Map<number, number>();
  let beforeFirst = 0;
  let upToAnchor = 0;
  for (const d of source.days) {
    const day = dayNumber(d.date);
    if (day < first) beforeFirst += d.cents;
    else byDay.set(day, (byDay.get(day) ?? 0) + d.cents);
    if (day <= anchor) upToAnchor += d.cents;
  }
  let running = beforeFirst;
  for (let i = 0; i < count; i++) {
    running += byDay.get(first + i) ?? 0;
    if (first + i >= start) out[i] = source.balance.cents + running - upToAnchor;
  }
  return out;
}

/** Per day the sum of the accounts whose balance is known that day; NaN while none is. */
export function sumBalances(series: readonly Float64Array[], count: number): Float64Array {
  const out = new Float64Array(count).fill(Number.NaN);
  for (const values of series) {
    for (let i = 0; i < count; i++) {
      const v = values[i] ?? Number.NaN;
      if (Number.isNaN(v)) continue;
      out[i] = Number.isNaN(out[i] ?? Number.NaN) ? v : (out[i] ?? 0) + v;
    }
  }
  return out;
}

export function changePoints(values: Float64Array): [number, number][] {
  const points: [number, number][] = [];
  let previous = Number.NaN;
  values.forEach((v, i) => {
    if (Number.isNaN(v) || v === previous) return;
    points.push([i, v]);
    previous = v;
  });
  return points;
}

/**
 * The balance history of one visible account (bookings including transfers, like its detail page) or of all accounts of
 * the current view (transfers between them left out, like the statistics). Null when no balance is known at all.
 */
export async function balanceTimeline(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof timelineInput>,
  now = new Date(),
): Promise<Timeline | null> {
  const { groupId, accountId } = timelineInput.parse(input);
  let ids: number[];
  let excludeInternal: SQL | undefined;
  if (accountId !== undefined) {
    await requireVisibleAccount(db, viewer, accountId);
    ids = [accountId];
  } else {
    ids = (await resolveView(db, viewer, groupId)).accountIds;
    excludeInternal = not(internalTransferSql(ids));
  }
  if (ids.length === 0) return null;

  const today = dayNumber(isoDate(now));
  const rows = await db
    .select({
      id: accounts.id,
      kind: accounts.kind,
      connectionId: accounts.connectionId,
      balanceCents: accounts.balanceCents,
      balanceDate: accounts.balanceDate,
    })
    .from(accounts)
    .where(inArray(accounts.id, ids));
  // Hand-kept accounts and depots have dated balances; bank accounts get theirs from the bookings.
  const entryIds = rows.filter((a) => a.connectionId === null || a.kind === "brokerage").map((a) => a.id);
  const entries =
    entryIds.length > 0
      ? await db
          .select({
            accountId: accountBalanceEntries.accountId,
            date: accountBalanceEntries.date,
            balanceCents: accountBalanceEntries.balanceCents,
          })
          .from(accountBalanceEntries)
          .where(and(inArray(accountBalanceEntries.accountId, entryIds), lte(accountBalanceEntries.date, isoOf(today))))
      : [];
  const withEntries = new Set(entries.map((e) => e.accountId));
  const derived = rows.filter((a) => !withEntries.has(a.id) && a.balanceCents !== null).map((a) => a.id);
  const bookingDays =
    derived.length > 0
      ? await db
          .select({
            accountId: transactions.accountId,
            date: transactions.bookingDate,
            cents: sql<number>`sum(${transactions.amountCents})::bigint`,
          })
          .from(transactions)
          .where(inArray(transactions.accountId, derived))
          .groupBy(transactions.accountId, transactions.bookingDate)
      : [];

  const sources: BalanceSource[] = rows.flatMap((a): BalanceSource[] => {
    if (withEntries.has(a.id)) return [{ type: "entries", entries: entries.filter((e) => e.accountId === a.id) }];
    if (a.balanceCents === null) return [];
    return [
      {
        type: "bookings",
        balance: { cents: a.balanceCents, date: a.balanceDate ?? isoOf(today) },
        days: bookingDays.filter((d) => d.accountId === a.id).map((d) => ({ date: d.date, cents: Number(d.cents) })),
      },
    ];
  });
  const starts = sources.map(sourceStart).filter((s): s is number => s !== null);
  if (starts.length === 0) return null;
  const first = Math.min(today, Math.max(Math.min(...starts), today - TIMELINE_DAYS + 1));
  const count = today - first + 1;
  const balance = changePoints(
    sumBalances(
      sources.map((s) => dailyBalances(s, first, count)),
      count,
    ),
  );

  const flowRows = await db
    .select({
      date: transactions.bookingDate,
      inCents: sql<number>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)::bigint`,
      outCents: sql<number>`coalesce(-sum(${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, ids),
        gte(transactions.bookingDate, isoOf(first)),
        lte(transactions.bookingDate, isoOf(today)),
        excludeInternal,
      ),
    )
    .groupBy(transactions.bookingDate);
  const flows = flowRows
    .map((r): Timeline["flows"][number] => [dayNumber(r.date) - first, Number(r.inCents), Number(r.outCents), r.count])
    .sort((a, b) => a[0] - b[0]);

  return { start: isoOf(first), days: count, balance, flows };
}
