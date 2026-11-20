import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { useFormat, useI18n, useT } from "../i18n/react.tsx";
import { useAmountsHidden } from "../lib/amounts.ts";
import type { TransactionSearch } from "../lib/booking-filter.ts";
import { barPath, linear, linePath, niceTicks, useChartWidth } from "../lib/chart.ts";
import { Money, TableWrap, useMaskAmounts } from "./Bits.tsx";
import { Icon } from "./Icon.tsx";

export type Series = { key: string; name: string; color: string; values: number[] };

/** Chart and its table view; every chart has one, the choice is per chart. */
function ChartFrame({ title, legend, table, children }: { title: string; legend?: ReactNode; table: ReactNode; children: ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const t = useT();
  return (
    <div className="stack-sm">
      <div className="chart-toolbar">
        {legend ?? <span />}
        <button
          type="button"
          className="btn btn-sm btn-icon btn-ghost chart-view-toggle"
          title={t(view === "chart" ? "dashboard.charts.showTable" : "dashboard.charts.showChart", { title })}
          onClick={() => setView(view === "chart" ? "table" : "chart")}
        >
          <Icon name={view === "chart" ? "table" : "chart"} size={18} />
          <span className="visually-hidden">
            {t(view === "chart" ? "dashboard.charts.showTable" : "dashboard.charts.showChart", { title })}
          </span>
        </button>
      </div>
      {view === "chart" ? children : table}
    </div>
  );
}

export function Legend({ items }: { items: { key: string; name: string; color: string }[] }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className="swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

function SeriesTable({ caption, months, series, total }: { caption: string; months: string[]; series: Series[]; total?: boolean }) {
  const { t, f } = useI18n();
  return (
    <TableWrap>
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t("common.fields.month")}</th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="num">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((month, i) => (
            <tr key={month}>
              <th scope="row" style={{ fontWeight: 400, color: "var(--ink)" }}>
                {f.monthLong(month)}
              </th>
              {series.map((s) => (
                <td key={s.key} className="num">
                  <Money>{f.euro(s.values[i] ?? 0)}</Money>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr>
              <th scope="row">{t("common.fields.total")}</th>
              {series.map((s) => (
                <td key={s.key} className="num">
                  <Money>{f.euro(s.values.reduce((a, b) => a + b, 0))}</Money>
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </TableWrap>
  );
}

const PAD = { top: 12, right: 8, bottom: 28, left: 52 };

/**
 * Values per month as grouped bars or lines. Each month is a slot: hover and keyboard focus show the tooltip with every
 * series of that month. The chart is one tab stop; the arrow keys, Home and End move between the months.
 */
export function MonthChart({
  title,
  months,
  series,
  mode = "bars",
  height = 240,
}: {
  title: string;
  months: string[];
  series: Series[];
  mode?: "bars" | "lines";
  height?: number;
}) {
  const { t, f } = useI18n();
  const hidden = useAmountsHidden();
  const mask = useMaskAmounts();
  const [ref, width] = useChartWidth();
  const [active, setActive] = useState<number | null>(null);
  const [current, setCurrent] = useState(Number.POSITIVE_INFINITY);
  const slots = useRef<(SVGGElement | null)[]>([]);
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const y = linear([ticks[0] ?? 0, ticks.at(-1) ?? 1], [height - PAD.bottom, PAD.top]);
  const plotW = width - PAD.left - PAD.right;
  const slot = plotW / Math.max(months.length, 1);
  const labelEvery = Math.ceil(months.length / Math.max(1, Math.floor(plotW / 48)));
  const groupW = Math.min(slot * 0.72, 18 * series.length + 4);
  const barW = Math.max(2, groupW / Math.max(series.length, 1) - 2);
  const empty = all.every((v) => v === 0);
  const activeMonth = active === null ? null : months[active];
  const tabStop = Math.min(current, months.length - 1);

  function moveFocus(event: KeyboardEvent<SVGGElement>, from: number) {
    const keys: Record<string, number> = {
      ArrowRight: from + 1,
      ArrowDown: from + 1,
      ArrowLeft: from - 1,
      ArrowUp: from - 1,
      Home: 0,
      End: months.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(months.length - 1, next));
    setCurrent(target);
    slots.current[target]?.focus();
  }

  const table = <SeriesTable caption={title} months={months} series={series} total={mode === "bars"} />;
  const legend = <Legend items={series} />;

  if (empty) return <p className="empty">{t("dashboard.charts.noTransactions")}</p>;

  return (
    <ChartFrame title={title} legend={legend} table={table}>
      <div className="chart" ref={ref}>
        {/* biome-ignore lint/a11y/useSemanticElements: WebKit exposes an unroled svg as one image and hides the focusable months in it */}
        <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("dashboard.charts.svgTitle", { title })}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className={tick === 0 ? "axis-line" : "grid-line"} x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="money" aria-hidden={hidden || undefined} x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {f.axis(tick)}
              </text>
            </g>
          ))}
          {months.map((month, i) => {
            const x0 = PAD.left + i * slot;
            const label = t("dashboard.charts.slotLabel", {
              month: f.monthLong(month),
              values: series
                .map((s) => t("dashboard.charts.slotValue", { name: s.name, amount: mask(f.euro(s.values[i] ?? 0)) }))
                .join(", "),
            });
            return (
              // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a focusable data point (role img with its values as name) shows the tooltip on keyboard focus
              <g
                key={month}
                ref={(node) => {
                  slots.current[i] = node;
                }}
                className="slot"
                tabIndex={i === tabStop ? 0 : -1}
                role="img"
                aria-label={label}
                data-active={active === i || undefined}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => {
                  setActive(i);
                  setCurrent(i);
                }}
                onKeyDown={(event) => moveFocus(event, i)}
                onBlur={() => setActive(null)}
              >
                <rect
                  className="slot-bg"
                  x={x0}
                  y={PAD.top}
                  width={slot}
                  height={height - PAD.top - PAD.bottom}
                  fill="transparent"
                  rx={4}
                />
                <rect
                  className="focus-ring"
                  x={x0 + 1}
                  y={PAD.top + 1}
                  width={slot - 2}
                  height={height - PAD.top - PAD.bottom - 2}
                  fill="none"
                  rx={4}
                />
                {mode === "bars" &&
                  series.map((s, j) => (
                    <path
                      key={s.key}
                      d={barPath(x0 + (slot - groupW) / 2 + j * (barW + 2), y(0), y(s.values[i] ?? 0), barW)}
                      fill={s.color}
                    />
                  ))}
                {i % labelEvery === 0 && (
                  <text x={x0 + slot / 2} y={height - 8} textAnchor="middle">
                    {f.monthShort(month)}
                  </text>
                )}
              </g>
            );
          })}
          {mode === "lines" &&
            series.map((s) => (
              <g key={s.key} className="series-line">
                <path
                  d={linePath(s.values.map((v, i) => [PAD.left + i * slot + slot / 2, y(v)]))}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                {s.values.map((v, i) => (
                  <circle key={months[i]} cx={PAD.left + i * slot + slot / 2} cy={y(v)} r={active === i ? 4 : 2.5} fill={s.color} />
                ))}
              </g>
            ))}
        </svg>
        {active !== null && activeMonth && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{ left: `${((PAD.left + active * slot + slot / 2) / width) * 100}%`, top: PAD.top }}
          >
            <strong>{f.monthLong(activeMonth)}</strong>
            <dl>
              {series.map((s) => (
                <div key={s.key} style={{ display: "contents" }}>
                  <dt>
                    <span className="swatch" style={{ background: s.color }} />
                    {s.name}
                  </dt>
                  <dd className="money">{f.euro(s.values[active] ?? 0)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

export type RankedItem = { key: string; name: string; color?: string; cents: number; count?: number; search?: TransactionSearch };

/** Ranking as a list with proportional bars; the numbers are text, so the list doubles as its own table. */
export function RankedBars({ items, total }: { items: RankedItem[]; total?: number }) {
  const t = useT();
  const f = useFormat();
  const shown = items.filter((i) => i.cents > 0);
  if (shown.length === 0) return <p className="empty">{t("dashboard.charts.noTransactions")}</p>;
  const max = Math.max(...shown.map((i) => i.cents), 1);
  const sum = total ?? shown.reduce((a, b) => a + b.cents, 0);
  return (
    <ol className="ranked">
      {shown.map((item) => (
        <li key={item.key}>
          <span className="ranked-name">
            {item.color && <span className="swatch" style={{ background: item.color }} aria-hidden="true" />}
            {item.search ? (
              <Link to="/buchungen" search={item.search}>
                {item.name}
              </Link>
            ) : (
              <span>{item.name}</span>
            )}
          </span>
          <span className="num">
            <Money>{f.euro(item.cents)}</Money>
            {sum > 0 && <span className="muted small"> · {f.percent(item.cents / sum)}</span>}
          </span>
          <span className="ranked-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(2, (item.cents / max) * 100)}%`, ...(item.color ? { background: item.color } : {}) }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Trend line without axes, as wide as its container; decorative next to a number that says the same.
 * Left out when there is no trend to show (fewer than two months with a value).
 */
export function Sparkline({ values }: { values: number[] }) {
  if (values.filter((v) => v !== 0).length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = linear([0, values.length - 1], [0, 100]);
  // Leaves room for the end dot and the stroke at the top and bottom edge.
  const y = max === min ? () => 50 : linear([min, max], [90, 10]);
  const points = values.map((v, i): [number, number] => [x(i), y(v)]);
  const line = linePath(points);
  const [lastX, lastY] = points.at(-1) ?? [100, 50];
  return (
    <span className="spark" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path className="spark-area" d={`${line}L100,100L0,100Z`} />
        <path className="spark-line" d={line} />
      </svg>
      <span className="spark-dot" style={{ left: `${lastX}%`, top: `${lastY}%` }} />
    </span>
  );
}
