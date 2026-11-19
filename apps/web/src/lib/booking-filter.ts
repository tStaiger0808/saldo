import { z } from "zod";
import { isPeriod, PERIODS, type Period, resolvePeriod } from "./periods.ts";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const positiveId = z.number().int().positive();
const isoDay = z.string().regex(ISO_DAY);
const amountCents = z.number().int().min(0).max(10_000_000_000);

/**
 * Every filter of a booking list: the bookings page, an account's bookings, saved filters and the AI tools share it.
 * Unset filters are left out. A relative `period` is resolved on the day it is applied and wins over fixed dates.
 */
export const bookingFilterSchema = z.object({
  groupId: positiveId.optional(),
  accountId: positiveId.optional(),
  categoryId: positiveId.optional(),
  tagId: positiveId.optional(),
  /** Incoming bookings have a positive amount, outgoing ones a negative amount. */
  direction: z.enum(["in", "out"]).optional(),
  unread: z.boolean().optional(),
  uncategorized: z.boolean().optional(),
  /** The category was set by the AI and nobody has confirmed or changed it yet. */
  aiSuggested: z.boolean().optional(),
  /** Leaves out transfers between accounts of the selection. */
  hideTransfers: z.boolean().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  /** Bounds on the amount in cents regardless of its sign: 5000 is 50 € in or out. */
  amountMinCents: amountCents.optional(),
  amountMaxCents: amountCents.optional(),
  period: z.enum(PERIODS).optional(),
  dateFrom: isoDay.optional(),
  dateTo: isoDay.optional(),
});
export type BookingFilter = z.infer<typeof bookingFilterSchema>;

/** The quick filters above a booking list; at most one is active. */
export const QUICK_FILTERS = ["unread", "uncategorized", "aiSuggested"] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

/** Filters as search parameters; the keys are German because they show in the address bar. */
export type BookingSearch = {
  gruppe?: number;
  konto?: number;
  kategorie?: number;
  tag?: number;
  richtung?: "ein" | "aus";
  neu?: boolean;
  ohneKategorie?: boolean;
  kiVorschlag?: boolean;
  ohneUmbuchungen?: boolean;
  q?: string;
  /** Euros, regardless of the sign. */
  betragAb?: number;
  betragBis?: number;
  zeitraum?: Period;
  von?: string;
  bis?: string;
};

/** Order of a booking list; the first is the default and stays out of the address. */
export const BOOKING_SORTS = ["datum", "datum-auf", "betrag-ab", "betrag-auf"] as const;
export type BookingSort = (typeof BOOKING_SORTS)[number];

/** A booking list as shown: its filter and its order. */
export const bookingViewSchema = z.object({ filter: bookingFilterSchema, sort: z.enum(BOOKING_SORTS).optional() });
export type BookingView = z.infer<typeof bookingViewSchema>;

const SERVER_SORT = {
  datum: "newest",
  "datum-auf": "oldest",
  "betrag-ab": "largest_income",
  "betrag-auf": "largest_expense",
} as const satisfies Record<BookingSort, string>;

export type TransactionSearch = BookingSearch & { sortierung?: Exclude<BookingSort, "datum"> };

/** Bookings a list loads at once, first and each time it reaches its end. */
export const CHUNK_SIZE = 50;

/** Search parameter keys that hold a filter (not the order). */
export const FILTER_KEYS = [
  "gruppe",
  "konto",
  "kategorie",
  "tag",
  "richtung",
  "neu",
  "ohneKategorie",
  "kiVorschlag",
  "ohneUmbuchungen",
  "q",
  "betragAb",
  "betragBis",
  "zeitraum",
  "von",
  "bis",
] as const satisfies readonly (keyof BookingSearch)[];

