/**
 * Window math for the balance timeline. Day `d` of a series is the point at x = d; a viewport is a continuous range of
 * days, so panning and pinching can move it by fractions of a day.
 */

export type Viewport = { from: number; to: number };
export type Preset = "1m" | "3m" | "1y" | "max";
export const PRESETS: readonly Preset[] = ["1m", "3m", "1y", "max"];

/** Two weeks: the closest zoom. */
export const MIN_SPAN = 13;

const DAY = 86_400_000;
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoOfDay = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);

export function dayIso(start: string, day: number): string {
  return isoOfDay(dayNumber(start) + day);
}

/** Dense end-of-day balances; NaN before the first known one. */
export function expandBalance(points: readonly (readonly [number, number])[], days: number): Float64Array {
  const values = new Float64Array(days).fill(Number.NaN);
  let next = 0;
  let current = Number.NaN;
  for (let day = 0; day < days; day++) {
    for (let p = points[next]; p && p[0] <= day; p = points[++next]) current = p[1];
    values[day] = current;
  }
  return values;
}

export type FlowSums = { inCents: number; outCents: number; count: number };
/** Running totals of the daily flows, so any window's sums are two lookups. */
export type FlowPrefix = { inCents: Float64Array; outCents: Float64Array; count: Float64Array };

export function flowPrefix(flows: readonly (readonly [number, number, number, number])[], days: number): FlowPrefix {
  const prefix = { inCents: new Float64Array(days + 1), outCents: new Float64Array(days + 1), count: new Float64Array(days + 1) };
  const byDay = new Map(flows.map((f) => [f[0], f]));
  for (let day = 0; day < days; day++) {
    const f = byDay.get(day);
    prefix.inCents[day + 1] = (prefix.inCents[day] ?? 0) + (f?.[1] ?? 0);
    prefix.outCents[day + 1] = (prefix.outCents[day] ?? 0) + (f?.[2] ?? 0);
    prefix.count[day + 1] = (prefix.count[day] ?? 0) + (f?.[3] ?? 0);
  }
  return prefix;
}

/** Sums over days d0…d1, both included. */
export function sumFlows(prefix: FlowPrefix, d0: number, d1: number): FlowSums {
  const last = prefix.count.length - 1;
  const a = Math.min(Math.max(d0, 0), last);
  const b = Math.min(Math.max(d1 + 1, a), last);
  const diff = (arr: Float64Array) => (arr[b] ?? 0) - (arr[a] ?? 0);
  return { inCents: diff(prefix.inCents), outCents: diff(prefix.outCents), count: diff(prefix.count) };
}

/** The range a viewport may cover: the whole series, and at least two weeks even when the history is shorter. */
export function bounds(days: number): { lo: number; hi: number } {
  const hi = Math.max(0, days - 1);
  return { lo: Math.min(0, hi - MIN_SPAN), hi };
}

export function clampViewport(vp: Viewport, days: number): Viewport {
  const { lo, hi } = bounds(days);
  const span = Math.min(Math.max(vp.to - vp.from, MIN_SPAN), hi - lo);
  const from = Math.min(Math.max(vp.from, lo), hi - span);
  return { from, to: from + span };
}

export function panBy(vp: Viewport, deltaDays: number, days: number): Viewport {
  return clampViewport({ from: vp.from + deltaDays, to: vp.to + deltaDays }, days);
}

/**
 * Sets the span to `span` days with the day `pivot` at `anchor` (0 = left edge, 1 = right edge); a pinch passes the
 * fingers' new midpoint as anchor and pans along with zooming.
 */
export function zoomAround(span: number, pivot: number, anchor: number, days: number): Viewport {
  const { lo, hi } = bounds(days);
  const next = Math.min(Math.max(span, MIN_SPAN), hi - lo);
  const from = pivot - next * anchor;
  return clampViewport({ from, to: from + next }, days);
}

/** `factor` above 1 zooms out; the day under `anchor` stays in place. */
export function zoomBy(vp: Viewport, factor: number, anchor: number, days: number): Viewport {
  const span = vp.to - vp.from;
  return zoomAround(span * factor, vp.from + span * anchor, anchor, days);
}

export const ZOOM_STEP = 1.5;

/** One zoom step; while today is in view it stays at the right edge, as in a bank app, elsewhere the middle stays. */
export function zoomStep(vp: Viewport, direction: "in" | "out", days: number): Viewport {
  const { hi } = bounds(days);
  return zoomBy(vp, direction === "in" ? 1 / ZOOM_STEP : ZOOM_STEP, vp.to >= hi - 1e-3 ? 1 : 0.5, days);
}

