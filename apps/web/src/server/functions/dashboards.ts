import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import {
  dashboardInput,
  deleteDashboard,
  listDashboards,
  periodInput,
  saveDashboard,
  setDashboardPeriod,
} from "../modules/dashboards/index.ts";

export const getDashboards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listDashboards(db(), context.user));

export const saveDashboardFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(dashboardInput.extend({ id: z.number().int().optional() }))
  .handler(({ data: { id, ...input }, context }) => saveDashboard(db(), context.user, input, id));

export const deleteDashboardFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int() }))
  .handler(({ data, context }) => deleteDashboard(db(), context.user, data.id));

export const setDashboardPeriodFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(periodInput)
  .handler(({ data, context }) => setDashboardPeriod(db(), context.user, data));
