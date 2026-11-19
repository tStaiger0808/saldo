import { ruleApplies, tagKey } from "@saldo/core";
import { asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db, Tx } from "../../db/index.ts";
import { categories, rules, ruleTags, tags, transactions, transactionTags } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { requireHouseholdAdmin, type Viewer, visibleAccountIds } from "../access/index.ts";
import { reclassifyAll } from "../classification/index.ts";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "settings.errors.colorFormat");
export const categoryInput = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(["expense", "income", "savings"]),
  color: hexColor,
});
export const tagInput = z.object({ name: z.string().trim().min(1).max(64), color: hexColor });
export const ruleInput = z.object({
  pattern: z.string().trim().min(2).max(200),
  field: z.enum(["any", "counterparty", "purpose"]).default("any"),
  direction: z.enum(["any", "out", "in"]).default("any"),
  categoryId: z.number().int().nullish(),
  tagIds: z.array(z.number().int()).max(20).default([]),
  priority: z.number().int().min(0).max(1000).default(100),
});

export const listCategories = (db: Db) => db.select().from(categories).orderBy(asc(categories.position), asc(categories.name));
export const listTags = (db: Db) =>
  db.select({ id: tags.id, name: tags.name, color: tags.color, createdBy: tags.createdBy }).from(tags).orderBy(asc(tags.name));

async function unique<T extends typeof categories | typeof tags>(db: Db, table: T, name: string, exceptId?: number): Promise<void> {
  const [row] = await db
    .select({ id: table.id })
    .from(table as typeof categories)
    .where(eq((table as typeof categories).name, name));
  if (row && row.id !== exceptId) throw new UserError(msg("settings.errors.nameTaken"), 409);
}

export async function saveCategory(db: Db, viewer: Viewer, input: z.input<typeof categoryInput>, id?: number): Promise<number> {
  requireHouseholdAdmin(viewer);
  const data = categoryInput.parse(input);
  await unique(db, categories, data.name, id);
  if (id === undefined) {
    const position = (await db.select({ id: categories.id }).from(categories)).length;
    const [row] = await db
      .insert(categories)
      .values({ ...data, position })
      .returning({ id: categories.id });
    return row?.id ?? -1;
  }
  const updated = await db.update(categories).set(data).where(eq(categories.id, id)).returning({ id: categories.id });
  if (updated.length === 0) throw new NotFound(msg("settings.errors.categoryNotFound"));
  return id;
}

export async function deleteCategory(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireHouseholdAdmin(viewer);
  if ((await db.delete(categories).where(eq(categories.id, id)).returning({ id: categories.id })).length === 0)
    throw new NotFound(msg("settings.errors.categoryNotFound"));
  await reclassifyAll(db);
}

export async function saveTag(db: Db, viewer: Viewer, input: z.input<typeof tagInput>, id?: number): Promise<number> {
  requireHouseholdAdmin(viewer);
  const data = tagInput.parse(input);
  await unique(db, tags, data.name, id);
  if (id === undefined) return (await db.insert(tags).values(data).returning({ id: tags.id }))[0]?.id ?? -1;
  if ((await db.update(tags).set(data).where(eq(tags.id, id)).returning({ id: tags.id })).length === 0)
    throw new NotFound(msg("settings.errors.tagNotFound"));
  return id;
}

/** Swaps tag `from` for `to` (or drops it) in the manual and AI tag lists of every booking that carries it. */
async function replaceBookingTag(db: Db | Tx, from: number, to: number | null): Promise<void> {
  const carries = (column: typeof transactions.manualTagIds | typeof transactions.aiTagIds) =>
    sql`${column} @> ${JSON.stringify([from])}::jsonb`;
  const swap = (ids: number[]) => [...new Set(ids.flatMap((id) => (id !== from ? [id] : to === null ? [] : [to])))].sort((a, b) => a - b);
  const rows = await db
    .select({ id: transactions.id, manualTagIds: transactions.manualTagIds, aiTagIds: transactions.aiTagIds })
    .from(transactions)
    .where(or(carries(transactions.manualTagIds), carries(transactions.aiTagIds)) as SQL);
  for (const row of rows) {
    await db
      .update(transactions)
      .set({ manualTagIds: swap(row.manualTagIds), aiTagIds: swap(row.aiTagIds) })
      .where(eq(transactions.id, row.id));
  }
}

export async function deleteTag(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireHouseholdAdmin(viewer);
  if ((await db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id })).length === 0)
    throw new NotFound(msg("settings.errors.tagNotFound"));
  await replaceBookingTag(db, id, null);
  await reclassifyAll(db);
}

export type TagOverview = { id: number; name: string; color: string; createdBy: "user" | "ai"; bookings: number };

/** All tags with who created them and how many of the viewer's visible bookings carry each. */
export async function tagOverview(db: Db, viewer: Viewer): Promise<TagOverview[]> {
  const visible = await visibleAccountIds(db, viewer);
  const counts =
    visible.length === 0
      ? []
      : await db
          .select({ tagId: transactionTags.tagId, bookings: sql<number>`count(*)::int` })
          .from(transactionTags)
          .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
          .where(inArray(transactions.accountId, visible))
          .groupBy(transactionTags.tagId);
  const byTag = new Map(counts.map((c) => [c.tagId, c.bookings]));
  return (await listTags(db)).map((t) => ({ ...t, bookings: byTag.get(t.id) ?? 0 }));
}

