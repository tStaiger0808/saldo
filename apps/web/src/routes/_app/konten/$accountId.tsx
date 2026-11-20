import { createFileRoute, getRouteApi, Link, notFound, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AccountMenu, useAlsoAffects } from "../../../components/AccountActions.tsx";
import { AccountBadge, AccountStatus, balanceAsOf, formatIban, SharingBadge } from "../../../components/AccountBits.tsx";
import { BalanceTimeline } from "../../../components/BalanceTimeline.tsx";
import { coveredText } from "../../../components/BankDialogs.tsx";
import { amountTone, Balance, CopyButton, Money } from "../../../components/Bits.tsx";
import { BookingTable, ListEnd, PendingHiddenNote, QuickFilters, TotalsBar } from "../../../components/BookingList.tsx";
import { FilterBar } from "../../../components/Filters.tsx";
import { FoldToggle } from "../../../components/Fold.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { PageHead } from "../../../components/PageHead.tsx";
import { SavedFilters } from "../../../components/SavedFilters.tsx";
import { Banner, NoticeBanner, Status, Tag } from "../../../components/Status.tsx";
import { TransactionDrawer, type TransactionItem } from "../../../components/TransactionDrawer.tsx";
import { translator } from "../../../i18n/index.ts";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { errorMessage, type Notice, useAction, useNotice } from "../../../lib/action.ts";
import {
  BOOKING_SORTS,
  type BookingSort,
  CHUNK_SIZE,
  filterToSearch,
  isEmptySearch,
  listFilters,
  parseTransactionSearch,
  quickFilterOf,
  searchToFilter,
  serverSort,
  type TransactionSearch,
} from "../../../lib/booking-filter.ts";
import { useBookingRun } from "../../../lib/booking-run.ts";
import { type DateWindow, gapBefore, placeRows, windowTarget } from "../../../lib/booking-window.ts";
import { amountFilter, categoryFilter, directionFilter, periodFilter, tagFilter } from "../../../lib/filters.ts";
import { PERIODS } from "../../../lib/periods.ts";
import { managesHousehold } from "../../../lib/roles.ts";
import { getAccountBookingsFn, getAccountDetailFn, getBalanceTimelineFn } from "../../../server/functions/accounts.ts";
import { getBankConnectionsFn } from "../../../server/functions/banking.ts";
import { getCategories, getTags } from "../../../server/functions/catalog.ts";
import { getSavedFiltersFn } from "../../../server/functions/saved-filters.ts";
import { getPendingBookingsFn, markAllReadFn } from "../../../server/functions/transactions.ts";
import type { Holding } from "../../../server/modules/accounts/index.ts";
import type { PendingBooking } from "../../../server/modules/transactions/index.ts";

type AccountSearch = Omit<TransactionSearch, "gruppe" | "konto">;

/** The most bookings one request for an account may ask for. */
const MAX_PAGE = 200;

/** The account is fixed by the address, so a group or account in the search means nothing here. */
function parseSearch(raw: Record<string, unknown>): AccountSearch {
  const { gruppe: _group, konto: _account, ...rest } = parseTransactionSearch(raw);
  return rest;
}

function bookingQuery(accountId: number, search: AccountSearch) {
  const { groupId: _group, accountId: _account, ...filters } = listFilters(searchToFilter(search));
  return { ...filters, accountId, sort: serverSort(search.sortierung) };
}

