import type { CategoryTotal, CounterpartyTotal, MonthRow, Recurring, Series, Summary } from "@saldo/core";
import type { z } from "zod";
import type { Translate } from "../i18n/index.ts";
import { getAiUsage, getAnalyses } from "../server/functions/ai.ts";
import { getContractForecastFn } from "../server/functions/contracts.ts";
import type { getDashboards } from "../server/functions/dashboards.ts";
import {
  getBalances,
  getCategoryTotals,
  getMonthly,
  getRecurring,
  getSeries,
  getSummary,
  getTopCounterparties,
} from "../server/functions/stats.ts";
import { getTransactions } from "../server/functions/transactions.ts";
import type { cardSchema } from "../server/modules/dashboards/index.ts";
import type { CategoryKind } from "./labels.ts";
import { type CardPeriod, cardRange, type DashboardRange, type DateRange, isPeriod, previousRange, resolvePeriod } from "./periods.ts";

export type Card = z.infer<typeof cardSchema>;
export type CardType = Card["type"];
export type CardWidth = Card["width"];
type RawDashboard = Awaited<ReturnType<typeof getDashboards>>[number];
export type Dashboard = Omit<RawDashboard, "cards"> & { cards: Card[] };
export type Kind = CategoryKind;

/** Behaviour per card type; label, description and default title live under `dashboard.cards.<type>`. */
type Meta = {
  width: CardWidth;
  /** Shows a period: the dashboard's or its own. */
  period?: boolean;
  /** Can show a period in the future from the contracts due in it. */
  forecast?: boolean;
  kind?: boolean;
  limit?: { default: number; max: number };
  picker?: "category" | "tag";
  /** Needs the AI part of the app (functions/ai.ts) */
  ai?: boolean;
  adminOnly?: boolean;
};

export const CARD_META: Record<CardType, Meta> = {
  summary: { width: "full", period: true, forecast: true },
  monthly_trend: { width: "full", period: true, forecast: true },
  category_breakdown: { width: "half", period: true, forecast: true, kind: true },
  category_trend: { width: "full", period: true, picker: "category" },
  tag_trend: { width: "full", period: true, picker: "tag" },
  recent_transactions: { width: "half", limit: { default: 8, max: 30 } },
  top_counterparties: { width: "half", period: true, limit: { default: 8, max: 50 } },
  balances: { width: "half" },
  period_comparison: { width: "half", period: true, limit: { default: 6, max: 15 } },
  recurring_payments: { width: "half", limit: { default: 8, max: 30 } },
  category_matrix: { width: "full", period: true },
  ai_usage: { width: "half", period: true, ai: true, adminOnly: true },
  ai_chat: { width: "half", ai: true },
  ai_insight: { width: "half", ai: true },
};

export const CARD_ORDER = Object.keys(CARD_META) as CardType[];

function isCardType(value: string): value is CardType {
  return Object.hasOwn(CARD_META, value);
}

/** Cards are stored as JSON; unknown types (from an older version) are skipped. */
export function normalizeDashboard(raw: RawDashboard): Dashboard {
  return { ...raw, cards: raw.cards.flatMap((card) => (isCardType(card.type) ? [{ ...card, type: card.type }] : [])) };
}

/** Labels live under `dashboard.widths.<width>`. */
export const CARD_WIDTHS = ["full", "half", "third"] as const satisfies readonly CardWidth[];

/** The default title in the reader's language; once saved, a title is the user's own text. */
export function defaultCardTitle(type: CardType, t: Translate): string {
  return t(`dashboard.cards.${type}.title`);
}

export function createCard(type: CardType, t: Translate): Card {
  const meta = CARD_META[type];
  const options: Card["options"] = {};
  if (meta.period) options.period = "dashboard";
  if (meta.kind) options.kind = "expense";
  if (meta.limit) options.limit = meta.limit.default;
  if (meta.picker) options.ids = [];
  return { id: crypto.randomUUID().slice(0, 8), type, title: defaultCardTitle(type, t), width: meta.width, options };
}

