import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import {
  acceptSuggestion,
  contractDraftFromBooking,
  contractForecast,
  contractInput,
  contractPreferencesInput,
  contractSuggestionOverview,
  contractsOverview,
  contractViewInput,
  contractViewShareCoverage,
  deleteContract,
  deleteContractDocument,
  deleteContractView,
  dismissInput,
  dismissSuggestion,
  documentIdInput,
  forecastInput,
  getContract,
  hideContractViewInput,
  listContractViews,
  markDueSeen,
  restoreSuggestion,
  saveContract,
  saveContractPreferences,
  saveContractView,
  setContractViewHidden,
  shareCoverageInput,
  suggestionInput,
  unseenDueCount,
  viewInput,
} from "../modules/contracts/index.ts";

const idInput = z.object({ id: z.number().int() });

export const getContractsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(viewInput)
  .handler(({ data, context }) => contractsOverview(db(), context.user, data));

export const getContractSuggestionsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(viewInput)
  .handler(({ data, context }) => contractSuggestionOverview(db(), context.user, data));

export const getContractViewsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listContractViews(db(), context.user));

export const getContractViewShareCoverageFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(shareCoverageInput)
  .handler(({ data, context }) => contractViewShareCoverage(db(), context.user, data));

export const getUnseenDueCountFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => unseenDueCount(db(), context.user));

export const getContractFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(({ data, context }) => getContract(db(), context.user, data.id));

export const getContractDraftFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ transactionId: z.number().int() }))
  .handler(({ data, context }) => contractDraftFromBooking(db(), context.user, data.transactionId));

export const getContractForecastFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(forecastInput)
  .handler(({ data, context }) => contractForecast(db(), context.user, data));

export const saveContractFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int().optional(), contract: contractInput }))
  .handler(({ data, context }) => saveContract(db(), context.user, data.contract, data.id));

export const deleteContractFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(({ data, context }) => deleteContract(db(), context.user, data.id));

export const acceptSuggestionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(suggestionInput)
  .handler(({ data, context }) => acceptSuggestion(db(), context.user, data));

export const dismissSuggestionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(dismissInput)
  .handler(({ data, context }) => dismissSuggestion(db(), context.user, data));

export const restoreSuggestionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(dismissInput)
  .handler(({ data, context }) => restoreSuggestion(db(), context.user, data));

export const saveContractViewFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int().optional(), view: contractViewInput }))
  .handler(({ data, context }) => saveContractView(db(), context.user, data.view, data.id));

export const deleteContractViewFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(({ data, context }) => deleteContractView(db(), context.user, data.id));

export const hideContractViewFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(hideContractViewInput)
  .handler(({ data, context }) => setContractViewHidden(db(), context.user, data));

export const saveContractPreferencesFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(contractPreferencesInput)
  .handler(({ data, context }) => saveContractPreferences(db(), context.user, data));

export const markDueSeenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => markDueSeen(db(), context.user));

export const deleteContractDocumentFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(documentIdInput)
  .handler(({ data, context }) => deleteContractDocument(db(), context.user, data.id));
