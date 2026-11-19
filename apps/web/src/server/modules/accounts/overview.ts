import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { accountBalanceEntries, accounts, type BankProvider, bankConnections, transactions } from "../../db/schema.ts";
import { NotFound } from "../../errors.ts";
import { canManage, canShare, requireVisibleAccount, resolveView, type Viewer, visibleAccountIds, visibleGroups } from "../access/index.ts";
import { listInput, listTransactions } from "../transactions/index.ts";
import { type Holding, listHoldings } from "./holdings.ts";
import { listBalanceEntries } from "./manual.ts";
import { type Sharing, sharingOf } from "./sharing.ts";

type AccountKind = (typeof accounts.$inferSelect)["kind"];

/** Display order of the kind sections: everyday money first, debts last. */
export const KIND_ORDER: readonly AccountKind[] = ["checking", "savings", "brokerage", "prepaid", "credit_card"];

/** Matches the default lead time of the "bank problem" notification. */
const CONSENT_WARNING_DAYS = 14;

export type Attention = "error" | "expired" | "expiring" | null;

type ConnectionState = Pick<typeof bankConnections.$inferSelect, "status" | "consentValidUntil">;

export function connectionAttention(connection: ConnectionState, now: Date): Attention {
  if (connection.status === "error") return "error";
  const until = connection.consentValidUntil?.getTime();
  if (connection.status === "needs_reauth" || (until !== undefined && until < now.getTime())) return "expired";
  if (until !== undefined && until - now.getTime() < CONSENT_WARNING_DAYS * 86_400_000) return "expiring";
  return null;
}

export type AccountSummary = {
  id: number;
  name: string;
  kind: AccountKind;
  color: string;
  /** The connection's name for linked accounts, otherwise the bank as entered. */
  bankName: string;
  ibanLast4: string | null;
  balanceCents: number | null;
  balanceDate: string | null;
  /** Depots: the value against the previous daily entry. */
  change: { cents: number; since: string } | null;
  connection: {
    id: number;
    name: string;
    provider: BankProvider;
    status: string;
    lastSyncAt: string | null;
    consentValidUntil: string | null;
    attention: Attention;
    /** Left out of "Konten abrufen" and the schedule; only its own fetch runs it. */
    skipSyncAll: boolean;
    /** The viewer may sync, renew and remove it; actions act on the whole connection. */
    canManage: boolean;
    /** Other accounts of the same connection the viewer sees: a sync or renewal affects them, too. */
    otherAccounts: string[];
  } | null;
  /** Without a bank connection: balances and bookings are entered by hand. */
  manual: boolean;
  /** Bookings still marked new ("unread"). */
  unreadCount: number;
  canManage: boolean;
  canShare: boolean;
  sharing: Sharing;
};

export type Section =
  | { key: string; type: "group" | "bank"; name: string; accountIds: number[]; subtotalCents: number }
  | { key: string; type: "kind"; name: AccountKind; accountIds: number[]; subtotalCents: number }
  | { key: string; type: "ungrouped" | "manual"; name: ""; accountIds: number[]; subtotalCents: number };

type SectionDraft = Section extends infer S ? (S extends Section ? Omit<S, "subtotalCents"> : never) : never;

export type Grouping = "group" | "bank" | "kind";

export type AccountsOverview = {
  accounts: AccountSummary[];
  /** Every account of the view counted once, even when it is in several groups. */
  totalCents: number;
  withoutBalance: number;
  sections: Record<Grouping, Section[]>;
};

async function summaries(db: Db, viewer: Viewer, ids: number[], now: Date): Promise<AccountSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(accounts).where(inArray(accounts.id, ids)).orderBy(asc(accounts.name), asc(accounts.id));
  const sharing = await sharingOf(db, viewer, rows);
  const connectionIds = [...new Set(rows.map((a) => a.connectionId).filter((id): id is number => id !== null))];
  const connections =
    connectionIds.length > 0 ? await db.select().from(bankConnections).where(inArray(bankConnections.id, connectionIds)) : [];
  const byId = new Map(connections.map((c) => [c.id, c]));
  const visible = new Set(await visibleAccountIds(db, viewer));
  const siblings =
    connectionIds.length > 0
      ? (
          await db
            .select({ id: accounts.id, name: accounts.name, connectionId: accounts.connectionId })
            .from(accounts)
            .where(inArray(accounts.connectionId, connectionIds))
            .orderBy(asc(accounts.name))
        ).filter((a) => visible.has(a.id))
      : [];
  const depots = rows.filter((a) => a.kind === "brokerage").map((a) => a.id);
  const entries =
    depots.length > 0
      ? await db
          .select()
          .from(accountBalanceEntries)
          .where(inArray(accountBalanceEntries.accountId, depots))
          .orderBy(desc(accountBalanceEntries.date))
      : [];
  const unread = new Map(
    (
      await db
        .select({ accountId: transactions.accountId, count: sql<number>`count(*)::int` })
        .from(transactions)
        .where(and(inArray(transactions.accountId, ids), eq(transactions.isUnread, true)))
        .groupBy(transactions.accountId)
    ).map((r) => [r.accountId, r.count]),
  );
  const changeOf = (accountId: number): AccountSummary["change"] => {
    const [latest, previous] = entries.filter((e) => e.accountId === accountId);
    return latest && previous ? { cents: latest.balanceCents - previous.balanceCents, since: previous.date } : null;
  };
  return rows.map((a) => {
    const c = a.connectionId === null ? undefined : byId.get(a.connectionId);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      color: a.color,
      bankName: c?.name ?? a.bank,
      ibanLast4: a.iban ? a.iban.slice(-4) : null,
      balanceCents: a.balanceCents,
      balanceDate: a.balanceDate,
      change: a.kind === "brokerage" ? changeOf(a.id) : null,
      connection: c
        ? {
            id: c.id,
            name: c.name,
            provider: c.provider,
            status: c.status,
            lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
            consentValidUntil: c.consentValidUntil?.toISOString() ?? null,
            attention: connectionAttention(c, now),
            skipSyncAll: c.skipSyncAll,
            canManage: canManage(viewer, c),
            otherAccounts: siblings.filter((o) => o.connectionId === c.id && o.id !== a.id).map((o) => o.name),
          }
        : null,
      manual: a.connectionId === null,
      unreadCount: unread.get(a.id) ?? 0,
      canManage: canManage(viewer, a),
      canShare: canShare(viewer, a),
      sharing: sharing.get(a.id) ?? { visibility: a.visibility, owner: null, sharedWith: null },
    };
  });
}

