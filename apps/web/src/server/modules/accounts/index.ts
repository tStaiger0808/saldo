import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import {
  ACCOUNT_KINDS,
  accountGroupMembers,
  accountGroups,
  accountShares,
  accounts,
  user,
  VISIBILITIES,
  type Visibility,
} from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import {
  accessibleGroupIds,
  canManage,
  canShare,
  type Group,
  isSuperuser,
  managesHousehold,
  requireHouseholdAdmin,
  requireManageableAccount,
  requireVisibleAccount,
  type Viewer,
  visibleAccountIds,
  visibleGroups,
} from "../access/index.ts";
import { record } from "../audit/index.ts";
import { canGroup, type Sharing, sharingOf } from "./sharing.ts";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "settings.errors.colorFormat");

export const accountInput = z.object({
  name: z.string().trim().min(1).max(100),
  bank: z.string().trim().min(1).max(32),
  kind: z.enum(ACCOUNT_KINDS),
  iban: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/, "settings.errors.invalidIban"))
    .nullable()
    .optional(),
  transferPatterns: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
  color: hexColor,
  groupIds: z.array(z.number().int()).default([]),
  /** Members only create private accounts; omitted means household for the household's admins. */
  visibility: z.enum(VISIBILITIES).optional(),
});

export const groupInput = z.object({
  name: z.string().trim().min(1).max(64),
  position: z.number().int().min(0).optional(),
  accountIds: z.array(z.number().int()).optional(),
});

export type AccountRow = typeof accounts.$inferSelect & {
  groupIds: number[];
  manual: boolean;
  canManage: boolean;
  canShare: boolean;
  sharing: Sharing;
};

export async function listAccounts(db: Db, viewer: Viewer): Promise<AccountRow[]> {
  const ids = await visibleAccountIds(db, viewer);
  if (ids.length === 0) return [];
  const rows = await db.select().from(accounts).where(inArray(accounts.id, ids)).orderBy(asc(accounts.name));
  const groups = await visibleGroups(db, viewer);
  const sharing = await sharingOf(db, viewer, rows);
  return rows.map((a) => ({
    ...a,
    groupIds: groups.filter((g) => g.accountIds.includes(a.id)).map((g) => g.id),
    manual: a.connectionId === null,
    canManage: canManage(viewer, a),
    canShare: canShare(viewer, a),
    sharing: sharing.get(a.id) ?? { visibility: a.visibility, owner: null, sharedWith: null },
  }));
}

/** Replaces the account's groups among those the viewer can see; memberships in other groups stay. */
async function setAccountGroups(db: Db, viewer: Viewer, accountId: number, groupIds: number[]): Promise<void> {
  const accessible = await accessibleGroupIds(db, viewer);
  const wanted = [...new Set(groupIds)];
  if (wanted.some((id) => !accessible.includes(id))) throw new UserError(msg("settings.errors.unknownGroup"));
  if (accessible.length > 0) {
    await db
      .delete(accountGroupMembers)
      .where(and(eq(accountGroupMembers.accountId, accountId), inArray(accountGroupMembers.groupId, accessible)));
  }
  if (wanted.length > 0) await db.insert(accountGroupMembers).values(wanted.map((groupId) => ({ accountId, groupId })));
}

/**
 * Members create private accounts only, the household's admins choose. `ownerUserId` is set for accounts of a bank
 * connection, which belong to the connection's owner.
 */
export async function createAccount(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof accountInput>,
  ownerUserId: string = viewer.id,
): Promise<number> {
  const { groupIds, visibility: requested, ...data } = accountInput.parse(input);
  const visibility = requested ?? (managesHousehold(viewer) ? "household" : "private");
  if (visibility === "household" && !managesHousehold(viewer)) throw new Forbidden(msg("settings.errors.householdOnlyAdmins"));
  if (groupIds.length > 0 && !canGroup(viewer, { ownerUserId, visibility })) throw new Forbidden(msg("errors.notYourAccount"));
  const [row] = await db
    .insert(accounts)
    .values({ ...data, iban: data.iban ?? null, ownerUserId, visibility })
    .returning({ id: accounts.id });
  if (!row) throw new UserError(msg("settings.errors.accountCreateFailed"));
  if (groupIds.length > 0) await setAccountGroups(db, viewer, row.id, groupIds);
  await record(db, {
    action: "accounts.created",
    actor: viewer,
    target: { type: "account", id: row.id },
    details: { name: data.name, visibility },
  });
  return row.id;
}

