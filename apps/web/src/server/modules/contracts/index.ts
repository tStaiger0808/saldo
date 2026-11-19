/**
 * Contracts (recurring income and expenses), their linked bookings, suggestions and forecasts.
 *
 * Who sees a contract: on an account, whoever sees the account; without one, everyone for household contracts and the
 * owner (and superusers) for private ones. The owner always sees their own. Bookings are linked by matching
 * (`relinkContracts`, after imports and every contract change); a viewer only ever sees linked bookings of accounts
 * they may see, so the state of a contract is computed per viewer.
 */
import * as core from "@saldo/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { boundedDate, rangeWithinSpan } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import {
  accounts,
  CONTRACT_DIRECTIONS,
  CONTRACT_INTERVALS,
  categories,
  contractDismissals,
  contractDueReads,
  contracts,
  transactions,
  user,
  VISIBILITIES,
  type Visibility,
} from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import {
  canManage,
  managesHousehold,
  requireManageableAccount,
  requireVisibleTransaction,
  resolveView,
  type View,
  type Viewer,
  visibleAccountIds,
} from "../access/index.ts";
import { loadStatTxns, statLabels } from "../stats/index.ts";
import { type ContractDocumentView, listContractDocuments } from "./documents.ts";
import {
  type AccountInfo,
  effectiveVisibility,
  type Row,
  requireManageableContract,
  requireVisibleContract,
  rowsWithAccounts,
  sees,
} from "./guard.ts";
import { getContractPreferences } from "./preferences.ts";
import { readableContractView } from "./views.ts";

export {
  addContractDocument,
  type ContractDocumentView,
  deleteContractDocument,
  documentIdInput,
  MAX_CONTRACT_DOCUMENTS,
  MAX_CONTRACT_DOCUMENTS_BYTES,
  MAX_DOCUMENT_BYTES,
  readContractDocument,
  sniffDocumentType,
} from "./documents.ts";
export { contractPreferencesInput, getContractPreferences, saveContractPreferences } from "./preferences.ts";
export {
  type ContractViewTab,
  contractViewInput,
  contractViewShareCoverage,
  deleteContractView,
  hideContractViewInput,
  listContractViews,
  type ShareCoverage,
  saveContractView,
  setContractViewHidden,
  shareCoverageInput,
} from "./views.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day in the server's timezone. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const day = boundedDate;

export const contractInput = z
  .object({
    name: z.string().trim().min(1, "contracts.errors.nameRequired").max(100),
    direction: z.enum(CONTRACT_DIRECTIONS),
    amountCents: z.number().int().min(1, "contracts.errors.amountPositive").max(100_000_000_000),
    variable: z.boolean().default(false),
    interval: z.enum(CONTRACT_INTERVALS),
    intervalMonths: z.number().int().min(1, "contracts.errors.intervalMonths").max(120, "contracts.errors.intervalMonths").nullish(),
    nextDue: day,
    accountId: z.number().int().nullish(),
    categoryId: z.number().int().nullish(),
    /** Only for contracts without an account; on an account the account's visibility applies. */
    visibility: z.enum(VISIBILITIES).optional(),
    matchPayee: z.string().trim().max(200).default(""),
    matchPurpose: z.string().trim().max(200).default(""),
    tolerancePercent: z.number().int().min(0).max(100).nullish(),
    startDate: day.nullish(),
    endDate: day.nullish(),
    notes: z.string().max(2000).default(""),
  })
  .refine((c) => c.interval !== "custom" || c.intervalMonths != null, {
    message: "contracts.errors.intervalMonths",
    path: ["intervalMonths"],
  })
  .refine((c) => !c.startDate || !c.endDate || c.startDate <= c.endDate, { message: "contracts.errors.endBeforeStart", path: ["endDate"] });

export type ContractInput = z.input<typeof contractInput>;

export type ContractView = {
  id: number;
  name: string;
  direction: core.ContractDirection;
  amountCents: number;
  variable: boolean;
  interval: core.ContractInterval;
  intervalMonths: number | null;
  /** The due date the contract was saved with. */
  anchor: string;
  accountId: number | null;
  /** Null when there is no account or the viewer cannot see it. */
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryKind: core.Kind | null;
  visibility: Visibility;
  matchPayee: string;
  matchPurpose: string;
  tolerancePercent: number | null;
  startDate: string | null;
  endDate: string | null;
  notes: string;
  mine: boolean;
  canManage: boolean;
  state: core.ContractState;
  /** Days until the next payment when it is due within the viewer's due-soon window; null otherwise. */
  dueInDays: number | null;
};

