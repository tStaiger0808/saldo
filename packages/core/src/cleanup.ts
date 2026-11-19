import { bookingDirection, type ClassifyRule, type ClassifyTxn, type Direction, KIND_DIRECTIONS, ruleMatches } from "./classify.ts";
import { paymentIntermediary } from "./intermediaries.ts";

export type CleanupRule = Pick<ClassifyRule, "id" | "pattern" | "field" | "source" | "direction" | "categoryKind">;
export type CleanupTxn = Pick<ClassifyTxn, "counterparty" | "purpose" | "amountCents" | "isTransfer">;
export type CleanupReason = "intermediary" | "kind";
export type AiRuleCleanup = {
  remove: { id: number; reason: CleanupReason }[];
  narrow: { id: number; direction: Direction }[];
};

/**
 * Repairs AI rules learned before rules had a direction. Only AI rules are touched:
 * - a counterparty rule for a payment intermediary (PayPal, Klarna …) is removed, it says nothing about the purchase;
 * - a rule without direction whose non-transfer bookings all go one way gets that direction, unless its category kind
 *   contradicts it (removed);
 * - one whose bookings go both ways keeps the one direction its kind allows (an income rule only takes incoming money),
 *   and stays without direction when the kind fits both (savings);
 * - one that matches nothing stays as it is.
 * Rules that already have a direction are left alone, so running it again changes nothing.
 */
export function planAiRuleCleanup(rules: CleanupRule[], txns: CleanupTxn[]): AiRuleCleanup {
  const plan: AiRuleCleanup = { remove: [], narrow: [] };
  const bookings = txns.filter((t) => !t.isTransfer);
  for (const rule of rules) {
    if (rule.source !== "ai") continue;
    if (rule.field === "counterparty" && paymentIntermediary(rule.pattern)) {
      plan.remove.push({ id: rule.id, reason: "intermediary" });
      continue;
    }
    if (rule.direction !== "any") continue;
    const directions = new Set(bookings.filter((t) => ruleMatches(rule, t)).map((t) => bookingDirection(t.amountCents)));
    const kind = rule.categoryKind;
    if (directions.size === 1) {
      const [direction] = [...directions] as [Direction];
      if (kind && !KIND_DIRECTIONS[kind].includes(direction)) plan.remove.push({ id: rule.id, reason: "kind" });
      else plan.narrow.push({ id: rule.id, direction });
    } else if (directions.size === 2 && kind && KIND_DIRECTIONS[kind].length === 1) {
      plan.narrow.push({ id: rule.id, direction: KIND_DIRECTIONS[kind][0] as Direction });
    }
  }
  return plan;
}
