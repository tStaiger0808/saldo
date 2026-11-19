/**
 * Contract views: tabs on the contracts page, each a name and a set of accounts. They only narrow what a person may see
 * anyway; accounts they lose access to drop out whenever a view is used. The owner may share a view with the household
 * or chosen people. A recipient uses it read-only and only ever gets the accounts both they and the owner see now, so a
 * shared view never shows them anything of an account they could not open themselves.
 */
import { and, asc, eq, inArray, max, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { CONTRACT_VIEW_SHARING, type ContractViewSharing } from "../../../lib/contract-preferences.ts";
import type { Db } from "../../db/index.ts";
import { accounts, contractViewHidden, contractViewShares, contractViews, user } from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import { canManage, checkAccounts, resolveView, type Viewer, visibleAccountIds } from "../access/index.ts";
import { listPeople } from "../users/index.ts";

export const contractViewInput = z
  .object({
    name: z.string().trim().min(1, "contracts.views.errors.nameRequired").max(64),
    accountIds: z.array(z.number().int()).min(1, "contracts.views.errors.accountsRequired").max(500),
    sharing: z.enum(CONTRACT_VIEW_SHARING).default("private"),
    /** The people for "people"; ignored otherwise. */
    shareWith: z.array(z.string().min(1).max(100)).max(500).default([]),
  })
  .refine((v) => v.sharing !== "people" || v.shareWith.length > 0, {
    message: "contracts.views.errors.peopleRequired",
    path: ["shareWith"],
  });

export type ContractViewTab = {
  id: number;
  name: string;
  accountIds: number[];
  /** Who shares the view with the viewer; null on the viewer's own views, the only ones they may change. */
  sharedBy: string | null;
  /** The picture of whoever shares the view, if they have one. */
  sharedByAvatar: string | null;
  /** Whom the viewer shares their own view with; null on views shared with them. */
  sharing: { scope: ContractViewSharing; userIds: string[] } | null;
  /** A view shared with the viewer that they chose not to show as a tab. */
  hidden: boolean;
};

type ViewRow = typeof contractViews.$inferSelect;

/** A view as the viewer may use it: their own, or one shared with them narrowed to accounts both sides see now. */
export type ReadableView = { row: ViewRow; accountIds: number[]; own: boolean };

const sharedWith = (viewer: Viewer) =>
  and(
    ne(contractViews.ownerId, viewer.id),
    or(
      eq(contractViews.sharing, "household"),
      and(
        eq(contractViews.sharing, "people"),
        sql`exists (select 1 from ${contractViewShares} where ${contractViewShares.viewId} = ${contractViews.id} and ${contractViewShares.userId} = ${viewer.id})`,
      ),
    ),
  );

/** The accounts each person sees now, by id. */
async function visibleOf(db: Db, ids: readonly string[]): Promise<Map<string, Set<number>>> {
  if (ids.length === 0) return new Map();
  const people = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(inArray(user.id, [...new Set(ids)]));
  return new Map(await Promise.all(people.map(async (p) => [p.id, new Set(await visibleAccountIds(db, p))] as const)));
}

const NOBODY: ReadonlySet<number> = new Set();

const narrowed = (row: ViewRow, ...visible: ReadonlySet<number>[]) => row.accountIds.filter((id) => visible.every((v) => v.has(id)));

/** One's own view or one shared with one; any other is a 404. */
export async function readableContractView(db: Db, viewer: Viewer, id: number): Promise<ReadableView> {
  const [row] = await db
    .select()
    .from(contractViews)
    .where(and(eq(contractViews.id, id), or(eq(contractViews.ownerId, viewer.id), sharedWith(viewer))));
  if (!row) throw new NotFound(msg("contracts.views.errors.notFound"));
  const visible = new Set(await visibleAccountIds(db, viewer));
  if (row.ownerId === viewer.id) return { row, accountIds: narrowed(row, visible), own: true };
  const owner = (await visibleOf(db, [row.ownerId])).get(row.ownerId) ?? NOBODY;
  return { row, accountIds: narrowed(row, visible, owner), own: false };
}

/** Only the owner changes a view: one shared with the viewer is a 403, any other a 404. */
export async function requireContractView(db: Db, viewer: Viewer, id: number): Promise<ViewRow> {
  const view = await readableContractView(db, viewer, id);
  if (!view.own) throw new Forbidden(msg("contracts.views.errors.notYours"));
  return view.row;
}

/** The viewer's own views in their order, then those shared with them, each with the accounts the viewer may use. */
export async function listContractViews(db: Db, viewer: Viewer): Promise<ContractViewTab[]> {
  const visible = new Set(await visibleAccountIds(db, viewer));
  const own = await db
    .select()
    .from(contractViews)
    .where(eq(contractViews.ownerId, viewer.id))
    .orderBy(asc(contractViews.position), asc(contractViews.id));
  const recipients =
    own.length > 0
      ? await db
          .select()
          .from(contractViewShares)
          .where(
            inArray(
              contractViewShares.viewId,
              own.map((v) => v.id),
            ),
          )
      : [];
  const shared = await db.select().from(contractViews).where(sharedWith(viewer)).orderBy(asc(contractViews.name), asc(contractViews.id));
  const owners = await visibleOf(
    db,
    shared.map((v) => v.ownerId),
  );
  const people = new Map((await listPeople(db, viewer)).map((p) => [p.id, p]));
  const hiddenRows = await db
    .select({ viewId: contractViewHidden.viewId })
    .from(contractViewHidden)
    .where(eq(contractViewHidden.userId, viewer.id));
  const hidden = new Set(hiddenRows.map((h) => h.viewId));
  return [
    ...own.map((r) => ({
      id: r.id,
      name: r.name,
      accountIds: narrowed(r, visible),
      sharedBy: null,
      sharedByAvatar: null,
      sharing: {
        scope: r.sharing,
        userIds: r.sharing === "people" ? recipients.filter((s) => s.viewId === r.id).map((s) => s.userId) : [],
      },
      hidden: false,
    })),
    ...shared.map((r) => ({
      id: r.id,
      name: r.name,
      accountIds: narrowed(r, visible, owners.get(r.ownerId) ?? NOBODY),
      sharedBy: people.get(r.ownerId)?.username ?? "",
      sharedByAvatar: people.get(r.ownerId)?.avatar ?? null,
      sharing: null,
      hidden: hidden.has(r.id),
    })),
  ];
}

async function checkPeople(db: Db, viewer: Viewer, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, [...ids]), ne(user.id, viewer.id)));
  if (found.length !== ids.length) throw new UserError(msg("contracts.views.errors.unknownPerson"));
}

