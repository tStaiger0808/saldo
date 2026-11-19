import type { MonthRow } from "@saldo/core";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useI18n, useT } from "../i18n/react.tsx";
import { errorMessage } from "../lib/action.ts";
import { type Card, type CardData, cardKey, cardLimit, compareTotals, loadCardData } from "../lib/cards.ts";
import { seriesColor } from "../lib/chart.ts";
import type { DashboardRange, DateRange } from "../lib/periods.ts";
import { UsageView } from "./AiUsage.tsx";
import { Amount, Balance, Money, NewMark, TableWrap, TransferBadge } from "./Bits.tsx";
import { MonthChart, RankedBars, Sparkline } from "./Charts.tsx";
import { ChatBody } from "./ChatPanel.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

export type Lookup = {
  categories: Map<number, { name: string; color: string; kind: string }>;
  accounts: Map<number, { name: string }>;
};

type Loaded = { key: string; data: CardData } | { key: string; error: string };

/** Card data from the page loader, or loaded in the browser for a card edited in the draft. */
function useCardData(card: Card, groupId: number | null, range: DashboardRange, initial: Loaded | undefined) {
  const key = cardKey(card, groupId, range);
  const t = useT();
  const [state, setState] = useState<Loaded | undefined>(initial?.key === key ? initial : undefined);
  useEffect(() => {
    if (initial?.key === key) {
      setState(initial);
      return;
    }
    let live = true;
    setState(undefined);
    loadCardData(card, groupId, range).then(
      (data) => live && setState({ key, data }),
      (error) => live && setState({ key, error: errorMessage(error, t) }),
    );
    return () => {
      live = false;
    };
  }, [key, initial, card, groupId, range, t]);
  return state?.key === key ? state : undefined;
}

export function CardContent({
  card,
  groupId,
  range,
  initial,
  lookup,
}: {
  card: Card;
  groupId: number | null;
  range: DashboardRange;
  initial: Loaded | undefined;
  lookup: Lookup;
}) {
  const state = useCardData(card, groupId, range, initial);
  const t = useT();
  if (!state) return <p className="loading">{t("common.loading")}</p>;
  if ("error" in state) return <Banner tone="danger">{state.error}</Banner>;
  return <CardBody card={card} data={state.data} lookup={lookup} groupId={groupId} />;
}

function rangeSearch(range: DateRange) {
  return { von: range.dateFrom, bis: range.dateTo };
}

function Delta({ current, previous, betterWhen }: { current: number; previous: number; betterWhen: "up" | "down" }) {
  const { t, f } = useI18n();
  if (previous === 0) return <span className="muted small">{t("dashboard.body.noPrevious")}</span>;
  const change = (current - previous) / Math.abs(previous);
  if (Math.abs(change) < 0.005) return <span className="delta">{t("dashboard.body.same")}</span>;
  const up = change > 0;
  const good = up === (betterWhen === "up");
  return (
    <span className={`delta ${good ? "delta-good" : "delta-bad"}`}>
      <Icon name={up ? "up" : "down"} size={14} />
      {t(up ? "dashboard.body.more" : "dashboard.body.less", { percent: f.percent(Math.abs(change)) })}
      <span className="visually-hidden">{t("dashboard.body.thanBefore")}</span>
    </span>
  );
}

/** Sits at the bottom of the tile, so the sparklines of a row share one baseline. */
function Trend({ values }: { values: number[] }) {
  return (
    <dd className="kpi-trend" aria-hidden="true">
      <Sparkline values={values} />
    </dd>
  );
}

/** A thin bar under a key figure; its share is always written beside it (savings rate, change against before). */
function Meter({ share }: { share: number | null }) {
  if (share === null) return null;
  return (
    <dd className="kpi-bar" aria-hidden="true">
      <span style={{ inlineSize: `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%` }} />
    </dd>
  );
}

const shareOf = (current: number, previous: number) => (previous > 0 ? current / previous : null);

