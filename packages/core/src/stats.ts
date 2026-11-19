/**
 * Aggregations for dashboards, analysis and MCP. Input bookings are already limited to a view
 * (see `isInternalTransfer`). A booking's bucket comes from its category kind; uncategorized bookings
 * fall back to their sign. A transfer leaving the view counts like a payment, as savings when the other
 * side is a savings or brokerage account. Result amounts are positive cents for expenses and savings.
 */
import type { Direction } from "./classify.ts";
import {
  type ContractDirection,
  dayDiff,
  dueDate,
  guessSchedule,
  monthlyEquivalent,
  regularSchedule,
  type Schedule,
  scheduleMonths,
  shiftMonths,
} from "./contracts.ts";
import { normalize } from "./text.ts";

export type Kind = "expense" | "income" | "savings";
export type Named = { id: number; name: string; color: string };

export type StatTxn = {
  id: number;
  accountId: number;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  isTransfer: boolean;
  transferAccountId: number | null;
  category: (Named & { kind: Kind }) | null;
  tags: Named[];
  transferAccount: (Named & { kind: string }) | null;
};

export const UNCATEGORIZED_COLOR = "#9ca3af";
export const TRANSFER_COLOR = "#64748b";
const SAVINGS_KINDS = new Set(["savings", "brokerage"]);

/** A move between two accounts of the view, or a manual transfer without a known other side. */
export function isInternalTransfer(txn: Pick<StatTxn, "isTransfer" | "transferAccountId">, viewAccountIds: ReadonlySet<number>): boolean {
  return txn.isTransfer && (txn.transferAccountId === null || viewAccountIds.has(txn.transferAccountId));
}

/** Texts that end up in results; the app passes them in the reader's language. */
export type StatLabels = {
  uncategorized: string;
  ownAccount: string;
  transferTo: (name: string) => string;
  transferFrom: (name: string) => string;
};

export const GERMAN_STAT_LABELS: StatLabels = {
  uncategorized: "Ohne Kategorie",
  ownAccount: "eigenes Konto",
  transferTo: (name) => `Übertrag an ${name}`,
  transferFrom: (name) => `Übertrag von ${name}`,
};

export function transferLabel(
  txn: Pick<StatTxn, "amountCents" | "counterparty" | "transferAccount">,
  visibleIds: ReadonlySet<number>,
  labels: StatLabels = GERMAN_STAT_LABELS,
): string {
  const target = txn.transferAccount;
  const name = target && visibleIds.has(target.id) ? target.name : txn.counterparty || labels.ownAccount;
  return txn.amountCents < 0 ? labels.transferTo(name) : labels.transferFrom(name);
}

export function bucket(txn: Pick<StatTxn, "category" | "isTransfer" | "transferAccount" | "amountCents">): Kind {
  if (txn.category) return txn.category.kind;
  if (txn.isTransfer && txn.transferAccount && SAVINGS_KINDS.has(txn.transferAccount.kind)) return "savings";
  return txn.amountCents > 0 ? "income" : "expense";
}

function signed(txn: Pick<StatTxn, "amountCents">, kind: Kind): number {
  return kind === "income" ? txn.amountCents : -txn.amountCents;
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function monthsBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number) as [number, number];
  const [endYear, endMonth] = to.slice(0, 7).split("-").map(Number) as [number, number];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) [year, month] = [year + 1, 1];
  }
  return keys;
}

export type Summary = {
  incomeCents: number;
  expensesCents: number;
  savingsCents: number;
  balanceCents: number;
  transactionCount: number;
  uncategorizedCount: number;
};

export function summary(txns: StatTxn[]): Summary {
  const totals: Record<Kind, number> = { income: 0, expense: 0, savings: 0 };
  let uncategorized = 0;
  for (const txn of txns) {
    const kind = bucket(txn);
    totals[kind] += signed(txn, kind);
    if (!txn.category && !txn.isTransfer) uncategorized += 1;
  }
  return {
    incomeCents: totals.income,
    expensesCents: totals.expense,
    savingsCents: totals.savings,
    balanceCents: totals.income - totals.expense - totals.savings,
    transactionCount: txns.length,
    uncategorizedCount: uncategorized,
  };
}

export type MonthRow = { month: string; incomeCents: number; expensesCents: number; savingsCents: number };

export function monthly(txns: StatTxn[], from: string, to: string): MonthRow[] {
  const rows = new Map(monthsBetween(from, to).map((m) => [m, { month: m, incomeCents: 0, expensesCents: 0, savingsCents: 0 }]));
  const field = { income: "incomeCents", expense: "expensesCents", savings: "savingsCents" } as const;
  for (const txn of txns) {
    const row = rows.get(monthKey(txn.bookingDate));
    if (!row) continue;
    const kind = bucket(txn);
    row[field[kind]] += signed(txn, kind);
  }
  return [...rows.values()];
}

export type CategoryTotal = {
  categoryId: number | null;
  transferAccountId: number | null;
  name: string;
  color: string;
  amountCents: number;
  count: number;
};