const terms = (c: Row): core.ContractTerms => ({
  interval: c.interval,
  intervalMonths: c.intervalMonths,
  anchor: c.nextDue,
  amountCents: c.amountCents,
  variable: c.variable,
  tolerancePercent: c.tolerancePercent,
  startDate: c.startDate,
  endDate: c.endDate,
});

/** Linked bookings of the viewer's accounts, per contract. */
async function paymentsOf(db: Db, contractIds: number[], visible: readonly number[]): Promise<Map<number, core.ContractPayment[]>> {
  const map = new Map<number, core.ContractPayment[]>();
  if (contractIds.length === 0 || visible.length === 0) return map;
  const rows = await db
    .select({
      id: transactions.id,
      contractId: transactions.contractId,
      bookingDate: transactions.bookingDate,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(inArray(transactions.contractId, contractIds), inArray(transactions.accountId, [...visible])));
  for (const r of rows) {
    if (r.contractId === null) continue;
    map.set(r.contractId, [...(map.get(r.contractId) ?? []), { id: r.id, bookingDate: r.bookingDate, amountCents: r.amountCents }]);
  }
  return map;
}

async function present(
  db: Db,
  viewer: Viewer,
  rows: { contract: Row; account: AccountInfo }[],
  visible: readonly number[],
  today: string,
): Promise<ContractView[]> {
  const { dueSoonDays } = await getContractPreferences(db, viewer);
  const visibleSet = new Set(visible);
  const categoryMap = new Map((await db.select().from(categories)).map((c) => [c.id, c]));
  const payments = await paymentsOf(
    db,
    rows.map((r) => r.contract.id),
    visible,
  );
  return rows.map(({ contract: c, account }) => {
    const category = c.categoryId !== null ? categoryMap.get(c.categoryId) : undefined;
    const visibility = effectiveVisibility(c, account);
    const state = core.contractState(terms(c), payments.get(c.id) ?? [], today);
    return {
      id: c.id,
      name: c.name,
      direction: c.direction,
      amountCents: c.amountCents,
      variable: c.variable,
      interval: c.interval,
      intervalMonths: c.intervalMonths,
      anchor: c.nextDue,
      accountId: c.accountId,
      accountName: account && c.accountId !== null && visibleSet.has(c.accountId) ? account.name : null,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      categoryColor: category?.color ?? null,
      categoryKind: category?.kind ?? null,
      visibility,
      matchPayee: c.matchPayee,
      matchPurpose: c.matchPurpose,
      tolerancePercent: c.tolerancePercent,
      startDate: c.startDate,
      endDate: c.endDate,
      notes: c.notes,
      mine: c.ownerUserId === viewer.id,
      canManage: canManage(viewer, { ownerUserId: c.ownerUserId, visibility }),
      state,
      dueInDays: core.dueWithin(state, today, dueSoonDays),
    };
  });
}

/** `viewId` is a contract view of the viewer or shared with them, `groupId` an account group; without either, all accounts. */
export const viewInput = z.object({ groupId: z.number().int().nullish(), viewId: z.number().int().nullish() });

/** The accounts a page shows; `narrowed` when only contracts on those accounts belong to it. */
async function scopeOf(db: Db, viewer: Viewer, input: z.output<typeof viewInput>): Promise<{ view: View; narrowed: boolean }> {
  if (input.viewId != null) {
    const { row, accountIds } = await readableContractView(db, viewer, input.viewId);
    const all = await resolveView(db, viewer, null);
    return { view: { ...all, groupName: row.name, accountIds }, narrowed: true };
  }
  const view = await resolveView(db, viewer, input.groupId);
  return { view, narrowed: view.groupId !== null };
}

/**
 * The contracts of a view: in "all accounts" every contract the viewer sees, in a group or contract view those on its
 * accounts. `today` is an ISO date.
 */
export async function listContracts(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof viewInput> = {},
  today = localToday(),
): Promise<ContractView[]> {
  const { view, narrowed } = await scopeOf(db, viewer, viewInput.parse(input));
  const visible = new Set(view.visibleIds);
  const inView = new Set(view.accountIds);
  const rows = (await rowsWithAccounts(db)).filter(
    ({ contract: c }) => sees(viewer, c, visible) && (!narrowed || (c.accountId !== null && inView.has(c.accountId))),
  );
  return present(db, viewer, rows, view.visibleIds, today);
}

export type ContractPaymentView = {
  id: number;
  bookingDate: string;
  amountCents: number;
  currency: string;
  counterparty: string;
  purpose: string;
  accountId: number;
  priceChanged: boolean;
};

const HISTORY_LIMIT = 36;

export async function getContract(
  db: Db,
  viewer: Viewer,
  id: number,
  today = localToday(),
): Promise<{ contract: ContractView; payments: ContractPaymentView[]; documents: ContractDocumentView[] }> {
  const row = await requireVisibleContract(db, viewer, id);
  const visible = await visibleAccountIds(db, viewer);
  const [contract] = await present(db, viewer, [row], visible, today);
  if (!contract) throw new NotFound(msg("contracts.errors.notFound"));
  const rows =
    visible.length > 0
      ? await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.contractId, id), inArray(transactions.accountId, visible)))
          .orderBy(desc(transactions.bookingDate), desc(transactions.id))
          .limit(HISTORY_LIMIT)
      : [];
  const t = terms(row.contract);
  return {
    contract,
    documents: await listContractDocuments(db, id),
    payments: rows.map((r) => ({
      id: r.id,
      bookingDate: r.bookingDate,
      amountCents: r.amountCents,
      currency: r.currency,
      counterparty: r.counterparty,
      purpose: r.purpose,
      accountId: r.accountId,
      priceChanged: core.priceChangeOf(t, r) !== null,
    })),
  };
}

