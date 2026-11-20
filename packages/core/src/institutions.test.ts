import { describe, expect, it } from "vitest";
import { type ClassifyAccount, type ClassifyTxn, classify } from "./classify.ts";
import { institutionKeys, namesInstitution } from "./institutions.ts";

let nextId = 1;
const txn = (accountId: number, amountCents: number, counterparty: string, bookingDate: string, extra: Partial<ClassifyTxn> = {}) =>
  ({
    id: nextId++,
    accountId,
    amountCents,
    bookingDate,
    counterparty,
    counterpartyIban: null,
    purpose: "",
    isTransfer: false,
    transferManual: false,
    transferAccountId: null,
    categoryId: null,
    categorySource: null,
    manualTagIds: [],
    aiTagIds: [],
    ...extra,
  }) satisfies ClassifyTxn;

const bank: ClassifyAccount = {
  id: 1,
  iban: "DE02120300000000202051",
  transferPatterns: [],
  names: ["dkb", "DKB Girokonto", "dkb", "DKB"],
};
/** A wallet nobody wrote code for: its names come only from its own account and connection. */
const wallet: ClassifyAccount = { id: 2, iban: null, transferPatterns: [], names: ["zahlfix", "Zahlfix Wallet", "zahlfix", "Zahlfix"] };
const paypal: ClassifyAccount = { id: 3, iban: null, transferPatterns: [], names: ["paypal", "PayPal", "paypal", "PayPal"] };

const flags = (result: ReturnType<typeof classify>, t: ClassifyTxn) => {
  const r = result.get(t.id);
  return [r?.isTransfer, r?.transferAccountId];
};

describe("institution keys", () => {
  it("drops legal forms, regions, account words and accents", () => {
    expect(institutionKeys(["PayPal (Europe) S.à r.l. et Cie, S.C.A.", "paypal", "DKB Girokonto", "Bank", "Sparkasse"])).toEqual([
      ["paypal"],
      ["dkb"],
    ]);
    expect(institutionKeys(["volksbank-allgaeu-west"])).toEqual([["volksbank", "allgau", "west"]]);
  });

  it("matches whole words only", () => {
    const keys = institutionKeys(["ing"]);
    expect(namesInstitution("ING-DiBa AG", keys)).toBe(true);
    expect(namesInstitution("Sparkasse Ingolstadt", keys)).toBe(false);
    expect(namesInstitution("PAYPAL *SPOTIFY 3531", institutionKeys(["PayPal"]))).toBe(true);
    expect(namesInstitution("Volksbank Allgäu-Oberschwaben", institutionKeys(["Volksbank Allgäu West"]))).toBe(false);
  });
});