export function byCategory(
  txns: StatTxn[],
  kind: Kind,
  visibleIds: ReadonlySet<number>,
  labels: StatLabels = GERMAN_STAT_LABELS,
): CategoryTotal[] {
  const groups = new Map<string, CategoryTotal>();
  for (const txn of txns) {
    if (bucket(txn) !== kind) continue;
    let key: string;
    let entry: Omit<CategoryTotal, "amountCents" | "count">;
    if (!txn.category && txn.isTransfer) {
      const name = transferLabel(txn, visibleIds, labels);
      const visibleTarget = txn.transferAccount && visibleIds.has(txn.transferAccount.id) ? txn.transferAccount : null;
      key = `t:${name}`;
      entry = { categoryId: null, transferAccountId: visibleTarget?.id ?? null, name, color: visibleTarget?.color ?? TRANSFER_COLOR };
    } else {
      key = `c:${txn.category?.id ?? "none"}`;
      entry = {
        categoryId: txn.category?.id ?? null,
        transferAccountId: null,
        name: txn.category?.name ?? labels.uncategorized,
        color: txn.category?.color ?? UNCATEGORIZED_COLOR,
      };
    }
    const group = groups.get(key) ?? { ...entry, amountCents: 0, count: 0 };
    group.amountCents += signed(txn, kind);
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.amountCents - a.amountCents);
}

export type Series = { months: string[]; series: (Named & { values: number[] })[] };

