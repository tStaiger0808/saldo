import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { LOCALES, type Locale } from "../../../i18n/locales.ts";
import type { Db } from "../../db/index.ts";
import {
  account,
  accountGroups,
  accounts,
  bankConnections,
  contracts,
  mcpTokens,
  pushSubscriptions,
  ROLES,
  type Role,
  session,
  user,
  userGroupAccess,
} from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import { assignableRoles, isSuperuser, requireHouseholdAdmin, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import { avatarUrls } from "../avatars/index.ts";
import { endImpersonationsOf } from "../impersonation/index.ts";

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_.]{3,30}$/, "users.errors.usernameFormat");
export const passwordSchema = z.string().min(12, "users.errors.passwordLength").max(256);
export const roleSchema = z.enum(ROLES);
/** Null follows the browser's language. */
export const localeSchema = z.enum(LOCALES).nullable();

export const createUserInput = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
  groupIds: z.array(z.number().int()).default([]),
  locale: localeSchema.default(null),
  aiAllowed: z.boolean().optional(),
});
export const updateUserInput = z.object({
  id: z.string(),
  role: roleSchema.optional(),
  groupIds: z.array(z.number().int()).optional(),
  locale: localeSchema.optional(),
  aiAllowed: z.boolean().optional(),
});

export type UserRow = {
  id: string;
  username: string;
  role: Role;
  locale: Locale | null;
  groupIds: number[];
  aiAllowed: boolean;
  createdAt: string;
  avatar: string | null;
};

// better-auth requires an email; users here only have a username.
const placeholderEmail = (username: string) => `${username.toLowerCase()}@users.saldo.invalid`;
const nameOf = (row: typeof user.$inferSelect) => row.displayUsername ?? row.username ?? row.name;

/** Superusers manage everyone; family admins only members, never superusers, other family admins or themselves. */
function canManageUser(viewer: Viewer, target: Pick<typeof user.$inferSelect, "id" | "role">): boolean {
  if (isSuperuser(viewer)) return true;
  return viewer.role === "familyAdmin" && target.role === "member" && target.id !== viewer.id;
}

/** Family admins only learn about the members they manage. */
export async function listUsers(db: Db, viewer: Viewer): Promise<UserRow[]> {
  requireHouseholdAdmin(viewer);
  const users = await db.select().from(user).orderBy(asc(user.username));
  const access = await db.select().from(userGroupAccess);
  const shown = users.filter((u) => canManageUser(viewer, u));
  const avatars = await avatarUrls(
    db,
    shown.map((u) => u.id),
  );
  return shown.map((u) => ({
    id: u.id,
    username: nameOf(u),
    role: u.role,
    locale: u.locale,
    groupIds: access.filter((a) => a.userId === u.id).map((a) => a.groupId),
    aiAllowed: u.role === "superuser" || u.aiAllowed,
    createdAt: u.createdAt.toISOString(),
    avatar: avatars.get(u.id) ?? null,
  }));
}

export type Person = { id: string; username: string; avatar: string | null };

/** Everyone else in the household, so an account can be shared with them; names and pictures only. */
export async function listPeople(db: Db, viewer: Viewer): Promise<Person[]> {
  const users = await db.select().from(user).where(ne(user.id, viewer.id)).orderBy(asc(user.username));
  const avatars = await avatarUrls(
    db,
    users.map((u) => u.id),
  );
  return users.map((u) => ({ id: u.id, username: nameOf(u), avatar: avatars.get(u.id) ?? null }));
}

async function checkGroups(db: Db, groupIds: number[]): Promise<void> {
  if (groupIds.length === 0) return;
  const found = await db.select({ id: accountGroups.id }).from(accountGroups).where(inArray(accountGroups.id, groupIds));
  if (found.length !== new Set(groupIds).size) throw new UserError(msg("users.errors.unknownGroup"));
}

