/**
 * The notification events. Every check runs per subscribed user on the accounts that user may see, so nobody hears
 * about an account they cannot see; bank problems reach those who manage the connection. Dedup keys make every check
 * safe to repeat.
 */
import * as core from "@saldo/core";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { render, type Translatable, t } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE, INTL_LOCALES, type Locale } from "../../../i18n/locales.ts";
import { formatter } from "../../../lib/format.ts";
import type { Db } from "../../db/index.ts";
import {
  accounts,
  bankConnections,
  contracts,
  type NotificationKind,
  notificationPreferences,
  transactions,
  user,
} from "../../db/schema.ts";
import { canManage, isSuperuser, type Owned, resolveView, visibleAccountIds } from "../access/index.ts";
import { type ContractView, listContracts } from "../contracts/index.ts";
import { loadStatTxns } from "../stats/index.ts";
import { deliver, release, type Subscriber, subscribers } from "./deliver.ts";
import { deps } from "./deps.ts";
import { DEFAULT_PREFERENCES, DEFAULT_THRESHOLDS } from "./kinds.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day in the server's timezone. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const dayMonthFormats = new Map<Locale, Intl.DateTimeFormat>();

/** Day and month without the year ("09.11." in German). */
function shortDate(locale: Locale, day: string): string {
  let format = dayMonthFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(INTL_LOCALES[locale], { day: "2-digit", month: "2-digit", timeZone: "UTC" });
    dayMonthFormats.set(locale, format);
  }
  return format.format(new Date(`${day}T00:00:00Z`));
}
const thresholdOf = (s: Subscriber, kind: keyof typeof DEFAULT_THRESHOLDS) => s.threshold ?? DEFAULT_THRESHOLDS[kind] ?? 0;

// ---- after a sync

type Fresh = {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  purpose: string;
  isTransfer: boolean;
  transferAccountId: number | null;
  /** A booking of a variable contract is expected to differ, so it is no price change. */
  variableContract: boolean;
};

