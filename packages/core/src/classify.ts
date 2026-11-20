/**
 * Derives transfer flags, categories and rule tags from accounts and rules.
 * Manual decisions (categorySource "manual", transferManual, manualTagIds) always win; everything
 * else is recomputed from scratch so edited rules apply retroactively.
 */
import { institutionKeys, namesInstitution } from "./institutions.ts";
import type { Kind } from "./stats.ts";
import type { TagSource } from "./tags.ts";
import { normalize, normalizeIban } from "./text.ts";

export type RuleField = "any" | "counterparty" | "purpose";
export type Direction = "out" | "in";
export type RuleDirection = "any" | Direction;
export type CategorySource = "manual" | "ai" | "rule";

/** Money leaving the account is "out"; a zero amount counts as "out" like a fee. */
export function bookingDirection(amountCents: number): Direction {
  return amountCents > 0 ? "in" : "out";
}

/** Which category kinds a booking of a direction may get from a rule or the AI; savings go both ways (deposit, withdrawal). */
export const KIND_DIRECTIONS: Record<Kind, readonly Direction[]> = { expense: ["out"], income: ["in"], savings: ["out", "in"] };

export function kindFits(kind: Kind, amountCents: number): boolean {
  return KIND_DIRECTIONS[kind].includes(bookingDirection(amountCents));
}

/** Owner and visibility decide which accounts may be each other's transfer target; left out, all accounts count as one owner's. */
export type ClassifyAccount = {
  id: number;
  iban: string | null;
  transferPatterns: string[];
  ownerUserId?: string | null;
  visibility?: "household" | "private";
  /** Names its institution goes by (bank, account and connection name); a booking naming it may pair with it. */
  names?: readonly (string | null | undefined)[];
};

/**
 * Money can move between one person's accounts or between household accounts. Matching across someone else's private
 * account would let one member's IBAN or patterns reclassify another's private bookings and reveal their amounts.
 */
export function mayTransferBetween(a: ClassifyAccount, b: ClassifyAccount): boolean {
  return a.ownerUserId === b.ownerUserId || (a.visibility === "household" && b.visibility === "household");
}

export type ClassifyRule = {
  id: number;
  pattern: string;
  field: RuleField;
  direction: RuleDirection;
  categoryId: number | null;
  /** Kind of `categoryId`; a rule never gives a booking a category of a kind its direction contradicts. */
  categoryKind: Kind | null;
  priority: number;
  source: "manual" | "seed" | "ai";
  tagIds: number[];
};

export type ClassifyTxn = {
  id: number;
  accountId: number;
  amountCents: number;
  bookingDate: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  isTransfer: boolean;
  transferManual: boolean;
  transferAccountId: number | null;
  categoryId: number | null;
  categorySource: CategorySource | null;
  manualTagIds: number[];
  aiTagIds: number[];
};

export type Classification = {
  isTransfer: boolean;
  transferAccountId: number | null;
  categoryId: number | null;
  categorySource: CategorySource | null;
  /** Sorted by id; a tag set by several sources counts as the strongest: manual > ai > rule. */
  tags: { id: number; source: TagSource }[];
};

const PAIRING_WINDOW_DAYS = 5;
/**
 * A wallet collects a purchase from the bank by direct debit, which settles one to three business days after the
 * purchase (five days over a weekend); a bank may also date it up to two days before the wallet does.
 */
export const WALLET_WINDOW = { bankBefore: 2, bankAfter: 5 } as const;

function haystack(txn: Pick<ClassifyTxn, "counterparty" | "purpose">, field: RuleField): string {
  if (field === "counterparty") return normalize(txn.counterparty);
  if (field === "purpose") return normalize(txn.purpose);
  return normalize(`${txn.counterparty} ${txn.purpose}`);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function containsWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const before = text[at - 1];
    const after = text[at + word.length];
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true;
  }
  return false;
}

/** Whether the rule's pattern matches the booking's text, whatever its direction. */
export function ruleMatches(
  rule: Pick<ClassifyRule, "pattern" | "field" | "source">,
  txn: Pick<ClassifyTxn, "counterparty" | "purpose">,
): boolean {
  const pattern = normalize(rule.pattern);
  if (!pattern) return false;
  const text = haystack(txn, rule.field);
  if (rule.source !== "ai") return text.includes(pattern);
  // AI rules name one exact counterparty, or a merchant inside a payment service's purpose as a whole word:
  // as substrings a short bank-supplied name would match anything.
  return rule.field === "purpose" ? containsWord(text, pattern) : pattern === text;
}