/** Creates a login without going through sign-up, which is disabled. Also used to bootstrap the first superuser. */
export async function insertUser(db: Db, input: z.input<typeof createUserInput>): Promise<string> {
  const data = createUserInput.parse(input);
  const name = data.username.toLowerCase();
  if ((await db.select({ id: user.id }).from(user).where(eq(user.username, name))).length > 0) {
    throw new UserError(msg("users.errors.usernameTaken"), 409);
  }
  await checkGroups(db, data.groupIds);
  const id = randomUUID();
  const passwordHash = await hashPassword(data.password);
  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id,
      name: data.username,
      email: placeholderEmail(data.username),
      username: name,
      displayUsername: data.username,
      role: data.role,
      aiAllowed: data.role === "superuser" || (data.aiAllowed ?? false),
      locale: data.locale,
    });
    await tx.insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: passwordHash });
    if (data.groupIds.length > 0) await tx.insert(userGroupAccess).values(data.groupIds.map((groupId) => ({ userId: id, groupId })));
  });
  return id;
}

async function groupNames(db: Db, groupIds: number[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db.select({ name: accountGroups.name }).from(accountGroups).where(inArray(accountGroups.id, groupIds));
  return rows.map((g) => g.name).sort((a, b) => a.localeCompare(b));
}

function checkRoleChange(viewer: Viewer, role: Role | undefined, aiAllowed: boolean | undefined): void {
  if (role !== undefined && !assignableRoles(viewer).includes(role)) throw new Forbidden(msg("users.errors.roleNotAllowed"));
  if (aiAllowed !== undefined && !isSuperuser(viewer)) throw new Forbidden(msg("errors.superuserOnly"));
}

export async function createUser(db: Db, viewer: Viewer, input: z.input<typeof createUserInput>): Promise<string> {
  requireHouseholdAdmin(viewer);
  const data = createUserInput.parse(input);
  checkRoleChange(viewer, data.role, data.aiAllowed);
  const id = await insertUser(db, input);
  await record(db, {
    action: "users.created",
    actor: viewer,
    target: { type: "user", id },
    details: { name: data.username, role: data.role, groups: await groupNames(db, data.groupIds) },
  });
  return id;
}

async function otherSuperusers(db: Db, id: string): Promise<number> {
  return (
    await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.role, "superuser"), ne(user.id, id)))
  ).length;
}

/** A user the viewer may not manage is a 404, so family admins cannot probe for superusers. */
async function manageable(db: Db, viewer: Viewer, id: string) {
  requireHouseholdAdmin(viewer);
  const [row] = await db.select().from(user).where(eq(user.id, id));
  if (!row || !canManageUser(viewer, row)) throw new NotFound(msg("users.errors.notFound"));
  return row;
}

export async function updateUser(db: Db, viewer: Viewer, input: z.input<typeof updateUserInput>): Promise<void> {
  const data = updateUserInput.parse(input);
  const target = await manageable(db, viewer, data.id);
  checkRoleChange(viewer, data.role, data.aiAllowed);
  if (data.role !== undefined && data.role !== "superuser" && target.role === "superuser" && (await otherSuperusers(db, target.id)) === 0) {
    throw new UserError(msg("users.errors.lastSuperuser"));
  }
  if (data.groupIds) await checkGroups(db, data.groupIds);
  const previousGroups = (await db.select().from(userGroupAccess).where(eq(userGroupAccess.userId, target.id))).map((a) => a.groupId);
  const role = data.role ?? target.role;
  const aiAllowed = role === "superuser" ? true : data.aiAllowed;
  await db.transaction(async (tx) => {
    if (data.role !== undefined || data.locale !== undefined || aiAllowed !== undefined) {
      await tx.update(user).set({ role: data.role, locale: data.locale, aiAllowed, updatedAt: new Date() }).where(eq(user.id, target.id));
    }
    if (data.groupIds) {
      await tx.delete(userGroupAccess).where(eq(userGroupAccess.userId, target.id));
      if (data.groupIds.length > 0)
        await tx.insert(userGroupAccess).values(data.groupIds.map((groupId) => ({ userId: target.id, groupId })));
    }
  });
  const sameGroups = (ids: number[]) => ids.length === previousGroups.length && ids.every((id) => previousGroups.includes(id));
  await record(db, {
    action: "users.updated",
    actor: viewer,
    target: { type: "user", id: target.id },
    details: {
      name: nameOf(target),
      role: data.role !== undefined && data.role !== target.role ? data.role : undefined,
      groups: data.groupIds && !sameGroups(data.groupIds) ? await groupNames(db, data.groupIds) : undefined,
      aiAllowed: data.aiAllowed !== undefined && data.aiAllowed !== target.aiAllowed ? data.aiAllowed : undefined,
    },
  });
}

