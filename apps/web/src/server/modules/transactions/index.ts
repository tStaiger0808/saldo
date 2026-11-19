import { createHash } from "node:crypto";
import type { RawPendingBooking } from "@saldo/banking";
import { csvCell, normalize, payeeFromPurpose, ruleCategory, transferLabel } from "@saldo/core";
import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, lte, not, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale, msg, t } from "../../../i18n/index.ts";
import { boundedDate } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import { accounts, categories, pendingTransactions, rules, ruleTags, tags, transactions, transactionTags } from "../../db/schema.ts";
import { Forbidden, UserError } from "../../errors.ts";
import {
  canManage,
  checkAccounts,
  managesHousehold,
  requireVisibleTransaction,
  resolveView,
  type View,
  type Viewer,
} from "../access/index.ts";
import { record } from "../audit/index.ts";
import { reclassifyAll, tagsOf } from "../classification/index.ts";

export const filterInput = z.object({
  groupId: z.number().int().nullish(),
  accountId: z.number().int().nullish(),
  categoryId: z.number().int().nullish(),
  tagId: z.number().int().nullish(),
  uncategorized: z.boolean().default(false),
  unread: z.boolean().default(false),
  aiSuggested: z.boolean().default(false),
  includeTransfers: z.boolean().default(true),
  q: z.string().trim().max(100).nullish(),
  dateFrom: boundedDate.nullish(),
  dateTo: boundedDate.nullish(),
  minAmountCents: z.number().int().nullish(),
  maxAmountCents: z.number().int().nullish(),
  /** Bounds on the amount regardless of its sign. */
  absMinCents: z.number().int().min(0).nullish(),
  absMaxCents: z.number().int().min(0).nullish(),
});
export type Filters = z.infer<typeof filterInput>;

export const TRANSACTION_SORTS = ["newest", "oldest", "largest_expense", "largest_income"] as const;

export const listInput = filterInput.extend({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(TRANSACTION_SORTS).default("newest"),
});

const ORDER: Record<(typeof TRANSACTION_SORTS)[number], SQL[]> = {
  newest: [desc(transactions.bookingDate), desc(transactions.id)],
  oldest: [asc(transactions.bookingDate), asc(transactions.id)],
  largest_expense: [asc(transactions.amountCents), desc(transactions.bookingDate), desc(transactions.id)],
  largest_income: [desc(transactions.amountCents), desc(transactions.bookingDate), desc(transactions.id)],
};

export const patchInput = z.object({
  id: z.number().int(),
  categoryId: z.number().int().nullish(),
  clearCategory: z.boolean().default(false),
  manualTagIds: z.array(z.number().int()).max(50).nullish(),
  note: z.string().max(2000).nullish(),
  isUnread: z.boolean().nullish(),
  isTransfer: z.boolean().nullish(),
  createRule: z
    .object({
      pattern: z.string().trim().min(2).max(200),
      field: z.enum(["any", "counterparty", "purpose"]),
      direction: z.enum(["any", "out", "in"]).default("any"),
    })
    .nullish(),
});

/** A transfer between two accounts of the view is "internal" (hidden from totals); to an account outside it is "external". */
export function internalTransferSql(accountIds: number[]): SQL {
  const inside = accountIds.length > 0 ? inArray(transactions.transferAccountId, accountIds) : sql`false`;
  return and(eq(transactions.isTransfer, true), or(isNull(transactions.transferAccountId), inside)) as SQL;
}

const uncategorizedSql = () => and(isNull(transactions.categoryId), eq(transactions.isTransfer, false)) as SQL;
const aiSuggestedSql = () => and(eq(transactions.categorySource, "ai"), isNotNull(transactions.categoryId)) as SQL;

type FilteredColumns = { accountId: AnyPgColumn; bookingDate: AnyPgColumn; amountCents: AnyPgColumn; text: AnyPgColumn[] };

