import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware, householdAdminMiddleware } from "../middleware.ts";
import {
  accountBookings,
  accountDetail,
  accountInput,
  accountsOverview,
  addManualBooking,
  balanceEntryInput,
  balanceInput,
  balanceTimeline,
  bookingsInput,
  createAccount,
  createGroup,
  deleteAccount,
  deleteBalanceEntry,
  deleteGroup,
  detailInput,
  editAccount,
  editInput,
  getAccountSharing,
  groupInput,
  listAccounts,
  listGroups,
  manualBookingInput,
  recordBalance,
  setAccountSharing,
  sharingInput,
  timelineInput,
  updateAccount,
  updateGroup,
} from "../modules/accounts/index.ts";

const idOnly = z.object({ id: z.number().int() });

export const getAccounts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listAccounts(db(), context.user));

export const saveAccountFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(accountInput.extend({ id: z.number().int().optional() }))
  .handler(async ({ data: { id, ...input }, context }) => {
    if (id === undefined) return createAccount(db(), context.user, input);
    await updateAccount(db(), context.user, id, input);
    return id;
  });

export const deleteAccountFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => deleteAccount(db(), context.user, data.id));

export const getGroups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listGroups(db(), context.user));

export const saveGroupFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(groupInput.extend({ id: z.number().int().optional() }))
  .handler(async ({ data: { id, ...input }, context }) => {
    if (id === undefined) return createGroup(db(), context.user, input);
    await updateGroup(db(), context.user, id, input);
    return id;
  });

export const deleteGroupFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => deleteGroup(db(), context.user, data.id));

export const getAccountsOverviewFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ groupId: z.number().int().nullish() }))
  .handler(({ data, context }) => accountsOverview(db(), context.user, data.groupId));

export const getAccountDetailFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(detailInput)
  .handler(({ data, context }) => accountDetail(db(), context.user, data));

export const getBalanceTimelineFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(timelineInput)
  .handler(({ data, context }) => balanceTimeline(db(), context.user, data));

export const getAccountBookingsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(bookingsInput)
  .handler(({ data, context }) => accountBookings(db(), context.user, data));

export const editAccountFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(editInput)
  .handler(({ data, context }) => editAccount(db(), context.user, data));

export const getAccountSharingFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ accountId: z.number().int() }))
  .handler(({ data, context }) => getAccountSharing(db(), context.user, data.accountId));

export const setAccountSharingFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(sharingInput)
  .handler(({ data, context }) => setAccountSharing(db(), context.user, data));

export const recordBalanceFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(balanceInput)
  .handler(({ data, context }) => recordBalance(db(), context.user, data));

export const deleteBalanceEntryFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(balanceEntryInput)
  .handler(({ data, context }) => deleteBalanceEntry(db(), context.user, data));

export const addManualBookingFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(manualBookingInput)
  .handler(({ data, context }) => addManualBooking(db(), context.user, data));
