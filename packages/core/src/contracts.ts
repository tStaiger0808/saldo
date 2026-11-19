/**
 * Contracts: recurring income and expenses on a schedule. Days are ISO dates (`YYYY-MM-DD`), contract amounts are
 * positive cents; booking amounts keep their sign.
 */
import { fold } from "./text.ts";

export const CONTRACT_INTERVALS = ["weekly", "monthly", "quarterly", "half_yearly", "yearly", "custom"] as const;
export type ContractInterval = (typeof CONTRACT_INTERVALS)[number];
export type ContractDirection = "income" | "expense";
/** `intervalMonths` only counts for `custom`. */
export type Schedule = { interval: ContractInterval; intervalMonths?: number | null };

const FIXED_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 } as const;
const DAY_MS = 86_400_000;

/** Months between two due dates; null for weekly contracts. */
export function scheduleMonths(schedule: Schedule): number | null {
  if (schedule.interval === "weekly") return null;
  if (schedule.interval === "custom") return Math.max(1, Math.round(schedule.intervalMonths ?? 1));
  return FIXED_MONTHS[schedule.interval];
}

/** The amount per calendar month, e.g. a quarter of a quarterly one; a weekly amount occurs 52 times in 12 months. */
export function monthlyEquivalent(amountCents: number, schedule: Schedule): number {
  const months = scheduleMonths(schedule);
  return Math.round(months === null ? (amountCents * 52) / 12 : amountCents / months);
}

function dayParts(day: string): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