/** The filters booked and pending bookings share: view, account, search text, period and amount. */
function commonParts(columns: FilteredColumns, view: View, filters: Filters): SQL[] {
  const parts: (SQL | undefined)[] = [inArray(columns.accountId, view.accountIds)];
  if (filters.accountId) parts.push(eq(columns.accountId, checkAccounts(view, [filters.accountId])[0] ?? -1));
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(or(...columns.text.map((column) => sql`unaccent(${column}) ilike unaccent(${like})`)));
  }
  if (filters.dateFrom) parts.push(gte(columns.bookingDate, filters.dateFrom));
  if (filters.dateTo) parts.push(lte(columns.bookingDate, filters.dateTo));
  if (filters.minAmountCents != null) parts.push(gte(columns.amountCents, filters.minAmountCents));
  if (filters.maxAmountCents != null) parts.push(lte(columns.amountCents, filters.maxAmountCents));
  if (filters.absMinCents != null) parts.push(sql`abs(${columns.amountCents}) >= ${filters.absMinCents}`);
  if (filters.absMaxCents != null) parts.push(sql`abs(${columns.amountCents}) <= ${filters.absMaxCents}`);
  return parts.filter((part): part is SQL => part !== undefined);
}

function whereFor(view: View, filters: Filters): SQL | undefined {
  if (view.accountIds.length === 0) return sql`false`;
  const parts: (SQL | undefined)[] = commonParts(
    {
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amountCents: transactions.amountCents,
      text: [transactions.counterparty, transactions.purpose, transactions.note],
    },
    view,
    filters,
  );
  if (filters.categoryId) parts.push(eq(transactions.categoryId, filters.categoryId));
  if (filters.tagId) {
    parts.push(
      exists(
        sql`select 1 from ${transactionTags} where ${transactionTags.transactionId} = ${transactions.id} and ${transactionTags.tagId} = ${filters.tagId}`,
      ),
    );
  }
  if (filters.uncategorized) parts.push(uncategorizedSql());
  if (filters.unread) parts.push(eq(transactions.isUnread, true));
  if (filters.aiSuggested) parts.push(aiSuggestedSql());
  if (!filters.includeTransfers) parts.push(not(internalTransferSql(view.accountIds)));
  return and(...parts);
}

export type TransactionRow = typeof transactions.$inferSelect & {
  tagIds: number[];
  transferKind: "internal" | "external" | null;
  transferLabel: string | null;
};

async function annotate(db: Db, view: View, rows: (typeof transactions.$inferSelect)[], locale: Locale): Promise<TransactionRow[]> {
  const tagMap = await tagsOf(
    db,
    rows.map((r) => r.id),
  );
  const inView = new Set(view.accountIds);
  const visible = new Set(view.visibleIds);
  // Accounts the viewer cannot see stay anonymous: no name, no id.
  const targetIds = [...new Set(rows.map((r) => r.transferAccountId).filter((id): id is number => id !== null && visible.has(id)))];
  const targets = targetIds.length > 0 ? await db.select().from(accounts).where(inArray(accounts.id, targetIds)) : [];
  // Built here rather than taken from modules/stats, which imports this module.
  const labels = {
    uncategorized: t(locale, "dashboard.body.uncategorized"),
    ownAccount: t(locale, "transactions.ownAccount"),
    transferTo: (name: string) => t(locale, "transactions.transferTo", { name }),
    transferFrom: (name: string) => t(locale, "transactions.transferFrom", { name }),
  };
  return rows.map((r) => {
    const target = targets.find((a) => a.id === r.transferAccountId) ?? null;
    const internal = r.isTransfer && (r.transferAccountId === null || inView.has(r.transferAccountId));
    return {
      ...r,
      transferAccountId: r.transferAccountId !== null && visible.has(r.transferAccountId) ? r.transferAccountId : null,
      tagIds: tagMap.get(r.id) ?? [],
      transferKind: r.isTransfer ? (internal ? "internal" : "external") : null,
      transferLabel: r.isTransfer && !internal ? transferLabel({ ...r, transferAccount: target && { ...target } }, visible, labels) : null,
    };
  });
}

/** Sums over every booking matching the filters; transfers inside the selection count but add nothing, as in the statistics. */
export type BookingTotals = { count: number; incomeCents: number; expenseCents: number; sumCents: number; internalTransfers: number };

/** How many bookings each quick filter would show with the other filters as they are. */
export type QuickCounts = { all: number; unread: number; uncategorized: number; aiSuggested: number };