export const mergeTagInput = z.object({ id: z.number().int(), intoId: z.number().int() });

/** Moves every booking and rule of tag `id` to tag `intoId` and deletes `id`; manual and AI assignments keep their source. */
export async function mergeTag(db: Db, viewer: Viewer, input: z.input<typeof mergeTagInput>): Promise<void> {
  requireHouseholdAdmin(viewer);
  const { id, intoId } = mergeTagInput.parse(input);
  if (id === intoId) throw new UserError(msg("settings.errors.mergeSameTag"));
  const found = await db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.id, [id, intoId]));
  if (found.length !== 2) throw new NotFound(msg("settings.errors.tagNotFound"));
  await db.transaction(async (tx) => {
    const links = await tx.select({ ruleId: ruleTags.ruleId }).from(ruleTags).where(eq(ruleTags.tagId, id));
    if (links.length > 0)
      await tx
        .insert(ruleTags)
        .values(links.map((l) => ({ ruleId: l.ruleId, tagId: intoId })))
        .onConflictDoNothing();
    await replaceBookingTag(tx, id, intoId);
    await tx.delete(tags).where(eq(tags.id, id));
  });
  await reclassifyAll(db);
}

const AI_TAG_COLORS = ["#3f7cac", "#8a5a9e", "#c0763a", "#4f8a5b", "#b0535e", "#5a6f8f", "#9a8a3c", "#3e8f8c"];

/**
 * Tags for names the AI proposed: an existing tag of the same normalized name is reused, otherwise one is created and
 * marked as created by the AI. Returns the ids in the order of `names` and how many tags were new.
 */
export async function ensureAiTags(db: Db, names: readonly string[]): Promise<{ ids: number[]; created: number }> {
  const known = new Map((await listTags(db)).map((t) => [tagKey(t.name), t.id]));
  const ids: number[] = [];
  let created = 0;
  for (const name of names) {
    const key = tagKey(name);
    let id = known.get(key);
    if (id === undefined) {
      const color = AI_TAG_COLORS[(known.size + created) % AI_TAG_COLORS.length] ?? "#3f7cac";
      const [row] = await db.insert(tags).values({ name, color, createdBy: "ai" }).onConflictDoNothing().returning({ id: tags.id });
      if (row) created += 1;
      id = row?.id ?? (await db.select({ id: tags.id }).from(tags).where(eq(tags.name, name)))[0]?.id;
      if (id === undefined) continue;
      known.set(key, id);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, created };
}

export type RuleRow = typeof rules.$inferSelect & { tagIds: number[] };

export async function listRules(db: Db, viewer: Viewer): Promise<RuleRow[]> {
  requireHouseholdAdmin(viewer);
  const rows = await db.select().from(rules).orderBy(asc(rules.priority), asc(rules.pattern));
  const links = await db.select().from(ruleTags);
  return rows.map((r) => ({ ...r, tagIds: links.filter((l) => l.ruleId === r.id).map((l) => l.tagId) }));
}

export async function saveRule(db: Db, viewer: Viewer, input: z.input<typeof ruleInput>, id?: number): Promise<number> {
  requireHouseholdAdmin(viewer);
  const data = ruleInput.parse(input);
  if (data.categoryId == null && data.tagIds.length === 0) throw new UserError(msg("settings.errors.ruleNeedsTarget"));
  const values = {
    pattern: data.pattern,
    field: data.field,
    direction: data.direction,
    categoryId: data.categoryId ?? null,
    priority: data.priority,
  };
  const ruleId = await db.transaction(async (tx) => {
    let target = id;
    if (target === undefined)
      target = (
        await tx
          .insert(rules)
          .values({ ...values, source: "manual" })
          .returning({ id: rules.id })
      )[0]?.id;
    else if ((await tx.update(rules).set(values).where(eq(rules.id, target)).returning({ id: rules.id })).length === 0)
      throw new NotFound(msg("settings.errors.ruleNotFound"));
    if (target === undefined) throw new UserError(msg("settings.errors.ruleSaveFailed"));
    await tx.delete(ruleTags).where(eq(ruleTags.ruleId, target));
    const known = data.tagIds.length > 0 ? await tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, data.tagIds)) : [];
    if (known.length > 0) await tx.insert(ruleTags).values(known.map((t) => ({ ruleId: target, tagId: t.id })));
    return target;
  });
  await reclassifyAll(db);
  return ruleId;
}

export async function deleteRule(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireHouseholdAdmin(viewer);
  if ((await db.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id })).length === 0)
    throw new NotFound(msg("settings.errors.ruleNotFound"));
  await reclassifyAll(db);
}

export const previewInput = ruleInput.pick({ pattern: true, field: true, direction: true });

/** How many of the viewer's visible bookings a rule draft would match, with a few example texts. */
export async function previewRule(db: Db, viewer: Viewer, input: z.input<typeof previewInput>) {
  const draft = previewInput.parse(input);
  requireHouseholdAdmin(viewer);
  const visible = await visibleAccountIds(db, viewer);
  const rows =
    visible.length === 0
      ? []
      : await db
          .select({ counterparty: transactions.counterparty, purpose: transactions.purpose, amountCents: transactions.amountCents })
          .from(transactions)
          .where(inArray(transactions.accountId, visible));
  const hits = rows.filter((t) => ruleApplies({ ...draft, source: "manual" }, t));
  return { matchCount: hits.length, examples: [...new Set(hits.map((t) => t.counterparty || t.purpose))].slice(0, 5) };
}