function id(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function flag(value: unknown): true | undefined {
  return value === true || value === "true" || value === "1" ? true : undefined;
}

function euros(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000_000 ? Math.round(n * 100) / 100 : undefined;
}

function day(value: unknown): string | undefined {
  return typeof value === "string" && ISO_DAY.test(value) ? value : undefined;
}

/** Validates raw search parameters (from the address or a link); invalid values are dropped, unknown keys ignored. */
export function parseBookingSearch(raw: Record<string, unknown>): BookingSearch {
  const q = typeof raw.q === "string" && raw.q.trim() ? raw.q.trim().slice(0, 100) : undefined;
  const search: BookingSearch = {
    gruppe: id(raw.gruppe),
    konto: id(raw.konto),
    kategorie: id(raw.kategorie),
    tag: id(raw.tag),
    richtung: raw.richtung === "ein" || raw.richtung === "aus" ? raw.richtung : undefined,
    neu: flag(raw.neu),
    ohneKategorie: flag(raw.ohneKategorie),
    kiVorschlag: flag(raw.kiVorschlag),
    ohneUmbuchungen: flag(raw.ohneUmbuchungen),
    q,
    betragAb: euros(raw.betragAb),
    betragBis: euros(raw.betragBis),
    zeitraum: isPeriod(raw.zeitraum) ? raw.zeitraum : undefined,
    von: day(raw.von),
    bis: day(raw.bis),
  };
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined)) as BookingSearch;
}

/** Like `parseBookingSearch` plus the order; a page number (`seite`) from older links is dropped, the list grows by scrolling. */
export function parseTransactionSearch(raw: Record<string, unknown>): TransactionSearch {
  const sort = BOOKING_SORTS.find((s) => s !== "datum" && s === raw.sortierung) as TransactionSearch["sortierung"];
  return { ...parseBookingSearch(raw), ...(sort ? { sortierung: sort } : {}) };
}

export function searchToFilter(search: BookingSearch): BookingFilter {
  const filter: BookingFilter = {
    groupId: search.gruppe,
    accountId: search.konto,
    categoryId: search.kategorie,
    tagId: search.tag,
    direction: search.richtung === "ein" ? "in" : search.richtung === "aus" ? "out" : undefined,
    unread: search.neu || undefined,
    uncategorized: search.ohneKategorie || undefined,
    aiSuggested: search.kiVorschlag || undefined,
    hideTransfers: search.ohneUmbuchungen || undefined,
    q: search.q,
    amountMinCents: search.betragAb === undefined ? undefined : Math.round(search.betragAb * 100),
    amountMaxCents: search.betragBis === undefined ? undefined : Math.round(search.betragBis * 100),
    period: search.zeitraum,
    dateFrom: search.zeitraum ? undefined : search.von,
    dateTo: search.zeitraum ? undefined : search.bis,
  };
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== false)) as BookingFilter;
}

export function filterToSearch(filter: BookingFilter): BookingSearch {
  return parseBookingSearch({
    gruppe: filter.groupId,
    konto: filter.accountId,
    kategorie: filter.categoryId,
    tag: filter.tagId,
    richtung: filter.direction === "in" ? "ein" : filter.direction === "out" ? "aus" : undefined,
    neu: filter.unread,
    ohneKategorie: filter.uncategorized,
    kiVorschlag: filter.aiSuggested,
    ohneUmbuchungen: filter.hideTransfers,
    q: filter.q,
    betragAb: filter.amountMinCents === undefined ? undefined : filter.amountMinCents / 100,
    betragBis: filter.amountMaxCents === undefined ? undefined : filter.amountMaxCents / 100,
    zeitraum: filter.period,
    von: filter.period ? undefined : filter.dateFrom,
    bis: filter.period ? undefined : filter.dateTo,
  });
}

/** Reads a filter from an address's query (`?konto=3&zeitraum=last_3_months`). */
export function parseBookingFilterQuery(query: string | URLSearchParams): BookingFilter {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  return searchToFilter(parseBookingSearch(Object.fromEntries(params)));
}

/** The query for an address showing the filter (`konto=3&zeitraum=last_3_months`), keys in a stable order. */
export function bookingFilterQuery(filter: BookingFilter): string {
  const search = filterToSearch(bookingFilterSchema.parse(filter));
  return new URLSearchParams(FILTER_KEYS.flatMap((key) => (search[key] === undefined ? [] : [[key, String(search[key])]]))).toString();
}