// ---- totals of a view

export type ContractTotals = { incomeCents: number; expensesCents: number; bufferCents: number; count: number };

/** Monthly equivalents of the contracts that still run; the buffer is income minus expenses. */
export function contractTotals(items: readonly Pick<ContractView, "direction" | "state">[]): ContractTotals {
  const running = items.filter((c) => c.state.status !== "ended");
  const sum = (direction: core.ContractDirection) =>
    running.filter((c) => c.direction === direction).reduce((total, c) => total + c.state.monthlyCents, 0);
  const incomeCents = sum("income");
  const expensesCents = sum("expense");
  return { incomeCents, expensesCents, bufferCents: incomeCents - expensesCents, count: running.length };
}

export type ActualAverage = {
  dateFrom: string;
  dateTo: string;
  months: number;
  incomeCents: number;
  expensesCents: number;
  bufferCents: number;
};

const ACTUAL_MONTHS = 3;

/**
 * The page "Verträge": contracts, monthly totals, the actual average of the last complete months, what is due within the
 * viewer's due-soon window, how many of those due dates the viewer has not marked as seen, and the viewer's choices.
 */
export async function contractsOverview(db: Db, viewer: Viewer, input: z.input<typeof viewInput> = {}, today = localToday()) {
  const scope = viewInput.parse(input);
  const items = await listContracts(db, viewer, scope, today);
  const { view } = await scopeOf(db, viewer, scope);
  const monthStart = `${today.slice(0, 7)}-01`;
  const range = { dateFrom: core.shiftMonths(monthStart, -ACTUAL_MONTHS), dateTo: core.shiftDays(monthStart, -1), accountIds: [] };
  const actual = core.summary(await loadStatTxns(db, view, range));
  const per = (cents: number) => Math.round(cents / ACTUAL_MONTHS);
  return {
    items,
    totals: contractTotals(items),
    actual: {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      months: ACTUAL_MONTHS,
      incomeCents: per(actual.incomeCents),
      expensesCents: per(actual.expensesCents + actual.savingsCents),
      bufferCents: per(actual.balanceCents),
    } satisfies ActualAverage,
    upcoming: items
      .filter((c) => c.dueInDays !== null)
      .sort((a, b) => (a.state.nextDue ?? "").localeCompare(b.state.nextDue ?? "") || a.name.localeCompare(b.name)),
    unseenDue: await unseenDueCount(db, viewer, today),
    preferences: await getContractPreferences(db, viewer),
  };
}

