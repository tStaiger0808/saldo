import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { ensureDefaultDashboards, listDashboards, saveDashboard, setDashboardPeriod } from "./index.ts";

describe("dashboard period", () => {
  let lena: Viewer;
  let max: Viewer;

  beforeEach(async () => {
    await resetDb();
    lena = await makeUser("lena", "familyAdmin");
    max = await makeUser("max", "familyAdmin");
    await ensureDefaultDashboards(db(), lena);
    await ensureDefaultDashboards(db(), max);
  });

  it("starts with this month and keeps each person's choice per dashboard", async () => {
    const [first] = await listDashboards(db(), lena);
    expect(first).toMatchObject({ period: "this_month", periodFrom: null, periodTo: null });
    const second = await saveDashboard(db(), lena, { name: "Zweites", groupId: null, cards: [] });

    await setDashboardPeriod(db(), lena, { id: first?.id ?? -1, period: "next_month" });
    await setDashboardPeriod(db(), lena, { id: second, period: "custom", dateFrom: "2026-01-01", dateTo: "2026-03-31" });
    const mine = await listDashboards(db(), lena);
    expect(mine.map((d) => [d.name, d.period, d.periodFrom, d.periodTo])).toEqual([
      ["Alle Konten", "next_month", null, null],
      ["Zweites", "custom", "2026-01-01", "2026-03-31"],
    ]);
    // Someone else's dashboards are their own: theirs are untouched, and Lena's are a 404 for them.
    expect((await listDashboards(db(), max)).map((d) => d.period)).toEqual(["this_month"]);
    await expect(setDashboardPeriod(db(), max, { id: second, period: "last_year" })).rejects.toMatchObject({ status: 404 });

    // Editing the cards keeps the period; a preset drops the custom dates.
    await saveDashboard(db(), lena, { name: "Zweites", groupId: null, cards: [] }, second);
    expect((await listDashboards(db(), lena))[1]).toMatchObject({ period: "custom", periodFrom: "2026-01-01" });
    await setDashboardPeriod(db(), lena, { id: second, period: "last_30_days", dateFrom: "2026-01-01", dateTo: "2026-03-31" });
    expect((await listDashboards(db(), lena))[1]).toMatchObject({ period: "last_30_days", periodFrom: null, periodTo: null });
  });

  it("needs both dates in order for a custom range", async () => {
    const [first] = await listDashboards(db(), lena);
    const id = first?.id ?? -1;
    await expect(setDashboardPeriod(db(), lena, { id, period: "custom", dateFrom: "2026-01-01" })).rejects.toThrow();
    await expect(setDashboardPeriod(db(), lena, { id, period: "custom", dateFrom: "2026-03-01", dateTo: "2026-01-01" })).rejects.toThrow();
    await expect(setDashboardPeriod(db(), lena, { id, period: "next_year" as "next_month" })).rejects.toThrow();
  });
});

describe("default dashboards", () => {
  beforeEach(resetDb);

  it("are set up once, not by reading", async () => {
    const lena = await makeUser("lena", "familyAdmin");
    expect(await listDashboards(db(), lena)).toEqual([]);
    await ensureDefaultDashboards(db(), lena);
    await ensureDefaultDashboards(db(), lena);
    expect((await listDashboards(db(), lena)).map((d) => [d.name, d.groupId])).toEqual([["Alle Konten", null]]);
  });
});