/** Whether the rule matches the booking's text and direction, so its tags apply. */
export function ruleApplies(
  rule: Pick<ClassifyRule, "pattern" | "field" | "source" | "direction">,
  txn: Pick<ClassifyTxn, "counterparty" | "purpose" | "amountCents">,
): boolean {
  return (rule.direction === "any" || rule.direction === bookingDirection(txn.amountCents)) && ruleMatches(rule, txn);
}

/** The category the rule gives this booking, or null when it does not apply or its kind contradicts the direction. */
export function ruleCategory(
  rule: Pick<ClassifyRule, "pattern" | "field" | "source" | "direction" | "categoryId" | "categoryKind">,
  txn: Pick<ClassifyTxn, "counterparty" | "purpose" | "amountCents">,
): number | null {
  if (rule.categoryId === null || rule.categoryKind === null || !kindFits(rule.categoryKind, txn.amountCents)) return null;
  return ruleApplies(rule, txn) ? rule.categoryId : null;
}

export function targetAccount(txn: ClassifyTxn, accounts: ClassifyAccount[]): ClassifyAccount | null {
  const iban = normalizeIban(txn.counterpartyIban);
  const text = haystack(txn, "any");
  const source = accounts.find((a) => a.id === txn.accountId);
  for (const account of accounts) {
    if (account.id === txn.accountId) continue;
    if (source && !mayTransferBetween(source, account)) continue;
    if (iban && iban === normalizeIban(account.iban)) return account;
    if (account.transferPatterns.some((p) => normalize(p) && text.includes(normalize(p)))) return account;
  }
  return null;
}

export function sortedRules<T extends Pick<ClassifyRule, "id" | "pattern" | "priority">>(rules: T[]): T[] {
  return [...rules].sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length || a.id - b.id);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

type TransferState = Map<number, { isTransfer: boolean; transferAccountId: number | null }>;

/**
 * Pairs bookings whose counterparty names another own account's institution, for accounts without a known IBAN or
 * pattern. With an opposite booking there it is an ordinary transfer, both sides marked. A wallet such as PayPal
 * often delivers no funding booking, only the purchase itself: the bank booking with the same sign and amount is then
 * the transfer to (or refund from) the wallet, and the wallet's booking stays the expense or income.
 * Each booking pairs at most once, nearest date first; on a tie the ordinary transfer wins, as an opposite booking is
 * the explicit funding.
 */
