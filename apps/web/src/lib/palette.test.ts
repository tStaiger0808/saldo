import { describe, expect, it } from "vitest";
import { ibanEndsWith, matches, parseAmountQuery } from "./palette.ts";

describe("palette", () => {
  it("matches every word, ignoring case and accents", () => {
    expect(matches("uber", "Überweisung")).toBe(true);
    expect(matches("dkb giro", "DKB Girokonto", "Deutsche Kreditbank")).toBe(true);
    expect(matches("dkb spar", "DKB Girokonto")).toBe(false);
    expect(matches("  ", "anything")).toBe(false);
  });

  it("finds an IBAN by its last digits", () => {
    expect(ibanEndsWith("DE12 1203 0000 0000 4321", "4321")).toBe(true);
    expect(ibanEndsWith("DE12120300000000004321", "1234")).toBe(false);
    expect(ibanEndsWith(null, "4321")).toBe(false);
    expect(ibanEndsWith("DE12120300000000004321", "Giro")).toBe(false);
  });

  it("reads amounts in German and English notation", () => {
    expect(parseAmountQuery("12,50")).toBe(1250);
    expect(parseAmountQuery("12.5")).toBe(1250);
    expect(parseAmountQuery("1.234,56 €")).toBe(123456);
    expect(parseAmountQuery("1,234.56")).toBe(123456);
    expect(parseAmountQuery("-8")).toBe(800);
    expect(parseAmountQuery("1.234")).toBe(123400);
    expect(parseAmountQuery("Rewe 12")).toBeNull();
    expect(parseAmountQuery("")).toBeNull();
  });
});
