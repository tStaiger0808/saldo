import { describe, expect, it } from "vitest";
import { translator } from "../i18n/index.ts";
import {
  activeFilterCount,
  amountFilter,
  categoryFilter,
  clearKeys,
  directionFilter,
  type FilterDef,
  type FilterValues,
  filterChips,
  groupFilter,
  periodFilter,
  pickFilterValues,
} from "./filters.ts";
import { formatter } from "./format.ts";

const t = translator("de");
const f = formatter("de");
const DEFS: FilterDef[] = [
  categoryFilter(t, [
    { id: 4, name: "Lebensmittel" },
    { id: 7, name: "Miete" },
  ]),
  directionFilter(t),
  { kind: "dateRange", from: "von", to: "bis", label: "Zeitraum" },
  { kind: "flag", key: "neu", label: "Nur neue" },
];
const SEARCH = { key: "q", label: "Suche" };
const chipTexts = (values: FilterValues) => filterChips(DEFS, values, SEARCH, t, f).map((chip) => chip.text);

describe("filter chips", () => {
  it("shows no chip for default values", () => {
    expect(chipTexts({})).toEqual([]);
    expect(chipTexts({ kategorie: undefined, neu: false, q: "", seite: 3 })).toEqual([]);
    expect(activeFilterCount(DEFS, { neu: false, q: "rewe" })).toBe(0);
  });

  it("names each active filter, in the order of the definitions and the search last", () => {
    expect(chipTexts({ q: "eBay", neu: true, richtung: "aus", kategorie: 4, von: "2026-01-01", bis: "2026-03-31" })).toEqual([
      "Kategorie: Lebensmittel",
      "Nur Ausgänge",
      "Zeitraum: 01.01.2026 – 31.03.2026",
      "Nur neue",
      "Suche: „eBay“",
    ]);
  });

  it("describes open date ranges and unknown options", () => {
    expect(chipTexts({ von: "2026-02-01" })).toEqual(["Zeitraum: ab 01.02.2026"]);
    expect(chipTexts({ bis: "2026-02-28" })).toEqual(["Zeitraum: bis 28.02.2026"]);
    expect(chipTexts({ kategorie: 99 })).toEqual(["Kategorie: 99"]);
  });

  it("lists the keys a chip clears, and a date range counts once", () => {
    const chips = filterChips(DEFS, { von: "2026-02-01", bis: "2026-02-28", richtung: "ein" }, SEARCH, t, f);
    expect(chips.map((chip) => chip.keys)).toEqual([["richtung"], ["von", "bis"]]);
    expect(activeFilterCount(DEFS, { von: "2026-02-01", bis: "2026-02-28", richtung: "ein" })).toBe(2);
    expect(clearKeys(["von", "bis"])).toEqual({ von: undefined, bis: undefined });
  });

  it("translates chip texts", () => {
    const en = translator("en");
    const chips = filterChips([directionFilter(en)], { richtung: "ein", q: "rent" }, { key: "q", label: "Search" }, en, formatter("en"));
    expect(chips.map((chip) => chip.text)).toEqual(["Incoming only", "Search: “rent”"]);
  });

  it("copies only the dialog's own keys", () => {
    expect(pickFilterValues(DEFS, { kategorie: 7, q: "x", seite: 2, neu: false })).toEqual({
      kategorie: 7,
      richtung: undefined,
      von: undefined,
      bis: undefined,
      neu: undefined,
    });
  });

  it("names a relative period or its fixed dates, and a group, in one chip each", () => {
    const defs = [groupFilter(t, [{ id: 2, name: "Familie" }]), periodFilter(t, ["last_3_months", "this_year"])];
    const texts = (values: FilterValues) => filterChips(defs, values, null, t, f).map((chip) => chip.text);
    expect(texts({ gruppe: 2, zeitraum: "last_3_months" })).toEqual(["Gruppe: Familie", "Zeitraum: Letzte 3 Monate"]);
    expect(texts({ von: "2026-01-01", bis: "2026-03-31" })).toEqual(["Zeitraum: 01.01.2026 – 31.03.2026"]);
    expect(filterChips(defs, { zeitraum: "this_year" }, null, t, f)[0]?.keys).toEqual(["zeitraum", "von", "bis"]);
  });

  it("names amount bounds regardless of sign in one chip", () => {
    const defs = [amountFilter(t)];
    const texts = (values: FilterValues) => filterChips(defs, values, null, t, f).map((chip) => chip.text);
    expect(texts({ betragAb: 50 })).toEqual(["Betrag: ab 50,00\u00a0€"]);
    expect(texts({ betragBis: 99.5 })).toEqual(["Betrag: bis 99,50\u00a0€"]);
    expect(texts({ betragAb: 10, betragBis: 20 })).toEqual(["Betrag: 10,00\u00a0€ – 20,00\u00a0€"]);
    expect(filterChips(defs, { betragAb: 1 }, null, t, f)[0]?.keys).toEqual(["betragAb", "betragBis"]);
  });
});
