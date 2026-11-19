import { describe, expect, it } from "vitest";
import {
  applicableFilter,
  bookingFilterQuery,
  bookingFilterSchema,
  csvExportUrl,
  filterToSearch,
  isEmptySearch,
  listFilters,
  parseBookingFilterQuery,
  parseTransactionSearch,
  quickFilterOf,
  sameFilter,
  searchToFilter,
  serverSort,
} from "./booking-filter.ts";

const TODAY = new Date(2026, 10, 17);

describe("booking filter", () => {
  it("drops invalid search values and the old page number, keeps valid ones and the order", () => {
    expect(
      parseTransactionSearch({
        konto: "3",
        kategorie: "x",
        von: "2026-01-01",
        bis: "01.02.2026",
        neu: true,
        q: "  rewe ",
        seite: "2",
        sortierung: "betrag-auf",
        zeitraum: "letzte",
        ansicht: "7",
      }),
    ).toEqual({ konto: 3, von: "2026-01-01", neu: true, q: "rewe", sortierung: "betrag-auf" });
    expect(parseTransactionSearch({ seite: "1", sortierung: "datum" })).toEqual({});
  });

  it("round-trips between the address and the typed filter", () => {
    const filter = bookingFilterSchema.parse({
      groupId: 2,
      accountId: 5,
      categoryId: 4,
      tagId: 9,
      direction: "out",
      unread: true,
      hideTransfers: true,
      q: "a&b",
      period: "last_3_months",
    });
    const query = bookingFilterQuery(filter);
    expect(query).toBe("gruppe=2&konto=5&kategorie=4&tag=9&richtung=aus&neu=true&ohneUmbuchungen=true&q=a%26b&zeitraum=last_3_months");
    expect(parseBookingFilterQuery(query)).toEqual(filter);
    expect(searchToFilter(filterToSearch(filter))).toEqual(filter);
  });

  it("lets a relative period win over fixed dates", () => {
    const filter = searchToFilter({ zeitraum: "this_month", von: "2020-01-01", bis: "2020-01-31" });
    expect(filter).toEqual({ period: "this_month" });
    expect(listFilters(filter, TODAY)).toMatchObject({ dateFrom: "2026-11-01", dateTo: "2026-11-17" });
    expect(listFilters({ dateFrom: "2026-02-01" }, TODAY)).toMatchObject({ dateFrom: "2026-02-01", dateTo: null });
  });

  it("maps to the server's list input and the CSV address with the same filters", () => {
    const filter = searchToFilter(parseTransactionSearch({ gruppe: 5, tag: 2, ohneUmbuchungen: true, q: "a&b", kiVorschlag: true }));
    expect(listFilters(filter, TODAY)).toMatchObject({ groupId: 5, tagId: 2, includeTransfers: false, q: "a&b", aiSuggested: true });
    expect(csvExportUrl(filter, TODAY)).toBe("/api/transactions/export.csv?group=5&tag=2&ai=1&transfers=0&q=a%26b");
    expect(csvExportUrl({}, TODAY)).toBe("/api/transactions/export.csv");
    expect(listFilters({ direction: "in" })).toMatchObject({ minAmountCents: 1, maxAmountCents: null });
    expect(listFilters({ direction: "out" })).toMatchObject({ minAmountCents: null, maxAmountCents: -1 });
  });

  it("knows empty searches, equal filters, the quick filter and the order", () => {
    expect(isEmptySearch(parseTransactionSearch({ seite: 3, sortierung: "datum-auf" }))).toBe(true);
    expect(isEmptySearch({ neu: true })).toBe(false);
    expect(sameFilter({ q: "x", unread: true }, { unread: true, q: "x" })).toBe(true);
    expect(sameFilter({ q: "x" }, { q: "y" })).toBe(false);
    expect(quickFilterOf({ uncategorized: true, categoryId: 3 })).toBe("uncategorized");
    expect(quickFilterOf({ categoryId: 3 })).toBeNull();
    expect(serverSort(undefined)).toBe("newest");
    expect(serverSort("betrag-ab")).toBe("largest_income");
    expect(serverSort("betrag-auf")).toBe("largest_expense");
  });
});

describe("amount bounds", () => {
  it("round-trip in euros through the address and in cents through the filter, regardless of sign", () => {
    const filter = searchToFilter(parseTransactionSearch({ betragAb: "50", betragBis: "120.5", richtung: "aus" }));
    expect(filter).toEqual({ amountMinCents: 5_000, amountMaxCents: 12_050, direction: "out" });
    expect(bookingFilterQuery(filter)).toBe("richtung=aus&betragAb=50&betragBis=120.5");
    expect(parseBookingFilterQuery(bookingFilterQuery(filter))).toEqual(filter);
    expect(listFilters(filter, TODAY)).toMatchObject({ absMinCents: 5_000, absMaxCents: 12_050, maxAmountCents: -1 });
    expect(csvExportUrl({ amountMinCents: 5_000 }, TODAY)).toBe("/api/transactions/export.csv?absMin=5000");
    expect(parseTransactionSearch({ betragAb: "-3", betragBis: "x" })).toEqual({});
    expect(bookingFilterSchema.safeParse({ amountMinCents: -1 }).success).toBe(false);
  });
});

describe("group scoping of a filter", () => {
  const known = {
    groups: [{ id: 1 }, { id: 2 }],
    accounts: [
      { id: 10, groupIds: [1] },
      { id: 11, groupIds: [2] },
      { id: 12, groupIds: [] },
    ],
  };

  it("keeps a visible group and an account inside it", () => {
    expect(applicableFilter({ groupId: 1, accountId: 10, q: "x" }, known)).toEqual({ q: "x", groupId: 1, accountId: 10 });
  });

  it("drops an account outside the chosen group, so the group decides", () => {
    expect(applicableFilter({ groupId: 1, accountId: 11 }, known)).toEqual({ groupId: 1 });
  });

  it("drops a group or account the viewer no longer sees, and keeps any visible account without a group", () => {
    expect(applicableFilter({ groupId: 7, accountId: 12 }, known)).toEqual({ accountId: 12 });
    expect(applicableFilter({ accountId: 99, unread: true }, known)).toEqual({ unread: true });
  });
});
