import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n, useT } from "../i18n/react.tsx";
import type { BookingSort, QuickFilter } from "../lib/booking-filter.ts";
import type { LoadTrigger } from "../lib/booking-run.ts";
import { type DateWindow, inWindow } from "../lib/booking-window.ts";
import type { PendingBooking } from "../server/modules/transactions/index.ts";
import { Amount, CategoryOrigin, NewMark, TableWrap, TransferBadge } from "./Bits.tsx";
import { Icon } from "./Icon.tsx";
import type { TransactionItem } from "./TransactionDrawer.tsx";

type Named = { id: number; name: string; color: string };
type Totals = { count: number; incomeCents: number; expenseCents: number; sumCents: number; internalTransfers: number };
type QuickCounts = { all: number; unread: number; uncategorized: number; aiSuggested: number };

const PILLS = [
  { key: null, label: "transactions.quick.all", count: "all" },
  { key: "unread", label: "transactions.quick.unread", count: "unread" },
  { key: "uncategorized", label: "transactions.quick.uncategorized", count: "uncategorized" },
] as const satisfies readonly { key: QuickFilter | null; label: string; count: keyof QuickCounts }[];

/** "Alle · Neu · Ohne Kategorie": one click each; the counts follow the other filters. */
export function QuickFilters({
  active,
  counts,
  onChange,
}: {
  active: QuickFilter | null;
  counts: QuickCounts;
  onChange: (quick: QuickFilter | null) => void;
}) {
  const { t, f } = useI18n();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset
    <div className="quick-filters" role="group" aria-label={t("transactions.quick.label")}>
      {PILLS.map((pill) => (
        <button key={pill.label} type="button" className="quick-pill" aria-pressed={active === pill.key} onClick={() => onChange(pill.key)}>
          {t(pill.label)}
          <span className="quick-count">{f.integer(counts[pill.count])}</span>
        </button>
      ))}
    </div>
  );
}

/** Sorting by date and amount; the first click on the amount shows the largest incomes first. */
function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: "datum" | "betrag";
  sort: BookingSort;
  onSort: (sort: BookingSort) => void;
  className?: string;
}) {
  const t = useT();
  const active = sort.startsWith(column);
  const ascending = sort.endsWith("-auf");
  const next: BookingSort =
    column === "datum" ? (active && !ascending ? "datum-auf" : "datum") : active && !ascending ? "betrag-auf" : "betrag-ab";
  return (
    <th scope="col" className={className} aria-sort={active ? (ascending ? "ascending" : "descending") : undefined}>
      <button type="button" className="sort-button" onClick={() => onSort(next)}>
        {label}
        <span className="sort-mark" data-active={active || undefined} aria-hidden="true">
          <Icon name={active && ascending ? "up" : "down"} size={14} />
        </span>
        {!active && <span className="visually-hidden">, {t("transactions.sort.sortable")}</span>}
      </button>
    </th>
  );
}

function CategoryCell({ txn, categories, tags }: { txn: TransactionItem; categories: Map<number, Named>; tags: Map<number, Named> }) {
  const t = useT();
  const category = txn.categoryId ? categories.get(txn.categoryId) : undefined;
  return (
    <span className="booking-category">
      {category ? (
        <span className="booking-category-name">
          <span className="swatch" style={{ background: category.color }} aria-hidden="true" />
          {category.name}
          <CategoryOrigin source={txn.categorySource} />
        </span>
      ) : txn.transferKind ? null : (
        <span className="booking-uncategorized">{t("transactions.uncategorized")}</span>
      )}
      <TransferBadge kind={txn.transferKind} label={txn.transferLabel} />
      {txn.tagIds.map((id) => {
        const tag = tags.get(id);
        return tag ? (
          <span key={id} className="tag">
            <span className="swatch" style={{ background: tag.color }} aria-hidden="true" />
            {tag.name}
          </span>
        ) : null;
      })}
    </span>
  );
}

