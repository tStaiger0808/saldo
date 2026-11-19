import { describe, expect, it } from "vitest";
import {
  clampViewport,
  dateViewport,
  dayIso,
  downsample,
  expandBalance,
  extent,
  flowPrefix,
  HISTORY_LIMIT,
  keySelection,
  keyViewport,
  MIN_SPAN,
  matchesPreset,
  panBy,
  periodOf,
  popHistory,
  presetViewport,
  pushHistory,
  resizeViewport,
  selectionDays,
  selectionViewport,
  sumFlows,
  valueTicks,
  visibleDays,
  xTicks,
  zoomAround,
  zoomBy,
  zoomStep,
} from "./timeline.ts";

// 2023-11-18 … 2026-11-17, the last day is "today".
const START = "2023-11-18";
const DAYS = 1096;
const LAST = DAYS - 1;

describe("series", () => {
  it("expands change points with carry-forward and leaves unknown days empty", () => {
    const values = expandBalance(
      [
        [2, 100],
        [4, 50],
      ],
      6,
    );
    expect([...values]).toEqual([Number.NaN, Number.NaN, 100, 100, 50, 50]);
    expect(extent(values, 0, 5)).toEqual({ min: 50, max: 100 });
    expect(extent(values, 0, 1)).toBeNull();
  });

  it("sums the flows of any window from running totals", () => {
    const prefix = flowPrefix(
      [
        [1, 1_000, 0, 1],
        [3, 0, 400, 2],
        [5, 50, 60, 2],
      ],
      6,
    );
    expect(sumFlows(prefix, 0, 5)).toEqual({ inCents: 1_050, outCents: 460, count: 5 });
    expect(sumFlows(prefix, 2, 4)).toEqual({ inCents: 0, outCents: 400, count: 2 });
    expect(sumFlows(prefix, -10, 99)).toEqual({ inCents: 1_050, outCents: 460, count: 5 });
  });
});

describe("viewport", () => {
  it("opens on the last three calendar months and knows the presets", () => {
    expect(dayIso(START, LAST)).toBe("2026-11-17");
    const three = presetViewport("3m", START, DAYS);
    expect(dayIso(START, three.from)).toBe("2026-08-17");
    expect(three.to).toBe(LAST);
    expect(dayIso(START, presetViewport("1y", START, DAYS).from)).toBe("2025-11-17");
    expect(presetViewport("max", START, DAYS)).toEqual({ from: 0, to: LAST });
    expect(matchesPreset(three, "3m", START, DAYS)).toBe(true);
    expect(matchesPreset(panBy(three, -30, DAYS), "3m", START, DAYS)).toBe(false);
  });

  it("clamps a month back to its last day", () => {
    // 31 March minus one month is the last day of February.
    expect(dayIso("2026-01-01", presetViewport("1m", "2026-01-01", 90).from)).toBe("2026-02-28");
  });

  it("pans within the history and keeps the span", () => {
    const vp = { from: 100, to: 200 };
    expect(panBy(vp, 50, DAYS)).toEqual({ from: 150, to: 250 });
    expect(panBy(vp, -500, DAYS)).toEqual({ from: 0, to: 100 });
    expect(panBy(vp, 5_000, DAYS)).toEqual({ from: LAST - 100, to: LAST });
  });

  it("zooms around the anchor between two weeks and the whole history", () => {
    const zoomed = zoomBy({ from: 100, to: 200 }, 0.5, 0.5, DAYS);
    expect(zoomed).toEqual({ from: 125, to: 175 });
    expect(zoomBy(zoomed, 0.01, 0.5, DAYS).to - zoomBy(zoomed, 0.01, 0.5, DAYS).from).toBe(MIN_SPAN);
    expect(zoomBy(zoomed, 1_000, 0.5, DAYS)).toEqual({ from: 0, to: LAST });
    // The right edge stays on today when zooming with the anchor there.
    expect(zoomBy({ from: LAST - 90, to: LAST }, 2, 1, DAYS)).toEqual({ from: LAST - 180, to: LAST });
    // A pinch moves along: the pivot day follows the fingers' midpoint.
    expect(zoomAround(50, 150, 0.25, DAYS)).toEqual({ from: 137.5, to: 187.5 });
  });

  it("keeps at least two weeks in view when the history is shorter", () => {
    expect(clampViewport({ from: 0, to: 4 }, 5)).toEqual({ from: 4 - MIN_SPAN, to: 4 });
    expect(presetViewport("max", "2026-11-13", 5)).toEqual({ from: 4 - MIN_SPAN, to: 4 });
    expect(visibleDays({ from: 4 - MIN_SPAN, to: 4 }, 5)).toEqual([0, 4]);
    expect(visibleDays({ from: 10.4, to: 20.6 }, DAYS)).toEqual([11, 20]);
  });
});

