import { describe, expect, it } from "vitest";
import { foldForSearch, matchOptions, searchIndex } from "./combobox.ts";

const BANKS = [
  "1822direkt",
  "Ärzte- und Apothekerbank",
  "Bank im Bistum Essen",
  "comdirect",
  "Commerzbank",
  "DKB",
  "Evangelische Bank",
  "ING",
  "Sparkasse Heilbronn",
  "Thüringer Aufbaubank",
  "VR Bank Ingolstadt",
];
const index = searchIndex(BANKS, (name) => name);

describe("combobox matching", () => {
  it("folds case, accents and ß", () => {
    expect(foldForSearch("Ärzte")).toBe("arzte");
    expect(foldForSearch("Straße")).toBe("strasse");
    expect(foldForSearch("Crédit Mutuel")).toBe("credit mutuel");
  });

  it("matches substrings ignoring case and accents, the label start first, then a word start, then the rest", () => {
    expect(matchOptions(index, "ing", 50).items).toEqual(["ING", "VR Bank Ingolstadt", "Thüringer Aufbaubank"]);
    expect(matchOptions(index, "arzte", 50).items).toEqual(["Ärzte- und Apothekerbank"]);
    expect(matchOptions(index, "ÄRZTE", 50).items).toEqual(["Ärzte- und Apothekerbank"]);
    expect(matchOptions(index, "bank", 50).items).toEqual([
      "Bank im Bistum Essen",
      "Evangelische Bank",
      "VR Bank Ingolstadt",
      "Ärzte- und Apothekerbank",
      "Commerzbank",
      "Thüringer Aufbaubank",
    ]);
  });

  it("keeps the given order within a rank", () => {
    expect(matchOptions(index, "com", 50).items).toEqual(["comdirect", "Commerzbank"]);
  });

  it("limits the shown items and counts all matches", () => {
    expect(matchOptions(index, "", 3)).toEqual({ items: ["1822direkt", "Ärzte- und Apothekerbank", "Bank im Bistum Essen"], total: 11 });
    expect(matchOptions(index, "  bank ", 2)).toEqual({ items: ["Bank im Bistum Essen", "Evangelische Bank"], total: 6 });
    expect(matchOptions(index, "xyz", 50)).toEqual({ items: [], total: 0 });
  });
});