// ---- due soon, as a badge in the navigation

async function unseenDue(db: Db, viewer: Viewer, today: string): Promise<ContractView[]> {
  const soon = (await listContracts(db, viewer, {}, today)).filter((c) => c.dueInDays !== null);
  if (soon.length === 0) return [];
  const seen = await db
    .select({ contractId: contractDueReads.contractId, dueDate: contractDueReads.dueDate })
    .from(contractDueReads)
    .where(
      and(
        eq(contractDueReads.userId, viewer.id),
        inArray(
          contractDueReads.contractId,
          soon.map((c) => c.id),
        ),
      ),
    );
  const marked = new Set(seen.map((r) => `${r.contractId}:${r.dueDate}`));
  return soon.filter((c) => !marked.has(`${c.id}:${c.state.nextDue}`));
}

/** Contracts the viewer sees that are due within their due-soon window and whose due date they have not marked as seen. */
export async function unseenDueCount(db: Db, viewer: Viewer, today = localToday()): Promise<number> {
  return (await unseenDue(db, viewer, today)).length;
}

/** Marks the current due dates as seen; the next due date of each contract counts as new again. */
export async function markDueSeen(db: Db, viewer: Viewer, today = localToday()): Promise<void> {
  const rows = (await unseenDue(db, viewer, today)).flatMap((c) =>
    c.state.nextDue ? [{ userId: viewer.id, contractId: c.id, dueDate: c.state.nextDue }] : [],
  );
  if (rows.length > 0) await db.insert(contractDueReads).values(rows).onConflictDoNothing();
}

// ---- saving

/** A contract on an account links that account's bookings, which needs authority over the account, not only sight. */
async function visibilityFor(db: Db, viewer: Viewer, data: z.output<typeof contractInput>): Promise<Visibility> {
  if (data.accountId != null) return (await requireManageableAccount(db, viewer, data.accountId)).visibility;
  const visibility = data.visibility ?? (managesHousehold(viewer) ? "household" : "private");
  if (visibility === "household" && !managesHousehold(viewer)) throw new Forbidden(msg("contracts.errors.householdOnlyAdmins"));
  return visibility;
}

export async function saveContract(db: Db, viewer: Viewer, input: ContractInput, id?: number): Promise<number> {
  const data = contractInput.parse(input);
  if (id !== undefined) await requireManageableContract(db, viewer, id);
  const visibility = await visibilityFor(db, viewer, data);
  if (data.categoryId != null) {
    const [category] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, data.categoryId));
    if (!category) throw new UserError(msg("contracts.errors.unknownCategory"));
  }
  const values = {
    name: data.name,
    direction: data.direction,
    amountCents: data.amountCents,
    variable: data.variable,
    interval: data.interval,
    intervalMonths: data.interval === "custom" ? (data.intervalMonths ?? 1) : null,
    nextDue: data.nextDue,
    accountId: data.accountId ?? null,
    categoryId: data.categoryId ?? null,
    matchPayee: data.matchPayee,
    matchPurpose: data.matchPurpose,
    tolerancePercent: data.tolerancePercent ?? null,
    startDate: data.startDate ?? null,
    endDate: data.endDate ?? null,
    notes: data.notes,
    visibility,
  };
  let saved = id;
  if (saved === undefined) {
    const [row] = await db
      .insert(contracts)
      .values({ ...values, ownerUserId: viewer.id })
      .returning({ id: contracts.id });
    if (!row) throw new UserError(msg("contracts.errors.saveFailed"));
    saved = row.id;
  } else {
    await db.update(contracts).set(values).where(eq(contracts.id, saved));
  }
  await relinkContracts(db);
  return saved;
}

export async function deleteContract(db: Db, viewer: Viewer, id: number): Promise<void> {
  await requireManageableContract(db, viewer, id);
  await db.delete(contracts).where(eq(contracts.id, id));
  // Its bookings may belong to another contract now.
  await relinkContracts(db);
}

/** Contracts created by Saldo itself flag a price change from 10 % on. */
const DEFAULT_TOLERANCE = 10;