/** Keys on the focused chart (a slider, so Up/Down work like Right/Left): arrows pan a tenth of the window, Page keys a whole one, Home/End jump, +/- zoom. */
export function keyViewport(key: string, vp: Viewport, days: number): Viewport | null {
  const span = vp.to - vp.from;
  const { lo, hi } = bounds(days);
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return panBy(vp, -span * 0.1, days);
    case "ArrowRight":
    case "ArrowUp":
      return panBy(vp, span * 0.1, days);
    case "PageUp":
      return panBy(vp, -span, days);
    case "PageDown":
      return panBy(vp, span, days);
    case "Home":
      return clampViewport({ from: lo, to: lo + span }, days);
    case "End":
      return clampViewport({ from: hi - span, to: hi }, days);
    case "+":
    case "=":
      return zoomStep(vp, "in", days);
    case "-":
    case "_":
      return zoomStep(vp, "out", days);
    default:
      return null;
  }
}

/** A range being picked to zoom into, in whole days: `anchor` stays where it began, `head` follows the pointer or keys. */
export type Selection = { anchor: number; head: number };

export function selectionDays(sel: Selection): [number, number] {
  return sel.anchor <= sel.head ? [sel.anchor, sel.head] : [sel.head, sel.anchor];
}

/** The window a selection zooms to, widened around its middle to two weeks; null for a single day, which is a tap. */
export function selectionViewport(sel: Selection, days: number): Viewport | null {
  const [a, b] = selectionDays(sel);
  if (b - a < 1) return null;
  const span = Math.max(b - a, MIN_SPAN);
  const mid = (a + b) / 2;
  return clampViewport({ from: mid - span / 2, to: mid + span / 2 }, days);
}

/**
 * Shift + arrow keys pick a range inside the window: the first press anchors it at the edge opposite the arrow
 * (Shift+Left grows from the right edge, as from today), each press moves the other end by a tenth of the window.
 */
export function keySelection(key: string, sel: Selection | null, vp: Viewport, days: number): Selection | null {
  const direction = key === "ArrowLeft" || key === "ArrowDown" ? -1 : key === "ArrowRight" || key === "ArrowUp" ? 1 : 0;
  if (!direction) return null;
  const [d0, d1] = visibleDays(vp, days);
  const step = Math.max(1, Math.round((vp.to - vp.from) / 10));
  const edge = direction < 0 ? d1 : d0;
  const current = sel ?? { anchor: edge, head: edge };
  return { anchor: current.anchor, head: Math.min(Math.max(current.head + direction * step, d0), d1) };
}

/** Drags one edge of the window (in the overview) to `day`; the other edge stays, the span stays at least two weeks. */
export function resizeViewport(vp: Viewport, edge: "from" | "to", day: number, days: number): Viewport {
  const { lo, hi } = bounds(days);
  if (edge === "from") return clampViewport({ from: Math.min(Math.max(day, lo), vp.to - MIN_SPAN), to: vp.to }, days);
  return clampViewport({ from: vp.from, to: Math.max(Math.min(day, hi), vp.from + MIN_SPAN) }, days);
}

export const HISTORY_LIMIT = 50;
const sameViewport = (a: Viewport, b: Viewport) => Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;

/** Remembers `previous` before a zoom to `next`, so it can be undone; a step that changes nothing is none. */
export function pushHistory(history: readonly Viewport[], previous: Viewport, next: Viewport): readonly Viewport[] {
  if (sameViewport(previous, next)) return history;
  return [...history, previous].slice(-HISTORY_LIMIT);
}

/** The window to go back to (skipping entries equal to `current`) and the history without it. */
export function popHistory(history: readonly Viewport[], current: Viewport): { viewport: Viewport | null; history: readonly Viewport[] } {
  const rest = [...history];
  for (let v = rest.pop(); v; v = rest.pop()) if (!sameViewport(v, current)) return { viewport: v, history: rest };
  return { viewport: null, history: [] };
}

/** Calendar months back from the last day ("3 M" on 17.11. starts on 17.08.), or everything. */
export function presetViewport(preset: Preset, start: string, days: number): Viewport {
  const { lo, hi } = bounds(days);
  if (preset === "max") return { from: lo, to: hi };
  const months = preset === "1m" ? 1 : preset === "3m" ? 3 : 12;
  const end = new Date((dayNumber(start) + hi) * DAY);
  const target = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(end.getUTCDate(), lastOfMonth));
  return clampViewport({ from: Math.round(target.getTime() / DAY) - dayNumber(start), to: hi }, days);
}

/**
 * The window for a picked date range (ISO dates, both days included), or null for a reversed or incomplete one.
 * Shorter ranges than two weeks widen around their middle, like a zoom.
 */
export function dateViewport(from: string, to: string, start: string, days: number): Viewport | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = dayNumber(from) - dayNumber(start);
  const b = dayNumber(to) - dayNumber(start);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  const span = Math.max(b - a, MIN_SPAN);
  const mid = (a + b) / 2;
  return clampViewport({ from: mid - span / 2, to: mid + span / 2 }, days);
}

export function matchesPreset(vp: Viewport, preset: Preset, start: string, days: number): boolean {
  const p = presetViewport(preset, start, days);
  return Math.abs(p.from - vp.from) < 0.5 && Math.abs(p.to - vp.to) < 0.5;
}

/** Whole days inside the viewport that belong to the series. */
export function visibleDays(vp: Viewport, days: number): [number, number] {
  const d0 = Math.max(0, Math.ceil(vp.from - 1e-6));
  const d1 = Math.min(days - 1, Math.floor(vp.to + 1e-6));
  return [d0, Math.max(d0, d1)];
}

