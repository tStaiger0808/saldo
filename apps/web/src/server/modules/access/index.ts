/**
 * Who may see and change what. Every module and every MCP tool resolves accounts through here.
 *
 * - Superusers see every account, private ones included.
 * - Family admins see all household accounts; members see the household accounts of the groups granted to them.
 * - Everyone sees their own accounts and accounts shared with them, directly or through a group they can see.
 */
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { msg, t } from "../../../i18n/index.ts";
import type { SessionUser } from "../../auth.ts";
import type { Db } from "../../db/index.ts";
import {
  accountGroupMembers,
  accountGroups,
  accountShares,
  accounts,
  bankConnections,
  type Role,
  transactions,
  user,
  userGroupAccess,
  type Visibility,
} from "../../db/schema.ts";
import { Forbidden, NotFound } from "../../errors.ts";

/**
 * `locale` is set for requests from the app; modules that write text for the viewer fall back to German without it.
 * `impersonation` is set while a superuser views Saldo as this person.
 */
export type Viewer = Pick<SessionUser, "id" | "role"> & Partial<Pick<SessionUser, "locale" | "impersonation">>;

export type Group = { id: number; name: string; position: number; accountIds: number[] };

/**
 * The accounts one request works on. `accountIds` is the selection (a group or everything visible),
 * `visibleIds` everything the viewer may see, used for labels of transfers leaving the selection.
 */
export type View = { groupId: number | null; groupName: string; accountIds: number[]; visibleIds: number[] };

/** What decides who may change an account or a bank connection. */
export type Owned = { ownerUserId: string; visibility: Visibility };

export const isSuperuser = (viewer: Pick<Viewer, "role">): boolean => viewer.role === "superuser";

/** Superusers and family admins run the household: groups, categories, tags, rules and members. */
export const managesHousehold = (viewer: Pick<Viewer, "role">): boolean => viewer.role === "superuser" || viewer.role === "familyAdmin";

/** Roles a viewer may give to someone else. */
export function assignableRoles(viewer: Pick<Viewer, "role">): Role[] {
  if (viewer.role === "superuser") return ["superuser", "familyAdmin", "member"];
  return viewer.role === "familyAdmin" ? ["member"] : [];
}

export function requireSuperuser(viewer: Viewer): void {
  if (!isSuperuser(viewer)) throw new Forbidden(msg("errors.superuserOnly"));
}

export function requireHouseholdAdmin(viewer: Viewer): void {
  if (!managesHousehold(viewer)) throw new Forbidden();
}

/** Superusers manage everything, family admins the household's and their own, members their own. */
export function canManage(viewer: Viewer, item: Owned): boolean {
  return isSuperuser(viewer) || item.ownerUserId === viewer.id || (viewer.role === "familyAdmin" && item.visibility === "household");
}

/** Only the owner (or a superuser) decides who else sees an account. */
export function canShare(viewer: Viewer, item: Owned): boolean {
  return isSuperuser(viewer) || item.ownerUserId === viewer.id;
}

/** Groups whose accounts the viewer sees: all for superusers and family admins, the granted ones for members. */
export async function accessibleGroupIds(db: Db, viewer: Viewer): Promise<number[]> {
  if (managesHousehold(viewer)) return (await db.select({ id: accountGroups.id }).from(accountGroups)).map((g) => g.id);
  const rows = await db.select({ groupId: userGroupAccess.groupId }).from(userGroupAccess).where(eq(userGroupAccess.userId, viewer.id));
  return rows.map((r) => r.groupId);
}

/** The viewer's groups with all their accounts; callers narrow `accountIds` to the visible ones. */
export async function visibleGroups(db: Db, viewer: Viewer): Promise<Group[]> {
  const allowed = new Set(await accessibleGroupIds(db, viewer));
  const groups = await db.select().from(accountGroups).orderBy(asc(accountGroups.position), asc(accountGroups.name));
  const members = await db.select().from(accountGroupMembers);
  return groups
    .filter((g) => allowed.has(g.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      position: g.position,
      accountIds: members.filter((m) => m.groupId === g.id).map((m) => m.accountId),
    }));
}

/** The one condition that decides which accounts a viewer sees; undefined (no filter) for superusers. */
async function visibilityCondition(db: Db, viewer: Viewer): Promise<SQL | undefined> {
  if (isSuperuser(viewer)) return undefined;
  const groupIds = await accessibleGroupIds(db, viewer);
  const parts: SQL[] = [
    eq(accounts.ownerUserId, viewer.id),
    inArray(accounts.id, db.select({ id: accountShares.accountId }).from(accountShares).where(eq(accountShares.userId, viewer.id))),
  ];
  if (viewer.role === "familyAdmin") parts.push(eq(accounts.visibility, "household"));
  if (groupIds.length > 0) {
    parts.push(
      inArray(
        accounts.id,
        db.select({ id: accountGroupMembers.accountId }).from(accountGroupMembers).where(inArray(accountGroupMembers.groupId, groupIds)),
      ),
    );
  }
  return or(...parts);
}

