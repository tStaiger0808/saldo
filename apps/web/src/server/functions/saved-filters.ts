import { createServerFn } from "@tanstack/react-start";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import {
  createInput,
  createSavedFilter,
  deleteInput,
  deleteSavedFilter,
  listSavedFilters,
  scopeInput,
  updateInput,
  updateSavedFilter,
} from "../modules/saved-filters/index.ts";

export const getSavedFiltersFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(scopeInput)
  .handler(({ data, context }) => listSavedFilters(db(), context.user, data));

export const createSavedFilterFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createInput)
  .handler(({ data, context }) => createSavedFilter(db(), context.user, data));

export const updateSavedFilterFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(updateInput)
  .handler(({ data, context }) => updateSavedFilter(db(), context.user, data));

export const deleteSavedFilterFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(deleteInput)
  .handler(({ data, context }) => deleteSavedFilter(db(), context.user, data));
