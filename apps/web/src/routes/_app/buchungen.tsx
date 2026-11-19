import { createFileRoute, getRouteApi, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { BookingTable, ListEnd, PendingHiddenNote, QuickFilters, TotalsBar } from "../../components/BookingList.tsx";
import { ConfirmDialog } from "../../components/Dialog.tsx";
import { FilterBar } from "../../components/Filters.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PageHead } from "../../components/PageHead.tsx";
import { RecategorizeButton, type ScopeStart } from "../../components/Recategorize.tsx";
import { SavedFilters } from "../../components/SavedFilters.tsx";
import { Banner, NoticeBanner } from "../../components/Status.tsx";
import { TransactionDrawer, type TransactionItem } from "../../components/TransactionDrawer.tsx";
import { useI18n } from "../../i18n/react.tsx";
import { useAction, useNotice } from "../../lib/action.ts";
import {
  applicableFilter,
  type BookingFilter,
  type BookingSort,
  CHUNK_SIZE,
  csvExportUrl,
  filterRange,
  filterToSearch,
  isEmptySearch,
  listFilters,
  parseTransactionSearch,
  type QuickFilter,
  quickFilterOf,
  searchToFilter,
  serverSort,
  type TransactionSearch,
} from "../../lib/booking-filter.ts";
import { type RowPage, useBookingRun } from "../../lib/booking-run.ts";
import { amountFilter, categoryFilter, directionFilter, type FilterDef, groupFilter, periodFilter, tagFilter } from "../../lib/filters.ts";
import { prefersReducedMotion } from "../../lib/motion.ts";
import { isoDate, PERIODS } from "../../lib/periods.ts";
import { managesHousehold } from "../../lib/roles.ts";
import { getAccounts } from "../../server/functions/accounts.ts";
import { getCategories, getTags } from "../../server/functions/catalog.ts";
import { getSavedFiltersFn } from "../../server/functions/saved-filters.ts";
import { getPendingBookingsFn, getTransactions, markAllReadFn } from "../../server/functions/transactions.ts";
import type { PendingBooking } from "../../server/modules/transactions/index.ts";

export const Route = createFileRoute("/_app/buchungen")({
  validateSearch: (search: Record<string, unknown>) => parseTransactionSearch(search),
  // Opened without filters, the page starts with the default saved filter; removing filters on the page keeps them off.
  beforeLoad: async ({ search, cause }) => {
    if (cause !== "enter" || !isEmptySearch(search)) return;
    const saved = await getSavedFiltersFn({ data: { scope: "transactions" } }).catch(() => []);
    const preset = saved.find((s) => s.isDefault);
    if (preset)
      throw redirect({ to: "/buchungen", search: { ...filterToSearch(preset.filter), sortierung: search.sortierung }, replace: true });
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const [accounts, categories, tags, saved] = await Promise.all([
      getAccounts(),
      getCategories(),
      getTags(),
      getSavedFiltersFn({ data: { scope: "transactions" } }).catch(() => []),
    ]);
    const filter = applicableFilter(searchToFilter(deps), { groups: context.groups, accounts });
    const filters = listFilters(filter);
    const query = { ...filters, sort: serverSort(deps.sortierung) };
    const [{ items, ...result }, pending] = await Promise.all([
      getTransactions({ data: { ...query, limit: CHUNK_SIZE } }),
      getPendingBookingsFn({ data: filters }),
    ]);
    return { ...result, first: { items, total: result.total }, query, pending, filter, accounts, categories, tags, saved };
  },
  component: TransactionsPage,
});

const appRoute = getRouteApi("/_app");

/** The period the list shows preselects the dialog; without one it starts with the last three months. */
function recategorizeStart(filter: BookingFilter): ScopeStart {
  if (filter.period === "last_3_months") return { choice: "last_3_months" };
  const { dateFrom, dateTo } = filterRange(filter);
  if (!dateFrom && !dateTo) return { choice: "last_3_months" };
  return { choice: "custom", dateFrom, dateTo: dateTo ?? isoDate(new Date()) };
}

function TransactionsPage() {
  const { first, query, pending, total, unread, totals, quick, filter, accounts, categories, tags, saved } = Route.useLoaderData();
  const { aiReady } = appRoute.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/buchungen" });
  const { user, groups } = Route.useRouteContext();
  const { t } = useI18n();
  const [open, setOpen] = useState<TransactionItem | null>(null);
  const [confirmRead, setConfirmRead] = useState(false);
  const { notice, setNotice, clear } = useNotice();
  const markAll = useAction(markAllReadFn);
  const admin = managesHousehold(user);
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const group = filter.groupId === undefined ? null : (groups.find((g) => g.id === filter.groupId) ?? null);
  const sort: BookingSort = search.sortierung ?? "datum";
  const filterDefs: FilterDef[] = [
    ...(groups.length > 0 ? [groupFilter(t, groups)] : []),
    {
      kind: "select",
      key: "konto",
      label: t("common.fields.account"),
      anyLabel: group ? t("transactions.filter.allAccountsOfGroup") : t("common.allAccounts"),
      options: accounts.filter((a) => !group || a.groupIds.includes(group.id)).map((a) => ({ value: a.id, label: a.name })),
    },
    categoryFilter(t, categories),
    tagFilter(t, tags),
    directionFilter(t),
    amountFilter(t),
    periodFilter(t, PERIODS),
    { kind: "flag", key: "ohneUmbuchungen", label: t("transactions.filter.hideTransfers") },
  ];

  function show(next: TransactionSearch) {
    void navigate({ search: next, replace: true, resetScroll: false });
  }

  function patch(values: Record<string, unknown>) {
    const next = parseTransactionSearch({ ...search, ...values });
    // An account outside a newly chosen group would empty the list; the group decides.
    const kept = applicableFilter(searchToFilter(next), { groups, accounts });
    show({ ...filterToSearch(kept), sortierung: next.sortierung });
  }

  const setQuick = (quickFilter: QuickFilter | null) =>
    patch({
      neu: quickFilter === "unread" || undefined,
      ohneKategorie: quickFilter === "uncategorized" || undefined,
      kiVorschlag: quickFilter === "aiSuggested" || undefined,
    });

  const applySaved = (chosen: BookingFilter) =>
    show({ ...filterToSearch(applicableFilter(chosen, { groups, accounts })), sortierung: search.sortierung });

  async function readAll() {
    const result = await markAll.run({ data: { groupId: filter.groupId ?? null } });
    setNotice(result.ok ? { tone: "ok", text: t("transactions.allMarkedRead") } : { tone: "danger", text: result.error });
  }

  return (
    <>
      <PageHead
        eyebrow={group?.name ?? t("common.allAccounts")}
        title={t("shell.transactions")}
        actions={
          <>
            <a className="btn" href={csvExportUrl(filter)} download>
              <Icon name="download" size={18} /> {t("transactions.exportCsv")}
            </a>
            {unread > 0 && (
              <button type="button" className="btn" disabled={markAll.busy} aria-busy={markAll.busy} onClick={() => setConfirmRead(true)}>
                <Icon name="check" size={18} /> {t("transactions.markAllRead")}
              </button>
            )}
            {aiReady && managesHousehold(user) && (
              <RecategorizeButton
                groupId={filter.groupId ?? null}
                start={recategorizeStart(filter)}
                label={t("transactions.recategorize")}
                onNotice={setNotice}
              />
            )}
          </>
        }
      />
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card card-flush bookings-card" aria-labelledby="txn-title">
        <div className="card-head">
          <h2 id="txn-title">{t("transactions.count", { count: total })}</h2>
        </div>
        <FilterBar
          className="bookings-toolbar"
          label={t("transactions.filter.label")}
          defs={filterDefs}
          values={search}
          search={{ key: "q", label: t("transactions.filter.search"), placeholder: t("transactions.filter.searchPlaceholder") }}
          resultCount={total}
          leading={<QuickFilters active={quickFilterOf(filter)} counts={quick} onChange={setQuick} />}
          trailing={<SavedFilters scope="transactions" saved={saved} current={filter} onApply={applySaved} />}
          onApply={patch}
        />
        <PendingHiddenNote count={pending.hidden} />
        {first.items.length === 0 && pending.items.length === 0 ? (
          <p className="empty">{t("transactions.empty")}</p>
        ) : (
          <TransactionList
            key={JSON.stringify(query)}
            first={first}
            query={query}
            pending={pending.items}
            categories={categories}
            tags={tags}
            accountNames={accountNames}
            sort={sort}
            onSort={(next) => show({ ...search, sortierung: next === "datum" ? undefined : next })}
            onOpen={setOpen}
          />
        )}
        <TotalsBar totals={totals} />
      </section>
      {open && (
        <TransactionDrawer
          txn={open}
          accountName={accountNames.get(open.accountId) ?? "–"}
          categories={categories}
          tags={tags}
          admin={admin}
          aiReady={aiReady}
          onClose={() => setOpen(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      <ConfirmDialog
        open={confirmRead}
        title={t("transactions.confirmRead.title", { count: unread })}
        confirmLabel={t("transactions.confirmRead.confirm")}
        onConfirm={readAll}
        onClose={() => setConfirmRead(false)}
      >
        <p>{t("transactions.confirmRead.text")}</p>
      </ConfirmDialog>
    </>
  );
}

type ListQuery = ReturnType<typeof listFilters> & { sort: ReturnType<typeof serverSort> };
type Named = { id: number; name: string; color: string };

/**
 * The bookings matching the filters, newest chunk first, growing as the end of the list comes into view. A new filter or
 * order mounts a new list (keyed by its query), which starts with the first chunk and scrolls back to its top.
 */
function TransactionList({
  first,
  query,
  pending,
  categories,
  tags,
  accountNames,
  sort,
  onSort,
  onOpen,
}: {
  first: RowPage<TransactionItem>;
  query: ListQuery;
  pending: PendingBooking[];
  categories: readonly Named[];
  tags: readonly Named[];
  accountNames: Map<number, string>;
  sort: BookingSort;
  onSort: (sort: BookingSort) => void;
  onOpen: (txn: TransactionItem) => void;
}) {
  const { t } = useI18n();
  const fetchList = useServerFn(getTransactions);
  const list = useRef<HTMLDivElement>(null);
  const bookings = useBookingRun(first, (range) => fetchList({ data: { ...query, ...range } }), 500, list);
  const { run } = bookings;

  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const covered = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    if (node.getBoundingClientRect().top < covered)
      node.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  return (
    <div ref={list} className="booking-list">
      <BookingTable
        label={t("transactions.tableLabel")}
        items={run.items}
        pending={pending}
        categories={categories}
        tags={tags}
        accountNames={accountNames}
        sort={sort}
        onSort={onSort}
        onOpen={onOpen}
        footer={
          run.items.length > 0 && (
            <ListEnd
              shown={run.items.length}
              total={run.total}
              more={run.nextOffset !== null}
              busy={bookings.busy}
              auto={bookings.autoLoad}
              added={bookings.added}
              onMore={bookings.loadOlder}
            />
          )
        }
      />
      {bookings.error && <Banner tone="danger">{bookings.error}</Banner>}
    </div>
  );
}
