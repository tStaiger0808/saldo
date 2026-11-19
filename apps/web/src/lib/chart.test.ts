import { describe, expect, it } from "vitest";
import { barPath, niceTicks } from "./chart.ts";

describe("chart helpers", () => {
  it("returns round ticks that include zero and the maximum", () => {
    const ticks = niceTicks(0, 412_350);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(412_350);
    expect(niceTicks(0, 0).length).toBeGreaterThan(1);
    expect(niceTicks(-50_000, 100_000)[0]).toBeLessThanOrEqual(-50_000);
  });

  it("draws nothing for an empty bar", () => {
    expect(barPath(0, 100, 100, 10)).toBe("");
    expect(barPath(0, 100, 50, 10)).toMatch(/^M0,100V/);
  });
});