function SummaryBody({ data }: { data: Extract<CardData, { type: "summary" }> }) {
  const { t, f } = useI18n();
  const { current, previous, trend, range } = data;
  const spark = (pick: (row: MonthRow) => number) => trend.map(pick);
  const rate = current.incomeCents > 0 ? current.balanceCents / current.incomeCents : null;
  return (
    <>
      <div className="kpi-board">
        <dl className="kpi-tiles">
          <div className="kpi-tile">
            <dt>{t("common.fields.balance")}</dt>
            <dd className="kpi-value">
              <Amount cents={current.balanceCents} unit />
            </dd>
            <Meter share={rate} />
            <dd className="kpi-meta">
              {rate === null ? t("dashboard.body.balanceHint") : t("dashboard.body.savingsRate", { rate: f.percent(rate) })}
            </dd>
            <Trend values={spark((m) => m.incomeCents - m.expensesCents - m.savingsCents)} />
          </div>
          <div className="kpi-tile">
            <dt>{t("common.fields.income")}</dt>
            <dd className="kpi-value">
              <Amount cents={current.incomeCents} unit />
            </dd>
            <Meter share={shareOf(current.incomeCents, previous.incomeCents)} />
            <dd className="kpi-meta">
              <Delta current={current.incomeCents} previous={previous.incomeCents} betterWhen="up" />
            </dd>
            <Trend values={spark((m) => m.incomeCents)} />
          </div>
          <div className="kpi-tile">
            <dt>{t("common.fields.expenses")}</dt>
            <dd className="kpi-value">
              <Amount cents={-current.expensesCents} unit />
            </dd>
            <Meter share={shareOf(current.expensesCents, previous.expensesCents)} />
            <dd className="kpi-meta">
              <Delta current={current.expensesCents} previous={previous.expensesCents} betterWhen="down" />
            </dd>
            <Trend values={spark((m) => m.expensesCents)} />
          </div>
          <div className="kpi-tile">
            <dt>{t("common.fields.saved")}</dt>
            <dd className="kpi-value">
              <Money unit>{f.euro(current.savingsCents)}</Money>
            </dd>
            <Meter share={shareOf(current.savingsCents, previous.savingsCents)} />
            <dd className="kpi-meta">
              <Delta current={current.savingsCents} previous={previous.savingsCents} betterWhen="up" />
            </dd>
            <Trend values={spark((m) => m.savingsCents)} />
          </div>
        </dl>
      </div>
      <p className="card-foot">
        <span>{t("dashboard.body.transactionCount", { count: current.transactionCount })}</span>
        {current.uncategorizedCount > 0 ? (
          <Link to="/buchungen" search={{ ohneKategorie: true, ...rangeSearch(range) }}>
            {t("dashboard.body.uncategorizedCount", { count: current.uncategorizedCount })}
          </Link>
        ) : (
          <span>{t("dashboard.body.allCategorized")}</span>
        )}
        <span>{t("dashboard.body.summaryFoot")}</span>
      </p>
    </>
  );
}

/** Names the forecast above its numbers, so they are never taken for bookings. */
function ForecastLabel() {
  const t = useT();
  return (
    <p className="forecast-label">
      <Icon name="clock" size={16} /> {t("dashboard.body.forecast")}
    </p>
  );
}

function ForecastFoot({ range }: { range: DateRange }) {
  const { t, f } = useI18n();
  return <p className="card-foot">{t("dashboard.body.forecastFoot", { from: f.date(range.dateFrom), to: f.date(range.dateTo) })}</p>;
}

function ForecastSummaryBody({ data }: { data: Extract<CardData, { type: "forecast_summary" }> }) {
  const { t, f } = useI18n();
  const { totals } = data;
  const tiles = [
    {
      key: "buffer",
      label: t("dashboard.body.buffer"),
      value: <Amount cents={totals.bufferCents} unit />,
      meta: t("dashboard.body.bufferHint"),
    },
    { key: "income", label: t("common.fields.income"), value: <Amount cents={totals.incomeCents} unit /> },
    { key: "expenses", label: t("common.fields.expenses"), value: <Amount cents={-totals.expensesCents} unit /> },
    { key: "saved", label: t("common.fields.saved"), value: <Money unit>{f.euro(totals.savingsCents)}</Money> },
  ];
  return (
    <>
      <ForecastLabel />
      {data.count === 0 && <p className="muted">{t("dashboard.body.noForecast")}</p>}
      <div className="kpi-board">
        <dl className="kpi-tiles">
          {tiles.map((tile) => (
            <div key={tile.key} className="kpi-tile">
              <dt>{tile.label}</dt>
              <dd className="kpi-value">{tile.value}</dd>
              {tile.meta && <dd className="kpi-meta">{tile.meta}</dd>}
            </div>
          ))}
        </dl>
      </div>
      <ForecastFoot range={data.range} />
    </>
  );
}