/** A card follows its dashboard's period unless it stores one of its own. */
export function cardPeriod(card: Card): CardPeriod {
  const value = card.options.period;
  return isPeriod(value) ? value : "dashboard";
}

/** The range a card shows; null for cards without a period. */
export function cardRangeOf(card: Card, dashboard: DashboardRange): DashboardRange | null {
  return CARD_META[card.type].period ? cardRange(cardPeriod(card), dashboard) : null;
}

export function cardLimit(card: Card): number {
  const meta = CARD_META[card.type].limit;
  const value = Number(card.options.limit);
  if (!meta) return 8;
  return Number.isInteger(value) && value > 0 ? Math.min(value, meta.max) : meta.default;
}

export function cardKind(card: Card): Kind {
  const value = card.options.kind;
  return value === "income" || value === "savings" ? value : "expense";
}

export function cardIds(card: Card): number[] {
  const value = card.options.ids;
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

/** Identifies what a card's data depends on, so an edited draft card or a new period reloads only when needed. */
export function cardKey(card: Card, groupId: number | null, dashboard: DashboardRange): string {
  return JSON.stringify([card.id, card.type, card.options, groupId, cardRangeOf(card, dashboard)]);
}

type Forecast = Awaited<ReturnType<typeof getContractForecastFn>>;

/** `forecast`: the rows come from the contracts due in a future range, not from bookings. */
export type CardData =
  | { type: "summary"; range: DateRange; current: Summary; previous: Summary; trend: MonthRow[] }
  | { type: "forecast_summary"; range: DateRange; totals: Forecast["totals"]; count: number }
  | { type: "monthly_trend"; range: DateRange; rows: MonthRow[]; forecast?: boolean }
  | { type: "category_breakdown"; range: DateRange; kind: Kind; rows: CategoryTotal[]; forecast?: boolean }
  | { type: "no_future"; range: DateRange }
  | { type: "series"; range: DateRange; data: Series }
  | { type: "recent_transactions"; items: Awaited<ReturnType<typeof getTransactions>>["items"]; unread: number }
  | { type: "top_counterparties"; range: DateRange; rows: CounterpartyTotal[] }
  | { type: "balances"; data: Awaited<ReturnType<typeof getBalances>> }
  | { type: "period_comparison"; range: DateRange; previous: DateRange; current: CategoryTotal[]; before: CategoryTotal[] }
  | { type: "recurring_payments"; rows: Recurring[] }
  | { type: "category_matrix"; range: DateRange; data: Series }
  | { type: "ai_usage"; range: DateRange; usage: Awaited<ReturnType<typeof getAiUsage>> }
  | { type: "ai_insight"; analysis: Awaited<ReturnType<typeof getAnalyses>>[number] | null }
  | { type: "ai_chat" };

function lastCompleteMonths(count: number): DateRange {
  const today = new Date();
  const lastMonth = resolvePeriod("last_month", today);
  const from = new Date(today.getFullYear(), today.getMonth() - count, 1);
  return { dateFrom: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`, dateTo: lastMonth.dateTo };
}

/** A future range: what the contracts due in it say, for the cards that can show that. */
async function loadForecast(card: Card, groupId: number | null, range: DateRange): Promise<CardData> {
  if (!CARD_META[card.type].forecast) return { type: "no_future", range };
  const forecast = await getContractForecastFn({ data: { groupId, dateFrom: range.dateFrom, dateTo: range.dateTo } });
  switch (card.type) {
    case "summary":
      return { type: "forecast_summary", range, totals: forecast.totals, count: forecast.items.length };
    case "monthly_trend":
      return { type: "monthly_trend", range, rows: forecast.months, forecast: true };
    case "category_breakdown": {
      const kind = cardKind(card);
      return { type: "category_breakdown", range, kind, rows: forecast.categories[kind], forecast: true };
    }
    default:
      return { type: "no_future", range };
  }
}

/** Loads what one card shows; used by the overview loader and, for edited draft cards, from the browser. */
export async function loadCardData(card: Card, groupId: number | null, dashboard: DashboardRange): Promise<CardData> {
  const own = cardRangeOf(card, dashboard);
  const range: DateRange = own ? { dateFrom: own.dateFrom, dateTo: own.dateTo } : resolvePeriod("this_month");
  if (own?.forecast) return loadForecast(card, groupId, range);
  const r = (dates: DateRange) => ({ groupId, dateFrom: dates.dateFrom, dateTo: dates.dateTo, accountIds: [] });
  switch (card.type) {
    case "summary": {
      const previous = previousRange(range);
      const [current, before, trend] = await Promise.all([
        getSummary({ data: r(range) }),
        getSummary({ data: r(previous) }),
        getMonthly({ data: r(lastCompleteMonths(12)) }),
      ]);
      return { type: "summary", range, current, previous: before, trend };
    }
    case "monthly_trend":
      return { type: "monthly_trend", range, rows: await getMonthly({ data: r(range) }) };
    case "category_breakdown": {
      const kind = cardKind(card);
      return { type: "category_breakdown", range, kind, rows: await getCategoryTotals({ data: { range: r(range), kind } }) };
    }
    case "category_trend":
    case "tag_trend": {
      const groupBy = card.type === "tag_trend" ? "tag" : "category";
      const data = await getSeries({ data: { range: r(range), groupBy, ids: cardIds(card) } });
      return { type: "series", range, data: cardIds(card).length > 0 ? data : topSeries(data, 5) };
    }
    case "recent_transactions": {
      const { items, unread } = await getTransactions({ data: { groupId, limit: cardLimit(card) } });
      return { type: "recent_transactions", items, unread };
    }
    case "top_counterparties":
      return { type: "top_counterparties", range, rows: await getTopCounterparties({ data: { range: r(range), limit: cardLimit(card) } }) };
    case "balances":
      return { type: "balances", data: await getBalances({ data: { groupId } }) };
    case "period_comparison": {
      const previous = previousRange(range);
      const [current, before] = await Promise.all([
        getCategoryTotals({ data: { range: r(range), kind: "expense" } }),
        getCategoryTotals({ data: { range: r(previous), kind: "expense" } }),
      ]);
      return { type: "period_comparison", range, previous, current, before };
    }
    case "recurring_payments":
      return { type: "recurring_payments", rows: await getRecurring({ data: r(lastCompleteMonths(12)) }) };
    case "category_matrix":
      return { type: "category_matrix", range, data: await getSeries({ data: { range: r(range), groupBy: "category", ids: [] } }) };
    case "ai_usage":
      return { type: "ai_usage", range, usage: await getAiUsage({ data: { ...range, limit: 5 } }) };
    case "ai_insight":
      return { type: "ai_insight", analysis: (await getAnalyses({ data: { groupId, limit: 1 } }))[0] ?? null };
    case "ai_chat":
      return { type: "ai_chat" };
  }
}

/** The `count` series with the largest absolute total, in that order. */
export function topSeries(data: Series, count: number): Series {
  const total = (values: number[]) => values.reduce((a, b) => a + Math.abs(b), 0);
  return { months: data.months, series: [...data.series].sort((a, b) => total(b.values) - total(a.values)).slice(0, count) };
}

export type ComparisonRow = { key: string; name: string; categoryId: number | null; current: number; previous: number; delta: number };

/** Categories whose spending changed most against the previous period. */
export function compareTotals(current: CategoryTotal[], before: CategoryTotal[], limit: number): ComparisonRow[] {
  const key = (t: CategoryTotal) => (t.categoryId === null ? `n:${t.name}` : `c:${t.categoryId}`);
  const rows = new Map<string, ComparisonRow>();
  for (const t of current)
    rows.set(key(t), { key: key(t), name: t.name, categoryId: t.categoryId, current: t.amountCents, previous: 0, delta: 0 });
  for (const t of before) {
    const row = rows.get(key(t)) ?? { key: key(t), name: t.name, categoryId: t.categoryId, current: 0, previous: 0, delta: 0 };
    row.previous = t.amountCents;
    rows.set(key(t), row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, delta: row.current - row.previous }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}
