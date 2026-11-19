/** Labels live under `periods.*` in the messages. */
export const PERIODS = ["this_month", "last_month", "last_3_months", "last_6_months", "last_12_months", "this_year", "last_year"] as const;

export type Period = (typeof PERIODS)[number];
export type DateRange = { dateFrom: string; dateTo: string };

export function isPeriod(value: unknown): value is Period {
  return typeof value === "string" && (PERIODS as readonly string[]).includes(value);
}

export function isoDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function parse(iso: string): Date {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function resolvePeriod(period: Period, today = new Date()): DateRange {
  const y = today.getFullYear();
  const m = today.getMonth();
  const range = (from: Date, to: Date) => ({ dateFrom: isoDate(from), dateTo: isoDate(to) });
  switch (period) {
    case "this_month":
      return range(new Date(y, m, 1), today);
    case "last_month":
      return range(new Date(y, m - 1, 1), new Date(y, m, 0));
    case "last_3_months":
      return range(new Date(y, m - 2, 1), today);
    case "last_6_months":
      return range(new Date(y, m - 5, 1), today);
    case "last_12_months":
      return range(new Date(y, m - 11, 1), today);
    case "this_year":
      return range(new Date(y, 0, 1), today);
    case "last_year":
      return range(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31));
  }
}

/** A dashboard's period; "custom" carries its own dates. Labels live under `periods.*`. */
export const DASHBOARD_PERIODS = [
  "this_month",
  "last_month",
  "next_month",
  "last_30_days",
  "last_3_months",
  "this_year",
  "last_year",
  "custom",
] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** `forecast`: the range starts after today, so only contracts can tell anything about it. */
export type DashboardRange = DateRange & { forecast: boolean };

export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
  return typeof value === "string" && (DASHBOARD_PERIODS as readonly string[]).includes(value);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A custom range needs both dates in order; anything else falls back to this month. */
export function resolveDashboardPeriod(
  period: DashboardPeriod,
  custom: { dateFrom?: string | null; dateTo?: string | null } | null,
  today = new Date(),
): DashboardRange {
  const y = today.getFullYear();
  const m = today.getMonth();
  let range: DateRange;
  if (period === "next_month") range = { dateFrom: isoDate(new Date(y, m + 1, 1)), dateTo: isoDate(new Date(y, m + 2, 0)) };
  else if (period === "last_30_days") range = { dateFrom: isoDate(new Date(y, m, today.getDate() - 29)), dateTo: isoDate(today) };
  else if (period === "custom") {
    const from = custom?.dateFrom ?? "";
    const to = custom?.dateTo ?? "";
    range = ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to ? { dateFrom: from, dateTo: to } : resolvePeriod("this_month", today);
  } else range = resolvePeriod(period, today);
  return { ...range, forecast: range.dateFrom > isoDate(today) };
}

/** A card's own period, or "dashboard" to follow its dashboard's. */
export type CardPeriod = Period | "dashboard";

export function cardRange(period: CardPeriod, dashboard: DashboardRange, today = new Date()): DashboardRange {
  return period === "dashboard" ? dashboard : { ...resolvePeriod(period, today), forecast: false };
}

/** Number of calendar months a range touches, used to shift it to the previous period. */
export function monthSpan(range: DateRange): number {
  const from = parse(range.dateFrom);
  const to = parse(range.dateTo);
  return (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() + 1;
}

function shiftDate(date: Date, months: number): Date {
  const monthEnd = date.getDate() === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(monthEnd ? lastDay : Math.min(date.getDate(), lastDay));
  return target;
}

export function previousRange(range: DateRange): DateRange {
  const months = monthSpan(range);
  return { dateFrom: isoDate(shiftDate(parse(range.dateFrom), -months)), dateTo: isoDate(shiftDate(parse(range.dateTo), -months)) };
}
