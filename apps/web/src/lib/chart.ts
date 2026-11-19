import { type RefCallback, useCallback, useRef, useState } from "react";

export const SERIES_COLORS = [
  "var(--s1)",
  "var(--s2)",
  "var(--s3)",
  "var(--s4)",
  "var(--s5)",
  "var(--s6)",
  "var(--s7)",
  "var(--s8)",
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? "var(--s1)";
}

/** Round tick values in cents that include min and max; never fewer than two ticks, so nothing divides by zero. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  const raw = Math.max(high - low, 100_00) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const first = Math.floor(low / step) * step;
  const last = Math.max(Math.ceil(high / step) * step, first + step);
  const ticks: number[] = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Bar with a 3px rounded data edge, square at the baseline; works for negative values too. */
export function barPath(x: number, y0: number, y1: number, w: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5 || w <= 0) return "";
  const r = Math.min(3, h, w / 2);
  const dir = y1 < y0 ? 1 : -1;
  return `M${x},${y0}V${y1 + dir * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + dir * r}V${y0}Z`;
}

export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

/** Width of the chart container; the SVG uses it as viewBox width so text stays at its CSS size. */
export function useChartWidth(fallback = 640): [RefCallback<HTMLDivElement>, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const measure = () => {
      const w = Math.round(node.clientWidth);
      if (w > 0) setWidth(Math.max(260, w));
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);
  return [ref, width];
}