describe("keyboard and buttons", () => {
  it("pans with the arrow and page keys, jumps with Home and End and zooms with plus and minus", () => {
    const vp = { from: 500, to: 600 };
    expect(keyViewport("ArrowLeft", vp, DAYS)).toEqual({ from: 490, to: 590 });
    expect(keyViewport("ArrowDown", vp, DAYS)).toEqual({ from: 490, to: 590 });
    expect(keyViewport("ArrowUp", vp, DAYS)).toEqual(keyViewport("ArrowRight", vp, DAYS));
    expect(keyViewport("ArrowRight", vp, DAYS)).toEqual({ from: 510, to: 610 });
    expect(keyViewport("PageUp", vp, DAYS)).toEqual({ from: 400, to: 500 });
    expect(keyViewport("Home", vp, DAYS)).toEqual({ from: 0, to: 100 });
    expect(keyViewport("End", vp, DAYS)).toEqual({ from: LAST - 100, to: LAST });
    const zoomedIn = keyViewport("+", vp, DAYS);
    expect(zoomedIn && zoomedIn.to - zoomedIn.from).toBeCloseTo(100 / 1.5);
    expect(keyViewport("-", vp, DAYS)).toEqual(zoomStep(vp, "out", DAYS));
    expect(keyViewport("a", vp, DAYS)).toBeNull();
  });

  it("keeps today at the right edge when zooming there", () => {
    const now = { from: LAST - 90, to: LAST };
    expect(zoomStep(now, "out", DAYS)).toEqual({ from: LAST - 135, to: LAST });
    expect(zoomStep({ from: 100, to: 190 }, "out", DAYS)).toEqual({ from: 77.5, to: 212.5 });
  });
});

describe("range selection", () => {
  it("zooms to the selected days in either direction", () => {
    expect(selectionDays({ anchor: 300, head: 240 })).toEqual([240, 300]);
    expect(selectionViewport({ anchor: 300, head: 240 }, DAYS)).toEqual({ from: 240, to: 300 });
    expect(selectionViewport({ anchor: 240, head: 300 }, DAYS)).toEqual({ from: 240, to: 300 });
  });

  it("treats a single day as a tap and widens short selections to two weeks around their middle", () => {
    expect(selectionViewport({ anchor: 50, head: 50 }, DAYS)).toBeNull();
    expect(selectionViewport({ anchor: 50, head: 54 }, DAYS)).toEqual({ from: 52 - MIN_SPAN / 2, to: 52 + MIN_SPAN / 2 });
  });

  it("clamps a widened selection to the history", () => {
    expect(selectionViewport({ anchor: 0, head: 2 }, DAYS)).toEqual({ from: 0, to: MIN_SPAN });
    expect(selectionViewport({ anchor: LAST, head: LAST - 1 }, DAYS)).toEqual({ from: LAST - MIN_SPAN, to: LAST });
  });

  it("extends a keyboard selection from the window edge by a tenth of the window and stays inside it", () => {
    const vp = { from: 500, to: 600 };
    const left = keySelection("ArrowLeft", null, vp, DAYS);
    expect(left).toEqual({ anchor: 600, head: 590 });
    expect(keySelection("ArrowLeft", left, vp, DAYS)).toEqual({ anchor: 600, head: 580 });
    expect(keySelection("ArrowRight", left, vp, DAYS)).toEqual({ anchor: 600, head: 600 });
    expect(keySelection("ArrowRight", null, vp, DAYS)).toEqual({ anchor: 500, head: 510 });
    expect(keySelection("ArrowUp", null, vp, DAYS)).toEqual(keySelection("ArrowRight", null, vp, DAYS));
    let sel = left;
    for (let i = 0; i < 20; i++) sel = keySelection("ArrowLeft", sel, vp, DAYS);
    expect(sel).toEqual({ anchor: 600, head: 500 });
    expect(keySelection("Enter", left, vp, DAYS)).toBeNull();
    // At least a day per step in a two-week window.
    expect(keySelection("ArrowLeft", null, { from: 100, to: 100 + MIN_SPAN }, DAYS)).toEqual({ anchor: 113, head: 112 });
  });

  it("resizes the window from either edge, keeping two weeks and the history's bounds", () => {
    const vp = { from: 500, to: 600 };
    expect(resizeViewport(vp, "from", 400, DAYS)).toEqual({ from: 400, to: 600 });
    expect(resizeViewport(vp, "to", 700, DAYS)).toEqual({ from: 500, to: 700 });
    expect(resizeViewport(vp, "from", 650, DAYS)).toEqual({ from: 600 - MIN_SPAN, to: 600 });
    expect(resizeViewport(vp, "to", 0, DAYS)).toEqual({ from: 500, to: 500 + MIN_SPAN });
    expect(resizeViewport(vp, "from", -50, DAYS)).toEqual({ from: 0, to: 600 });
    expect(resizeViewport(vp, "to", 5_000, DAYS)).toEqual({ from: 500, to: LAST });
  });
});