export async function updateAccount(db: Db, viewer: Viewer, id: number, input: z.input<typeof accountInput>): Promise<void> {
  const current = await requireManageableAccount(db, viewer, id);
  const { groupIds, visibility, ...data } = accountInput.parse(input);
  if (visibility !== undefined && visibility !== current.visibility) {
    if (!canShare(viewer, current)) throw new Forbidden(msg("errors.notYourAccount"));
    if (visibility === "household" && !managesHousehold(viewer)) throw new Forbidden(msg("settings.errors.householdOnlyAdmins"));
  }
  const next = { ownerUserId: current.ownerUserId, visibility: visibility ?? current.visibility };
  await db
    .update(accounts)
    .set({ ...data, iban: data.iban ?? null, visibility: next.visibility })
    .where(eq(accounts.id, id));
  if (canGroup(viewer, next)) await setAccountGroups(db, viewer, id, groupIds);
}

export const editInput = z.object({
  id: z.number().int(),
  name: accountInput.shape.name.optional(),
  kind: accountInput.shape.kind.optional(),
  color: hexColor.optional(),
  iban: accountInput.shape.iban,
  transferPatterns: accountInput.shape.transferPatterns.optional(),
});

/** Changes single fields (name, kind, …) of an account the viewer manages. */
export async function editAccount(db: Db, viewer: Viewer, input: z.input<typeof editInput>): Promise<void> {
  const { id, iban, ...fields } = editInput.parse(input);
  await requireManageableAccount(db, viewer, id);
  const update = Object.fromEntries(Object.entries({ ...fields, iban }).filter(([, value]) => value !== undefined));
  if (Object.keys(update).length > 0) await db.update(accounts).set(update).where(eq(accounts.id, id));
}

export async function renameAccount(db: Db, viewer: Viewer, input: { id: number; name: string }): Promise<void> {
  await editAccount(db, viewer, input);
}

/** Only accounts without a bank connection; linked ones go with their connection. */
export async function deleteAccount(db: Db, viewer: Viewer, id: number): Promise<void> {
  const current = await requireManageableAccount(db, viewer, id);
  if (current.connectionId !== null) throw new UserError(msg("settings.errors.accountLinked"), 409);
  await db.delete(accounts).where(eq(accounts.id, id));
  await record(db, { action: "accounts.deleted", actor: viewer, target: { type: "account", id }, details: { name: current.name } });
}

// ---- sharing

/** Without `userIds` only the groups change: that is all a family admin decides for a household account. */
export const sharingInput = z.object({
  accountId: z.number().int(),
  userIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  groupIds: z.array(z.number().int()).max(50).default([]),
});

export type AccountSharing = {
  accountId: number;
  visibility: Visibility;
  /** Null when the viewer only manages the account's groups. */
  userIds: string[] | null;
  /** Only groups the viewer can see; shares into other groups stay untouched. */
  groupIds: number[];
};

async function shareable(db: Db, viewer: Viewer, accountId: number) {
  await requireVisibleAccount(db, viewer, accountId);
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new NotFound(msg("errors.accountNotFound"));
  if (!canShare(viewer, row) && !canGroup(viewer, row)) throw new Forbidden(msg("errors.notYourAccount"));
  return row;
}

export async function getAccountSharing(db: Db, viewer: Viewer, accountId: number): Promise<AccountSharing> {
  const row = await shareable(db, viewer, accountId);
  const accessible = new Set(await accessibleGroupIds(db, viewer));
  const users = await db.select({ userId: accountShares.userId }).from(accountShares).where(eq(accountShares.accountId, accountId));
  const groups = await db.select().from(accountGroupMembers).where(eq(accountGroupMembers.accountId, accountId));
  return {
    accountId,
    visibility: row.visibility,
    userIds: canShare(viewer, row) ? users.map((u) => u.userId) : null,
    groupIds: groups.filter((g) => accessible.has(g.groupId)).map((g) => g.groupId),
  };
}

/** The owner decides who else sees an account: single people and groups (everyone who sees the group). */
export async function setAccountSharing(db: Db, viewer: Viewer, input: z.input<typeof sharingInput>): Promise<void> {
  const data = sharingInput.parse(input);
  const row = await shareable(db, viewer, data.accountId);
  if (data.userIds !== undefined && !canShare(viewer, row)) throw new Forbidden(msg("errors.notYourAccount"));
  if (!canGroup(viewer, row) && data.groupIds.length > 0) throw new Forbidden(msg("errors.notYourAccount"));
  const userIds = [...new Set(data.userIds ?? [])].filter((id) => id !== row.ownerUserId);
  const people = userIds.length > 0 ? await db.select().from(user).where(inArray(user.id, userIds)) : [];
  if (people.length !== userIds.length) throw new UserError(msg("users.errors.notFound"));
  await db.transaction(async (tx) => {
    if (data.userIds !== undefined) {
      await tx.delete(accountShares).where(eq(accountShares.accountId, row.id));
      if (userIds.length > 0) await tx.insert(accountShares).values(userIds.map((userId) => ({ accountId: row.id, userId })));
    }
    if (canGroup(viewer, row)) await setAccountGroups(tx, viewer, row.id, data.groupIds);
  });
  const sharing = (await sharingOf(db, viewer, [{ ...row, visibility: "private" }])).get(row.id);
  await record(db, {
    action: "accounts.sharingChanged",
    actor: viewer,
    target: { type: "account", id: row.id },
    details: { name: row.name, sharedWith: sharing?.sharedWith ?? [] },
  });
}

