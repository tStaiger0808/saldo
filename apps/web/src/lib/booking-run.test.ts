import { describe, expect, it } from "vitest";
import { chunkRanges, offsetAfter, unseenRows } from "./booking-run.ts";

const rows = (...ids: number[]) => ids.map((id) => ({ id }));

describe("booking run", () => {
  it("keeps only rows not loaded yet, in their order", () => {
    expect(unseenRows(rows(1, 2, 3), rows(3, 4, 5))).toEqual(rows(4, 5));
    expect(unseenRows(rows(1, 2), rows(2, 1))).toEqual([]);
    expect(unseenRows([], rows(7, 6))).toEqual(rows(7, 6));
  });

  it("splits a range into requests the server accepts", () => {
    expect(chunkRanges(50, 330, 200)).toEqual([
      { offset: 50, limit: 200 },
      { offset: 250, limit: 130 },
    ]);
    expect(chunkRanges(0, 200, 200)).toEqual([{ offset: 0, limit: 200 }]);
    expect(chunkRanges(120, 0, 200)).toEqual([]);
    expect(chunkRanges(10, -5, 200)).toEqual([]);
  });

  it("continues after the loaded rows until the total", () => {
    expect(offsetAfter(50, 324)).toBe(50);
    expect(offsetAfter(324, 324)).toBeNull();
    expect(offsetAfter(60, 50)).toBeNull();
  });
});
