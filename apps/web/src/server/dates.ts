import { z } from "zod";

/** The days Saldo works with: before 1970 nothing is booked, and beyond 9999 ISO dates stop sorting as strings. */
export const MIN_DATE = "1970-01-01";
export const MAX_DATE = "2200-12-31";
/** The longest range a statistic, forecast or analysis covers, so one request cannot make the server walk centuries. */
export const MAX_SPAN_YEARS = 10;

/** An ISO date within MIN_DATE..MAX_DATE. */
export const boundedDate = z.iso.date().refine((day) => day >= MIN_DATE && day <= MAX_DATE, "errors.dateOutOfRange");

/** Whether `to` is at most MAX_SPAN_YEARS after `from`. */
export function withinSpan(from: string, to: string): boolean {
  return to <= `${Number(from.slice(0, 4)) + MAX_SPAN_YEARS}${from.slice(4)}`;
}

/** For a refine on objects with an optional range; a range with one end missing passes. */
export const rangeWithinSpan = (r: { dateFrom?: string | null; dateTo?: string | null }) =>
  !r.dateFrom || !r.dateTo || withinSpan(r.dateFrom, r.dateTo);