function RecentBody({ card, data, lookup }: { card: Card; data: Extract<CardData, { type: "recent_transactions" }>; lookup: Lookup }) {
  const { t, f } = useI18n();
  if (data.items.length === 0) return <p className="empty">{t("dashboard.body.noTransactionsYet")}</p>;
  return (
    <>
      <ul className="list">
        {data.items.slice(0, cardLimit(card)).map((txn) => {
          const category = txn.categoryId ? lookup.categories.get(txn.categoryId) : undefined;
          return (
            <li key={txn.id} className="list-accent" data-unread={txn.isUnread || undefined}>
              <span className="list-main">
                <span className="list-title">
                  {txn.counterparty || txn.purpose || t("dashboard.body.noCounterparty")}
                  {txn.isUnread && <NewMark />}
                </span>
                <span className="list-sub">
                  {f.date(txn.bookingDate)} · {category?.name ?? (txn.transferKind ? "" : t("dashboard.body.uncategorized"))}
                  {txn.transferKind && <TransferBadge kind={txn.transferKind} label={txn.transferLabel} />}
                </span>
              </span>
              <span className="num">
                <Amount cents={txn.amountCents} currency={txn.currency} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="card-foot">
        <Link to="/buchungen">{t("dashboard.body.allTransactions")}</Link>
        {data.unread > 0 && (
          <Link to="/buchungen" search={{ neu: true }}>
            {t("dashboard.body.newCount", { count: data.unread })}
          </Link>
        )}
      </p>
    </>
  );
}

function ComparisonBody({ card, data }: { card: Card; data: Extract<CardData, { type: "period_comparison" }> }) {
  const { t, f } = useI18n();
  const rows = compareTotals(data.current, data.before, cardLimit(card));
  if (rows.length === 0) return <p className="empty">{t("dashboard.body.noChange")}</p>;
  return (
    <TableWrap>
      <table className="data-table">
        <caption className="visually-hidden">
          {t("dashboard.body.comparisonCaption", {
            from: f.date(data.range.dateFrom),
            to: f.date(data.range.dateTo),
            previousFrom: f.date(data.previous.dateFrom),
            previousTo: f.date(data.previous.dateTo),
          })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("common.fields.category")}</th>
            <th scope="col" className="num">
              {t("dashboard.body.now")}
            </th>
            <th scope="col" className="num">
              {t("dashboard.body.before")}
            </th>
            <th scope="col" className="num">
              {t("dashboard.body.change")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td className="num">
                <Money>{f.euro(row.current)}</Money>
              </td>
              <td className="num">
                <Money>{f.euro(row.previous)}</Money>
              </td>
              <td className={`num ${row.delta > 0 ? "delta-bad" : "delta-good"}`}>
                <Money>{f.signed(row.delta)}</Money>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function RecurringTable({ rows, limit }: { rows: Extract<CardData, { type: "recurring_payments" }>["rows"]; limit?: number }) {
  const { t, f } = useI18n();
  if (rows.length === 0) return <p className="empty">{t("dashboard.body.noRecurring")}</p>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <TableWrap>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("common.fields.counterparty")}</th>
            <th scope="col" className="num">
              {t("dashboard.body.typical")}
            </th>
            <th scope="col" className="num">
              {t("dashboard.body.months")}
            </th>
            <th scope="col" className="num">
              {t("dashboard.body.last")}
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.counterparty}>
              <td>
                <span className="cell-main">
                  <Link to="/buchungen" search={{ q: row.counterparty }} className="cell-title">
                    {row.counterparty}
                  </Link>
                  {row.category && <span className="cell-sub">{row.category}</span>}
                </span>
              </td>
              <td className="num">
                <Money>{f.euro(row.typicalAmountCents)}</Money>
              </td>
              <td className="num">{f.integer(row.months)}</td>
              <td className="num">{f.date(row.lastDate)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("dashboard.body.perMonth")}</td>
            <td className="num">
              <Money>{f.euro(rows.reduce((a, b) => a + b.typicalAmountCents, 0))}</Money>
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </TableWrap>
  );
}

export function CategoryMatrix({
  data,
  lookup,
  range,
}: {
  data: Extract<CardData, { type: "category_matrix" }>["data"];
  lookup: Lookup;
  range: DateRange;
}) {
  const { t, f } = useI18n();
  const rows = data.series.filter((s) => lookup.categories.get(s.id)?.kind === "expense" && s.values.some((v) => v !== 0));
  if (rows.length === 0) return <p className="empty">{t("dashboard.body.noExpenses")}</p>;
  const max = Math.max(...rows.flatMap((r) => r.values), 1);
  const totals = data.months.map((_, i) => rows.reduce((sum, r) => sum + (r.values[i] ?? 0), 0));
  return (
    <TableWrap>
      <table className="data-table">
        <caption className="visually-hidden">{t("dashboard.body.matrixCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("common.fields.category")}</th>
            {data.months.map((m) => (
              <th key={m} scope="col" className="num">
                {f.monthShort(m)}
              </th>
            ))}
            <th scope="col" className="num">
              {t("common.fields.total")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" style={{ fontWeight: 400, color: "var(--ink)" }}>
                <Link to="/buchungen" search={{ kategorie: row.id, von: range.dateFrom, bis: range.dateTo }}>
                  {row.name}
                </Link>
              </th>
              {row.values.map((v, i) => (
                <td key={data.months[i]} className="num" style={{ padding: "8px 4px" }}>
                  <span
                    className="heat"
                    style={{ background: `color-mix(in srgb, var(--accent) ${Math.round((Math.max(0, v) / max) * 32)}%, transparent)` }}
                  >
                    {v === 0 ? "–" : <Money>{f.euro(v)}</Money>}
                  </span>
                </td>
              ))}
              <td className="num">
                <Money>{f.euro(row.values.reduce((a, b) => a + b, 0))}</Money>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("common.fields.total")}</td>
            {totals.map((total, i) => (
              <td key={data.months[i]} className="num">
                <Money>{f.euro(total)}</Money>
              </td>
            ))}
            <td className="num">
              <Money>{f.euro(totals.reduce((a, b) => a + b, 0))}</Money>
            </td>
          </tr>
        </tfoot>
      </table>
    </TableWrap>
  );
}

export function monthSeries(rows: MonthRow[], t: Translate) {
  return {
    months: rows.map((r) => r.month),
    series: [
      { key: "income", name: t("common.fields.income"), color: "var(--s1)", values: rows.map((r) => r.incomeCents) },
      { key: "expense", name: t("common.fields.expenses"), color: "var(--s2)", values: rows.map((r) => r.expensesCents) },
      { key: "savings", name: t("common.fields.saved"), color: "var(--s3)", values: rows.map((r) => r.savingsCents) },
    ],
  };
}

export function categoryItems(rows: Extract<CardData, { type: "category_breakdown" }>["rows"], range: DateRange) {
  return rows.map((row) => ({
    key: row.categoryId === null ? `n:${row.name}` : `c:${row.categoryId}`,
    name: row.name,
    color: row.color,
    cents: row.amountCents,
    count: row.count,
    search:
      row.categoryId !== null
        ? { kategorie: row.categoryId, ...rangeSearch(range) }
        : row.transferAccountId === null
          ? { ohneKategorie: true, ...rangeSearch(range) }
          : undefined,
  }));
}

function CardBody({ card, data, lookup, groupId }: { card: Card; data: CardData; lookup: Lookup; groupId: number | null }) {
  const { t, f } = useI18n();
  const range = (from: string, to: string) => t("dashboard.body.range", { from: f.date(from), to: f.date(to) });
  switch (data.type) {
    case "summary":
      return <SummaryBody data={data} />;
    case "forecast_summary":
      return <ForecastSummaryBody data={data} />;
    case "no_future":
      return <p className="empty">{t("dashboard.body.noFuture")}</p>;
    case "monthly_trend": {
      const { months, series } = monthSeries(data.rows, t);
      if (!data.forecast) return <MonthChart title={card.title} months={months} series={series} />;
      const due = data.rows.some((r) => r.incomeCents + r.expensesCents + r.savingsCents > 0);
      return (
        <>
          <ForecastLabel />
          {due ? (
            <MonthChart title={card.title} months={months} series={series} />
          ) : (
            <p className="empty">{t("dashboard.body.noForecast")}</p>
          )}
          <ForecastFoot range={data.range} />
        </>
      );
    }
    case "category_breakdown":
      if (data.forecast) {
        return (
          <>
            <ForecastLabel />
            {data.rows.length === 0 ? (
              <p className="empty">{t("dashboard.body.noForecast")}</p>
            ) : (
              <RankedBars
                items={categoryItems(data.rows, data.range).map((item) => ({ ...item, search: undefined }))}
                total={data.rows.reduce((a, b) => a + b.amountCents, 0)}
              />
            )}
            <ForecastFoot range={data.range} />
          </>
        );
      }
      return (
        <>
          <RankedBars items={categoryItems(data.rows, data.range).slice(0, 10)} total={data.rows.reduce((a, b) => a + b.amountCents, 0)} />
          <p className="card-foot">
            {t("dashboard.body.kindRange", {
              kind: t(`labels.categoryKind.${data.kind}`),
              from: f.date(data.range.dateFrom),
              to: f.date(data.range.dateTo),
            })}
          </p>
        </>
      );
    case "series": {
      if (data.data.series.length === 0) return <p className="empty">{t("dashboard.body.noSelection")}</p>;
      const series = data.data.series.map((s, i) => ({ key: String(s.id), name: s.name, color: seriesColor(i), values: s.values }));
      return <MonthChart title={card.title} months={data.data.months} series={series} mode="lines" />;
    }
    case "recent_transactions":
      return <RecentBody card={card} data={data} lookup={lookup} />;
    case "top_counterparties":
      return (
        <RankedBars
          items={data.rows.map((row) => ({
            key: row.counterparty,
            name: row.counterparty,
            cents: row.amountCents,
            search: { q: row.counterparty, ...rangeSearch(data.range) },
          }))}
        />
      );
    case "balances":
      if (data.data.accounts.length === 0) return <p className="empty">{t("dashboard.body.noAccounts")}</p>;
      return (
        <ul className="list">
          {data.data.accounts.map((a) => (
            <li key={a.accountId}>
              <span className="list-main">
                <span className="list-title">
                  <span className="swatch" style={{ background: a.color }} aria-hidden="true" />
                  <Link to="/buchungen" search={{ konto: a.accountId }}>
                    {a.name}
                  </Link>
                </span>
                <span className="list-sub">
                  {a.balanceDate ? t("dashboard.body.balanceAsOf", { date: f.date(a.balanceDate) }) : t("dashboard.body.noBalance")}
                </span>
              </span>
              <span className="num">
                <Balance cents={a.balanceCents} />
              </span>
            </li>
          ))}
          <li>
            <span className="list-title">{t("common.fields.total")}</span>
            <span className="num" style={{ fontWeight: 600 }}>
              <Balance cents={data.data.totalCents} />
            </span>
          </li>
        </ul>
      );
    case "period_comparison":
      return <ComparisonBody card={card} data={data} />;
    case "recurring_payments":
      return <RecurringTable rows={data.rows} limit={cardLimit(card)} />;
    case "category_matrix":
      return <CategoryMatrix data={data.data} lookup={lookup} range={data.range} />;
    case "ai_usage":
      return <UsageView usage={data.usage} />;
    case "ai_insight":
      return data.analysis ? (
        <>
          <div className="prose prose-scroll">{data.analysis.content}</div>
          <p className="card-foot">
            {range(data.analysis.periodFrom, data.analysis.periodTo)} · {data.analysis.model} ·{" "}
            <Link to="/analyse">{t("dashboard.body.newAnalysis")}</Link>
          </p>
        </>
      ) : (
        <p className="muted">
          {t("dashboard.body.noAnalysis")} <Link to="/analyse">{t("dashboard.body.toAnalysis")}</Link>
        </p>
      );
    case "ai_chat":
      return <ChatBody groupId={groupId} compact />;
  }
}
