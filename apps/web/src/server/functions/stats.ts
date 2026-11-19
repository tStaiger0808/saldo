import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import * as stats from "../modules/stats/index.ts";

const range = stats.rangeInput;

export const getSummary = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(range)
  .handler(({ data, context }) => stats.summary(db(), context.user, data));

export const getMonthly = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(range)
  .handler(({ data, context }) => stats.monthly(db(), context.user, data));

export const getCategoryTotals = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ range, kind: z.enum(["expense", "income", "savings"]).default("expense") }))
  .handler(({ data, context }) => stats.categoryTotals(db(), context.user, data.range, data.kind));

export const getSeries = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ range, groupBy: z.enum(["category", "tag"]), ids: z.array(z.number().int()).max(50).default([]) }))
  .handler(({ data, context }) => stats.series(db(), context.user, data.range, data.groupBy, data.ids));

export const getTopCounterparties = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ range, limit: z.number().int().min(1).max(50).default(10) }))
  .handler(({ data, context }) => stats.topCounterparties(db(), context.user, data.range, data.limit));

export const getRecurring = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(range)
  .handler(({ data, context }) => stats.recurringPayments(db(), context.user, data));

export const getBalances = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ groupId: z.number().int().nullish() }))
  .handler(({ data, context }) => stats.balances(db(), context.user, data.groupId));
