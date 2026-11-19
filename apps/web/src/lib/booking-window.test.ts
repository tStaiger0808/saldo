import { describe, expect, it } from "vitest";
import { gapBefore, inWindow, placeRows, windowTarget } from "./booking-window.ts";

const dates = ["2026-11-10", "2026-11-03", "2026-11-03", "2026-10-28", "2026-10-15"];
const october = { from: "2026-10-01", to: "2026-10-31" };

describe("booking window", () => {
  it("includes both ends of the window", () => {
    expect(inWindow("2026-10-01", october)).toBe(true);
    expect(inWindow("2026-10-31", october)).toBe(true);
    expect(inWindow("2026-11-01", october)).toBe(false);
    expect(inWindow("2026-09-30", october)).toBe(false);
  });

  it("finds the window's newest loaded booking", () => {
    expect(windowTarget(dates, 0, false, october)).toBe(3);
    expect(windowTarget(dates, 0, false, { from: "2026-11-01", to: "2026-11-05" })).toBe(1);
    expect(windowTarget(dates, 0, true, { from: "2026-11-01", to: "2026-11-30" })).toBe(0);
  });

  it("reports a window without bookings", () => {
    expect(windowTarget(dates, 0, false, { from: "2026-11-04", to: "2026-11-08" })).toBe("none");
    expect(windowTarget(dates, 0, true, { from: "2026-09-01", to: "2026-09-30" })).toBe("none");
    expect(windowTarget([], 0, true, october)).toBe("none");
  });

  it("asks to fetch when the window's newest booking may not be loaded", () => {
    expect(windowTarget(dates, 0, false, { from: "2026-09-01", to: "2026-09-30" })).toBe("fetch");
    expect(windowTarget(dates, 100, false, { from: "2026-11-01", to: "2026-11-30" })).toBe("fetch");
    expect(windowTarget(dates, 100, false, october)).toBe(3);
  });

  it("appends close rows and jumps to far ones", () => {
    expect(gapBefore({ start: 0, length: 50 }, 50, 200)).toEqual({ offset: 50, limit: 0 });
    expect(gapBefore({ start: 0, length: 50 }, 180, 200)).toEqual({ offset: 50, limit: 130 });
    expect(gapBefore({ start: 0, length: 50 }, 251, 200)).toBeNull();
    expect(gapBefore({ start: 100, length: 50 }, 40, 200)).toBeNull();
  });

  it("places fetched rows after the gap or on their own", () => {
    const run = { items: ["a", "b", "c"], start: 10, nextOffset: 13 };
    expect(placeRows(run, ["f", "g"], 15, 17, ["d", "e"])).toEqual({
      items: ["a", "b", "c", "d", "e", "f", "g"],
      start: 10,
      nextOffset: 17,
    });
    expect(placeRows(run, ["b2", "c2"], 11, null, [])).toEqual({ items: ["a", "b2", "c2"], start: 10, nextOffset: null });
    expect(placeRows(run, ["x", "y"], 400, 402, null)).toEqual({ items: ["x", "y"], start: 400, nextOffset: 402 });
  });
});