/**
 * Creates a view at the end, or changes one of the viewer's own; every account must be one the viewer sees. Whoever is
 * no longer a recipient loses the view together with their choice to hide it.
 */
export async function saveContractView(db: Db, viewer: Viewer, input: z.input<typeof contractViewInput>, id?: number): Promise<number> {
  const data = contractViewInput.parse(input);
  const accountIds = checkAccounts(await resolveView(db, viewer, null), [...new Set(data.accountIds)]);
  const people = data.sharing === "people" ? [...new Set(data.shareWith)] : [];
  await checkPeople(db, viewer, people);
  if (id !== undefined) await requireContractView(db, viewer, id);
  const values = { name: data.name, accountIds, sharing: data.sharing };
  return db.transaction(async (tx) => {
    let saved = id;
    if (saved !== undefined) {
      await tx.update(contractViews).set(values).where(eq(contractViews.id, saved));
    } else {
      const [last] = await tx
        .select({ position: max(contractViews.position) })
        .from(contractViews)
        .where(eq(contractViews.ownerId, viewer.id));
      const [row] = await tx
        .insert(contractViews)
        .values({ ownerId: viewer.id, ...values, position: (last?.position ?? -1) + 1 })
        .returning({ id: contractViews.id });
      if (!row) throw new UserError(msg("contracts.views.errors.saveFailed"));
      saved = row.id;
    }
    const viewId = saved;
    await tx.delete(contractViewShares).where(eq(contractViewShares.viewId, viewId));
    if (people.length > 0) await tx.insert(contractViewShares).values(people.map((userId) => ({ viewId, userId })));
    if (data.sharing === "private") await tx.delete(contractViewHidden).where(eq(contractViewHidden.viewId, viewId));
    if (data.sharing === "people")
      await tx.delete(contractViewHidden).where(and(eq(contractViewHidden.viewId, viewId), notInArray(contractViewHidden.userId, people)));
    return viewId;
  });
}

export async function deleteContractView(db: Db, viewer: Viewer, id: number): Promise<void> {
  await requireContractView(db, viewer, id);
  await db.delete(contractViews).where(eq(contractViews.id, id));
}

export const hideContractViewInput = z.object({ id: z.number().int(), hidden: z.boolean() });

/** Hides a view shared with the viewer from their tabs, or shows it again; one's own views are deleted instead. */
export async function setContractViewHidden(db: Db, viewer: Viewer, input: z.input<typeof hideContractViewInput>): Promise<void> {
  const { id, hidden } = hideContractViewInput.parse(input);
  const view = await readableContractView(db, viewer, id);
  if (view.own) throw new UserError(msg("contracts.views.errors.hideOwn"));
  if (hidden) await db.insert(contractViewHidden).values({ viewId: id, userId: viewer.id }).onConflictDoNothing();
  else await db.delete(contractViewHidden).where(and(eq(contractViewHidden.viewId, id), eq(contractViewHidden.userId, viewer.id)));
}

export const shareCoverageInput = z.object({ accountIds: z.array(z.number().int()).max(500) });

export type ShareCoverage = { userId: string; name: string; hiddenCount: number };

/**
 * For the owner choosing accounts and people: how many of the chosen accounts each other person does not see, listing
 * only those who miss some. Counts only, of accounts the viewer sees, so no account is named.
 */
export async function contractViewShareCoverage(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof shareCoverageInput>,
): Promise<ShareCoverage[]> {
  const { accountIds } = shareCoverageInput.parse(input);
  const requested = checkAccounts(await resolveView(db, viewer, null), [...new Set(accountIds)]);
  if (requested.length === 0) return [];
  // Who else sees an account is only told to whoever manages it (owner, superuser, family admin for household ones).
  const owned = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId, visibility: accounts.visibility })
    .from(accounts)
    .where(inArray(accounts.id, requested));
  const chosen = owned.filter((a) => canManage(viewer, a)).map((a) => a.id);
  if (chosen.length === 0) return [];
  const people = await listPeople(db, viewer);
  const visible = await visibleOf(
    db,
    people.map((p) => p.id),
  );
  return people.flatMap((p) => {
    const sees = visible.get(p.id) ?? NOBODY;
    const hiddenCount = chosen.filter((id) => !sees.has(id)).length;
    return hiddenCount > 0 ? [{ userId: p.id, name: p.username, hiddenCount }] : [];
  });
}
