import { describe, expect, it } from "vitest";
import { guessAccountKind, remoteAccountName } from "./accounts.ts";

describe("accounts from bank data", () => {
  it("guesses the kind from type, product and name, checking otherwise", () => {
    expect(guessAccountKind({ type: "CARD" })).toBe("credit_card");
    expect(guessAccountKind({ type: "SVGS" })).toBe("savings");
    expect(guessAccountKind({ type: "PREPAID", name: "givve Card 6363" })).toBe("prepaid");
    expect(guessAccountKind({ type: "DEPOT", name: "Depot" })).toBe("brokerage");
    expect(guessAccountKind({ name: "Tagesgeld PLUS" })).toBe("savings");
    expect(guessAccountKind({ product: "Wertpapierdepot" })).toBe("brokerage");
    expect(guessAccountKind({ name: "Visa Card" })).toBe("credit_card");
    expect(guessAccountKind({ name: "Girokonto", type: "CACC" })).toBe("checking");
    expect(guessAccountKind({ name: "Konto" })).toBe("checking");
    expect(remoteAccountName({ name: "Girokonto", iban: "DE02120300000000202051" }, "DKB")).toBe("Girokonto");
    expect(remoteAccountName({ name: "DE02 1203 0000 0000 2020 51", iban: "DE02120300000000202051" }, "DKB")).toBe("DKB 2051");
    expect(remoteAccountName({ name: "Konto", iban: null }, "ING")).toBe("ING");
  });
});