function pairByInstitution(txns: ClassifyTxn[], accounts: ClassifyAccount[], state: TransferState): void {
  const keyed = accounts.map((account) => ({ account, keys: institutionKeys(account.names ?? []) })).filter((a) => a.keys.length);
  if (keyed.length === 0) return;
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const free = (txn: ClassifyTxn) => !state.get(txn.id)?.isTransfer;
  const byAccountAmount = new Map<string, ClassifyTxn[]>();
  for (const txn of txns) {
    if (txn.amountCents === 0 || !free(txn)) continue;
    const key = `${txn.accountId}:${txn.amountCents}`;
    const list = byAccountAmount.get(key);
    if (list) list.push(txn);
    else byAccountAmount.set(key, [txn]);
  }

  type Candidate = { from: ClassifyTxn; other: ClassifyTxn; wallet: boolean; offset: number };
  const candidates: Candidate[] = [];
  for (const from of txns) {
    if (from.transferManual || from.amountCents === 0 || !free(from)) continue;
    const source = accountById.get(from.accountId);
    const text = from.counterparty.trim() || from.purpose;
    for (const { account, keys } of keyed) {
      if (account.id === from.accountId || (source && !mayTransferBetween(source, account)) || !namesInstitution(text, keys)) continue;
      for (const other of byAccountAmount.get(`${account.id}:${-from.amountCents}`) ?? []) {
        const offset = (Date.parse(from.bookingDate) - Date.parse(other.bookingDate)) / 86_400_000;
        if (!other.transferManual && Math.abs(offset) <= PAIRING_WINDOW_DAYS) candidates.push({ from, other, wallet: false, offset });
      }
      for (const other of byAccountAmount.get(`${account.id}:${from.amountCents}`) ?? []) {
        const offset = (Date.parse(from.bookingDate) - Date.parse(other.bookingDate)) / 86_400_000;
        if (offset >= -WALLET_WINDOW.bankBefore && offset <= WALLET_WINDOW.bankAfter)
          candidates.push({ from, other, wallet: true, offset });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.offset) - Math.abs(b.offset) ||
      Number(a.wallet) - Number(b.wallet) ||
      Number(a.offset < 0) - Number(b.offset < 0) ||
      a.from.bookingDate.localeCompare(b.from.bookingDate) ||
      a.from.id - b.from.id ||
      a.other.id - b.other.id,
  );
  const used = new Set<number>();
  for (const { from, other, wallet } of candidates) {
    if (used.has(from.id) || used.has(other.id)) continue;
    used.add(from.id);
    used.add(other.id);
    state.set(from.id, { isTransfer: true, transferAccountId: other.accountId });
    if (!wallet) state.set(other.id, { isTransfer: true, transferAccountId: from.accountId });
  }
}

/**
 * Every move between own accounts is a transfer with its target account; whether it counts in a
 * statistic is decided per view (see `internalTo`). The opposite booking on the target is paired. Bookings whose
 * counterparty only names another own account's institution are paired afterwards (`pairByInstitution`).
 */
export function classify(txns: ClassifyTxn[], accounts: ClassifyAccount[], rules: ClassifyRule[]): Map<number, Classification> {
  const ordered = sortedRules(rules);
  const state: TransferState = new Map();
  for (const txn of txns) {
    state.set(
      txn.id,
      txn.transferManual
        ? { isTransfer: txn.isTransfer, transferAccountId: txn.transferAccountId }
        : { isTransfer: false, transferAccountId: null },
    );
  }

  const candidates: ClassifyTxn[] = [];
  for (const txn of txns) {
    if (txn.transferManual) continue;
    const target = targetAccount(txn, accounts);
    if (!target) continue;
    state.set(txn.id, { isTransfer: true, transferAccountId: target.id });
    candidates.push(txn);
  }

  const byAccountAmount = new Map<string, ClassifyTxn[]>();
  for (const txn of txns) {
    const key = `${txn.accountId}:${txn.amountCents}`;
    byAccountAmount.set(key, [...(byAccountAmount.get(key) ?? []), txn]);
  }
  for (const txn of candidates) {
    const target = state.get(txn.id)?.transferAccountId;
    for (const other of byAccountAmount.get(`${target}:${-txn.amountCents}`) ?? []) {
      const otherState = state.get(other.id);
      if (!otherState || otherState.isTransfer || other.transferManual) continue;
      if (daysBetween(other.bookingDate, txn.bookingDate) <= PAIRING_WINDOW_DAYS) {
        state.set(other.id, { isTransfer: true, transferAccountId: txn.accountId });
        break;
      }
    }
  }
  pairByInstitution(txns, accounts, state);

  const result = new Map<number, Classification>();
  for (const txn of txns) {
    const transfer = state.get(txn.id) ?? { isTransfer: false, transferAccountId: null };
    const ruleTags = new Set<number>();
    let matched: number | null = null;
    if (!transfer.isTransfer) {
      for (const rule of ordered) {
        if (!ruleApplies(rule, txn)) continue;
        for (const tag of rule.tagIds) ruleTags.add(tag);
        matched ??= ruleCategory(rule, txn);
      }
    }
    const sources = new Map<number, TagSource>();
    for (const id of ruleTags) sources.set(id, "rule");
    for (const id of txn.aiTagIds) sources.set(id, "ai");
    for (const id of txn.manualTagIds) sources.set(id, "manual");
    const tags = [...sources].map(([id, source]) => ({ id, source })).sort((a, b) => a.id - b.id);
    let categoryId: number | null;
    let categorySource: Classification["categorySource"];
    // Precedence: manual > ai > rule. An AI category whose category was deleted falls back to the rules.
    if (txn.categorySource === "manual") [categoryId, categorySource] = [txn.categoryId, "manual"];
    else if (transfer.isTransfer) [categoryId, categorySource] = [null, null];
    else if (txn.categorySource === "ai" && txn.categoryId !== null) [categoryId, categorySource] = [txn.categoryId, "ai"];
    else if (matched !== null) [categoryId, categorySource] = [matched, "rule"];
    else [categoryId, categorySource] = [null, null];
    result.set(txn.id, { ...transfer, categoryId, categorySource, tags });
  }
  return result;
}