async function totalsFor(db: Db, view: View, where: SQL | undefined): Promise<BookingTotals> {
  const internal = view.accountIds.length > 0 ? internalTransferSql(view.accountIds) : sql`false`;
  const amount = transactions.amountCents;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      incomeCents: sql<number>`coalesce(sum(${amount}) filter (where ${amount} > 0 and not (${internal})), 0)::bigint`.mapWith(Number),
      expenseCents: sql<number>`coalesce(sum(${amount}) filter (where ${amount} < 0 and not (${internal})), 0)::bigint`.mapWith(Number),
      internalTransfers: sql<number>`(count(*) filter (where ${internal}))::int`,
    })
    .from(transactions)
    .where(where);
  const income = row?.incomeCents ?? 0;
  const expense = row?.expenseCents ?? 0;
  return {
    count: row?.count ?? 0,
    incomeCents: income,
    expenseCents: expense,
    sumCents: income + expense,
    internalTransfers: row?.internalTransfers ?? 0,
  };
}

async function quickCountsFor(db: Db, view: View, filters: Filters): Promise<QuickCounts> {
  const base = whereFor(view, { ...filters, unread: false, uncategorized: false, aiSuggested: false });
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      unread: sql<number>`(count(*) filter (where ${transactions.isUnread}))::int`,
      uncategorized: sql<number>`(count(*) filter (where ${uncategorizedSql()}))::int`,
      aiSuggested: sql<number>`(count(*) filter (where ${aiSuggestedSql()}))::int`,
    })
    .from(transactions)
    .where(base);
  return { all: row?.all ?? 0, unread: row?.unread ?? 0, uncategorized: row?.uncategorized ?? 0, aiSuggested: row?.aiSuggested ?? 0 };
}

/** One page of bookings with the totals and quick filter counts of all bookings matching the filters. */
export async function listTransactions(db: Db, viewer: Viewer, input: z.input<typeof listInput>) {
  const filters = listInput.parse(input);
  const view = await resolveView(db, viewer, filters.groupId);
  const where = whereFor(view, filters);
  const totals = await totalsFor(db, view, where);
  const quick = await quickCountsFor(db, view, filters);
  const unreadWhere =
    view.accountIds.length > 0 ? and(inArray(transactions.accountId, view.accountIds), eq(transactions.isUnread, true)) : sql`false`;
  const [unread] = await db.select({ total: sql<number>`count(*)::int` }).from(transactions).where(unreadWhere);
  const rows = await db
    .select()
    .from(transactions)
    .where(where)
    .orderBy(...ORDER[filters.sort])
    .limit(filters.limit)
    .offset(filters.offset);
  return {
    items: await annotate(db, view, rows, viewer.locale ?? DEFAULT_LOCALE),
    total: totals.count,
    unread: unread?.total ?? 0,
    totals,
    quick,
  };
}