describe("zoom history", () => {
  const a = { from: 0, to: 100 };
  const b = { from: 50, to: 80 };
  const c = { from: 60, to: 75 };

  it("remembers each zoom step and goes back one at a time", () => {
    const history = pushHistory(pushHistory([], a, b), b, c);
    expect(history).toEqual([a, b]);
    const once = popHistory(history, c);
    expect(once).toEqual({ viewport: b, history: [a] });
    expect(popHistory(once.history, b)).toEqual({ viewport: a, history: [] });
    expect(popHistory([], a)).toEqual({ viewport: null, history: [] });
  });

  it("ignores steps that change nothing and skips entries equal to the current window", () => {
    const history = pushHistory([a], b, { ...b });
    expect(history).toEqual([a]);
    expect(popHistory([a, b], b)).toEqual({ viewport: a, history: [] });
  });

  it("keeps a bounded number of steps", () => {
    let history: readonly { from: number; to: number }[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) history = pushHistory(history, { from: i, to: i + 20 }, { from: i + 1, to: i + 21 });
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toEqual({ from: 10, to: 30 });
  });
});

describe("axes", () => {
  it("rescales the value axis to the window and includes zero only when in range", () => {
    const ticks = valueTicks(1_234_500, 1_310_000);
    expect(ticks[0]).toBeLessThanOrEqual(1_234_500);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(1_310_000);
    expect(ticks[0]).toBeGreaterThan(0);
    expect(valueTicks(-20_000, 50_000)).toContain(0);
    const flat = valueTicks(500_00, 500_00);
    expect(flat.length).toBeGreaterThan(1);
  });

  it("labels days, weeks, months or years depending on the zoom", () => {
    const two = { from: LAST - 13, to: LAST };
    const days = xTicks(START, two, 1000);
    expect(days.every((t) => t.kind === "day")).toBe(true);
    expect(days).toHaveLength(14);
    const weeks = xTicks(START, two, 300);
    expect(weeks.length).toBeLessThanOrEqual(3);
    expect(weeks.every((t) => new Date(`${dayIso(START, t.day)}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    const year = xTicks(START, { from: LAST - 365, to: LAST }, 800);
    expect(year.every((t) => dayIso(START, t.day).endsWith("-01"))).toBe(true);
    expect(year.find((t) => dayIso(START, t.day) === "2026-01-01")?.kind).toBe("year");
    const all = xTicks(START, { from: 0, to: LAST }, 300);
    expect(all.map((t) => dayIso(START, t.day))).toEqual(["2024-01-01", "2025-01-01", "2026-01-01"]);
  });

  it("downsamples to the pixel width while keeping peaks", () => {
    const values = Float64Array.from({ length: 1000 }, (_, i) => (i === 503 ? 9_999 : i % 7));
    const points = downsample(values, 0, 999, 100);
    expect(points.length).toBeLessThanOrEqual(200);
    expect(points.some(([d, v]) => d === 503 && v === 9_999)).toBe(true);
    expect(points.map(([d]) => d)).toEqual([...points.map(([d]) => d)].sort((a, b) => a - b));
    expect(downsample(values, 10, 19, 100)).toHaveLength(10);
    expect(downsample(Float64Array.from([Number.NaN, 1, 2]), 0, 2, 10)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("names a whole month by its name and anything else as a range", () => {
    const nov = Math.round((Date.parse("2026-11-01") - Date.parse(START)) / 86_400_000);
    expect(periodOf(START, nov, LAST, DAYS)).toEqual({ kind: "month", month: "2026-11" });
    expect(periodOf(START, nov - 31, nov - 1, DAYS)).toEqual({ kind: "month", month: "2026-10" });
    expect(periodOf(START, nov - 5, LAST, DAYS)).toEqual({ kind: "range", from: "2026-10-27", to: "2026-11-17" });
  });
});

describe("custom date range", () => {
  it("shows exactly the picked days", () => {
    const vp = dateViewport("2024-01-01", "2024-03-31", START, DAYS);
    expect(vp).not.toBeNull();
    if (!vp) return;
    expect(dayIso(START, vp.from)).toBe("2024-01-01");
    expect(dayIso(START, vp.to)).toBe("2024-03-31");
  });
  it("widens a range shorter than two weeks around its middle", () => {
    const vp = dateViewport("2024-05-10", "2024-05-12", START, DAYS);
    expect(vp && vp.to - vp.from).toBe(MIN_SPAN);
    expect(vp && (vp.from + vp.to) / 2).toBeCloseTo((dateViewport("2024-05-11", "2024-05-11", START, DAYS)?.from ?? 0) + MIN_SPAN / 2);
  });
  it("rejects a reversed or incomplete range and keeps the rest inside the history", () => {
    expect(dateViewport("2024-03-01", "2024-02-01", START, DAYS)).toBeNull();
    expect(dateViewport("", "2024-02-01", START, DAYS)).toBeNull();
    const all = dateViewport("2000-01-01", "2099-01-01", START, DAYS);
    expect(all).toEqual({ from: 0, to: DAYS - 1 });
  });
});
