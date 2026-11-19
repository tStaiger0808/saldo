import { describe, expect, it } from "vitest";
import { latestSlot, nextSlot } from "./schedule.ts";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const plan = { frequency: "daily" as const, time: "03:30", weekday: 1, monthDay: 1 as number | "last" };

describe("backup schedule", () => {
  it("is never due while off", () => {
    expect(latestSlot({ ...plan, frequency: "off" }, local(2026, 11, 19, 12))).toBeNull();
    expect(nextSlot({ ...plan, frequency: "off" }, local(2026, 11, 19, 12))).toBeNull();
  });

  it("runs daily at the chosen time", () => {
    expect(latestSlot(plan, local(2026, 11, 19, 3, 29))).toEqual(local(2026, 11, 18, 3, 30));
    expect(latestSlot(plan, local(2026, 11, 19, 3, 30))).toEqual(local(2026, 11, 19, 3, 30));
    expect(nextSlot(plan, local(2026, 11, 19, 3, 30))).toEqual(local(2026, 11, 20, 3, 30));
  });

  it("runs weekly on the chosen ISO weekday", () => {
    const sunday = { ...plan, frequency: "weekly" as const, weekday: 7 };
    // 2026-11-19 is a Thursday.
    expect(latestSlot(sunday, local(2026, 11, 19, 12))).toEqual(local(2026, 11, 15, 3, 30));
    expect(nextSlot(sunday, local(2026, 11, 19, 12))).toEqual(local(2026, 11, 22, 3, 30));
    const thursday = { ...sunday, weekday: 4 };
    expect(latestSlot(thursday, local(2026, 11, 19, 12))).toEqual(local(2026, 11, 19, 3, 30));
    expect(nextSlot(thursday, local(2026, 11, 19, 12))).toEqual(local(2026, 11, 26, 3, 30));
  });

  it("runs monthly on a day or the last day of each month", () => {
    const fifteenth = { ...plan, frequency: "monthly" as const, monthDay: 15 };
    expect(latestSlot(fifteenth, local(2026, 11, 10))).toEqual(local(2026, 10, 15, 3, 30));
    expect(nextSlot(fifteenth, local(2026, 11, 10))).toEqual(local(2026, 11, 15, 3, 30));
    const last = { ...plan, frequency: "monthly" as const, monthDay: "last" as const };
    expect(nextSlot(last, local(2027, 2, 2))).toEqual(local(2027, 2, 28, 3, 30));
    expect(latestSlot(last, local(2027, 1, 15))).toEqual(local(2026, 12, 31, 3, 30));
    expect(nextSlot(last, local(2026, 12, 31, 4))).toEqual(local(2027, 1, 31, 3, 30));
  });
});