export async function patchTransaction(db: Db, viewer: Viewer, input: z.input<typeof patchInput>): Promise<void> {
  const data = patchInput.parse(input);
  await requireVisibleTransaction(db, viewer, data.id);
  if (data.createRule && !managesHousehold(viewer)) throw new Forbidden(msg("transactions.errors.rulesOnlyAdmins"));
  if (data.isTransfer != null) {
    const [account] = await db
      .select({ ownerUserId: accounts.ownerUserId, visibility: accounts.visibility })
      .from(accounts)
      .innerJoin(transactions, eq(transactions.accountId, accounts.id))
      .where(eq(transactions.id, data.id));
    if (!account || !canManage(viewer, account)) throw new Forbidden(msg("transactions.errors.transferOnlyManagers"));
  }
  const [category] =
    data.categoryId != null ? await db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, data.categoryId)) : [];
  if (data.categoryId != null && !category) throw new UserError(msg("transactions.errors.unknownCategory"));
  const tagIds = data.manualTagIds
    ? (
        await db
          .select({ id: tags.id })
          .from(tags)
          .where(inArray(tags.id, data.manualTagIds.length > 0 ? data.manualTagIds : [-1]))
      ).map((t) => t.id)
    : null;
  const update: Partial<typeof transactions.$inferInsert> = {};
  if (data.clearCategory) Object.assign(update, { categoryId: null, categorySource: "manual" });
  else if (data.categoryId != null) Object.assign(update, { categoryId: data.categoryId, categorySource: "manual" });
  // The person's selection includes the AI tags they kept; from now on it alone decides.
  if (tagIds) Object.assign(update, { manualTagIds: tagIds.sort((a, b) => a - b), aiTagIds: [] });
  if (data.note != null) update.note = data.note;
  if (data.isUnread != null) update.isUnread = data.isUnread;
  if (data.isTransfer != null) Object.assign(update, { isTransfer: data.isTransfer, transferManual: true, transferAccountId: null });

  await db.transaction(async (tx) => {
    if (data.createRule) {
      if (data.categoryId == null && !tagIds?.length) throw new UserError(msg("transactions.errors.ruleNeedsTarget"));
      const draft = { ...data.createRule, source: "manual" as const, categoryId: data.categoryId ?? null };
      const [rule] = await tx
        .insert(rules)
        .values({ ...draft, priority: 100 })
        .returning({ id: rules.id });
      if (rule && tagIds?.length) await tx.insert(ruleTags).values(tagIds.map((tagId) => ({ ruleId: rule.id, tagId })));
      const [booking] = await tx
        .select({ counterparty: transactions.counterparty, purpose: transactions.purpose, amountCents: transactions.amountCents })
        .from(transactions)
        .where(eq(transactions.id, data.id));
      // The rule now carries the decision, so this booking follows it like all others, if the rule reaches it at all.
      if (booking && ruleCategory({ ...draft, categoryKind: category?.kind ?? null }, booking) !== null) update.categorySource = null;
      if (tagIds?.length) Object.assign(update, { manualTagIds: [], aiTagIds: [] });
    }
    if (Object.keys(update).length > 0) await tx.update(transactions).set(update).where(eq(transactions.id, data.id));
  });
  await reclassifyAll(db);
}

/** Marks the view's new bookings read, or only one account's when `accountId` is given (it must be visible). */
export async function markAllRead(db: Db, viewer: Viewer, groupId: number | null | undefined, accountId?: number | null): Promise<void> {
  const view = await resolveView(db, viewer, groupId);
  if (view.accountIds.length === 0) return;
  const ids = accountId ? checkAccounts(view, [accountId]) : view.accountIds;
  await db
    .update(transactions)
    .set({ isUnread: false })
    .where(and(inArray(transactions.accountId, ids), eq(transactions.isUnread, true)));
}