/** A new contract filled in from a booking; the interval comes from the payee's earlier bookings. */
export async function contractDraftFromBooking(
  db: Db,
  viewer: Viewer,
  transactionId: number,
): Promise<{ contract: z.output<typeof contractInput>; bookingDate: string }> {
  await requireVisibleTransaction(db, viewer, transactionId);
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!txn) throw new NotFound(msg("errors.transactionNotFound"));
  const income = txn.amountCents > 0;
  const visible = await visibleAccountIds(db, viewer);
  const history = txn.counterparty
    ? await db
        .select({ bookingDate: transactions.bookingDate })
        .from(transactions)
        .where(
          and(
            inArray(transactions.accountId, visible),
            sql`lower(${transactions.counterparty}) = lower(${txn.counterparty})`,
            income ? sql`${transactions.amountCents} > 0` : sql`${transactions.amountCents} < 0`,
          ),
        )
    : [];
  const schedule = core.guessSchedule([...history.map((h) => h.bookingDate), txn.bookingDate]);
  const purpose = txn.purpose.split(/\s+/).filter(Boolean).join(" ").slice(0, 60);
  const contract = contractInput.parse({
    name: (txn.counterparty || purpose || "–").slice(0, 100),
    direction: income ? "income" : "expense",
    amountCents: Math.max(1, Math.abs(txn.amountCents)),
    interval: schedule.interval,
    intervalMonths: schedule.intervalMonths ?? null,
    nextDue: core.dueDate(txn.bookingDate, schedule, 1),
    accountId: txn.accountId,
    categoryId: txn.categoryId,
    matchPayee: txn.counterparty.slice(0, 200),
    matchPurpose: txn.counterparty ? "" : purpose,
    tolerancePercent: DEFAULT_TOLERANCE,
  });
  return { contract, bookingDate: txn.bookingDate };
}

// ---- suggestions

export type ContractSuggestion = core.ContractCandidate;

/** Payments that look like a contract in the view, are no contract yet and that the viewer has dismissed or not. */
async function suggestionsOf(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof viewInput>,
  today: string,
): Promise<{ open: ContractSuggestion[]; dismissed: ContractSuggestion[] }> {
  const { view } = await scopeOf(db, viewer, viewInput.parse(input));
  if (view.accountIds.length === 0) return { open: [], dismissed: [] };
  const range = { dateFrom: core.shiftMonths(`${today.slice(0, 7)}-01`, 1 - core.CANDIDATE_HISTORY_MONTHS), dateTo: today, accountIds: [] };
  const txns = await loadStatTxns(db, view, range);
  const candidates = [...core.contractCandidates(txns, "out", today), ...core.contractCandidates(txns, "in", today)];
  const known = await listContracts(db, viewer, {}, today);
  const dismissedRows = await db
    .select({ key: contractDismissals.key })
    .from(contractDismissals)
    .where(eq(contractDismissals.userId, viewer.id));
  const linkedRows = await db
    .selectDistinct({ counterparty: transactions.counterparty, income: sql<boolean>`${transactions.amountCents} > 0` })
    .from(transactions)
    .where(and(inArray(transactions.accountId, view.accountIds), sql`${transactions.contractId} is not null`));
  const linked = new Set(
    linkedRows.map((r) => core.suggestionKey({ key: core.normalize(r.counterparty), direction: r.income ? "income" : "expense" })),
  );
  const dismissedKeys = new Set(dismissedRows.map((d) => d.key));
  const monthly = (s: ContractSuggestion) => core.monthlyEquivalent(s.variable ? s.latestAmountCents : s.typicalAmountCents, s.schedule);
  const byWeight = (a: ContractSuggestion, b: ContractSuggestion) =>
    monthly(b) - monthly(a) || a.counterparty.localeCompare(b.counterparty);
  return {
    open: core.openSuggestions(candidates, known, dismissedKeys, linked).sort(byWeight),
    dismissed: core
      .openSuggestions(candidates, known, new Set(), linked)
      .filter((c) => dismissedKeys.has(core.suggestionKey(c)))
      .sort(byWeight),
  };
}

/** Payments of the view that look like a contract and are none yet, largest monthly amount first, without dismissed ones. */
export async function contractSuggestions(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof viewInput> = {},
  today = localToday(),
): Promise<ContractSuggestion[]> {
  return (await suggestionsOf(db, viewer, input, today)).open;
}

