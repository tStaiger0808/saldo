import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware, householdAdminMiddleware } from "../middleware.ts";
import * as catalog from "../modules/catalog/index.ts";

const idOnly = z.object({ id: z.number().int() });
const optionalId = { id: z.number().int().optional() };

export const getCategories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => catalog.listCategories(db()));

export const saveCategoryFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(catalog.categoryInput.extend(optionalId))
  .handler(({ data: { id, ...input }, context }) => catalog.saveCategory(db(), context.user, input, id));

export const deleteCategoryFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => catalog.deleteCategory(db(), context.user, data.id));

export const getTags = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => catalog.listTags(db()));

export const saveTagFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(catalog.tagInput.extend(optionalId))
  .handler(({ data: { id, ...input }, context }) => catalog.saveTag(db(), context.user, input, id));

export const deleteTagFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => catalog.deleteTag(db(), context.user, data.id));

export const getTagOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => catalog.tagOverview(db(), context.user));

export const mergeTagFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(catalog.mergeTagInput)
  .handler(({ data, context }) => catalog.mergeTag(db(), context.user, data));

export const getRules = createServerFn({ method: "GET" })
  .middleware([householdAdminMiddleware])
  .handler(({ context }) => catalog.listRules(db(), context.user));

export const saveRuleFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(catalog.ruleInput.extend(optionalId))
  .handler(({ data: { id, ...input }, context }) => catalog.saveRule(db(), context.user, input, id));

export const deleteRuleFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => catalog.deleteRule(db(), context.user, data.id));

export const previewRuleFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(catalog.previewInput)
  .handler(({ data, context }) => catalog.previewRule(db(), context.user, data));