export function series(txns: StatTxn[], from: string, to: string, groupBy: "category" | "tag", ids: ReadonlySet<number>): Series {
  const months = monthsBetween(from, to);
  const meta = new Map<number, Named>();
  const values = new Map<number, Map<string, number>>();
  for (const txn of txns) {
    const amount = signed(txn, bucket(txn));
    const groups: Named[] = groupBy === "tag" ? txn.tags : txn.category ? [txn.category] : [];
    for (const group of groups) {
      if (ids.size > 0 && !ids.has(group.id)) continue;
      meta.set(group.id, { id: group.id, name: group.name, color: group.color });
      const perMonth = values.get(group.id) ?? new Map<string, number>();
      perMonth.set(monthKey(txn.bookingDate), (perMonth.get(monthKey(txn.bookingDate)) ?? 0) + amount);
      values.set(group.id, perMonth);
    }
  }
  return {
    months,
    series: [...meta.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map((g) => ({ ...g, values: months.map((m) => values.get(g.id)?.get(m) ?? 0) })),
  };
}

export type CounterpartyTotal = { counterparty: string; amountCents: number; count: number };

export function topCounterparties(txns: StatTxn[], limit: number): CounterpartyTotal[] {
  const groups = new Map<string, CounterpartyTotal>();
  for (const txn of txns) {
    // Transfers leaving the view count in totals but are not payments to a third party.
    if (bucket(txn) !== "expense" || !txn.counterparty || txn.isTransfer) continue;
    const key = normalize(txn.counterparty);
    const group = groups.get(key) ?? { counterparty: txn.counterparty, amountCents: 0, count: 0 };
    group.amountCents -= txn.amountCents;
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.amountCents - a.amountCents).slice(0, limit);
}

export type Recurring = {
  /** The normalized payee, which identifies the payment. */
  key: string;
  direction: ContractDirection;
  counterparty: string;
  typicalAmountCents: number;
  months: number;
  category: string | null;
  categoryId: number | null;
  /** The account of the latest payment. */
  accountId: number;
  lastDate: string;
  schedule: Schedule;
};

/**
 * Payments to (or, with direction "in", from) one counterparty in at least `minMonths` distinct months with stable
 * amounts.
 */
export function recurringPayments(txns: StatTxn[], minMonths = 3, direction: Direction = "out"): Recurring[] {
  const groups = new Map<string, StatTxn[]>();
  for (const txn of txns) {
    if ((direction === "out" ? txn.amountCents < 0 : txn.amountCents > 0) && txn.counterparty && !txn.isTransfer) {
      const key = normalize(txn.counterparty);
      groups.set(key, [...(groups.get(key) ?? []), txn]);
    }
  }
  const result: Recurring[] = [];
  for (const [key, items] of groups) {
    const months = new Set(items.map((t) => monthKey(t.bookingDate)));
    if (months.size < minMonths) continue;
    const amounts = items.map((t) => Math.abs(t.amountCents)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] ?? 0;
    const spread = (amounts.at(-1) ?? 0) - (amounts[0] ?? 0);
    if (median <= 0 || spread > median * 0.25) continue;
    const latest = items.reduce((a, b) => (b.bookingDate > a.bookingDate ? b : a));
    result.push({
      key,
      direction: direction === "out" ? "expense" : "income",
      counterparty: latest.counterparty,
      typicalAmountCents: median,
      months: months.size,
      category: latest.category?.name ?? null,
      categoryId: latest.category?.id ?? null,
      accountId: latest.accountId,
      lastDate: latest.bookingDate,
      schedule: guessSchedule(items.map((t) => t.bookingDate)),
    });
  }
  return result.sort((a, b) => b.typicalAmountCents - a.typicalAmountCents);
}

export type ContractCandidate = Recurring & {
  /** The amounts differ too much for a fixed price; a contract would follow the latest one. */
  variable: boolean;
  latestAmountCents: number;
  minAmountCents: number;
  maxAmountCents: number;
};

/** Months of history `contractCandidates` needs: two yearly payments and some slack. */
export const CANDIDATE_HISTORY_MONTHS = 25;
const YEARLY: Schedule = { interval: "yearly", intervalMonths: null };

type Rhythm = { items: StatTxn[]; schedule: Schedule };

/** Stable amounts in at least three months, or any amounts once a month (quarter, half year) around the same day. */
function stableOrRhythm(recent: StatTxn[], direction: Direction): Rhythm | null {
  if (recent.length === 0) return null;
  const stable = recurringPayments(recent, 3, direction)[0];
  if (stable) return { items: recent, schedule: stable.schedule };
  const schedule = regularSchedule(
    recent.map((t) => t.bookingDate),
    3,
  );
  return schedule && (scheduleMonths(schedule) ?? 0) < 12 ? { items: recent, schedule } : null;
}

/** Two or more payments about a year apart. */
function yearlyRhythm(items: StatTxn[]): Rhythm | null {
  return regularSchedule(
    items.map((t) => t.bookingDate),
    2,
    YEARLY,
  )
    ? { items, schedule: YEARLY }
    : null;
}

const latestOf = (items: StatTxn[]): StatTxn =>
  items.reduce((a, b) => (b.bookingDate > a.bookingDate || (b.bookingDate === a.bookingDate && b.id > a.id) ? b : a));

/**
 * Payments that look like a contract, from `CANDIDATE_HISTORY_MONTHS` of history up to `today`: stable amounts in at
 * least three months of the last twelve; varying amounts that arrive once a month (or quarter, half year) around the
 * same day, at least three times; or two or more payments a year apart. Only while they still run: the next payment is
 * at most a month overdue. Sorted by the monthly amount, largest first.
 */
export function contractCandidates(txns: StatTxn[], direction: Direction, today: string): ContractCandidate[] {
  const yearAgo = shiftMonths(`${today.slice(0, 7)}-01`, -11);
  const groups = new Map<string, StatTxn[]>();
  for (const txn of txns) {
    if (
      (direction === "out" ? txn.amountCents < 0 : txn.amountCents > 0) &&
      txn.counterparty &&
      !txn.isTransfer &&
      txn.bookingDate <= today
    ) {
      const key = normalize(txn.counterparty);
      groups.set(key, [...(groups.get(key) ?? []), txn]);
    }
  }
  const running = ({ items, schedule }: Rhythm) => dayDiff(dueDate(latestOf(items).bookingDate, schedule, 1), today) <= 31;
  const result: ContractCandidate[] = [];
  for (const [key, items] of groups) {
    const recent = items.filter((t) => t.bookingDate >= yearAgo);
    const found = stableOrRhythm(recent, direction) ?? yearlyRhythm(items);
    if (!found || !running(found)) continue;
    const amounts = found.items.map((t) => Math.abs(t.amountCents)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] ?? 0;
    const min = amounts[0] ?? 0;
    const max = amounts.at(-1) ?? 0;
    const latest = latestOf(found.items);
    result.push({
      key,
      direction: direction === "out" ? "expense" : "income",
      counterparty: latest.counterparty,
      typicalAmountCents: median,
      months: new Set(found.items.map((t) => monthKey(t.bookingDate))).size,
      category: latest.category?.name ?? null,
      categoryId: latest.category?.id ?? null,
      accountId: latest.accountId,
      lastDate: latest.bookingDate,
      schedule: found.schedule,
      variable: max - min > median * 0.25,
      latestAmountCents: Math.abs(latest.amountCents),
      minAmountCents: min,
      maxAmountCents: max,
    });
  }
  const monthlyOf = (c: ContractCandidate) => monthlyEquivalent(c.variable ? c.latestAmountCents : c.typicalAmountCents, c.schedule);
  return result.sort((a, b) => monthlyOf(b) - monthlyOf(a) || a.counterparty.localeCompare(b.counterparty));
}

export type PriceChange = { txnId: number; counterparty: string; previousCents: number; currentCents: number; changePercent: number };

/** New payments to a recurring counterparty (detected in `history`) whose amount moved away from the typical one by more than `minPercent`. */
export function priceChanges(history: StatTxn[], fresh: StatTxn[], minPercent: number): PriceChange[] {
  const typical = new Map(recurringPayments(history).map((r) => [normalize(r.counterparty), r.typicalAmountCents]));
  const result: PriceChange[] = [];
  for (const txn of fresh) {
    if (txn.amountCents >= 0 || !txn.counterparty || txn.isTransfer) continue;
    const previous = typical.get(normalize(txn.counterparty));
    if (!previous) continue;
    const current = -txn.amountCents;
    const changePercent = ((current - previous) / previous) * 100;
    if (Math.abs(changePercent) > minPercent) {
      result.push({ txnId: txn.id, counterparty: txn.counterparty, previousCents: previous, currentCents: current, changePercent });
    }
  }
  return result;
}
