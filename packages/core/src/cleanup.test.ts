import { describe, expect, it } from "vitest";
import { type CleanupRule, type CleanupTxn, planAiRuleCleanup } from "./cleanup.ts";

let nextId = 1;
const ai = (pattern: string, categoryKind: CleanupRule["categoryKind"], extra: Partial<CleanupRule> = {}): CleanupRule => ({
  id: nextId++,
  pattern,
  field: "counterparty",
  source: "ai",
  direction: "any",
  categoryKind,
  ...extra,
});
const booking = (counterparty: string, amountCents: number, extra: Partial<CleanupTxn> = {}): CleanupTxn => ({
  counterparty,
  purpose: "",
  amountCents,
  isTransfer: false,
  ...extra,
});

describe("AI rule cleanup plan", () => {
  it("removes intermediary rules, gives one-way rules a direction and narrows mixed ones to the way their kind fits", () => {
    const paypal = [
      ai("PayPal Europe S.a.r.l. et Cie S.C.A", "income"),
      ai("PayPal (Europe) S.a r.l. et Cie, S.C.A.", "expense"),
      ai("PayPal (Europe) S.à r.l. et Cie, SCA", "expense"),
      ai("PAYPAL", "income"),
      ai("PayPal Europe S.a.r.l. et Cie S.C.A", "expense", { direction: "out" }),
    ];
    const oneWay = ai("Gasthof Hirsch", "expense");
    const salary = ai("Muster GmbH", "income");
    const mixed = ai("Max Mustermann", "expense");
    const savings = ai("Bausparkasse Mainz", "savings");
    const contradicting = ai("Stadtwerke Immenstadt", "income");
    const unused = ai("Nie Gesehen GmbH", "expense");
    const directional = ai("Cafe Kult", "expense", { direction: "out" });
    const manual: CleanupRule = { ...ai("paypal", "expense"), source: "manual" };
    const txns = [
      booking("PayPal Europe S.a.r.l. et Cie S.C.A", 2_599),
      booking("PayPal Europe S.a.r.l. et Cie S.C.A", -1_000),
      booking("Gasthof Hirsch", -4_200),
      booking("Gasthof Hirsch", -3_100),
      booking("Muster GmbH", 352_000),
      booking("Max Mustermann", -5_000),
      booking("Max Mustermann", 2_500),
      booking("Bausparkasse Mainz", -10_000),
      booking("Bausparkasse Mainz", 50_000),
      booking("Stadtwerke Immenstadt", -9_500),
      // Transfers never count, so this one does not make the rule mixed.
      booking("Gasthof Hirsch", 4_200, { isTransfer: true }),
      booking("Cafe Kult", 800),
    ];
    const plan = planAiRuleCleanup([...paypal, oneWay, salary, mixed, savings, contradicting, unused, directional, manual], txns);
    expect(plan.remove).toEqual([...paypal.map((r) => ({ id: r.id, reason: "intermediary" })), { id: contradicting.id, reason: "kind" }]);
    expect(plan.narrow).toEqual([
      { id: oneWay.id, direction: "out" },
      { id: salary.id, direction: "in" },
      { id: mixed.id, direction: "out" },
    ]);
  });

  it("changes nothing on a second run", () => {
    const rule = ai("Gasthof Hirsch", "expense");
    const txns = [booking("Gasthof Hirsch", -4_200)];
    const [narrowed] = planAiRuleCleanup([rule], txns).narrow;
    expect(planAiRuleCleanup([{ ...rule, direction: narrowed?.direction ?? "any" }], txns)).toEqual({ remove: [], narrow: [] });
  });
});
