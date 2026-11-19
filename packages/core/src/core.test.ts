import { describe, expect, it } from "vitest";
import { type ClassifyAccount, type ClassifyRule, type ClassifyTxn, classify, kindFits, ruleApplies, ruleMatches } from "./classify.ts";
import { toCents } from "./money.ts";
import { byCategory, isInternalTransfer, priceChanges, recurringPayments, type StatTxn, summary, topCounterparties } from "./stats.ts";
import { csvCell } from "./text.ts";

let nextId = 1;
const txn = (accountId: number, amountCents: number, counterparty: string, extra: Partial<ClassifyTxn> = {}): ClassifyTxn => ({
  id: nextId++,
  accountId,
  amountCents,
  bookingDate: "2026-11-02",
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
});
const rule = (pattern: string, categoryId: number | null, extra: Partial<ClassifyRule> = {}): ClassifyRule => ({
  id: nextId++,
  pattern,
  field: "any",
  direction: "any",
  categoryId,
  categoryKind: categoryId === null ? null : "expense",
  priority: 100,
  source: "manual",
  tagIds: [],
  ...extra,
});

const giro: ClassifyAccount = { id: 1, iban: "DE02120300000000202051", transferPatterns: [] };
const savings: ClassifyAccount = { id: 2, iban: "DE02500105170137075030", transferPatterns: [] };
const card: ClassifyAccount = { id: 3, iban: null, transferPatterns: ["bank norwegian"] };
const joint: ClassifyAccount = { id: 4, iban: "DE02200411330506090200", transferPatterns: [] };
const accounts = [giro, savings, card, joint];

describe("classify", () => {
  it("marks moves between own accounts as transfers with target and pairs the counter booking", () => {
    const out = txn(1, -20_000, "ING", { counterpartyIban: savings.iban });
    const inn = txn(2, 20_000, "Tobias", { bookingDate: "2026-11-04" });
    const settle = txn(1, -9_000, "Bank Norwegian", { purpose: "Kreditkartenabrechnung" });
    const result = classify([out, inn, settle], accounts, []);
    expect(result.get(out.id)).toMatchObject({ isTransfer: true, transferAccountId: 2 });
    expect(result.get(inn.id)).toMatchObject({ isTransfer: true, transferAccountId: 1 });
    expect(result.get(settle.id)).toMatchObject({ isTransfer: true, transferAccountId: 3, categoryId: null });
  });

  it("applies rules by priority and keeps manual decisions", () => {
    const shop = txn(1, -1_200, "REWE Markt GmbH");
    const manual = txn(1, -900, "REWE Markt GmbH", { categoryId: 99, categorySource: "manual", manualTagIds: [7] });
    const result = classify([shop, manual], accounts, [rule("rewe", 10, { tagIds: [5] }), rule("markt", 11, { priority: 10 })]);
    expect(result.get(shop.id)).toMatchObject({ categoryId: 10, categorySource: "rule", tags: [{ id: 5, source: "rule" }] });
    expect(result.get(manual.id)).toMatchObject({
      categoryId: 99,
      categorySource: "manual",
      tags: [
        { id: 5, source: "rule" },
        { id: 7, source: "manual" },
      ],
    });
  });

  it("matches AI rules only on the exact counterparty", () => {
    const aiRule = { pattern: "e", field: "counterparty" as const, source: "ai" as const };
    expect(ruleMatches(aiRule, { counterparty: "Rewe Markt", purpose: "" })).toBe(false);
    expect(ruleMatches(aiRule, { counterparty: " E ", purpose: "" })).toBe(true);
    expect(ruleMatches({ ...aiRule, source: "manual" }, { counterparty: "Rewe Markt", purpose: "" })).toBe(true);
  });
});