function subtotal(list: AccountSummary[], ids: number[]): number {
  const set = new Set(ids);
  return list.filter((a) => set.has(a.id)).reduce((sum, a) => sum + (a.balanceCents ?? 0), 0);
}

/** Accounts of the current view with their balances, sectioned by group, bank connection and kind. */
export async function accountsOverview(
  db: Db,
  viewer: Viewer,
  groupId: number | null | undefined,
  now = new Date(),
): Promise<AccountsOverview> {
  const view = await resolveView(db, viewer, groupId);
  const list = await summaries(db, viewer, view.accountIds, now);
  const ids = list.map((a) => a.id);
  const section = (draft: SectionDraft): Section => ({ ...draft, subtotalCents: subtotal(list, draft.accountIds) }) as Section;

  const groups = (await visibleGroups(db, viewer)).filter((g) => view.groupId === null || g.id === view.groupId);
  const byGroup: Section[] = groups
    .map((g) => section({ key: `group:${g.id}`, type: "group", name: g.name, accountIds: ids.filter((id) => g.accountIds.includes(id)) }))
    .filter((s) => s.accountIds.length > 0);
  const grouped = new Set(byGroup.flatMap((s) => s.accountIds));
  const ungrouped = ids.filter((id) => !grouped.has(id));
  if (ungrouped.length > 0) byGroup.push(section({ key: "ungrouped", type: "ungrouped", name: "", accountIds: ungrouped }));

  const connections = new Map<number, string>();
  for (const a of list) if (a.connection) connections.set(a.connection.id, a.connection.name);
  const byBank: Section[] = [...connections]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([id, name]) =>
      section({ key: `bank:${id}`, type: "bank", name, accountIds: list.filter((a) => a.connection?.id === id).map((a) => a.id) }),
    );
  const manual = list.filter((a) => !a.connection).map((a) => a.id);
  if (manual.length > 0) byBank.push(section({ key: "manual", type: "manual", name: "", accountIds: manual }));

  const byKind: Section[] = KIND_ORDER.map((kind) =>
    section({ key: `kind:${kind}`, type: "kind", name: kind, accountIds: list.filter((a) => a.kind === kind).map((a) => a.id) }),
  ).filter((s) => s.accountIds.length > 0);

  return {
    accounts: list,
    totalCents: subtotal(list, ids),
    withoutBalance: list.filter((a) => a.balanceCents === null).length,
    sections: { group: byGroup, bank: byBank, kind: byKind },
  };
}

export const detailInput = z.object({ accountId: z.number().int(), groupId: z.number().int().nullish() });

/** One visible account (inside or outside the selected view). Depots come with their positions. */
export async function accountDetail(db: Db, viewer: Viewer, input: z.input<typeof detailInput>, now = new Date()) {
  const { accountId, groupId } = detailInput.parse(input);
  await requireVisibleAccount(db, viewer, accountId);
  const view = await resolveView(db, viewer, groupId);
  const [summary] = await summaries(db, viewer, [accountId], now);
  if (!summary) throw new NotFound(msg("errors.accountNotFound"));
  const [row] = await db.select({ iban: accounts.iban }).from(accounts).where(eq(accounts.id, accountId));
  const holdings: Holding[] = await listHoldings(db, viewer, accountId);
  return {
    account: { ...summary, iban: row?.iban ?? null },
    inView: view.accountIds.includes(accountId),
    // Only hand-entered balances can be edited; a depot's entries come from its syncs.
    balanceEntries: summary.manual ? await listBalanceEntries(db, viewer, accountId) : [],
    holdings,
  };
}

export const bookingsInput = listInput
  .pick({
    q: true,
    categoryId: true,
    tagId: true,
    unread: true,
    uncategorized: true,
    aiSuggested: true,
    includeTransfers: true,
    dateFrom: true,
    dateTo: true,
    minAmountCents: true,
    maxAmountCents: true,
    sort: true,
  })
  .extend({
    accountId: z.number().int(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  });

/** Bookings of one account with the totals of all that match; transfers to the viewer's other accounts count as internal. */
export async function accountBookings(db: Db, viewer: Viewer, input: z.input<typeof bookingsInput>) {
  const data = bookingsInput.parse(input);
  await requireVisibleAccount(db, viewer, data.accountId);
  const page = await listTransactions(db, viewer, { ...data, groupId: null });
  const end = data.offset + page.items.length;
  return { items: page.items, total: page.total, totals: page.totals, quick: page.quick, nextOffset: end < page.total ? end : null };
}