/** A stable, machine-readable file: German headers, `DD.MM.YYYY`, decimal comma and `;` whatever the reader's language. */
export async function exportCsv(db: Db, viewer: Viewer, input: z.input<typeof filterInput>): Promise<string> {
  const filters = filterInput.parse(input);
  const view = await resolveView(db, viewer, filters.groupId);
  const rows = await db
    .select()
    .from(transactions)
    .where(whereFor(view, filters))
    .orderBy(desc(transactions.bookingDate), desc(transactions.id));
  const annotated = await annotate(db, view, rows, DEFAULT_LOCALE);
  const accountNames = new Map(
    (
      await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(inArray(accounts.id, view.visibleIds.length > 0 ? view.visibleIds : [-1]))
    ).map((a) => [a.id, a.name]),
  );
  const categoryNames = new Map(
    (await db.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [c.id, c.name]),
  );
  const tagNames = new Map((await db.select({ id: tags.id, name: tags.name }).from(tags)).map((t) => [t.id, t.name]));
  const quote = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = [
    "Datum",
    "Konto",
    "Empfänger/Auftraggeber",
    "Verwendungszweck",
    "Betrag",
    "Währung",
    "Kategorie",
    "Tags",
    "Notiz",
    "Umbuchung",
  ];
  const lines = annotated.map((t) =>
    [
      t.bookingDate.split("-").reverse().join("."),
      csvCell(accountNames.get(t.accountId)),
      csvCell(t.counterparty),
      csvCell(t.purpose),
      (t.amountCents / 100).toFixed(2).replace(".", ","),
      csvCell(t.currency),
      csvCell(t.categoryId ? categoryNames.get(t.categoryId) : (t.transferLabel ?? "")),
      csvCell(t.tagIds.map((id) => tagNames.get(id) ?? "").join(", ")),
      csvCell(t.note),
      t.isTransfer ? "ja" : "nein",
    ]
      .map((v) => quote(v ?? ""))
      .join(";"),
  );
  await record(db, { action: "export.transactionsCsv", actor: viewer, details: { rows: lines.length } });
  return `﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

// ---- import from banks

export type RawBooking = {
  bookingDate: string;
  valueDate?: string | null;
  amountCents: number;
  currency: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  providerId?: string | null;
};

const MAX_EXTERNAL_ID = 64;
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

function cleanCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "XXX";
}

const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

function cleanTexts(b: { counterparty: string; purpose: string }): { counterparty: string; purpose: string } {
  return {
    counterparty: normalize(b.counterparty) ? squash(b.counterparty).slice(0, 200) : payeeFromPurpose(b.purpose),
    purpose: squash(b.purpose),
  };
}

const storableCents = (cents: number) => Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS;

function cleanIban(value: string | null): string | null {
  const iban = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) ? iban : null;
}

/** Stable ids: the provider's own id (hashed when long) or a content hash plus a counter for identical twins. */
export function externalIds(bookings: RawBooking[], prefix: string): string[] {
  const seen = new Map<string, number>();
  return bookings.map((b) => {
    if (b.providerId) {
      const id = `${prefix}:id:${b.providerId}`;
      return id.length <= MAX_EXTERNAL_ID ? id : `${prefix}:idh:${createHash("sha256").update(b.providerId).digest("hex").slice(0, 48)}`;
    }
    const content = [b.bookingDate, b.amountCents, b.currency, normalize(b.counterparty), normalize(b.purpose)].join("|");
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 40);
    const count = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, count);
    return `${prefix}:h:${digest}:${count}`;
  });
}

export type ImportResult = {
  ids: number[];
  /** The new bookings that are marked unread; on a first import only the recent ones. */
  unreadIds: number[];
  /** The account had no real (non-demo) bookings before. */
  firstImport: boolean;
};

/** On an account's first import, bookings older than this stay read, so a year of history is not flagged as new. */
const FIRST_IMPORT_UNREAD_DAYS = 7;

/** Inserts the bookings not stored yet; the caller reclassifies afterwards. `today` is an ISO date. */
export async function importBookings(
  db: Db,
  accountId: number,
  bookings: RawBooking[],
  source: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<ImportResult> {
  const ids = externalIds(bookings, source);
  const stored = await db
    .select({ externalId: transactions.externalId, source: transactions.source })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  const existing = new Set(stored.map((r) => r.externalId));
  const firstImport = !stored.some((r) => r.source !== "demo");
  const unreadFrom = new Date(`${today}T00:00:00Z`);
  unreadFrom.setUTCDate(unreadFrom.getUTCDate() - FIRST_IMPORT_UNREAD_DAYS);
  const unreadFromDay = unreadFrom.toISOString().slice(0, 10);
  const fresh: (typeof transactions.$inferInsert)[] = [];
  bookings.forEach((b, i) => {
    const externalId = ids[i];
    if (!externalId || existing.has(externalId) || !storableCents(b.amountCents)) return;
    existing.add(externalId);
    fresh.push({
      accountId,
      externalId,
      source,
      bookingDate: b.bookingDate,
      valueDate: b.valueDate ?? null,
      amountCents: b.amountCents,
      currency: cleanCurrency(b.currency),
      // The external id is derived from the raw booking, so filling in the payee here keeps later syncs deduplicated.
      ...cleanTexts(b),
      counterpartyIban: cleanIban(b.counterpartyIban),
      isUnread: !firstImport || b.bookingDate >= unreadFromDay,
    });
  });
  if (fresh.length === 0) return { ids: [], unreadIds: [], firstImport };
  const inserted = await db.insert(transactions).values(fresh).returning({ id: transactions.id, isUnread: transactions.isUnread });
  return { ids: inserted.map((r) => r.id), unreadIds: inserted.filter((r) => r.isUnread).map((r) => r.id), firstImport };
}

/** Start of the next fetch window: the latest real booking minus an overlap, or a year back. */
/** Fills in payees that older imports left empty (card payments); idempotent, so it can run on every start. */
export async function backfillPayees(db: Db): Promise<number> {
  const empty = await db
    .select({ id: transactions.id, purpose: transactions.purpose })
    .from(transactions)
    .where(eq(transactions.counterparty, ""));
  const found = empty.flatMap((t) => {
    const payee = payeeFromPurpose(t.purpose);
    return payee ? [{ id: t.id, payee }] : [];
  });
  if (found.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const { id, payee } of found) await tx.update(transactions).set({ counterparty: payee }).where(eq(transactions.id, id));
  });
  await reclassifyAll(db);
  return found.length;
}

export async function fetchStart(db: Db, accountId: number, today: string): Promise<string> {
  const [latest] = await db
    .select({ day: transactions.bookingDate })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), not(eq(transactions.source, "demo"))))
    .orderBy(desc(transactions.bookingDate))
    .limit(1);
  const base = new Date(`${latest?.day ?? today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - (latest ? 14 : 365));
  return base.toISOString().slice(0, 10);
}

