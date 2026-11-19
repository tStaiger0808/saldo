import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { DASHBOARD_PERIODS } from "../../../lib/periods.ts";
import { boundedDate, rangeWithinSpan } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import { dashboards } from "../../db/schema.ts";
import { NotFound } from "../../errors.ts";
import { resolveView, type Viewer, visibleGroups } from "../access/index.ts";
import { ensureDashboards } from "../seed/index.ts";

export const CARD_TYPES = [
  "summary",
  "monthly_trend",
  "category_breakdown",
  "category_trend",
  "tag_trend",
  "recent_transactions",
  "top_counterparties",
  "balances",
  "ai_insight",
  "period_comparison",
  "recurring_payments",
  "category_matrix",
  "ai_usage",
  "ai_chat",
] as const;

export const cardSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(CARD_TYPES),
  title: z.string().max(80),
  width: z.enum(["full", "half", "third"]).default("half"),
  options: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.number()).max(50)])).default({}),
});

export const dashboardInput = z.object({
  name: z.string().trim().min(1).max(64),
  groupId: z.number().int().nullable(),
  cards: z.array(cardSchema).max(40).default([]),
});

/** Sets up the first dashboards of someone who has none; runs at sign-in, since reading never writes. */
export async function ensureDefaultDashboards(db: Db, viewer: Viewer): Promise<void> {
  await ensureDashboards(db, viewer, await visibleGroups(db, viewer));
}

export async function listDashboards(db: Db, viewer: Viewer) {
  const rows = await db
    .select()
    .from(dashboards)
    .where(eq(dashboards.ownerId, viewer.id))
    .orderBy(asc(dashboards.position), asc(dashboards.id));
  const groups = new Set((await visibleGroups(db, viewer)).map((g) => g.id));
  // A group the user lost access to falls back to all visible accounts.
  return rows.map((d) => ({ ...d, groupId: d.groupId !== null && groups.has(d.groupId) ? d.groupId : null }));
}

async function owned(db: Db, viewer: Viewer, id: number) {
  const [row] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, id), eq(dashboards.ownerId, viewer.id)));
  if (!row) throw new NotFound(msg("dashboard.errors.notFound"));
  return row;
}

export async function saveDashboard(db: Db, viewer: Viewer, input: z.input<typeof dashboardInput>, id?: number): Promise<number> {
  const data = dashboardInput.parse(input);
  await resolveView(db, viewer, data.groupId);
  if (id === undefined) {
    const position = (await db.select({ id: dashboards.id }).from(dashboards).where(eq(dashboards.ownerId, viewer.id))).length;
    const [row] = await db
      .insert(dashboards)
      .values({ ...data, ownerId: viewer.id, position })
      .returning({ id: dashboards.id });
    return row?.id ?? -1;
  }
  await owned(db, viewer, id);
  await db.update(dashboards).set(data).where(eq(dashboards.id, id));
  return id;
}

export const periodInput = z
  .object({
    id: z.number().int(),
    period: z.enum(DASHBOARD_PERIODS),
    dateFrom: boundedDate.nullish(),
    dateTo: boundedDate.nullish(),
  })
  .refine((p) => p.period !== "custom" || (p.dateFrom && p.dateTo), { message: "dashboard.errors.customDates", path: ["dateFrom"] })
  .refine((p) => !p.dateFrom || !p.dateTo || p.dateFrom <= p.dateTo, { message: "dashboard.errors.rangeOrder", path: ["dateTo"] })
  .refine(rangeWithinSpan, { message: "errors.rangeTooLong", path: ["dateTo"] });

/** The owner's period of a dashboard; dates are kept only for a custom range. */
export async function setDashboardPeriod(db: Db, viewer: Viewer, input: z.input<typeof periodInput>): Promise<void> {
  const data = periodInput.parse(input);
  await owned(db, viewer, data.id);
  const custom = data.period === "custom";
  await db
    .update(dashboards)
    .set({ period: data.period, periodFrom: custom ? (data.dateFrom ?? null) : null, periodTo: custom ? (data.dateTo ?? null) : null })
    .where(eq(dashboards.id, data.id));
}

export async function deleteDashboard(db: Db, viewer: Viewer, id: number): Promise<void> {
  await owned(db, viewer, id);
  await db.delete(dashboards).where(eq(dashboards.id, id));
}
