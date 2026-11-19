import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import {
  filterInput,
  listInput,
  listPendingBookings,
  listTransactions,
  markAllRead,
  patchInput,
  patchTransaction,
} from "../modules/transactions/index.ts";

export const getTransactions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(listInput)
  .handler(({ data, context }) => listTransactions(db(), context.user, data));

export const getPendingBookingsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(filterInput)
  .handler(({ data, context }) => listPendingBookings(db(), context.user, data));

export const patchTransactionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(patchInput)
  .handler(({ data, context }) => patchTransaction(db(), context.user, data));

export const markAllReadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ groupId: z.number().int().nullish(), accountId: z.number().int().positive().nullish() }))
  .handler(({ data, context }) => markAllRead(db(), context.user, data.groupId, data.accountId));