export const Route = createFileRoute("/_app/konten/$accountId")({
  validateSearch: parseSearch,
  // Opened without filters, the account's bookings start with the default saved filter.
  beforeLoad: async ({ search, cause, params }) => {
    if (cause !== "enter" || !isEmptySearch(search)) return;
    const saved = await getSavedFiltersFn({ data: { scope: "account" } }).catch(() => []);
    const preset = saved.find((s) => s.isDefault);
    if (preset) {
      throw redirect({
        to: "/konten/$accountId",
        params,
        search: { ...parseSearch({ ...filterToSearch(preset.filter) }), sortierung: search.sortierung },
        replace: true,
      });
    }
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const accountId = Number(params.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) throw notFound();
    try {
      const query = bookingQuery(accountId, deps);
      const [detail, timeline, bookings, pending, categories, tags, connections, saved] = await Promise.all([
        getAccountDetailFn({ data: { accountId } }),
        getBalanceTimelineFn({ data: { accountId } }),
        getAccountBookingsFn({ data: { ...query, limit: CHUNK_SIZE } }),
        getPendingBookingsFn({ data: query }),
        getCategories(),
        getTags(),
        getBankConnectionsFn(),
        getSavedFiltersFn({ data: { scope: "account" } }).catch(() => []),
      ]);
      return {
        ...detail,
        timeline,
        bookings,
        pending,
        categories,
        tags,
        saved,
        context: {
          connection: connections.find((c) => c.id === detail.account.connection?.id),
          balanceEntries: detail.balanceEntries,
        },
      };
    } catch (error) {
      const t = translator(context.session.locale);
      if (errorMessage(error, t) === t("errors.accountNotFound")) throw notFound();
      throw error;
    }
  },
  component: AccountPage,
});

const appRoute = getRouteApi("/_app");

/** Keeps the day headings below the sticky page head, whose height depends on the viewport. */
function AccountPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/konten/$accountId" });
  const { t, f } = useI18n();
  const { notice, setNotice, clear } = useNotice();
  const { account, timeline, holdings } = data;
  const covered = (data.context.connection?.remoteAccounts ?? []).filter(
    (r) => r.coveredBy && !data.context.connection?.linkedAccounts.some((a) => a.remoteRef === r.ref),
  );
  const asOf = balanceAsOf(account, t, f);
  const also = useAlsoAffects(account);
  const query = useMemo(() => bookingQuery(account.id, search), [account.id, search]);
  const filter = searchToFilter(search);
  const show = (next: AccountSearch) => navigate({ search: next, replace: true, resetScroll: false });
  const patch = (values: Record<string, unknown>) => show(parseSearch({ ...search, ...values }));
  const [chartWindow, setChartWindow] = useState<{ accountId: number; shown: DateWindow } | null>(null);
  const chartId = useId();

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/konten" className="back-link">
            <Icon name="chevron-left" size={16} /> {t("accounts.detail.back")}
          </Link>
        }
        title={account.name}
        actions={
          <>
            {data.bookings.quick.unread > 0 && <MarkAccountRead accountId={account.id} onNotice={setNotice} />}
            <AccountMenu account={account} context={data.context} onNotice={setNotice} />
          </>
        }
      />
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card account-hero" aria-labelledby="account-balance">
        <div className="account-hero-main">
          <AccountBadge account={account} large />
          <div className="kpi">
            <h2 id="account-balance" className="kpi-label">
              {t("accounts.detail.balance")}
            </h2>
            <p className="kpi-value">
              <Balance cents={account.balanceCents} unit />
            </p>
            {asOf && <p className="muted small">{asOf}</p>}
          </div>
        </div>
        <dl className="facts">
          <dt>{t("common.fields.bank")}</dt>
          <dd>
            <span className="row">
              {account.bankName}
              <span className="muted">· {t(`labels.accountKind.${account.kind}`)}</span>
              <SharingBadge sharing={account.sharing} />
              {account.connection?.skipSyncAll && <Tag>{t("banking.manualOnly")}</Tag>}
            </span>
          </dd>
          {account.iban && (
            <>
              <dt>{t("accounts.detail.iban")}</dt>
              <dd>
                <span className="row">
                  <span className="mono">{formatIban(account.iban)}</span>
                  <CopyButton text={account.iban} label={t("accounts.detail.copyIban")} className="btn btn-sm" />
                </span>
              </dd>
            </>
          )}
          <dt>{t("common.fields.status")}</dt>
          <dd>
            {!account.connection ? (
              <span className="muted">{t("accounts.detail.manual")}</span>
            ) : account.connection.attention ? (
              <AccountStatus connection={account.connection} />
            ) : (
              <Status
                tone="ok"
                detail={account.connection.lastSyncAt && t("accounts.syncedAt", { date: f.dateTime(account.connection.lastSyncAt) })}
              >
                {t("common.fields.active")}
              </Status>
            )}
            {also && <p className="muted small">{also}</p>}
            {covered.map((r) => (
              <p key={r.ref} className="muted small">
                {coveredText(t, r)}
              </p>
            ))}
          </dd>
        </dl>
      </section>
      {holdings.length > 0 && <Positions holdings={holdings} />}
      <section className="card" aria-labelledby="account-history">
        <div className="card-head">
          <h2 id="account-history">{t("accounts.detail.history")}</h2>
          {timeline && <FoldToggle fold="konto-verlauf" controls={chartId} name={t("accounts.detail.history")} />}
        </div>
        {timeline ? (
          <BalanceTimeline
            key={account.id}
            title={t("accounts.detail.history")}
            timeline={timeline}
            transfers="included"
            fold="konto-verlauf"
            bodyId={chartId}
            onWindowChange={(shown) => setChartWindow({ accountId: account.id, shown })}
          />
        ) : (
          <p className="empty">{t("accounts.detail.noHistory")}</p>
        )}
      </section>
      <section className="card card-flush account-bookings bookings-card" aria-labelledby="account-bookings">
        <div className="card-head">
          <h2 id="account-bookings">{t("accounts.detail.bookings")}</h2>
          <div className="actions">
            <span className="muted small">{t("transactions.count", { count: data.bookings.total })}</span>
            <Link to="/buchungen" search={{ konto: account.id }} className="btn btn-sm">
              <Icon name="list" size={16} /> {t("accounts.detail.openInTransactions")}
            </Link>
          </div>
        </div>
        <FilterBar
          className="bookings-toolbar"
          label={t("accounts.detail.filterLabel")}
          defs={[
            categoryFilter(t, data.categories),
            tagFilter(t, data.tags),
            directionFilter(t),
            amountFilter(t),
            periodFilter(t, PERIODS),
            { kind: "flag", key: "ohneUmbuchungen", label: t("transactions.filter.hideTransfers") },
          ]}
          values={search}
          search={{ key: "q", label: t("transactions.filter.search"), placeholder: t("transactions.filter.searchPlaceholder") }}
          resultCount={data.bookings.total}
          leading={
            <QuickFilters
              active={quickFilterOf(filter)}
              counts={data.bookings.quick}
              onChange={(quick) =>
                patch({
                  neu: quick === "unread" || undefined,
                  ohneKategorie: quick === "uncategorized" || undefined,
                  kiVorschlag: quick === "aiSuggested" || undefined,
                })
              }
            />
          }
          trailing={
            <SavedFilters
              scope="account"
              saved={data.saved}
              current={filter}
              onApply={(chosen) => show({ ...parseSearch({ ...filterToSearch(chosen) }), sortierung: search.sortierung })}
            />
          }
          onApply={patch}
        />
        <PendingHiddenNote count={data.pending.hidden} />
        <AccountBookings
          key={JSON.stringify(query)}
          first={data.bookings}
          pending={data.pending.items}
          query={query}
          shown={chartWindow?.accountId === account.id ? chartWindow.shown : null}
          accountName={account.name}
          categories={data.categories}
          tags={data.tags}
          admin={managesHousehold(user)}
          onSort={(sort) => show({ ...search, sortierung: sort === "datum" ? undefined : sort })}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
        <TotalsBar totals={data.bookings.totals} />
      </section>
    </>
  );
}