/**
 * Ends what keeps working without a session: MCP tokens and push subscriptions. A password reset or change ends them
 * with the sessions, so whoever had the old password keeps neither data access nor booking notifications.
 */
export async function endStandingAccess(db: Db, userId: string): Promise<void> {
  await db.delete(mcpTokens).where(eq(mcpTokens.userId, userId));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}

export async function resetPassword(db: Db, viewer: Viewer, id: string, password: string): Promise<void> {
  const target = await manageable(db, viewer, id);
  const hash = await hashPassword(passwordSchema.parse(password));
  await db.transaction(async (tx) => {
    await tx
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, target.id), eq(account.providerId, "credential")));
    // A reset ends every session of that user, so an old login cannot continue with the old password.
    await tx.delete(session).where(eq(session.userId, target.id));
    await endStandingAccess(tx, target.id);
  });
  await record(db, {
    action: "auth.passwordReset",
    actor: viewer,
    target: { type: "user", id: target.id },
    details: { name: nameOf(target) },
  });
}

/**
 * Accounts, connections and contracts of a deleted user are kept and pass to a superuser with their visibility unchanged,
 * so private data stays private and no booking is lost.
 */
export async function deleteUser(db: Db, viewer: Viewer, id: string): Promise<void> {
  if (id === viewer.id) throw new UserError(msg("users.errors.deleteSelf"));
  const target = await manageable(db, viewer, id);
  if (target.role === "superuser" && (await otherSuperusers(db, target.id)) === 0) throw new UserError(msg("users.errors.lastSuperuser"));
  const [heir] = isSuperuser(viewer)
    ? [{ id: viewer.id }]
    : await db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.role, "superuser"), ne(user.id, target.id)))
        .orderBy(asc(user.createdAt), asc(user.id))
        .limit(1);
  if (!heir) throw new UserError(msg("users.errors.lastSuperuser"));
  await endImpersonationsOf(db, target.id, "targetDeleted");
  await db.transaction(async (tx) => {
    await tx.update(accounts).set({ ownerUserId: heir.id }).where(eq(accounts.ownerUserId, target.id));
    await tx.update(bankConnections).set({ ownerUserId: heir.id }).where(eq(bankConnections.ownerUserId, target.id));
    await tx.update(contracts).set({ ownerUserId: heir.id }).where(eq(contracts.ownerUserId, target.id));
    await tx.delete(user).where(eq(user.id, target.id));
  });
  await record(db, { action: "users.deleted", actor: viewer, target: { type: "user", id: target.id }, details: { name: nameOf(target) } });
}

export const ownNameInput = z.object({ name: z.string().trim().min(1, "personal.data.nameRequired").max(64, "personal.data.nameTooLong") });

/** The signed-in user's own display name; login name and the name others see stay with the admins. */
export async function setOwnName(db: Db, viewer: Viewer, input: z.input<typeof ownNameInput>): Promise<void> {
  const { name } = ownNameInput.parse(input);
  await db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, viewer.id));
}

/** The signed-in user's own language; null follows the browser. */
export async function setOwnLocale(db: Db, viewer: Viewer, locale: Locale | null): Promise<void> {
  await db
    .update(user)
    .set({ locale: localeSchema.parse(locale), updatedAt: new Date() })
    .where(eq(user.id, viewer.id));
}

export async function bootstrapAdmin(
  db: Db,
  username: string,
  password: string | undefined,
): Promise<"created" | "exists" | "no-password"> {
  if ((await db.select({ id: user.id }).from(user).limit(1)).length > 0) return "exists";
  if (!password) return "no-password";
  await insertUser(db, { username, password, role: "superuser", groupIds: [] });
  return "created";
}