export async function visibleAccountIds(db: Db, viewer: Viewer): Promise<number[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(await visibilityCondition(db, viewer))
    .orderBy(asc(accounts.id));
  return rows.map((a) => a.id);
}

export async function resolveView(db: Db, viewer: Viewer, groupId: number | null | undefined): Promise<View> {
  const visible = await visibleAccountIds(db, viewer);
  if (groupId == null)
    return { groupId: null, groupName: t(viewer.locale ?? "de", "common.allAccounts"), accountIds: visible, visibleIds: visible };
  const group = (await visibleGroups(db, viewer)).find((g) => g.id === groupId);
  if (!group) throw new NotFound(msg("errors.groupNotFound"));
  const visibleSet = new Set(visible);
  return { groupId: group.id, groupName: group.name, accountIds: group.accountIds.filter((id) => visibleSet.has(id)), visibleIds: visible };
}

/** Narrows a view to explicitly requested accounts, rejecting any outside of it. */
export function checkAccounts(view: View, accountIds: readonly number[]): number[] {
  const allowed = new Set(view.accountIds);
  if (accountIds.some((id) => !allowed.has(id))) throw new NotFound(msg("errors.accountNotFound"));
  return [...accountIds];
}

export async function visibleTransactionIds(db: Db, viewer: Viewer, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const visible = new Set(await visibleAccountIds(db, viewer));
  const rows = await db
    .select({ id: transactions.id, accountId: transactions.accountId })
    .from(transactions)
    .where(inArray(transactions.id, [...ids]));
  return rows.filter((r) => visible.has(r.accountId)).map((r) => r.id);
}

export async function requireVisibleTransaction(db: Db, viewer: Viewer, id: number): Promise<void> {
  if ((await visibleTransactionIds(db, viewer, [id])).length === 0) throw new NotFound(msg("errors.transactionNotFound"));
}

export async function requireVisibleAccount(db: Db, viewer: Viewer, id: number): Promise<void> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, id), await visibilityCondition(db, viewer)));
  if (!row) throw new NotFound(msg("errors.accountNotFound"));
}

/** A hidden account is a 404, a visible one the viewer may not change a 403. */
export async function requireManageableAccount(db: Db, viewer: Viewer, id: number): Promise<typeof accounts.$inferSelect> {
  await requireVisibleAccount(db, viewer, id);
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!row) throw new NotFound(msg("errors.accountNotFound"));
  if (!canManage(viewer, row)) throw new Forbidden(msg("errors.notYourAccount"));
  return row;
}

function manageableConnections(viewer: Viewer): SQL | undefined {
  if (isSuperuser(viewer)) return undefined;
  const own = eq(bankConnections.ownerUserId, viewer.id);
  return viewer.role === "familyAdmin" ? or(own, eq(bankConnections.visibility, "household")) : own;
}

/** Connections the viewer manages; nobody else learns that they exist. */
export async function manageableConnectionIds(db: Db, viewer: Viewer): Promise<number[]> {
  const rows = await db
    .select({ id: bankConnections.id })
    .from(bankConnections)
    .where(manageableConnections(viewer))
    .orderBy(asc(bankConnections.id));
  return rows.map((r) => r.id);
}

export async function requireManageableConnection(db: Db, viewer: Viewer, id: number): Promise<typeof bankConnections.$inferSelect> {
  const [row] = await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.id, id), manageableConnections(viewer)));
  if (!row) throw new NotFound(msg("banking.errors.connectionNotFound"));
  return row;
}

/** A connection the viewer may see the logo of: one they manage or one linked to an account they see. */
export async function requireVisibleConnection(db: Db, viewer: Viewer, id: number): Promise<void> {
  if ((await manageableConnectionIds(db, viewer)).includes(id)) return;
  const [linked] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.connectionId, id), await visibilityCondition(db, viewer)))
    .limit(1);
  if (!linked) throw new NotFound(msg("banking.errors.connectionNotFound"));
}

/** Superusers always may; everyone else only when a superuser allowed it. Read fresh, so a revoke applies at once. */
export async function mayUseAi(db: Db, viewer: Viewer): Promise<boolean> {
  if (isSuperuser(viewer)) return true;
  const [row] = await db.select({ allowed: user.aiAllowed }).from(user).where(eq(user.id, viewer.id));
  return row?.allowed === true;
}

export async function requireAi(db: Db, viewer: Viewer): Promise<void> {
  if (!(await mayUseAi(db, viewer))) throw new Forbidden(msg("ai.errors.notAllowed"));
}