export function isEmptySearch(search: BookingSearch): boolean {
  return FILTER_KEYS.every((key) => search[key] === undefined);
}

export function sameFilter(a: BookingFilter, b: BookingFilter): boolean {
  return bookingFilterQuery(a) === bookingFilterQuery(b);
}

export function quickFilterOf(filter: BookingFilter): QuickFilter | null {
  return QUICK_FILTERS.find((key) => filter[key]) ?? null;
}

/** The dates a filter covers on `today`; a relative period wins over fixed dates. */
export function filterRange(filter: BookingFilter, today = new Date()): { dateFrom: string | null; dateTo: string | null } {
  if (filter.period) return resolvePeriod(filter.period, today);
  return { dateFrom: filter.dateFrom ?? null, dateTo: filter.dateTo ?? null };
}

/** Incoming bookings have a positive amount, outgoing ones a negative amount. */
export function directionBounds(direction: BookingFilter["direction"]) {
  return { minAmountCents: direction === "in" ? 1 : null, maxAmountCents: direction === "out" ? -1 : null };
}

/** The filter as the server's list input (modules/transactions `filterInput`). */
export function listFilters(filter: BookingFilter, today = new Date()) {
  return {
    groupId: filter.groupId ?? null,
    accountId: filter.accountId ?? null,
    categoryId: filter.categoryId ?? null,
    tagId: filter.tagId ?? null,
    uncategorized: filter.uncategorized ?? false,
    unread: filter.unread ?? false,
    aiSuggested: filter.aiSuggested ?? false,
    includeTransfers: !filter.hideTransfers,
    q: filter.q ?? null,
    absMinCents: filter.amountMinCents ?? null,
    absMaxCents: filter.amountMaxCents ?? null,
    ...filterRange(filter, today),
    ...directionBounds(filter.direction),
  };
}

export function serverSort(sort: BookingSort | undefined) {
  return SERVER_SORT[sort ?? "datum"];
}

/** Address of the CSV download with the same filters as the list (see routes/api/transactions/export[.]csv.ts). */
export function csvExportUrl(filter: BookingFilter, today = new Date()): string {
  const f = listFilters(filter, today);
  const p = new URLSearchParams();
  const set = (key: string, value: string | number | undefined | null | false) => {
    if (value !== undefined && value !== null && value !== false && value !== "") p.set(key, String(value));
  };
  set("group", f.groupId);
  set("account", f.accountId);
  set("category", f.categoryId);
  set("tag", f.tagId);
  set("uncategorized", f.uncategorized && "1");
  set("unread", f.unread && "1");
  set("ai", f.aiSuggested && "1");
  set("transfers", !f.includeTransfers && "0");
  set("q", f.q);
  set("absMin", f.absMinCents);
  set("absMax", f.absMaxCents);
  set("from", f.dateFrom);
  set("to", f.dateTo);
  set("min", f.minAmountCents);
  set("max", f.maxAmountCents);
  const query = p.toString();
  return `/api/transactions/export.csv${query ? `?${query}` : ""}`;
}

/**
 * Drops what the viewer cannot apply: a group they no longer see, an account outside their accounts or outside the
 * chosen group. Saved filters and old links then show the rest instead of failing.
 */
export function applicableFilter(
  filter: BookingFilter,
  known: { groups: readonly { id: number }[]; accounts: readonly { id: number; groupIds: readonly number[] }[] },
): BookingFilter {
  const { groupId, accountId, ...rest } = filter;
  const group = groupId !== undefined && known.groups.some((g) => g.id === groupId) ? groupId : undefined;
  const account = known.accounts.find((a) => a.id === accountId);
  const keepAccount = account !== undefined && (group === undefined || account.groupIds.includes(group));
  return { ...rest, ...(group !== undefined ? { groupId: group } : {}), ...(keepAccount ? { accountId: account.id } : {}) };
}