// ---- bookings the bank has announced but not booked yet

export type PendingBooking = {
  id: number;
  accountId: number;
  bookingDate: string | null;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterparty: string;
  purpose: string;
};

const MAX_PENDING = 200;

/** Pending bookings have no category, tags or read state, so a filter on one of those can never match them. */
export function pendingExcluded(filters: Filters): boolean {
  return Boolean(filters.categoryId || filters.tagId || filters.uncategorized || filters.unread || filters.aiSuggested);
}

/**
 * The pending bookings matching the filters, newest (or undated) first. While a filter excludes them all, `hidden` says how
 * many the view holds, so the page can say why they are missing.
 */
export async function listPendingBookings(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof filterInput>,
): Promise<{ items: PendingBooking[]; hidden: number }> {
  const filters = filterInput.parse(input);
  const view = await resolveView(db, viewer, filters.groupId);
  if (view.accountIds.length === 0) return { items: [], hidden: 0 };
  const p = pendingTransactions;
  const where = and(
    ...commonParts(
      { accountId: p.accountId, bookingDate: p.bookingDate, amountCents: p.amountCents, text: [p.counterparty, p.purpose] },
      view,
      filters,
    ),
  );
  if (pendingExcluded(filters)) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(p).where(where);
    return { items: [], hidden: row?.count ?? 0 };
  }
  const items = await db
    .select({
      id: p.id,
      accountId: p.accountId,
      bookingDate: p.bookingDate,
      valueDate: p.valueDate,
      amountCents: p.amountCents,
      currency: p.currency,
      counterparty: p.counterparty,
      purpose: p.purpose,
    })
    .from(p)
    .where(where)
    .orderBy(sql`${p.bookingDate} desc nulls first`, desc(p.id))
    .limit(MAX_PENDING);
  return { items, hidden: 0 };
}

/** The bank's current list replaces the stored one, so a booking that got booked or dropped disappears with it. */
export async function replacePendingBookings(db: Db, accountId: number, pending: RawPendingBooking[], fetchedAt: Date): Promise<void> {
  await db.delete(pendingTransactions).where(eq(pendingTransactions.accountId, accountId));
  const rows = pending
    .filter((b) => storableCents(b.amountCents))
    .slice(0, MAX_PENDING)
    .map((b) => ({
      accountId,
      bookingDate: b.bookingDate,
      valueDate: b.valueDate ?? null,
      amountCents: b.amountCents,
      currency: cleanCurrency(b.currency),
      ...cleanTexts(b),
      fetchedAt,
    }));
  if (rows.length > 0) await db.insert(pendingTransactions).values(rows);
}

/** For accounts no bank fetches any more: nothing would replace their pending bookings again. */
export async function dropPendingBookings(db: Db, accountIds: number[]): Promise<void> {
  if (accountIds.length > 0) await db.delete(pendingTransactions).where(inArray(pendingTransactions.accountId, accountIds));
}