async function freshBookings(db: Db, ids: number[]): Promise<Fresh[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      bookingDate: transactions.bookingDate,
      amountCents: transactions.amountCents,
      counterparty: transactions.counterparty,
      purpose: transactions.purpose,
      isTransfer: transactions.isTransfer,
      transferAccountId: transactions.transferAccountId,
      variableContract: sql<boolean>`coalesce(${contracts.variable}, false)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(contracts, eq(contracts.id, transactions.contractId))
    .where(inArray(transactions.id, ids))
    .orderBy(asc(transactions.bookingDate), asc(transactions.id));
}

const label = (locale: Locale, txn: Pick<Fresh, "counterparty" | "purpose">) =>
  txn.counterparty || txn.purpose.slice(0, 60) || t(locale, "notifications.noCounterparty");

async function newBookings(db: Db, jobId: string, fresh: Fresh[]): Promise<void> {
  for (const s of await subscribers(db, "new_bookings")) {
    const visible = new Set(await visibleAccountIds(db, s.viewer));
    const mine = fresh.filter((txn) => visible.has(txn.accountId));
    if (mine.length === 0) continue;
    const f = formatter(s.locale);
    const lines = mine
      .slice(0, 5)
      .map((txn) => `${shortDate(s.locale, txn.bookingDate)} ${label(s.locale, txn)} ${f.euro(txn.amountCents)}`);
    if (mine.length > 5) lines.push(t(s.locale, "notifications.more", { count: mine.length - 5 }));
    await deliver(db, s, `new_bookings:${jobId}`, {
      kind: "new_bookings",
      title: t(s.locale, "notifications.newBookings", { count: mine.length }),
      body: lines.join("\n"),
      link: "/buchungen?neu=true",
    });
  }
}

async function largeExpenses(db: Db, fresh: Fresh[]): Promise<void> {
  for (const s of await subscribers(db, "large_expense")) {
    const visible = new Set(await visibleAccountIds(db, s.viewer));
    const limit = thresholdOf(s, "large_expense");
    const f = formatter(s.locale);
    for (const txn of fresh) {
      if (!visible.has(txn.accountId) || -txn.amountCents < limit || core.isInternalTransfer(txn, visible)) continue;
      await deliver(db, s, `large_expense:${txn.id}`, {
        kind: "large_expense",
        title: t(s.locale, "notifications.largeExpenseTitle", { amount: f.euro(-txn.amountCents) }),
        body: t(s.locale, "notifications.largeExpenseBody", {
          label: label(s.locale, txn),
          date: f.date(txn.bookingDate),
          account: txn.accountName,
        }),
        link: `/buchungen?konto=${txn.accountId}&von=${txn.bookingDate}&bis=${txn.bookingDate}`,
      });
    }
  }
}

async function priceChanges(db: Db, fresh: Fresh[]): Promise<void> {
  const freshIds = new Set(fresh.map((txn) => txn.id));
  const variable = new Set(fresh.filter((txn) => txn.variableContract).map((txn) => txn.id));
  const latest =
    fresh
      .map((txn) => txn.bookingDate)
      .sort()
      .at(-1) ?? "";
  for (const s of await subscribers(db, "price_change")) {
    const view = await resolveView(db, s.viewer, null);
    const visible = new Set(view.accountIds);
    if (!fresh.some((txn) => visible.has(txn.accountId))) continue;
    const txns = await loadStatTxns(db, view, { dateFrom: addDays(latest, -400), dateTo: latest, accountIds: [] });
    const history = txns.filter((txn) => !freshIds.has(txn.id));
    const mine = txns.filter((txn) => freshIds.has(txn.id) && !variable.has(txn.id));
    const f = formatter(s.locale);
    for (const change of core.priceChanges(history, mine, thresholdOf(s, "price_change"))) {
      const txn = fresh.find((candidate) => candidate.id === change.txnId);
      const vars = {
        previous: f.euro(change.previousCents),
        current: f.euro(change.currentCents),
        change: `${change.changePercent > 0 ? "+" : ""}${f.percent(Math.round(change.changePercent) / 100)}`,
      };
      await deliver(db, s, `price_change:${change.txnId}`, {
        kind: "price_change",
        title: t(s.locale, change.currentCents > change.previousCents ? "notifications.priceUp" : "notifications.priceDown", {
          name: change.counterparty,
        }),
        body: txn
          ? t(s.locale, "notifications.priceBodyOn", { ...vars, date: f.date(txn.bookingDate) })
          : t(s.locale, "notifications.priceBody", vars),
        link: txn ? `/buchungen?konto=${txn.accountId}&q=${encodeURIComponent(change.counterparty)}` : "/analyse",
      });
    }
  }
}

const BALANCE_KINDS = new Set(["checking", "savings"]);

/** Once per account while the balance stays below the limit; rising above it re-arms the notification. */
export async function checkBalances(db: Db): Promise<void> {
  const rows = await db.select().from(accounts);
  for (const s of await subscribers(db, "low_balance")) {
    const visible = new Set(await visibleAccountIds(db, s.viewer));
    const limit = thresholdOf(s, "low_balance");
    const f = formatter(s.locale);
    for (const a of rows) {
      if (!visible.has(a.id) || !BALANCE_KINDS.has(a.kind) || a.balanceCents === null) continue;
      const key = `low_balance:${a.id}`;
      if (a.balanceCents >= limit) {
        await release(db, s.viewer.id, key);
        continue;
      }
      await deliver(db, s, key, {
        kind: "low_balance",
        title: t(s.locale, "notifications.lowBalanceTitle", { account: a.name }),
        body: a.balanceDate
          ? t(s.locale, "notifications.lowBalanceBodyAsOf", {
              balance: f.euro(a.balanceCents),
              limit: f.euro(limit),
              date: f.date(a.balanceDate),
            })
          : t(s.locale, "notifications.lowBalanceBody", { balance: f.euro(a.balanceCents), limit: f.euro(limit) }),
        link: `/buchungen?konto=${a.id}`,
      });
    }
  }
}

const contractLink = (c: Pick<ContractView, "id">) => `/vertraege?vertrag=${c.id}`;

/** A new booking linked to a contract whose amount is off by more than the contract's tolerance. */
async function contractChanges(db: Db, fresh: Fresh[]): Promise<void> {
  const freshIds = new Set(fresh.map((txn) => txn.id));
  for (const s of await subscribers(db, "contract_changed")) {
    const f = formatter(s.locale);
    for (const c of await listContracts(db, s.viewer, {}, localDay(deps.now()))) {
      const change = c.state.priceChange;
      if (!change || !freshIds.has(change.txnId)) continue;
      await deliver(db, s, `contract_changed:${c.id}:${change.txnId}`, {
        kind: "contract_changed",
        title: t(s.locale, "notifications.contractChangedTitle", { name: c.name }),
        body: t(s.locale, "notifications.contractChangedBody", {
          previous: f.euro(change.expectedCents),
          current: f.euro(change.actualCents),
          change: `${change.changePercent > 0 ? "+" : ""}${f.percent(Math.round(change.changePercent) / 100)}`,
          date: f.date(change.date),
        }),
        link: contractLink(c),
      });
    }
  }
}

/** Once per contract and due date whose grace days passed without a matching booking. */
export async function checkContracts(db: Db, today: string): Promise<void> {
  for (const s of await subscribers(db, "contract_missed")) {
    const f = formatter(s.locale);
    for (const c of await listContracts(db, s.viewer, {}, today)) {
      const due = c.state.nextDue;
      if (!c.state.overdue || due === null) continue;
      await deliver(db, s, `contract_missed:${c.id}:${due}`, {
        kind: "contract_missed",
        title: t(s.locale, c.direction === "income" ? "notifications.contractMissedIncome" : "notifications.contractMissedExpense", {
          name: c.name,
        }),
        body: t(s.locale, "notifications.contractMissedBody", { date: f.date(due), amount: f.euro(c.state.expectedCents) }),
        link: contractLink(c),
      });
    }
  }
}

/** Once per contract and due date, at most `threshold` days ahead; a contract that is overdue already has its own event. */
export async function checkUpcomingContracts(db: Db, today: string): Promise<void> {
  for (const s of await subscribers(db, "contract_upcoming")) {
    const f = formatter(s.locale);
    const ahead = thresholdOf(s, "contract_upcoming");
    for (const c of await listContracts(db, s.viewer, {}, today)) {
      const due = c.state.nextDue;
      const left = core.dueWithin(c.state, today, ahead);
      if (due === null || left === null) continue;
      await deliver(db, s, `contract_upcoming:${c.id}:${due}`, {
        kind: "contract_upcoming",
        title:
          left === 0
            ? t(s.locale, "notifications.contractUpcomingToday", { name: c.name })
            : t(s.locale, "notifications.contractUpcomingIn", { name: c.name, count: left }),
        body: t(s.locale, c.direction === "income" ? "notifications.contractUpcomingIncome" : "notifications.contractUpcomingExpense", {
          amount: f.euro(c.state.expectedCents),
          date: f.date(due),
        }),
        link: contractLink(c),
      });
    }
  }
}

/** Booking and balance events after a successful sync (manual or scheduled). */
export async function notifyAfterSync(db: Db, input: { jobId: string; transactionIds: number[] }): Promise<void> {
  const fresh = await freshBookings(db, input.transactionIds);
  if (fresh.length > 0) {
    await newBookings(db, input.jobId, fresh);
    await largeExpenses(db, fresh);
    await priceChanges(db, fresh);
    await contractChanges(db, fresh);
  }
  await checkBalances(db);
}

// ---- daily checks

async function summaries(
  db: Db,
  kind: "weekly_summary" | "monthly_summary",
  from: string,
  to: string,
  title: (locale: Locale) => string,
): Promise<void> {
  for (const s of await subscribers(db, kind)) {
    const f = formatter(s.locale);
    const view = await resolveView(db, s.viewer, null);
    const txns = await loadStatTxns(db, view, { dateFrom: from, dateTo: to, accountIds: [] });
    if (txns.length === 0) continue;
    const total = core.summary(txns);
    const top = core
      .byCategory(txns, "expense", new Set(view.visibleIds))
      .slice(0, 3)
      .map((c) => `${c.name} ${f.euro(c.amountCents)}`);
    const lines = [
      t(s.locale, "notifications.summaryTotals", {
        income: f.euro(total.incomeCents),
        expenses: f.euro(total.expensesCents),
        saved: f.euro(total.savingsCents),
      }),
      t(s.locale, "notifications.summaryBalance", { balance: f.euro(total.balanceCents) }),
    ];
    if (top.length > 0) lines.push(t(s.locale, "notifications.summaryTop", { list: top.join(", ") }));
    await deliver(db, s, `${kind}:${from}`, {
      kind,
      title: title(s.locale),
      body: lines.join("\n"),
      link: kind === "weekly_summary" ? `/buchungen?von=${from}&bis=${to}` : "/analyse?zeitraum=last_month",
    });
  }
}

async function uncategorized(db: Db, today: string): Promise<void> {
  for (const s of await subscribers(db, "uncategorized")) {
    const visible = await visibleAccountIds(db, s.viewer);
    if (visible.length === 0) continue;
    const [row] = await db
      .select({ n: count() })
      .from(transactions)
      .where(and(inArray(transactions.accountId, visible), isNull(transactions.categoryId), eq(transactions.isTransfer, false)));
    const n = row?.n ?? 0;
    if (n <= thresholdOf(s, "uncategorized")) continue;
    await deliver(db, s, `uncategorized:${today}`, {
      kind: "uncategorized",
      title: t(s.locale, "notifications.uncategorizedTitle", { count: n }),
      body: t(s.locale, "notifications.uncategorizedBody"),
      link: "/buchungen?ohneKategorie=true",
    });
  }
}

const BANK_LINK = "/einstellungen/bankverbindungen";

/**
 * Reaches those who manage the connection (owner, superusers, family admins for household connections), or only
 * superusers for instance-wide problems (`null`). Title and body are rendered per recipient in their language; plain
 * strings (e.g. a bank's own message) pass through.
 */
export async function notifyBankProblem(
  db: Db,
  connection: Owned | null,
  dedupKey: string,
  title: Translatable | string,
  body: Translatable | string,
): Promise<void> {
  for (const s of await subscribers(db, "bank_problem")) {
    if (connection ? !canManage(s.viewer, connection) : !isSuperuser(s.viewer)) continue;
    await deliver(db, s, dedupKey, { kind: "bank_problem", title: render(s.locale, title), body: render(s.locale, body), link: BANK_LINK });
  }
}

/**
 * An instance-wide event for every superuser, honouring their choice or, without one, the kind's default (a failed
 * backup is on by default). Never throws: a notification must not change the outcome of what it reports.
 */
export async function notifySuperusers(
  db: Db,
  kind: NotificationKind,
  dedupKey: string,
  title: Translatable | string,
  body: Translatable | string,
  link: string,
): Promise<void> {
  try {
    const fallback = DEFAULT_PREFERENCES[kind] ?? { enabled: false, push: false, email: false };
    const rows = await db
      .select({
        id: user.id,
        role: user.role,
        locale: user.locale,
        enabled: notificationPreferences.enabled,
        push: notificationPreferences.push,
        email: notificationPreferences.email,
      })
      .from(user)
      .leftJoin(notificationPreferences, and(eq(notificationPreferences.userId, user.id), eq(notificationPreferences.kind, kind)))
      .where(eq(user.role, "superuser"));
    for (const row of rows) {
      if (!(row.enabled ?? fallback.enabled)) continue;
      const locale = row.locale ?? DEFAULT_LOCALE;
      const subscriber = {
        viewer: { id: row.id, role: row.role, locale },
        locale,
        channels: { push: row.push ?? fallback.push, email: row.email ?? fallback.email },
        threshold: null,
      };
      await deliver(db, subscriber, dedupKey, { kind, title: render(locale, title), body: render(locale, body), link });
    }
  } catch (error) {
    console.error(`Notification ${kind} not delivered: ${error instanceof Error ? error.name : typeof error}`);
  }
}

async function consents(db: Db): Promise<void> {
  const subscribed = await subscribers(db, "bank_problem");
  if (subscribed.length === 0) return;
  const now = deps.now().getTime();
  for (const c of await db.select().from(bankConnections)) {
    const until = c.consentValidUntil;
    const untilDay = until ? localDay(until) : null;
    for (const s of subscribed.filter((candidate) => canManage(candidate.viewer, c))) {
      if (c.status === "needs_reauth" || (until && until.getTime() < now)) {
        await deliver(db, s, `bank_reauth:${c.id}:${untilDay ?? "none"}`, {
          kind: "bank_problem",
          title: t(s.locale, "notifications.consentExpiredTitle", { name: c.name }),
          body: t(s.locale, "notifications.consentExpiredBody"),
          link: BANK_LINK,
        });
      } else if (until && untilDay && until.getTime() - now < thresholdOf(s, "bank_problem") * 24 * 3600_000) {
        await deliver(db, s, `bank_consent:${c.id}:${untilDay}`, {
          kind: "bank_problem",
          title: t(s.locale, "notifications.consentSoonTitle", { name: c.name }),
          body: t(s.locale, "notifications.consentSoonBody", { date: formatter(s.locale).date(untilDay) }),
          link: BANK_LINK,
        });
      }
    }
  }
}

/** Summaries, reminders, contracts and consent checks; called once per day by the scheduler (repeats are harmless). */
export async function runDailyChecks(db: Db, now: Date): Promise<void> {
  const today = localDay(now);
  if (now.getDay() === 1) {
    const from = addDays(today, -7);
    const to = addDays(today, -1);
    await summaries(db, "weekly_summary", from, to, (locale) =>
      t(locale, "notifications.weeklyTitle", { from: shortDate(locale, from), to: shortDate(locale, to) }),
    );
    await uncategorized(db, today);
  }
  if (now.getDate() === 1) {
    const from = `${addDays(today, -1).slice(0, 7)}-01`;
    await summaries(db, "monthly_summary", from, addDays(today, -1), (locale) =>
      t(locale, "notifications.monthlyTitle", { month: formatter(locale).monthLong(from) }),
    );
  }
  await checkContracts(db, today);
  await checkUpcomingContracts(db, today);
  await consents(db);
}