export function extent(values: ArrayLike<number>, d0: number, d1: number): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let d = d0; d <= d1; d++) {
    const v = values[d] ?? Number.NaN;
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : null;
}

/** Round ticks in cents around the visible values; unlike column charts, a balance axis need not start at zero. */
export function valueTicks(min: number, max: number, count = 4): number[] {
  let lo = min;
  let hi = max;
  if (hi - lo < 1) {
    const pad = Math.max(Math.abs(hi) * 0.05, 100_00);
    lo -= pad;
    hi += pad;
  }
  const raw = Math.max((hi - lo) / count, 100);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const first = Math.floor(lo / step) * step;
  const last = Math.max(Math.ceil(hi / step) * step, first + step);
  const ticks: number[] = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

export type TickKind = "day" | "month" | "year";
export type Tick = { day: number; kind: TickKind };

type Step = { unit: "day" | "week" | "month" | "year"; n: number; days: number };
const STEPS: readonly Step[] = [
  { unit: "day", n: 1, days: 1 },
  { unit: "day", n: 2, days: 2 },
  { unit: "week", n: 1, days: 7 },
  { unit: "week", n: 2, days: 14 },
  { unit: "month", n: 1, days: 30.4 },
  { unit: "month", n: 2, days: 61 },
  { unit: "month", n: 3, days: 91 },
  { unit: "month", n: 6, days: 183 },
  { unit: "year", n: 1, days: 365 },
];

/**
 * Axis ticks on calendar boundaries (days, Mondays, first of a month, New Year), as dense as `minGap` pixels allow.
 * Ticks sit on fixed dates, so they slide with the line while panning instead of jumping.
 */
export function xTicks(start: string, vp: Viewport, plotWidth: number, minGap = 64): Tick[] {
  const perDay = plotWidth / Math.max(vp.to - vp.from, 1);
  const step = STEPS.find((s) => s.days * perDay >= minGap) ?? { unit: "year", n: Math.ceil(minGap / (365 * perDay)), days: 365 };
  const base = dayNumber(start);
  const ticks: Tick[] = [];
  for (let day = Math.ceil(vp.from); day <= Math.floor(vp.to); day++) {
    const abs = base + day;
    const date = new Date(abs * DAY);
    const firstOfMonth = date.getUTCDate() === 1;
    const month = date.getUTCMonth();
    switch (step.unit) {
      case "day":
        if (abs % step.n === 0) ticks.push({ day, kind: "day" });
        break;
      // 1970-01-05, day number 4, was a Monday.
      case "week":
        if ((abs - 4) % (7 * step.n) === 0) ticks.push({ day, kind: "day" });
        break;
      case "month":
        if (firstOfMonth && month % step.n === 0) ticks.push({ day, kind: month === 0 ? "year" : "month" });
        break;
      case "year":
        if (firstOfMonth && month === 0 && date.getUTCFullYear() % step.n === 0) ticks.push({ day, kind: "year" });
        break;
    }
  }
  return ticks;
}

/**
 * The points to draw for days d0…d1: every day while they fit, otherwise the lowest and highest value of each bucket
 * (about one per pixel) in their order, so peaks survive zooming out. Buckets start on fixed days, so the line keeps
 * its shape while panning.
 */
export function downsample(values: ArrayLike<number>, d0: number, d1: number, buckets: number): [number, number][] {
  const points: [number, number][] = [];
  const n = d1 - d0 + 1;
  const size = n <= Math.max(1, buckets) * 2 ? 1 : Math.ceil(n / buckets);
  for (let b = Math.floor(d0 / size); b * size <= d1; b++) {
    let lowDay = -1;
    let highDay = -1;
    for (let d = Math.max(d0, b * size); d <= Math.min(d1, b * size + size - 1); d++) {
      const v = values[d] ?? Number.NaN;
      if (Number.isNaN(v)) continue;
      if (lowDay < 0 || v < (values[lowDay] ?? 0)) lowDay = d;
      if (highDay < 0 || v > (values[highDay] ?? 0)) highDay = d;
    }
    if (lowDay < 0) continue;
    const [first, second] = lowDay <= highDay ? [lowDay, highDay] : [highDay, lowDay];
    points.push([first, values[first] ?? 0]);
    if (second !== first) points.push([second, values[second] ?? 0]);
  }
  return points;
}

/** A whole calendar month (up to today in the current one) reads as that month, anything else as a date range. */
export type PeriodLabel = { kind: "month"; month: string } | { kind: "range"; from: string; to: string };

export function periodOf(start: string, d0: number, d1: number, days: number): PeriodLabel {
  const from = dayIso(start, d0);
  const to = dayIso(start, d1);
  const monthEnd = dayIso(start, d1 + 1).endsWith("-01");
  if (from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7) && (monthEnd || d1 === days - 1)) {
    return { kind: "month", month: from.slice(0, 7) };
  }
  return { kind: "range", from, to };
}