// ---- groups

export async function listGroups(db: Db, viewer: Viewer): Promise<Group[]> {
  const groups = await visibleGroups(db, viewer);
  if (isSuperuser(viewer)) return groups;
  // Viewers only learn about accounts they may see.
  const visible = new Set(await visibleAccountIds(db, viewer));
  return groups.map((g) => ({ ...g, accountIds: g.accountIds.filter((id) => visible.has(id)) }));
}

/** Replaces the group's accounts among those the viewer may group; others in it (shares of other people) stay. */
async function setGroupAccounts(db: Db, viewer: Viewer, groupId: number, accountIds: number[]): Promise<void> {
  const wanted = [...new Set(accountIds)];
  const visible = new Set(await visibleAccountIds(db, viewer));
  if (wanted.some((id) => !visible.has(id))) throw new UserError(msg("settings.errors.unknownAccount"));
  const rows = await db.select().from(accounts);
  const editable = new Set(rows.filter((a) => visible.has(a.id) && canGroup(viewer, a)).map((a) => a.id));
  const current = new Set(
    (await db.select().from(accountGroupMembers).where(eq(accountGroupMembers.groupId, groupId))).map((m) => m.accountId),
  );
  if (wanted.some((id) => !editable.has(id) && !current.has(id))) throw new Forbidden(msg("errors.notYourAccount"));
  if (editable.size > 0) {
    await db
      .delete(accountGroupMembers)
      .where(and(eq(accountGroupMembers.groupId, groupId), inArray(accountGroupMembers.accountId, [...editable])));
  }
  const added = wanted.filter((id) => editable.has(id));
  if (added.length > 0) await db.insert(accountGroupMembers).values(added.map((accountId) => ({ accountId, groupId })));
}

async function uniqueName(db: Db, name: string, exceptId?: number): Promise<void> {
  const [clash] = await db.select({ id: accountGroups.id }).from(accountGroups).where(eq(accountGroups.name, name));
  if (clash && clash.id !== exceptId) throw new UserError(msg("settings.errors.groupNameTaken"), 409);
}

export async function createGroup(db: Db, viewer: Viewer, input: z.input<typeof groupInput>): Promise<number> {
  requireHouseholdAdmin(viewer);
  const data = groupInput.parse(input);
  await uniqueName(db, data.name);
  const position = data.position ?? (await db.select({ id: accountGroups.id }).from(accountGroups)).length;
  const [row] = await db.insert(accountGroups).values({ name: data.name, position }).returning({ id: accountGroups.id });
  if (!row) throw new UserError(msg("settings.errors.groupCreateFailed"));
  if (data.accountIds) await setGroupAccounts(db, viewer, row.id, data.accountIds);
  return row.id;
}

export async function updateGroup(db: Db, viewer: Viewer, id: number, input: z.input<typeof groupInput>): Promise<void> {
  requireHouseholdAdmin(viewer);
  const data = groupInput.parse(input);
  await uniqueName(db, data.name, id);
  const updated = await db
    .update(accountGroups)
    .set({ name: data.name, ...(data.position === undefined ? {} : { position: data.position }) })
    .where(eq(accountGroups.id, id))
    .returning({ id: accountGroups.id });
  if (updated.length === 0) throw new NotFound(msg("errors.groupNotFound"));
  if (data.accountIds) await setGroupAccounts(db, viewer, id, data.accountIds);
}

/** Dashboards of the group fall back to "all accounts" (FK set null); access and shares through it end. */
export async function deleteGroup(db: Db, viewer: Viewer, id: number): Promise<void> {
  requireHouseholdAdmin(viewer);
  const deleted = await db.delete(accountGroups).where(eq(accountGroups.id, id)).returning({ id: accountGroups.id });
  if (deleted.length === 0) throw new NotFound(msg("errors.groupNotFound"));
}

export * from "./holdings.ts";
export * from "./manual.ts";
export * from "./overview.ts";
export * from "./sharing.ts";
export * from "./timeline.ts";