/** Announced by the bank, not booked yet: muted, marked and not clickable; nothing counts them. */
function PendingRow({ booking, accountNames }: { booking: PendingBooking; accountNames?: Map<number, string> }) {
  const { t, f } = useI18n();
  return (
    <tr className="pending-row">
      <td className="booking-date">
        {booking.bookingDate ? (
          f.date(booking.bookingDate)
        ) : (
          <>
            <span aria-hidden="true">–</span>
            <span className="visually-hidden">{t("transactions.pending.noDate")}</span>
          </>
        )}
      </td>
      <td className="booking-party">
        <span className="cell-main">
          <span className="booking-title">
            <span className="pending-name">{booking.counterparty || booking.purpose || t("transactions.noCounterparty")}</span>
            <span className="pending-mark">{t("transactions.pending.mark")}</span>
          </span>
          {booking.counterparty && booking.purpose && <span className="cell-sub">{booking.purpose}</span>}
          {accountNames && <span className="cell-sub booking-account">{accountNames.get(booking.accountId) ?? "–"}</span>}
        </span>
      </td>
      <td className="num booking-amount">
        <Amount cents={booking.amountCents} currency={booking.currency} />
      </td>
      <td className="booking-cat">
        <span className="pending-note">{t("transactions.pending.notCounted")}</span>
      </td>
    </tr>
  );
}

