/**
 * Booking filters a person saved under a name. They are private: every query is bound to the viewer, so someone
 * else's filter does not exist for them. The ids inside a filter are not checked here; applying it goes through
 * modules/access like every other list request.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { type BookingFilter, bookingFilterSchema } from "../../../lib/booking-filter.ts";
import type { Db } from "../../db/index.ts";
import { SAVED_FILTER_SCOPES, type SavedFilterScope, savedFilters } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import type { Viewer } from "../access/index.ts";

export type SavedFilter = { id: number; name: string; filter: BookingFilter; isDefault: boolean };

const name = z.string().trim().min(1, "savedFilters.errors.nameRequired").max(60);

export const scopeInput = z.object({ scope: z.enum(SAVED_FILTER_SCOPES) });
export const createInput = scopeInput.extend({ name, filter: bookingFilterSchema, isDefault: z.boolean().default(false) });
export const updateInput = z.object({
  id: z.number().int(),
  name: name.optional(),
  filter: bookingFilterSchema.optional(),
  isDefault: z.boolean().optional(),
});
export const deleteInput = z.object({ id: z.number().int() });

/** On an account's page the account is fixed, so its filters carry neither an account nor a group. */
function forScope(scope: SavedFilterScope, filter: BookingFilter): BookingFilter {
  if (scope === "transactions") return filter;
  const { accountId: _account, groupId: _group, ...rest } = filter;
  return rest;
}

const view = (row: typeof savedFilters.$inferSelect): SavedFilter => ({
  id: row.id,
  name: row.name,
  filter: bookingFilterSchema.catch({}).parse(row.filter),
  isDefault: row.isDefault,
});

export async function listSavedFilters(db: Db, viewer: Viewer, input: z.input<typeof scopeInput>): Promise<SavedFilter[]> {
  const { scope } = scopeInput.parse(input);
  const rows = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.userId, viewer.id), eq(savedFilters.scope, scope)))
    .orderBy(asc(savedFilters.createdAt), asc(savedFilters.id));
  return rows.map(view);
}

async function owned(db: Db, viewer: Viewer, id: number) {
  const [row] = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, viewer.id)));
  if (!row) throw new NotFound(msg("savedFilters.errors.notFound"));
  return row;
}

async function requireFreeName(db: Db, viewer: Viewer, scope: SavedFilterScope, name: string, except?: number): Promise<void> {
  const [taken] = await db
    .select({ id: savedFilters.id })
    .from(savedFilters)
    .where(
      and(
        eq(savedFilters.userId, viewer.id),
        eq(savedFilters.scope, scope),
        eq(savedFilters.name, name),
        except === undefined ? undefined : ne(savedFilters.id, except),
      ),
    );
  if (taken) throw new UserError(msg("savedFilters.errors.nameTaken", { name }), 409);
}

/** At most one default per page: making one the default clears the others in the same transaction. */
async function clearDefault(db: Db, viewer: Viewer, scope: SavedFilterScope): Promise<void> {
  await db
    .update(savedFilters)
    .set({ isDefault: false })
    .where(and(eq(savedFilters.userId, viewer.id), eq(savedFilters.scope, scope), eq(savedFilters.isDefault, true)));
}

export async function createSavedFilter(db: Db, viewer: Viewer, input: z.input<typeof createInput>): Promise<SavedFilter> {
  const data = createInput.parse(input);
  await requireFreeName(db, viewer, data.scope, data.name);
  return db.transaction(async (tx) => {
    if (data.isDefault) await clearDefault(tx, viewer, data.scope);
    const [row] = await tx
      .insert(savedFilters)
      .values({
        userId: viewer.id,
        scope: data.scope,
        name: data.name,
        filter: forScope(data.scope, data.filter),
        isDefault: data.isDefault,
      })
      .returning();
    if (!row) throw new UserError(msg("common.genericError"));
    return view(row);
  });
}

/** Renames, overwrites with another filter or (un)sets the default; fields left out stay. */
export async function updateSavedFilter(db: Db, viewer: Viewer, input: z.input<typeof updateInput>): Promise<SavedFilter> {
  const data = updateInput.parse(input);
  const row = await owned(db, viewer, data.id);
  if (data.name !== undefined) await requireFreeName(db, viewer, row.scope, data.name, row.id);
  return db.transaction(async (tx) => {
    if (data.isDefault) await clearDefault(tx, viewer, row.scope);
    const update: Partial<typeof savedFilters.$inferInsert> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.filter !== undefined) update.filter = forScope(row.scope, data.filter);
    if (data.isDefault !== undefined) update.isDefault = data.isDefault;
    if (Object.keys(update).length === 0) return view(row);
    const [saved] = await tx.update(savedFilters).set(update).where(eq(savedFilters.id, row.id)).returning();
    if (!saved) throw new NotFound(msg("savedFilters.errors.notFound"));
    return view(saved);
  });
}

export async function deleteSavedFilter(db: Db, viewer: Viewer, input: z.input<typeof deleteInput>): Promise<void> {
  const row = await owned(db, viewer, deleteInput.parse(input).id);
  await db.delete(savedFilters).where(eq(savedFilters.id, row.id));
}
