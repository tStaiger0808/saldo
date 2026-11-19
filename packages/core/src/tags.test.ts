import { describe, expect, it } from "vitest";
import { cleanTagName, looksPersonal, personNameParts, resolveTagProposals, tagKey } from "./tags.ts";

describe("tag names", () => {
  it("compares without case, accents, punctuation and spacing", () => {
    expect(tagKey("  Home-Office ")).toBe(tagKey("home office"));
    expect(tagKey("Café")).toBe(tagKey("CAFE"));
  });

  it("cleans proposals and refuses long or wordy ones", () => {
    expect(cleanTagName('  "#urlaub   Italien" ')).toBe("Urlaub Italien");
    expect(cleanTagName("x".repeat(33))).toBeNull();
    expect(cleanTagName("eins zwei drei vier")).toBeNull();
    expect(cleanTagName("  ")).toBeNull();
    expect(cleanTagName(42)).toBeNull();
  });

  it("recognizes personal data: IBANs, long numbers, e-mail, mostly digits and the paying person's name", () => {
    expect(looksPersonal("DE89 3704 0044")).toBe(true);
    expect(looksPersonal("Kunde 1234567")).toBe(true);
    expect(looksPersonal("max@example.org")).toBe(true);
    expect(looksPersonal("12 34")).toBe(true);
    expect(looksPersonal("Urlaub 2026")).toBe(false);
    expect(looksPersonal("Miete Mustermann", "Max Mustermann")).toBe(true);
    expect(looksPersonal("Miete Mustermann", "Mustermann, Max")).toBe(true);
    expect(looksPersonal("Miete", "Max Mustermann")).toBe(false);
    // An organisation is no person: its name may stay part of a tag.
    expect(personNameParts("Stadtwerke Kempten GmbH")).toEqual([]);
    expect(looksPersonal("Gasthof Hirsch", "Gasthof Hirsch")).toBe(false);
  });
});

describe("resolving the model's tag answer", () => {
  const tags = [
    { id: 1, name: "Urlaub" },
    { id: 2, name: "Home Office" },
  ];
  const categories = [{ name: "Lebensmittel" }];
  const context = { tags, categories, counterparty: "Max Mustermann", allowNew: true };

  it("reuses existing tags by normalization and proposes the rest as new", () => {
    expect(resolveTagProposals(["urlaub", "home-office", "Haustier"], context)).toEqual({ existing: [1, 2], fresh: ["Haustier"] });
  });

  it("never proposes categories, duplicates, personal data or more than three", () => {
    expect(resolveTagProposals(["lebensmittel", "Garten", "garten", "Extra"], context)).toEqual({ existing: [], fresh: ["Garten"] });
    expect(resolveTagProposals(["Geschenk Mustermann", "DE89370400440532013000"], context)).toEqual({ existing: [], fresh: [] });
    expect(resolveTagProposals("Urlaub", context)).toEqual({ existing: [], fresh: [] });
  });

  it("only reuses when creating is not allowed", () => {
    expect(resolveTagProposals(["Urlaub", "Haustier"], { ...context, allowNew: false })).toEqual({ existing: [1], fresh: [] });
  });
});
