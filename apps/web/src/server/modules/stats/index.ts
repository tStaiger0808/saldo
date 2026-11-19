import type { Kind, StatTxn } from "@saldo/core";
import * as core from "@saldo/core";
import { and, asc, gte, inArray, lte, not } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale, t } from "../../../i18n/index.ts";
import { boundedDate, rangeWithinSpan } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import { accounts, categories, tags, transactions } from "../../db/schema.ts";
import { checkAccounts, resolveView, type View, type Viewer } from "../access/index.ts";
import { tagsOf } from "../classification/index.ts";
import { internalTransferSql } from "../transactions/index.ts";

export const rangeInput = z
  .object({
    groupId: z.number().int().nullish(),
    dateFrom: boundedDate,
    dateTo: boundedDate,
    accountIds: z.array(z.number().int()).default([]),
  })
  .refine((r) => r.dateFrom <= r.dateTo, "dashboard.errors.rangeOrder")
  .refine(rangeWithinSpan, "errors.rangeTooLong");
export type Range = z.infer<typeof rangeInput>;

/** The texts core statistics put into results (uncategorized, transfers), in the reader's language. */
export function statLabels(locale: Locale = DEFAULT_LOCALE): core.StatLabels {
  return {
    uncategorized: t(locale, "dashboard.body.uncategorized"),
    ownAccount: t(locale, "transactions.ownAccount"),
    transferTo: (name) => t(locale, "transactions.transferTo", { name }),
    transferFrom: (name) => t(locale, "transactions.transferFrom", { name }),
  };
}

/** Bookings of a view in a period, without transfers inside the view, enriched for the core statistics. */
export async function loadStatTxns(db: Db, view: View, range: Pick<Range, "dateFrom" | "dateTo" | "accountIds">): Promise<StatTxn[]> {
  const only = checkAccounts(view, range.accountIds);
  if (view.accountIds.length === 0) return [];
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, only.length > 0 ? only : view.accountIds),
        gte(transactions.bookingDate, range.dateFrom),
        lte(transactions.bookingDate, range.dateTo),
        not(internalTransferSql(view.accountIds)),
      ),
    )
    .orderBy(asc(transactions.bookingDate));
  const categoryMap = new Map((await db.select().from(categories)).map((c) => [c.id, c]));
  const tagMap = new Map((await db.select().from(tags)).map((t) => [t.id, t]));
  const visible = new Set(view.visibleIds);
  const accountMap = new Map((await db.select().from(accounts)).map((a) => [a.id, a]));
  const txnTags = await tagsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const category = r.categoryId ? categoryMap.get(r.categoryId) : undefined;
    const target = r.transferAccountId ? accountMap.get(r.transferAccountId) : undefined;
    return {
      id: r.id,
      accountId: r.accountId,
      bookingDate: r.bookingDate,
      amountCents: r.amountCents,
      counterparty: r.counterparty,
      isTransfer: r.isTransfer,
      transferAccountId: r.transferAccountId,
      category: category ? { id: category.id, name: category.name, color: category.color, kind: category.kind } : null,
      tags: (txnTags.get(r.id) ?? []).flatMap((id) => {
        const tag = tagMap.get(id);
        return tag ? [{ id: tag.id, name: tag.name, color: tag.color }] : [];
      }),
      // Only the kind of an account the viewer cannot see (a transfer to savings counts as saved), never its name.
      transferAccount: target
        ? visible.has(target.id)
          ? { id: target.id, name: target.name, color: target.color, kind: target.kind }
          : { id: target.id, name: "", color: "", kind: target.kind }
        : null,
    };
  });
}

async function prepare(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>) {
  const range = rangeInput.parse(input);
  const view = await resolveView(db, viewer, range.groupId);
  return { range, view, txns: await loadStatTxns(db, view, range) };
}

export async function summary(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>) {
  return core.summary((await prepare(db, viewer, input)).txns);
}

export async function monthly(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>) {
  const { range, txns } = await prepare(db, viewer, input);
  return core.monthly(txns, range.dateFrom, range.dateTo);
}

export async function categoryTotals(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>, kind: Kind) {
  const { view, txns } = await prepare(db, viewer, input);
  return core.byCategory(txns, kind, new Set(view.visibleIds), statLabels(viewer.locale));
}

export async function series(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>, groupBy: "category" | "tag", ids: number[]) {
  const { range, txns } = await prepare(db, viewer, input);
  return core.series(txns, range.dateFrom, range.dateTo, groupBy, new Set(ids));
}

export async function topCounterparties(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>, limit: number) {
  return core.topCounterparties((await prepare(db, viewer, input)).txns, limit);
}

export async function recurringPayments(db: Db, viewer: Viewer, input: z.input<typeof rangeInput>) {
  return core.recurringPayments((await prepare(db, viewer, input)).txns);
}

export async function balances(db: Db, viewer: Viewer, groupId: number | null | undefined) {
  const view = await resolveView(db, viewer, groupId);
  const rows =
    view.accountIds.length > 0
      ? await db.select().from(accounts).where(inArray(accounts.id, view.accountIds)).orderBy(asc(accounts.name))
      : [];
  return {
    accounts: rows.map((a) => ({
      accountId: a.id,
      name: a.name,
      kind: a.kind,
      color: a.color,
      balanceCents: a.balanceCents,
      balanceDate: a.balanceDate,
    })),
    totalCents: rows.reduce((sum, a) => sum + (a.balanceCents ?? 0), 0),
  };
}