/** The open suggestions and those the viewer dismissed, so they can be brought back. */
export async function contractSuggestionOverview(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof viewInput> = {},
  today = localToday(),
): Promise<{ open: ContractSuggestion[]; dismissed: ContractSuggestion[] }> {
  return suggestionsOf(db, viewer, input, today);
}

export const suggestionInput = z.object({
  groupId: z.number().int().nullish(),
  viewId: z.number().int().nullish(),
  key: z.string().min(1).max(300),
  direction: z.enum(CONTRACT_DIRECTIONS),
});

/** Turns a suggestion into a contract, from the payee's latest payment on; a variable one starts with its latest amount. */
export async function acceptSuggestion(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof suggestionInput>,
  today = localToday(),
): Promise<number> {
  const { groupId, viewId, key, direction } = suggestionInput.parse(input);
  const suggestion = (await contractSuggestions(db, viewer, { groupId, viewId }, today)).find(
    (s) => s.key === key && s.direction === direction,
  );
  if (!suggestion) throw new NotFound(msg("contracts.errors.suggestionNotFound"));
  return saveContract(db, viewer, {
    name: suggestion.counterparty.slice(0, 100),
    direction,
    amountCents: suggestion.variable ? suggestion.latestAmountCents : suggestion.typicalAmountCents,
    variable: suggestion.variable,
    interval: suggestion.schedule.interval,
    intervalMonths: suggestion.schedule.intervalMonths ?? null,
    nextDue: core.dueDate(suggestion.lastDate, suggestion.schedule, 1),
    accountId: suggestion.accountId,
    categoryId: suggestion.categoryId,
    matchPayee: suggestion.counterparty.slice(0, 200),
    tolerancePercent: suggestion.variable ? null : DEFAULT_TOLERANCE,
  });
}

export const dismissInput = z.object({ key: z.string().min(1).max(300), direction: z.enum(CONTRACT_DIRECTIONS) });

export async function dismissSuggestion(db: Db, viewer: Viewer, input: z.input<typeof dismissInput>): Promise<void> {
  const data = dismissInput.parse(input);
  await db
    .insert(contractDismissals)
    .values({ userId: viewer.id, key: core.suggestionKey(data) })
    .onConflictDoNothing();
}

/** Brings a dismissed suggestion back for the viewer; others keep their own choice. */
export async function restoreSuggestion(db: Db, viewer: Viewer, input: z.input<typeof dismissInput>): Promise<void> {
  const data = dismissInput.parse(input);
  await db
    .delete(contractDismissals)
    .where(and(eq(contractDismissals.userId, viewer.id), eq(contractDismissals.key, core.suggestionKey(data))));
}

// ---- linking

const UPDATE_CHUNK = 1000;

/**
 * Links every booking to the contract it matches (or to none) and stores what changed; returns the number of bookings
 * changed. Idempotent, serialized by an advisory lock. A contract only takes bookings of accounts its owner manages
 * now (its own account, or all such accounts without one), and on an account the owner's contracts go first, so seeing
 * someone's account is not enough to take its bookings.
 */
