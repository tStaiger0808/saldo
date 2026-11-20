import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Amount, Money, TableWrap } from "../../components/Bits.tsx";
import { MonthChart, RankedBars } from "../../components/Charts.tsx";
import { CategoryMatrix, categoryItems, monthSeries, RecurringTable } from "../../components/DashboardCards.tsx";
import { groupChoice, knownGroup } from "../../components/GroupSelect.tsx";
import { PageHead } from "../../components/PageHead.tsx";
import { useFormat, useI18n } from "../../i18n/react.tsx";
import { compareTotals } from "../../lib/cards.ts";
import type { Formatter } from "../../lib/format.ts";
import { isPeriod, PERIODS, type Period, previousRange, resolvePeriod } from "../../lib/periods.ts";
import { getCategories } from "../../server/functions/catalog.ts";
import { getCategoryTotals, getMonthly, getRecurring, getSeries, getSummary } from "../../server/functions/stats.ts";

type AnalysisSearch = { zeitraum?: Period; gruppe?: number };

export const Route = createFileRoute("/_app/analyse")({
  validateSearch: (search: Record<string, unknown>): AnalysisSearch => {
    const result: AnalysisSearch = {};
    if (isPeriod(search.zeitraum)) result.zeitraum = search.zeitraum;
    const group = Number(search.gruppe);
    if (Number.isInteger(group) && group > 0) result.gruppe = group;
    return result;
  },
  loaderDeps: ({ search }) => ({ zeitraum: search.zeitraum ?? "last_6_months", gruppe: search.gruppe }),
  loader: async ({ context, deps }) => {
    const groupId = knownGroup(context.groups, deps.gruppe);
    const range = resolvePeriod(deps.zeitraum);
    const previous = previousRange(range);
    const r = (dates: { dateFrom: string; dateTo: string }) => ({ groupId, ...dates, accountIds: [] });
    const year = resolvePeriod("last_12_months");
    const [summary, before, monthly, current, prior, matrix, recurring, categories] = await Promise.all([
      getSummary({ data: r(range) }),
      getSummary({ data: r(previous) }),
      getMonthly({ data: r(range) }),
      getCategoryTotals({ data: { range: r(range), kind: "expense" } }),
      getCategoryTotals({ data: { range: r(previous), kind: "expense" } }),
      getSeries({ data: { range: r(range), groupBy: "category", ids: [] } }),
      getRecurring({ data: r(year) }),
      getCategories(),
    ]);
    return {
      period: deps.zeitraum,
      groupId,
      range,
      previous,
      summary,
      before,
      monthly,
      current,
      prior,
      matrix,
      recurring,
      categories,
    };
  },
  component: AnalysisPage,
});

function change(f: Formatter, current: number, previous: number): string {
  if (previous === 0) return "–";
  return `${current >= previous ? "+" : "−"}${f.percent(Math.abs(current - previous) / Math.abs(previous))}`;
}

/** Income, expenses and the balance as flows in their colour; what was saved moved between accounts and stays neutral. */
function KpiAmount({ kpi, cents }: { kpi: "income" | "expenses" | "saved" | "balance"; cents: number }) {
  const f = useFormat();
  if (kpi === "saved") return <Money>{f.euro(cents)}</Money>;
  return <Amount cents={kpi === "expenses" ? -cents : cents} />;
}

