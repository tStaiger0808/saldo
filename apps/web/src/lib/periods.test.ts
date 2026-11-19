import { describe, expect, it } from "vitest";
import { cardRange, monthSpan, previousRange, resolveDashboardPeriod, resolvePeriod } from "./periods.ts";

const today = new Date(2026, 10, 16);

describe("periods", () => {
  it("resolves presets relative to today", () => {
    expect(resolvePeriod("this_month", today)).toEqual({ dateFrom: "2026-11-01", dateTo: "2026-11-16" });
    expect(resolvePeriod("last_month", today)).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(resolvePeriod("last_12_months", today)).toEqual({ dateFrom: "2025-12-01", dateTo: "2026-11-16" });
    expect(resolvePeriod("last_year", today)).toEqual({ dateFrom: "2025-01-01", dateTo: "2025-12-31" });
  });

  it("shifts a range by its own length and keeps month ends", () => {
    expect(monthSpan({ dateFrom: "2026-09-01", dateTo: "2026-11-16" })).toBe(3);
    expect(previousRange({ dateFrom: "2026-09-01", dateTo: "2026-11-16" })).toEqual({ dateFrom: "2026-06-01", dateTo: "2026-08-16" });
    expect(previousRange({ dateFrom: "2026-03-01", dateTo: "2026-03-31" })).toEqual({ dateFrom: "2026-02-01", dateTo: "2026-02-28" });
  });

  it("resolves dashboard periods, the future ones as forecasts", () => {
    expect(resolveDashboardPeriod("next_month", null, today)).toEqual({ dateFrom: "2026-12-01", dateTo: "2026-12-31", forecast: true });
    expect(resolveDashboardPeriod("next_month", null, new Date(2027, 0, 31))).toEqual({
      dateFrom: "2027-02-01",
      dateTo: "2027-02-28",
      forecast: true,
    });
    expect(resolveDashboardPeriod("last_30_days", null, today)).toEqual({ dateFrom: "2026-10-18", dateTo: "2026-11-16", forecast: false });
    expect(resolveDashboardPeriod("this_month", null, today)).toEqual({ dateFrom: "2026-11-01", dateTo: "2026-11-16", forecast: false });
    expect(resolveDashboardPeriod("custom", { dateFrom: "2026-05-01", dateTo: "2026-06-15" }, today)).toEqual({
      dateFrom: "2026-05-01",
      dateTo: "2026-06-15",
      forecast: false,
    });
    expect(resolveDashboardPeriod("custom", { dateFrom: "2027-01-01", dateTo: "2027-03-31" }, today).forecast).toBe(true);
    expect(resolveDashboardPeriod("custom", { dateFrom: "2026-06-15", dateTo: "2026-05-01" }, today).dateFrom).toBe("2026-11-01");
  });

  it("lets cards follow the dashboard unless they have a period of their own", () => {
    const next = resolveDashboardPeriod("next_month", null, today);
    expect(cardRange("dashboard", next, today)).toBe(next);
    expect(cardRange("last_12_months", next, today)).toEqual({ dateFrom: "2025-12-01", dateTo: "2026-11-16", forecast: false });
  });
});