const toUtc = (day: string) => {
  const [y, m, d] = dayParts(day);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function shiftDays(day: string, days: number): string {
  return fromUtc(toUtc(day) + days * DAY_MS);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** The same day `months` later, or the last day of a month that is too short (Jan 31 → Feb 28, Feb 29 → Feb 28). */
export function shiftMonths(day: string, months: number): string {
  const [y, m, d] = dayParts(day);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(year, month, Math.min(d, lastDay)));
}

/**
 * The k-th due date counted from the anchor (k may be negative). Month-based dates are computed from the anchor, not
 * step by step, so a contract due on Jan 31 is due on Feb 28 and again on Mar 31.
 */
export function dueDate(anchor: string, schedule: Schedule, k: number): string {
  const months = scheduleMonths(schedule);
  return months === null ? shiftDays(anchor, 7 * k) : shiftMonths(anchor, months * k);
}

function monthPosition(day: string): number {
  const [y, m, d] = dayParts(day);
  return y * 12 + m + d / 31;
}

/** Index of the due date closest to `day`. */
export function nearestDueIndex(anchor: string, schedule: Schedule, day: string): number {
  const months = scheduleMonths(schedule);
  const estimate =
    months === null ? Math.round(dayDiff(anchor, day) / 7) : Math.round((monthPosition(day) - monthPosition(anchor)) / months);
  const distance = (k: number) => Math.abs(dayDiff(dueDate(anchor, schedule, k), day));
  let best = estimate;
  for (const k of [estimate - 1, estimate + 1]) if (distance(k) < distance(best)) best = k;
  return best;
}

function firstIndexFrom(anchor: string, schedule: Schedule, day: string): number {
  const target = toUtc(day);
  let k = nearestDueIndex(anchor, schedule, day);
  while (toUtc(dueDate(anchor, schedule, k)) < target) k += 1;
  while (toUtc(dueDate(anchor, schedule, k - 1)) >= target) k -= 1;
  return k;
}

/** The first due date on or after `day`. */
export function firstDueFrom(anchor: string, schedule: Schedule, day: string): string {
  return dueDate(anchor, schedule, firstIndexFrom(anchor, schedule, day));
}

/** The most due dates one call returns: twenty years of weekly dates, far beyond any range Saldo asks for. */
export const MAX_DUE_DATES = 1_000;

/**
 * Due dates from `from` to `to`, both included, at most MAX_DUE_DATES. Compared as days, not as ISO strings: past
 * year 9999 those start with "+" and would sort before any end date.
 */
export function dueDatesBetween(anchor: string, schedule: Schedule, from: string, to: string): string[] {
  const end = toUtc(to);
  const dates: string[] = [];
  for (let k = firstIndexFrom(anchor, schedule, from); dates.length < MAX_DUE_DATES; k += 1) {
    const day = dueDate(anchor, schedule, k);
    if (toUtc(day) > end) break;
    dates.push(day);
  }
  return dates;
}

/** Days after a due date before a missing payment counts as overdue; bank booking dates drift by a few days. */
export function graceDays(schedule: Schedule): number {
  return schedule.interval === "weekly" ? 2 : 5;
}

export function scheduleForMonths(months: number): Schedule {
  const whole = Math.min(120, Math.max(1, Math.round(months)));
  const named = (Object.keys(FIXED_MONTHS) as (keyof typeof FIXED_MONTHS)[]).find((key) => FIXED_MONTHS[key] === whole);
  return named ? { interval: named, intervalMonths: null } : { interval: "custom", intervalMonths: whole };
}

/** Days a payment may lie off its rhythm; one month's dates drift by weekends and bank holidays. */
const RHYTHM_SPREAD_DAYS = 8;
/** Share of the periods since the first payment that must have one, so a skipped month does not end a rhythm. */
const RHYTHM_COVERAGE = 0.75;

/**
 * The schedule payments follow when they arrive once per period around the same day, whatever their amounts: every
 * date lies within a few days of one grid, no period has two payments and few are missing. Monthly or longer only;
 * everyday payments (groceries, fuel) look weekly too often. `schedule` forces an interval, e.g. yearly.
 */
export function regularSchedule(dates: readonly string[], minPayments: number, schedule?: Schedule): Schedule | null {
  const days = [...new Set(dates)].sort();
  const last = days.at(-1);
  if (last === undefined || days.length < minPayments || days.length < 2) return null;
  const rhythm = schedule ?? guessSchedule(days);
  const months = scheduleMonths(rhythm);
  if (months === null) return null;
  const offsets: number[] = [];
  const periods = new Set<number>();
  for (const day of days) {
    const k = nearestDueIndex(last, rhythm, day);
    if (periods.has(k)) return null;
    periods.add(k);
    offsets.push(dayDiff(dueDate(last, rhythm, k), day));
  }
  const allowed = Math.max(RHYTHM_SPREAD_DAYS, Math.round(months * 1.5));
  if (Math.max(...offsets) - Math.min(...offsets) > allowed) return null;
  const span = 1 - Math.min(...periods);
  return periods.size / span >= RHYTHM_COVERAGE ? rhythm : null;
}

/** The interval from the typical gap between payments; monthly when there is too little history. */
export function guessSchedule(dates: readonly string[]): Schedule {
  const days = [...new Set(dates)].sort();
  if (days.length < 2) return { interval: "monthly", intervalMonths: null };
  const gaps = days
    .slice(1)
    .map((day, i) => dayDiff(days[i] ?? day, day))
    .sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 30;
  if (median <= 10) return { interval: "weekly", intervalMonths: null };
  return scheduleForMonths(median / 30.44);
}

// ---- matching bookings to contracts

/** What decides which bookings belong to a contract. */
export type ContractRule = {
  id: number;
  direction: ContractDirection;
  amountCents: number;
  variable: boolean;
  tolerancePercent: number | null;
  matchPayee: string;
  matchPurpose: string;
  /** Accounts whose bookings may belong to it; null for any. */
  accountIds: readonly number[] | null;
  /** Accounts whose owner may manage this contract: there it goes before contracts of others, whatever their amount. */
  ownerAccountIds?: readonly number[];
  startDate: string | null;
  endDate: string | null;
};

export type ContractBooking = {
  id: number;
  accountId: number;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  purpose: string;
  isTransfer: boolean;
};

/**
 * A booking that is off by more than this share of a fixed contract's amount is another payment to the same payee
 * (a purchase besides a subscription), not the contract; within it a deviation beyond the tolerance is a price change.
 */
export const MATCH_BAND_PERCENT = 50;
/** Payments may arrive a little before the start or after the end of a contract. */
const DATE_SLACK_DAYS = 7;

export function deviationPercent(expectedCents: number, actualCents: number): number {
  if (expectedCents === 0) return actualCents === 0 ? 0 : 100;
  return ((actualCents - expectedCents) / expectedCents) * 100;
}

function matchBand(rule: Pick<ContractRule, "tolerancePercent">): number {
  return Math.max(MATCH_BAND_PERCENT, 2 * (rule.tolerancePercent ?? 0));
}

/** Direction, account, payee and purpose text, dates and, for fixed amounts, the match band. Transfers never match. */
export function matchesContract(rule: ContractRule, booking: ContractBooking): boolean {
  if (booking.isTransfer) return false;
  if (rule.direction === "expense" ? booking.amountCents >= 0 : booking.amountCents <= 0) return false;
  if (rule.accountIds && !rule.accountIds.includes(booking.accountId)) return false;
  const payee = fold(rule.matchPayee);
  const purpose = fold(rule.matchPurpose);
  if (!payee && !purpose) return false;
  if (payee && !fold(booking.counterparty).includes(payee)) return false;
  if (purpose && !fold(booking.purpose).includes(purpose)) return false;
  if (rule.startDate && booking.bookingDate < shiftDays(rule.startDate, -DATE_SLACK_DAYS)) return false;
  if (rule.endDate && booking.bookingDate > shiftDays(rule.endDate, DATE_SLACK_DAYS)) return false;
  if (rule.variable) return true;
  return Math.abs(deviationPercent(rule.amountCents, Math.abs(booking.amountCents))) <= matchBand(rule);
}

/**
 * Every booking goes to at most one contract: one the account's owner may manage, then the one whose amount is closest,
 * then the oldest.
 */
export function assignContracts(rules: readonly ContractRule[], bookings: readonly ContractBooking[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const booking of bookings) {
    let best: { id: number; own: boolean; score: number } | null = null;
    for (const rule of rules) {
      if (!matchesContract(rule, booking)) continue;
      const own = rule.ownerAccountIds?.includes(booking.accountId) ?? false;
      const score = rule.variable ? MATCH_BAND_PERCENT : Math.abs(deviationPercent(rule.amountCents, Math.abs(booking.amountCents)));
      const better =
        !best || (own && !best.own) || (own === best.own && (score < best.score || (score === best.score && rule.id < best.id)));
      if (better) best = { id: rule.id, own, score };
    }
    if (best) result.set(booking.id, best.id);
  }
  return result;
}

// ---- state of a contract

export type ContractTerms = Schedule & {
  /** The due date the contract was saved with; all other due dates follow from it. */
  anchor: string;
  amountCents: number;
  variable: boolean;
  tolerancePercent: number | null;
  startDate: string | null;
  endDate: string | null;
};

export type ContractPayment = { id: number; bookingDate: string; amountCents: number };

export const CONTRACT_STATUSES = ["active", "overdue", "price_changed", "ending", "ended"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export type ContractPriceChange = { txnId: number; date: string; expectedCents: number; actualCents: number; changePercent: number };

export type ContractState = {
  status: ContractStatus;
  /** The next payment not made yet; null once no payment is expected any more. */
  nextDue: string | null;
  /** The next due date plus grace days has passed without a matching booking. */
  overdue: boolean;
  lastPayment: ContractPayment | null;
  priceChange: ContractPriceChange | null;
  /** What the next payment is expected to be: the latest one for variable contracts, else the agreed amount. */
  expectedCents: number;
  monthlyCents: number;
};

/** Positive cents expected per due date; a variable contract follows its latest payment. */
export function expectedAmount(terms: Pick<ContractTerms, "amountCents" | "variable">, last: ContractPayment | null): number {
  return terms.variable && last ? Math.abs(last.amountCents) : terms.amountCents;
}

/** A payment of a fixed contract whose amount is off by more than the tolerance; never for variable contracts. */
export function priceChangeOf(
  terms: Pick<ContractTerms, "amountCents" | "variable" | "tolerancePercent">,
  payment: ContractPayment,
): ContractPriceChange | null {
  if (terms.variable || terms.tolerancePercent === null) return null;
  const actual = Math.abs(payment.amountCents);
  const changePercent = deviationPercent(terms.amountCents, actual);
  if (Math.abs(changePercent) <= terms.tolerancePercent) return null;
  return { txnId: payment.id, date: payment.bookingDate, expectedCents: terms.amountCents, actualCents: actual, changePercent };
}

function latestPayment(payments: readonly ContractPayment[]): ContractPayment | null {
  let latest: ContractPayment | null = null;
  for (const p of payments) {
    if (!latest || p.bookingDate > latest.bookingDate || (p.bookingDate === latest.bookingDate && p.id > latest.id)) latest = p;
  }
  return latest;
}

/**
 * The latest payment covers the due date closest to it, so the next one follows that; without payments the anchor is
 * due. `today` is an ISO date.
 */
export function contractState(terms: ContractTerms, payments: readonly ContractPayment[], today: string): ContractState {
  const last = latestPayment(payments);
  let next = last ? dueDate(terms.anchor, terms, nearestDueIndex(terms.anchor, terms, last.bookingDate) + 1) : terms.anchor;
  if (terms.startDate && next < terms.startDate) next = firstDueFrom(terms.anchor, terms, terms.startDate);
  const nextDue = terms.endDate && next > terms.endDate ? null : next;
  const ended = terms.endDate !== null && terms.endDate < today;
  const overdue = !ended && nextDue !== null && today > shiftDays(nextDue, graceDays(terms));
  const priceChange = last ? priceChangeOf(terms, last) : null;
  let status: ContractStatus = terms.endDate ? "ending" : "active";
  if (ended) status = "ended";
  else if (overdue) status = "overdue";
  else if (priceChange) status = "price_changed";
  const expectedCents = expectedAmount(terms, last);
  return { status, nextDue, overdue, lastPayment: last, priceChange, expectedCents, monthlyCents: monthlyEquivalent(expectedCents, terms) };
}

/** Days until the next payment when it is due within `days` from `today` (0: today); null if not, overdue or ended. */
export function dueWithin(state: Pick<ContractState, "nextDue" | "overdue" | "status">, today: string, days: number): number | null {
  if (state.nextDue === null || state.overdue || state.status === "ended") return null;
  const left = dayDiff(today, state.nextDue);
  return left >= 0 && left <= days ? left : null;
}

/** Due dates still to be paid in `[from, to]`, from the next due date on and within the contract's term. */
export function expectedDueDates(
  terms: ContractTerms,
  state: Pick<ContractState, "nextDue" | "status">,
  from: string,
  to: string,
): string[] {
  if (state.nextDue === null || state.status === "ended") return [];
  const start = state.nextDue > from ? state.nextDue : from;
  if (start > to) return [];
  return dueDatesBetween(terms.anchor, terms, start, to).filter(
    (day) => (!terms.endDate || day <= terms.endDate) && (!terms.startDate || day >= terms.startDate),
  );
}

// ---- suggestions

export type SuggestionCandidate = { key: string; counterparty: string; direction: ContractDirection };

export function suggestionKey(candidate: Pick<SuggestionCandidate, "key" | "direction">): string {
  return `${candidate.direction}:${candidate.key}`;
}

/**
 * Recurring payments that are no contract yet: not dismissed, no booking of the payee linked to a contract (`linked`
 * holds `suggestionKey`s) and no contract of the same direction whose payee text matches.
 */
export function openSuggestions<T extends SuggestionCandidate>(
  candidates: readonly T[],
  contracts: readonly Pick<ContractRule, "direction" | "matchPayee">[],
  dismissed: ReadonlySet<string>,
  linked: ReadonlySet<string>,
): T[] {
  return candidates.filter((candidate) => {
    const key = suggestionKey(candidate);
    if (dismissed.has(key) || linked.has(key)) return false;
    const payee = fold(candidate.counterparty);
    return !contracts.some((c) => c.direction === candidate.direction && fold(c.matchPayee) !== "" && payee.includes(fold(c.matchPayee)));
  });
}