/** A depot's positions as of its last sync, largest first. */
function Positions({ holdings }: { holdings: Holding[] }) {
  const { t, f } = useI18n();
  const total = holdings.reduce((sum, h) => sum + h.valueCents, 0);
  const asOf =
    holdings
      .map((h) => h.asOf)
      .sort()
      .at(-1) ?? "";
  const price = (h: Holding) =>
    h.price === null
      ? "–"
      : h.currency === "%"
        ? t("accounts.positions.percentOfNominal", { value: f.decimal(h.price * 100, 3) })
        : f.euro(Math.round(h.price * 100), h.currency);
  return (
    <section className="card card-flush" aria-labelledby="account-positions">
      <div className="card-head">
        <h2 id="account-positions">{t("accounts.positions.title")}</h2>
        <span className="muted small">{t("accounts.positions.asOf", { date: f.date(asOf) })}</span>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
      <section className="table-wrap" tabIndex={0} aria-labelledby="account-positions-caption">
        <table className="data-table positions-table">
          <caption id="account-positions-caption" className="visually-hidden">
            {t("accounts.positions.caption", { count: holdings.length })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("accounts.positions.name")}</th>
              <th scope="col">{t("accounts.positions.isin")}</th>
              <th scope="col" className="num">
                {t("accounts.positions.quantity")}
              </th>
              <th scope="col" className="num">
                {t("accounts.positions.price")}
              </th>
              <th scope="col" className="num">
                {t("accounts.positions.value")}
              </th>
              <th scope="col" className="num">
                {t("accounts.positions.share")}
              </th>
              <th scope="col" className="num">
                {t("accounts.positions.gain")}
              </th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const gain = h.costBasisCents === null ? null : h.valueCents - h.costBasisCents;
              return (
                <tr key={`${h.isin ?? ""}:${h.name}`}>
                  <th scope="row">{h.name}</th>
                  <td className="mono">{h.isin ?? "–"}</td>
                  <td className="num">{f.decimal(h.quantity, 6)}</td>
                  <td className="num">
                    <Money>{price(h)}</Money>
                  </td>
                  <td className="num">
                    <Money>{f.euro(h.valueCents)}</Money>
                  </td>
                  <td className="num">{total > 0 ? f.percent(h.valueCents / total) : "–"}</td>
                  <td className="num">
                    {gain === null || h.costBasisCents === null ? (
                      <span className="muted">
                        <span aria-hidden="true">–</span>
                        <span className="visually-hidden">{t("accounts.positions.noCostBasis")}</span>
                      </span>
                    ) : (
                      <span className={`delta ${amountTone(gain)}`}>
                        <Money>{f.signed(gain)}</Money>
                        {h.costBasisCents > 0 && ` (${f.percent(gain / h.costBasisCents)})`}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                {t("accounts.positions.total")}
              </th>
              <td className="num">
                <Money>{f.euro(total)}</Money>
              </td>
              <td className="num">{f.percent(total > 0 ? 1 : 0)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </section>
    </section>
  );
}

type BookingPage = { items: TransactionItem[]; total: number; nextOffset: number | null };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The account's bookings, newest first, in a contiguous run that grows as its own scroll area reaches the end. Sorted
 * by date, the list follows the balance chart: the bookings of each settled window are tinted and scrolled to the top of
 * the list, unless focus is in the list or a booking is open. A window just past the loaded rows is appended; one further
 * away replaces them. "Load newer" above such a run stays a button: loading on reaching the top would shift the rows the
 * chart just scrolled into place.
 */
function AccountBookings({
  first,
  pending,
  query,
  shown,
  accountName,
  categories,
  tags,
  admin,
  onSort,
  onSaved,
}: {
  first: BookingPage;
  pending: PendingBooking[];
  query: ReturnType<typeof bookingQuery>;
  shown: DateWindow | null;
  accountName: string;
  categories: { id: number; name: string; color: string; kind: string }[];
  tags: { id: number; name: string; color: string }[];
  admin: boolean;
  onSort: (sort: BookingSort) => void;
  onSaved: (text: string) => void;
}) {
  const { t } = useI18n();
  const fetchPage = useServerFn(getAccountBookingsFn);
  const { aiReady } = appRoute.useLoaderData();
  const list = useRef<HTMLDivElement>(null);
  const bookings = useBookingRun(first, (range) => fetchPage({ data: { ...query, ...range } }), MAX_PAGE, list);
  const { run: page, loaded, claim, isLatest, setRun, setError } = bookings;
  const [open, setOpen] = useState<TransactionItem | null>(null);
  /** Asks to scroll the window's first row to the top; `start` is where the run begins then. */
  const [scrollRequest, setScrollRequest] = useState<{ start: number } | null>(null);
  const drawerOpen = useRef(false);
  drawerOpen.current = open !== null;
  const handled = useRef(shown);
  const sort = BOOKING_SORTS.find((s) => serverSort(s) === query.sort) ?? "datum";
  const follows = sort === "datum";

  useEffect(() => {
    if (handled.current === shown) return;
    handled.current = shown;
    const busyHere = () => drawerOpen.current || list.current?.contains(document.activeElement) === true;
    if (!shown || !follows || busyHere()) return;
    const run = loaded.current;
    const target = windowTarget(
      run.items.map((item) => item.bookingDate),
      run.start,
      run.nextOffset === null,
      shown,
    );
    if (target === "none") return;
    // The newest booking is loaded, and with a chunk of bookings after it the list can scroll it to the top.
    if (target !== "fetch" && (run.nextOffset === null || run.items.length - target >= CHUNK_SIZE)) {
      setScrollRequest({ start: run.start });
      return;
    }
    const ticket = claim();
    const stale = () => !isLatest(ticket) || busyHere();
    (async () => {
      const dateTo = query.dateTo !== null && query.dateTo < shown.to ? query.dateTo : shown.to;
      const found = await fetchPage({ data: { ...query, dateTo, limit: CHUNK_SIZE } });
      const head = found.items[0];
      if (stale() || !head || head.bookingDate < shown.from) return;
      const base = loaded.current;
      const offset = Math.max(0, base.total - found.total);
      const gap = gapBefore({ start: base.start, length: base.items.length }, offset, MAX_PAGE);
      let filler: TransactionItem[] | null = null;
      if (gap) filler = gap.limit > 0 ? (await fetchPage({ data: { ...query, ...gap } })).items : [];
      if (stale()) return;
      const nextOffset = found.nextOffset === null ? null : offset + found.nextOffset;
      const placed = placeRows(base, found.items, offset, nextOffset, filler);
      setRun({ ...placed, total: base.total });
      setScrollRequest({ start: placed.start });
    })().catch((e) => {
      if (isLatest(ticket)) setError(errorMessage(e, t));
    });
  }, [shown, follows, query, fetchPage, t, loaded, claim, isLatest, setRun, setError]);

  useEffect(() => {
    if (!scrollRequest) return;
    const wrap = list.current?.querySelector<HTMLElement>(".table-wrap");
    const row = wrap?.querySelector<HTMLElement>("tr[data-in-window]");
    if (!wrap || !row) return;
    const newest = scrollRequest.start === 0 && row.previousElementSibling === null;
    const top = newest ? 0 : row.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
    wrap.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [scrollRequest]);

  if (page.items.length === 0 && pending.length === 0) return <p className="empty">{t("accounts.detail.empty")}</p>;

  return (
    <div ref={list}>
      {page.start > 0 && (
        <div className="pager">
          <button type="button" className="btn btn-sm" onClick={bookings.loadNewer} disabled={bookings.busy} aria-busy={bookings.busy}>
            {t("accounts.detail.loadNewer")}
          </button>
        </div>
      )}
      <BookingTable
        label={t("accounts.detail.tableLabel", { name: accountName })}
        items={page.items}
        pending={page.start === 0 ? pending : []}
        categories={categories}
        tags={tags}
        sort={sort}
        onSort={onSort}
        onOpen={setOpen}
        marked={follows ? shown : null}
        footer={
          page.items.length > 0 && (
            <ListEnd
              shown={page.items.length}
              total={page.total}
              more={page.nextOffset !== null}
              busy={bookings.busy}
              auto={bookings.autoLoad}
              contained
              added={bookings.added}
              onMore={bookings.loadOlder}
            />
          )
        }
      />
      {bookings.error && <Banner tone="danger">{bookings.error}</Banner>}
      {open && (
        <TransactionDrawer
          txn={open}
          accountName={accountName}
          categories={categories}
          tags={tags}
          admin={admin}
          aiReady={aiReady}
          onClose={() => setOpen(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

/** Marks every new booking of this account read; the "Neu" marks and the badges update with the page data. */
function MarkAccountRead({ accountId, onNotice }: { accountId: number; onNotice: (notice: Notice | null) => void }) {
  const t = useT();
  const mark = useAction(markAllReadFn);
  return (
    <button
      type="button"
      className="btn"
      disabled={mark.busy}
      aria-busy={mark.busy}
      onClick={async () => {
        const result = await mark.run({ data: { accountId } });
        onNotice(result.ok ? { tone: "ok", text: t("transactions.allMarkedRead") } : { tone: "danger", text: result.error });
      }}
    >
      <Icon name="check" size={18} /> {t("transactions.markAllRead")}
    </button>
  );
}