describe("classify by direction and kind", () => {
  const paypal = "PayPal Europe S.a.r.l. et Cie S.C.A";
  const refunds = 20;
  const shopping = 21;
  const pot = 22;

  it("applies a rule only to bookings of its direction", () => {
    const refund = txn(1, 2_599, paypal);
    const payment = txn(1, -1_000, paypal);
    const rules = [rule(paypal, refunds, { field: "counterparty", source: "ai", priority: 50, direction: "in", categoryKind: "income" })];
    const result = classify([refund, payment], accounts, rules);
    expect(result.get(refund.id)).toMatchObject({ categoryId: refunds, categorySource: "rule" });
    // The observed bug: a refund rule must never turn an outgoing payment into income.
    expect(result.get(payment.id)).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("never gives a booking a category whose kind contradicts its sign, even from a rule without direction", () => {
    const refund = txn(1, 2_599, paypal);
    const payment = txn(1, -1_000, paypal);
    const income = rule(paypal, refunds, { field: "counterparty", source: "ai", priority: 50, categoryKind: "income", tagIds: [9] });
    const expense = rule("paypal", shopping, { priority: 10, categoryKind: "expense" });
    const result = classify([refund, payment], accounts, [income, expense]);
    expect(result.get(payment.id)).toMatchObject({ categoryId: shopping, categorySource: "rule", tags: [{ id: 9, source: "rule" }] });
    expect(result.get(refund.id)).toMatchObject({ categoryId: refunds, categorySource: "rule" });
  });

  it("adds AI tags beside rule and manual ones and names the strongest source of each", () => {
    const booking = txn(1, -1_200, "REWE Markt GmbH", { manualTagIds: [7], aiTagIds: [5, 7, 8] });
    const result = classify([booking], accounts, [rule("rewe", 10, { tagIds: [5, 6] })]);
    expect(result.get(booking.id)?.tags).toEqual([
      { id: 5, source: "ai" },
      { id: 6, source: "rule" },
      { id: 7, source: "manual" },
      { id: 8, source: "ai" },
    ]);
  });

  it("lets savings categories go both ways", () => {
    const deposit = txn(1, -5_000, "Sparplan");
    const withdrawal = txn(1, 5_000, "Sparplan");
    const result = classify([deposit, withdrawal], accounts, [rule("sparplan", pot, { categoryKind: "savings" })]);
    expect(result.get(deposit.id)?.categoryId).toBe(pot);
    expect(result.get(withdrawal.id)?.categoryId).toBe(pot);
    expect(kindFits("expense", 0)).toBe(true);
    expect(kindFits("income", 0)).toBe(false);
  });

  it("keeps manual over AI over rule decisions", () => {
    const rules = [rule("rewe", shopping)];
    const manual = txn(1, -900, "REWE", { categoryId: 1, categorySource: "manual" });
    const byAi = txn(1, -900, "REWE", { categoryId: 2, categorySource: "ai" });
    const byRule = txn(1, -900, "REWE", { categoryId: 3, categorySource: "rule" });
    const orphan = txn(1, -900, "REWE", { categoryId: null, categorySource: "ai" });
    const result = classify([manual, byAi, byRule, orphan], accounts, rules);
    expect(result.get(manual.id)).toMatchObject({ categoryId: 1, categorySource: "manual" });
    expect(result.get(byAi.id)).toMatchObject({ categoryId: 2, categorySource: "ai" });
    expect(result.get(byRule.id)).toMatchObject({ categoryId: shopping, categorySource: "rule" });
    // An AI category that was deleted falls back to the rules.
    expect(result.get(orphan.id)).toMatchObject({ categoryId: shopping, categorySource: "rule" });
  });

  it("matches AI purpose rules on the merchant as a whole word", () => {
    const aiRule = { pattern: "Spotify AB", field: "purpose" as const, source: "ai" as const };
    expect(ruleMatches(aiRule, { counterparty: paypal, purpose: "PP.1234.PP . Spotify AB, Ihr Einkauf bei Spotify AB" })).toBe(true);
    expect(ruleMatches(aiRule, { counterparty: paypal, purpose: "PP.1234.PP . Spotify ABC" })).toBe(false);
    expect(ruleApplies({ ...aiRule, direction: "out" }, { counterparty: "", purpose: "Spotify AB", amountCents: 1_000 })).toBe(false);
  });
});

const stat = (accountId: number, amountCents: number, counterparty: string, extra: Partial<StatTxn> = {}): StatTxn => ({
  id: nextId++,
  accountId,
  bookingDate: "2026-11-02",
  amountCents,
  counterparty,
  isTransfer: false,
  transferAccountId: null,
  category: null,
  tags: [],
  transferAccount: null,
  ...extra,
});
const savingsAccount = { id: 2, name: "Tagesgeld", color: "#f97316", kind: "savings" };
const jointAccount = { id: 4, name: "Gemeinschaftskonto", color: "#facc15", kind: "checking" };

describe("transfers per view", () => {
  const toJoint = stat(1, -120_000, "Tobias", { isTransfer: true, transferAccountId: 4, transferAccount: jointAccount });
  const toSavings = stat(1, -20_000, "ING", { isTransfer: true, transferAccountId: 2, transferAccount: savingsAccount });

  it("hides transfers inside the view and counts the ones leaving it", () => {
    expect(isInternalTransfer(toJoint, new Set([1, 4]))).toBe(true);
    expect(isInternalTransfer(toJoint, new Set([1, 2]))).toBe(false);
    expect(isInternalTransfer({ isTransfer: true, transferAccountId: null }, new Set([1]))).toBe(true);
  });

  it("books a transfer out of the group as expense, to savings as savings, with a readable label", () => {
    const txns = [toJoint, toSavings];
    expect(summary(txns)).toMatchObject({ expensesCents: 120_000, savingsCents: 20_000, uncategorizedCount: 0 });
    expect(byCategory(txns, "expense", new Set([1, 2, 4]))).toEqual([
      { categoryId: null, transferAccountId: 4, name: "Übertrag an Gemeinschaftskonto", color: "#facc15", amountCents: 120_000, count: 1 },
    ]);
    // A member who cannot see the target account only learns the counterparty text.
    expect(byCategory(txns, "expense", new Set([1]))[0]).toMatchObject({ name: "Übertrag an Tobias", transferAccountId: null });
  });

  it("keeps transfers out of top counterparties and recurring payments", () => {
    const rent = ["2026-08-03", "2026-09-03", "2026-10-03"].map((d) => stat(4, -145_000, "Hausverwaltung", { bookingDate: d }));
    const contributions = ["2026-08-01", "2026-09-01", "2026-10-01"].map((d) =>
      stat(1, -120_000, "Tobias", { bookingDate: d, isTransfer: true, transferAccountId: 4, transferAccount: jointAccount }),
    );
    expect(topCounterparties([...rent, ...contributions], 5).map((c) => c.counterparty)).toEqual(["Hausverwaltung"]);
    expect(recurringPayments([...rent, ...contributions]).map((r) => r.counterparty)).toEqual(["Hausverwaltung"]);
  });
});

describe("price changes", () => {
  it("flags a recurring payment whose amount moved by more than the threshold", () => {
    const history = ["2026-08-03", "2026-09-03", "2026-10-03"].map((d) => stat(1, -1299, "Netflix", { bookingDate: d }));
    const raised = stat(1, -1499, "NETFLIX", { bookingDate: "2026-11-03" });
    const same = stat(1, -1310, "Netflix", { bookingDate: "2026-11-04" });
    const oneOff = stat(1, -5000, "Baumarkt", { bookingDate: "2026-11-05" });
    const changes = priceChanges(history, [raised, same, oneOff], 5);
    expect(changes).toEqual([
      { txnId: raised.id, counterparty: "NETFLIX", previousCents: 1299, currentCents: 1499, changePercent: expect.closeTo(15.4, 1) },
    ]);
  });
});

describe("text and money", () => {
  it("neutralizes spreadsheet formulas", () => {
    expect(["=A1", "+1", "-2", "@x", "\tx", "ok"].map(csvCell)).toEqual(["'=A1", "'+1", "'-2", "'@x", "'\tx", "ok"]);
    expect(["  =HYPERLINK(1)", "\u00a0+1", " \n@x", "  ok"].map(csvCell)).toEqual(["'  =HYPERLINK(1)", "'\u00a0+1", "' \n@x", "  ok"]);
  });

  it("parses amounts into cents without float drift", () => {
    expect([toCents("12.34"), toCents("-0,5"), toCents(7), toCents("0.115"), toCents("21474837.00")]).toEqual([
      1234, -50, 700, 12, 2147483700,
    ]);
    expect(() => toCents("abc")).toThrow();
  });
});

describe("payeeFromPurpose", () => {
  it("takes the merchant of a card payment and drops place and order numbers", async () => {
    const { payeeFromPurpose } = await import("./text.ts");
    expect(
      payeeFromPurpose("CAMPING INTERNAZIONALE LA, LAZISE; IT; Karte Nr. 4871 78XX XXXX 7843; Kartenzahlung; comdirect Visa-Debitkarte"),
    ).toBe("CAMPING INTERNAZIONALE LA");
    expect(payeeFromPurpose("eBay O*16-15386-24688, Luxembourg; LU; Karte Nr. 4871 78XX XXXX 7843; Kartenzahlung")).toBe("eBay");
    expect(payeeFromPurpose("Karte Nr. 4871 78XX XXXX 7843; eBay O.15-14525-80288, Luxembourg L; U")).toBe("eBay");
    expect(payeeFromPurpose("Miete November")).toBe("");
  });
});