function AnalysisPage() {
  const data = Route.useLoaderData();
  const { groups } = Route.useRouteContext();
  const { groupId } = data;
  const navigate = useNavigate({ from: "/analyse" });
  const { t, f } = useI18n();
  const viewName = (groupId !== null && groups.find((g) => g.id === groupId)?.name) || t("common.allAccounts");
  const lookup = { categories: new Map(data.categories.map((c) => [c.id, c])), accounts: new Map() };
  const rows = compareTotals(data.current, data.prior, 50);
  const { months, series } = monthSeries(data.monthly, t);
  const kpis = [
    ["income", data.summary.incomeCents, data.before.incomeCents],
    ["expenses", data.summary.expensesCents, data.before.expensesCents],
    ["saved", data.summary.savingsCents, data.before.savingsCents],
    ["balance", data.summary.balanceCents, data.before.balanceCents],
  ] as const;

  return (
    <>
      <PageHead
        eyebrow={viewName}
        title={t("shell.analysis")}
        choices={[
          groupChoice(t, groups, groupId, (gruppe) => navigate({ search: (prev) => ({ ...prev, gruppe }), replace: true })),
          {
            label: t("common.fields.period"),
            display: "select",
            value: data.period,
            options: PERIODS.map((value) => ({ value, label: t(`periods.${value}`) })),
            onChange: (value) => navigate({ search: (prev) => ({ ...prev, zeitraum: value as Period }), replace: true }),
            summary: t(`periods.${data.period}`),
          },
        ]}
      />
      <section className="card" aria-labelledby="cmp-title">
        <div className="card-head">
          <h2 id="cmp-title">{t("analysis.comparison.title")}</h2>
          <span className="muted small">
            {t("analysis.comparison.range", {
              from: f.date(data.range.dateFrom),
              to: f.date(data.range.dateTo),
              prevFrom: f.date(data.previous.dateFrom),
              prevTo: f.date(data.previous.dateTo),
            })}
          </span>
        </div>
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("analysis.comparison.metric")}</th>
                <th scope="col" className="num">
                  {t("analysis.comparison.now")}
                </th>
                <th scope="col" className="num">
                  {t("analysis.comparison.before")}
                </th>
                <th scope="col" className="num">
                  {t("analysis.comparison.change")}
                </th>
              </tr>
            </thead>
            <tbody>
              {kpis.map(([kpi, now, before]) => (
                <tr key={kpi}>
                  <th scope="row" style={{ fontWeight: 500, color: "var(--ink)" }}>
                    {t(`common.fields.${kpi}`)}
                  </th>
                  <td className="num">
                    <KpiAmount kpi={kpi} cents={now} />
                  </td>
                  <td className="num">
                    <KpiAmount kpi={kpi} cents={before} />
                  </td>
                  <td className="num">{change(f, now, before)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>
      <section className="card" aria-labelledby="month-title">
        <h2 id="month-title">{t("analysis.monthly")}</h2>
        <MonthChart title={t("analysis.monthly")} months={months} series={series} />
      </section>
      <div className="grid-2">
        <section className="card" aria-labelledby="cat-title">
          <h2 id="cat-title">{t("analysis.byCategory")}</h2>
          <RankedBars items={categoryItems(data.current, data.range)} />
        </section>
        <section className="card" aria-labelledby="delta-title">
          <h2 id="delta-title">{t("analysis.biggestChanges")}</h2>
          {rows.length === 0 ? (
            <p className="empty">{t("analysis.noChange")}</p>
          ) : (
            <TableWrap>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t("common.fields.category")}</th>
                    <th scope="col" className="num">
                      {t("analysis.comparison.now")}
                    </th>
                    <th scope="col" className="num">
                      {t("analysis.comparison.before")}
                    </th>
                    <th scope="col" className="num">
                      {t("analysis.comparison.difference")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 12).map((row) => (
                    <tr key={row.key}>
                      <td>
                        {row.categoryId ? (
                          <Link
                            to="/buchungen"
                            search={{
                              kategorie: row.categoryId,
                              von: data.range.dateFrom,
                              bis: data.range.dateTo,
                              ...(groupId ? { gruppe: groupId } : {}),
                            }}
                          >
                            {row.name}
                          </Link>
                        ) : (
                          row.name
                        )}
                      </td>
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
          )}
        </section>
      </div>
      <section className="card" aria-labelledby="matrix-title">
        <h2 id="matrix-title">{t("analysis.matrix")}</h2>
        <CategoryMatrix data={data.matrix} lookup={lookup} range={data.range} />
      </section>
      <section className="card" aria-labelledby="rec-title">
        <div className="card-head">
          <h2 id="rec-title">{t("analysis.recurring.title")}</h2>
          <span className="muted small">{t("analysis.recurring.hint")}</span>
        </div>
        <RecurringTable rows={data.recurring} />
      </section>
    </>
  );
}