export async function relinkContracts(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('contracts:relink'))`);
    const rows = await tx.select().from(contracts);
    const people = new Map((await tx.select({ id: user.id, role: user.role }).from(user)).map((u) => [u.id, u]));
    const accountRows = await tx
      .select({ id: accounts.id, ownerUserId: accounts.ownerUserId, visibility: accounts.visibility })
      .from(accounts);
    const rules: core.ContractRule[] = rows.map((c) => {
      const owner = people.get(c.ownerUserId);
      const scope = accountRows.filter((a) => (c.accountId === null || a.id === c.accountId) && owner && canManage(owner, a));
      return {
        id: c.id,
        direction: c.direction,
        amountCents: c.amountCents,
        variable: c.variable,
        tolerancePercent: c.tolerancePercent,
        matchPayee: c.matchPayee,
        matchPurpose: c.matchPurpose,
        accountIds: scope.map((a) => a.id),
        ownerAccountIds: scope
          .filter((a) => {
            const accountOwner = a.ownerUserId === null ? undefined : people.get(a.ownerUserId);
            return accountOwner !== undefined && canManage(accountOwner, c);
          })
          .map((a) => a.id),
        startDate: c.startDate,
        endDate: c.endDate,
      };
    });
    const bookings = await tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        bookingDate: transactions.bookingDate,
        amountCents: transactions.amountCents,
        counterparty: transactions.counterparty,
        purpose: transactions.purpose,
        isTransfer: transactions.isTransfer,
        contractId: transactions.contractId,
      })
      .from(transactions);
    const assigned = core.assignContracts(rules, bookings);
    const changes = new Map<number | null, number[]>();
    for (const b of bookings) {
      const next = assigned.get(b.id) ?? null;
      if (next !== b.contractId) changes.set(next, [...(changes.get(next) ?? []), b.id]);
    }
    let changed = 0;
    for (const [contractId, ids] of changes) {
      for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
        const chunk = ids.slice(i, i + UPDATE_CHUNK);
        await tx.update(transactions).set({ contractId }).where(inArray(transactions.id, chunk));
        changed += chunk.length;
      }
    }
    return changed;
  });
}

// ---- forecast

export const forecastInput = z
  .object({ groupId: z.number().int().nullish(), dateFrom: boundedDate, dateTo: boundedDate })
  .refine((r) => r.dateFrom <= r.dateTo, "dashboard.errors.rangeOrder")
  .refine(rangeWithinSpan, "errors.rangeTooLong");

export type ForecastItem = { contractId: number; name: string; direction: core.ContractDirection; amountCents: number; date: string };

export type Forecast = {
  totals: { incomeCents: number; expensesCents: number; savingsCents: number; bufferCents: number };
  months: core.MonthRow[];
  categories: Record<core.Kind, core.CategoryTotal[]>;
  items: ForecastItem[];
};

/** Income goes to income; an expense counts as saved when its category is a savings one. */
function kindOf(c: Pick<ContractView, "direction" | "categoryKind">): core.Kind {
  if (c.direction === "income") return "income";
  return c.categoryKind === "savings" ? "savings" : "expense";
}

/**
 * What the view's running contracts are expected to bring and cost in a range, from their next due date on; variable
 * contracts with their latest payment.
 */
export async function contractForecast(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof forecastInput>,
  today = localToday(),
): Promise<Forecast> {
  const { groupId, dateFrom, dateTo } = forecastInput.parse(input);
  const items = await listContracts(db, viewer, { groupId }, today);
  const rows = new Map(
    core.monthsBetween(dateFrom, dateTo).map((month) => [month, { month, incomeCents: 0, expensesCents: 0, savingsCents: 0 }]),
  );
  const field = { income: "incomeCents", expense: "expensesCents", savings: "savingsCents" } as const;
  const groups: Record<core.Kind, Map<string, core.CategoryTotal>> = { income: new Map(), expense: new Map(), savings: new Map() };
  const uncategorized = statLabels(viewer.locale).uncategorized;
  const due: ForecastItem[] = [];
  for (const c of items) {
    const kind = kindOf(c);
    const amountCents = c.state.expectedCents;
    for (const date of core.expectedDueDates(c, c.state, dateFrom, dateTo)) {
      due.push({ contractId: c.id, name: c.name, direction: c.direction, amountCents, date });
      const row = rows.get(core.monthKey(date));
      if (row) row[field[kind]] += amountCents;
      const key = String(c.categoryId ?? "none");
      const group = groups[kind].get(key) ?? {
        categoryId: c.categoryId,
        transferAccountId: null,
        name: c.categoryName ?? uncategorized,
        color: c.categoryColor ?? core.UNCATEGORIZED_COLOR,
        amountCents: 0,
        count: 0,
      };
      group.amountCents += amountCents;
      group.count += 1;
      groups[kind].set(key, group);
    }
  }
  const months = [...rows.values()];
  const sum = (pick: (row: core.MonthRow) => number) => months.reduce((total, row) => total + pick(row), 0);
  const incomeCents = sum((r) => r.incomeCents);
  const expensesCents = sum((r) => r.expensesCents);
  const savingsCents = sum((r) => r.savingsCents);
  const sorted = (kind: core.Kind) => [...groups[kind].values()].sort((a, b) => b.amountCents - a.amountCents);
  return {
    totals: { incomeCents, expensesCents, savingsCents, bufferCents: incomeCents - expensesCents - savingsCents },
    months,
    categories: { income: sorted("income"), expense: sorted("expense"), savings: sorted("savings") },
    items: due.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
  };
}