describe("pairing by institution", () => {
  it("makes the bank debit for a wallet purchase a transfer and keeps the purchase", () => {
    const debit = txn(1, -2_499, "Zahlfix Europe GmbH", "2026-11-04", { purpose: "Ihr Einkauf bei Teeladen" });
    const purchase = txn(2, -2_499, "Teeladen", "2026-11-02");
    const result = classify([debit, purchase], [bank, wallet], []);
    expect(flags(result, debit)).toEqual([true, 2]);
    expect(flags(result, purchase)).toEqual([false, null]);
  });

  it("handles the PayPal shape the same way", () => {
    const debit = txn(1, -1_000, "PayPal (Europe) S.à r.l. et Cie, S.C.A.", "2026-11-03", {
      purpose: "1054534523152/PP.8419.PP/. AliExpress, Ihr Einkauf bei AliExpress",
    });
    const purchase = txn(3, -1_000, "AliExpress", "2026-11-02");
    const result = classify([debit, purchase], [bank, paypal], []);
    expect(flags(result, debit)).toEqual([true, 3]);
    expect(flags(result, purchase)).toEqual([false, null]);
  });

  it("only within two days before to five days after the wallet booking", () => {
    const cases: [string, boolean][] = [
      ["2026-11-07", false],
      ["2026-11-08", true],
      ["2026-11-15", true],
      ["2026-11-16", false],
    ];
    for (const [date, paired] of cases) {
      const debit = txn(1, -500, "Zahlfix", date);
      const purchase = txn(2, -500, "Shop", "2026-11-10");
      expect(classify([debit, purchase], [bank, wallet], []).get(debit.id)?.isTransfer, date).toBe(paired);
    }
  });

  it("pairs two purchases of the same amount one to one, nearest date first", () => {
    const early = txn(2, -999, "Shop A", "2026-11-01");
    const late = txn(2, -999, "Shop B", "2026-11-05");
    const d1 = txn(1, -999, "Zahlfix", "2026-11-06");
    const d2 = txn(1, -999, "Zahlfix", "2026-11-02");
    const third = txn(1, -999, "Zahlfix", "2026-11-03");
    const result = classify([early, late, d1, d2, third], [bank, wallet], []);
    expect(flags(result, d1)).toEqual([true, 2]);
    expect(flags(result, d2)).toEqual([true, 2]);
    expect(flags(result, third)).toEqual([false, null]);
  });

  it("leaves a purchase partly paid from the wallet balance alone", () => {
    const debit = txn(1, -1_500, "Zahlfix", "2026-11-03");
    const purchase = txn(2, -2_000, "Shop", "2026-11-02");
    expect(flags(classify([debit, purchase], [bank, wallet], []), debit)).toEqual([false, null]);
  });

  it("pairs a refund credit from the wallet with the wallet's incoming refund", () => {
    const refund = txn(3, 2_599, "Zalando SE", "2026-11-10");
    const credit = txn(1, 2_599, "PayPal Europe S.a.r.l. et Cie S.C.A", "2026-11-12");
    const result = classify([refund, credit], [bank, paypal], []);
    expect(flags(result, credit)).toEqual([true, 3]);
    expect(flags(result, refund)).toEqual([false, null]);
  });

  it("pairs a delivered funding credit as an ordinary transfer instead", () => {
    const debit = txn(1, -3_000, "Zahlfix", "2026-11-03");
    const funding = txn(2, 3_000, "Bankeinzug", "2026-11-02");
    const purchase = txn(2, -3_000, "Shop", "2026-11-02");
    const result = classify([debit, funding, purchase], [bank, wallet], []);
    expect(flags(result, debit)).toEqual([true, 2]);
    expect(flags(result, funding)).toEqual([true, 1]);
    expect(flags(result, purchase)).toEqual([false, null]);
  });

  it("lets the existing IBAN pairing win", () => {
    const walletWithIban = { ...wallet, iban: "LU89751000135104200E" };
    const debit = txn(1, -3_000, "Zahlfix", "2026-11-03", { counterpartyIban: "LU89751000135104200E" });
    const funding = txn(2, 3_000, "Bankeinzug", "2026-11-05");
    const purchase = txn(2, -3_000, "Shop", "2026-11-03");
    const result = classify([debit, funding, purchase], [bank, walletWithIban], []);
    expect(flags(result, debit)).toEqual([true, 2]);
    expect(flags(result, funding)).toEqual([true, 1]);
    expect(flags(result, purchase)).toEqual([false, null]);
  });

  it("changes nothing without a connected wallet", () => {
    const debit = txn(1, -1_000, "PayPal Europe S.a.r.l. et Cie S.C.A", "2026-11-03");
    expect(flags(classify([debit], [bank], []), debit)).toEqual([false, null]);
  });

  it("needs the counterparty to name the wallet", () => {
    const shop = txn(1, -2_499, "Teeladen", "2026-11-03");
    const purchase = txn(2, -2_499, "Teeladen", "2026-11-02");
    expect(flags(classify([shop, purchase], [bank, wallet], []), shop)).toEqual([false, null]);
  });

  it("does not take a bank with a similar name for an own account", () => {
    const ownVolksbank: ClassifyAccount = { id: 5, iban: null, transferPatterns: [], names: ["volksbank-allgaeu-west", "Girokonto"] };
    const loan = txn(1, -45_000, "Volksbank Allgäu-Oberschwaben eG", "2026-11-03", { purpose: "Darlehen" });
    const other = txn(5, -45_000, "Vermieter", "2026-11-03");
    expect(flags(classify([loan, other], [bank, ownVolksbank], []), loan)).toEqual([false, null]);
  });

  it("respects manual transfer decisions on either side", () => {
    const unset = txn(1, -700, "Zahlfix", "2026-11-03", { transferManual: true });
    const purchase = txn(2, -700, "Shop", "2026-11-02");
    expect(flags(classify([unset, purchase], [bank, wallet], []), unset)).toEqual([false, null]);

    const debit = txn(1, -700, "Zahlfix", "2026-11-03");
    const markedPurchase = txn(2, -700, "Shop", "2026-11-02", { transferManual: true, isTransfer: true });
    const result = classify([debit, markedPurchase], [bank, wallet], []);
    expect(flags(result, debit)).toEqual([false, null]);
    expect(flags(result, markedPurchase)).toEqual([true, null]);
  });

  it("never pairs across someone else's private account", () => {
    const mine = { ...bank, ownerUserId: "a", visibility: "private" as const };
    const theirs = { ...wallet, ownerUserId: "b", visibility: "private" as const };
    const debit = txn(1, -1_000, "Zahlfix", "2026-11-03");
    const purchase = txn(2, -1_000, "Shop", "2026-11-02");
    expect(flags(classify([debit, purchase], [mine, theirs], []), debit)).toEqual([false, null]);
  });
});