/** Why the pending bookings are missing while a filter they cannot match is on. */
export function PendingHiddenNote({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return null;
  return <p className="pending-hidden">{t("transactions.pending.hidden", { count })}</p>;
}

/**
 * Bookings as a table: date, payee with purpose, amount, category. A row opens the booking's drawer: the payee is a
 * button whose hit area covers the row. On phones the rows stack (date and amount, payee, purpose, category). Pending
 * bookings come first, whatever the sort. Rows inside `marked` (the balance chart's window) are tinted. `footer`
 * (the list's end) sits inside the table's scroll area.
 */
export function BookingTable({
  label,
  items,
  pending = [],
  categories,
  tags,
  accountNames,
  sort,
  onSort,
  onOpen,
  marked = null,
  footer,
}: {
  label: string;
  items: TransactionItem[];
  pending?: PendingBooking[];
  categories: readonly Named[];
  tags: readonly Named[];
  /** Shown below the purpose when the list spans several accounts. */
  accountNames?: Map<number, string>;
  sort: BookingSort;
  onSort: (sort: BookingSort) => void;
  onOpen: (txn: TransactionItem) => void;
  marked?: DateWindow | null;
  footer?: ReactNode;
}) {
  const { t, f } = useI18n();
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  return (
    <TableWrap>
      <table className="data-table responsive booking-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <SortHeader label={t("common.fields.date")} column="datum" sort={sort} onSort={onSort} className="booking-date" />
            <th scope="col">{t("transactions.counterpartyAndPurpose")}</th>
            <SortHeader label={t("common.fields.amount")} column="betrag" sort={sort} onSort={onSort} className="num" />
            <th scope="col">{t("common.fields.category")}</th>
          </tr>
        </thead>
        {pending.length > 0 && (
          <tbody className="pending-rows">
            {pending.map((booking) => (
              <PendingRow key={booking.id} booking={booking} accountNames={accountNames} />
            ))}
          </tbody>
        )}
        <tbody>
          {items.map((txn) => (
            <tr
              key={txn.id}
              className="booking-row"
              data-unread={txn.isUnread || undefined}
              data-in-window={(marked && inWindow(txn.bookingDate, marked)) || undefined}
            >
              <td className="booking-date">{f.date(txn.bookingDate)}</td>
              <td className="booking-party">
                <span className="cell-main">
                  <span className="booking-title">
                    <button type="button" className="booking-open" onClick={() => onOpen(txn)}>
                      {txn.counterparty || txn.purpose || t("transactions.noCounterparty")}
                    </button>
                    {txn.isUnread && <NewMark />}
                  </span>
                  {txn.counterparty && txn.purpose && <span className="cell-sub">{txn.purpose}</span>}
                  {accountNames && <span className="cell-sub booking-account">{accountNames.get(txn.accountId) ?? "–"}</span>}
                  {txn.note && <span className="cell-sub">{t("transactions.notePrefix", { note: txn.note })}</span>}
                </span>
              </td>
              <td className="num booking-amount">
                <Amount cents={txn.amountCents} currency={txn.currency} />
              </td>
              <td className="booking-cat">
                <CategoryCell txn={txn} categories={categoryMap} tags={tagMap} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </TableWrap>
  );
}

/**
 * The end of a booking list that grows by scrolling: once it comes within half a screen (of the list's own scroll
 * area when `contained`), the next chunk loads by itself while `auto`; "load more" does the same by hand, and from the
 * keyboard it moves focus to the first new row. Each load is announced politely; the end says when all are loaded.
 */
export function ListEnd({
  shown,
  total,
  more,
  busy,
  auto,
  contained = false,
  added,
  onMore,
}: {
  shown: number;
  total: number;
  more: boolean;
  busy: boolean;
  auto: boolean;
  contained?: boolean;
  added: { count: number; serial: number } | null;
  onMore: (trigger: LoadTrigger) => void;
}) {
  const t = useT();
  const end = useRef<HTMLDivElement>(null);
  const request = useRef(onMore);
  request.current = onMore;
  const [message, setMessage] = useState("");

  // Observed afresh after each load, so a list still short of the screen keeps loading.
  useEffect(() => {
    const node = end.current;
    if (!node || !more || !auto || busy || typeof IntersectionObserver === "undefined") return;
    const root = contained ? node.closest<HTMLElement>(".table-wrap") : null;
    const observer = new IntersectionObserver(
      (entries) => {
        // Someone on "load more" decides themselves; loading under them would move what they are about to read.
        if (entries.some((entry) => entry.isIntersecting) && !node.contains(document.activeElement)) request.current("auto");
      },
      { root, rootMargin: "0px 0px 50% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, auto, busy, contained]);

  useEffect(() => {
    if (!added || added.count === 0) return;
    setMessage("");
    // Cleared first, so the same text is read again after the next load.
    const timer = setTimeout(() => setMessage(t("transactions.list.added", { count: added.count })), 150);
    return () => clearTimeout(timer);
  }, [added, t]);

  return (
    <div ref={end} className="pager list-end">
      {more ? (
        <>
          <span>{t("transactions.list.loaded", { shown, total })}</span>
          <button
            type="button"
            className="btn btn-sm"
            aria-busy={busy}
            aria-disabled={busy || undefined}
            onClick={(event) => onMore(event.detail === 0 ? "keyboard" : "pointer")}
          >
            <Icon name={busy ? "loader" : "down"} size={16} /> {t("transactions.list.more")}
          </button>
        </>
      ) : (
        <span>{t("transactions.list.allLoaded", { count: total })}</span>
      )}
      <p className="visually-hidden" role="status">
        {message}
      </p>
    </div>
  );
}

/** Totals of every booking matching the filters, not only the loaded ones; sticks to the bottom while the list scrolls. */
export function TotalsBar({ totals }: { totals: Totals }) {
  const { t, f } = useI18n();
  const figures = [
    ["income", totals.incomeCents],
    ["expenses", totals.expenseCents],
    ["sum", totals.sumCents],
  ] as const;
  return (
    <section className="totals-bar" aria-label={t("transactions.totals.label")}>
      <dl className="totals-figures">
        {figures.map(([key, cents]) => (
          <div key={key} className="totals-figure">
            <dt>{t(`transactions.totals.${key}`)}</dt>
            <dd>
              <Amount cents={cents} />
            </dd>
          </div>
        ))}
        <div className="totals-figure">
          <dt>{t("transactions.totals.count")}</dt>
          <dd className="num">{f.integer(totals.count)}</dd>
        </div>
      </dl>
      {totals.internalTransfers > 0 && (
        <p className="totals-note">{t("transactions.totals.transfersExcluded", { count: totals.internalTransfers })}</p>
      )}
    </section>
  );
}
