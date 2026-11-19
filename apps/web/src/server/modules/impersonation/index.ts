/**
 * Superusers may view Saldo as another person: with that person's visibility, role and language, read-only and for a
 * limited time. The state lives on the server, bound to the superuser's own session, which stays theirs throughout.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { impersonations, user } from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import { isSuperuser, requireSuperuser, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";

export const IMPERSONATION_MINUTES = 60;

/** Message keys under `impersonation.reasons`, shown in the audit log. */
export type ImpersonationEndReason = "stopped" | "expired" | "signOut" | "targetChanged" | "targetDeleted" | "actorChanged";

export const startImpersonationInput = z.object({ userId: z.string().min(1).max(64) });

type UserRow = typeof user.$inferSelect;
type ImpersonationRow = typeof impersonations.$inferSelect;

export type ActiveImpersonation = { target: UserRow; expiresAt: Date };

const nameOf = (row: Pick<UserRow, "displayUsername" | "username" | "name">) => row.displayUsername ?? row.username ?? row.name;

/** Starts viewing as `input.userId` in the given session of the superuser; never as oneself or another superuser. */
export async function startImpersonation(
  db: Db,
  viewer: Viewer,
  sessionId: string,
  input: z.input<typeof startImpersonationInput>,
  now = new Date(),
): Promise<void> {
  requireSuperuser(viewer);
  const { userId } = startImpersonationInput.parse(input);
  if (userId === viewer.id) throw new UserError(msg("impersonation.errors.self"));
  const [target] = await db.select().from(user).where(eq(user.id, userId));
  if (!target) throw new NotFound(msg("users.errors.notFound"));
  if (target.role === "superuser") throw new Forbidden(msg("impersonation.errors.superuser"));
  await endImpersonation(db, sessionId, "stopped");
  await db.insert(impersonations).values({
    sessionId,
    actorUserId: viewer.id,
    targetUserId: target.id,
    startedAt: now,
    expiresAt: new Date(now.getTime() + IMPERSONATION_MINUTES * 60_000),
  });
  await record(db, {
    action: "users.impersonationStarted",
    actor: viewer,
    target: { type: "user", id: target.id },
    details: { name: nameOf(target), role: target.role },
  });
}

/** Ends the view of one session; false when there was none. */
export async function endImpersonation(db: Db, sessionId: string, reason: ImpersonationEndReason): Promise<boolean> {
  const [row] = await db.delete(impersonations).where(eq(impersonations.sessionId, sessionId)).returning();
  if (!row) return false;
  await recordEnd(db, row, reason);
  return true;
}

/** Ends every view of one person, before that person is deleted, for example. */
export async function endImpersonationsOf(db: Db, targetUserId: string, reason: ImpersonationEndReason): Promise<void> {
  const rows = await db.delete(impersonations).where(eq(impersonations.targetUserId, targetUserId)).returning();
  for (const row of rows) await recordEnd(db, row, reason);
}

async function recordEnd(db: Db, row: ImpersonationRow, reason: ImpersonationEndReason): Promise<void> {
  const [target] = await db
    .select({ displayUsername: user.displayUsername, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.id, row.targetUserId));
  await record(db, {
    action: "users.impersonationEnded",
    actor: { id: row.actorUserId },
    target: { type: "user", id: row.targetUserId },
    details: { name: target ? nameOf(target) : undefined, reason: `impersonation.reasons.${reason}` },
  });
}

/**
 * The person the session's superuser currently views Saldo as, or null. A view that expired, whose superuser lost the
 * role or whose target became a superuser ends here, so every request sees the current state.
 */
export async function activeImpersonation(db: Db, sessionId: string, actor: Viewer, now = new Date()): Promise<ActiveImpersonation | null> {
  const [row] = await db
    .select({ impersonation: impersonations, target: user })
    .from(impersonations)
    .innerJoin(user, eq(user.id, impersonations.targetUserId))
    .where(eq(impersonations.sessionId, sessionId));
  if (!row) return null;
  const reason: ImpersonationEndReason | null =
    row.impersonation.expiresAt <= now
      ? "expired"
      : !isSuperuser(actor) || row.impersonation.actorUserId !== actor.id
        ? "actorChanged"
        : row.target.role === "superuser"
          ? "targetChanged"
          : null;
  if (reason) {
    await endImpersonation(db, sessionId, reason);
    return null;
  }
  return { target: row.target, expiresAt: row.impersonation.expiresAt };
}

// ---- read-only guard

/** The one server function that changes something while viewing as someone else: ending the view. */
export const IMPERSONATION_EXIT_FN = { name: "stopImpersonationFn", file: "server/functions/impersonation.ts" } as const;

/** GET requests that change state anyway: the bank's return address completes an authorization, a backup download is audited. */
const MUTATING_GETS = new Set(["/bank/callback", "/api/backup/download"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const READ_REQUESTS = new Set(["GET", "HEAD"]);

/**
 * Whether a server function may run while viewing as someone else: reads only, and ending the view. Every server
 * function passes this check (a global function middleware), so a new mutation is refused without further ado. A read
 * must be declared GET and arrive as GET (or HEAD while a page renders), so neither method alone can be bent.
 */
export function serverFnAllowedWhileImpersonating(
  method: string,
  fn: { name: string; filename: string },
  httpMethod: string = method,
): boolean {
  if (method === "GET" && READ_REQUESTS.has(httpMethod.toUpperCase())) return true;
  return fn.name === IMPERSONATION_EXIT_FN.name && fn.filename.replaceAll("\\", "/").endsWith(IMPERSONATION_EXIT_FN.file);
}

/**
 * Whether a plain HTTP request (server routes, the auth API) is refused while viewing as someone else. Server functions
 * are decided by `serverFnAllowedWhileImpersonating`; signing out ends the view, MCP clients use their own tokens.
 */
export function refusedWhileImpersonating(method: string, pathname: string): boolean {
  if (pathname.startsWith("/_serverFn/")) return false;
  if (SAFE_METHODS.has(method.toUpperCase())) return MUTATING_GETS.has(pathname);
  return pathname !== "/api/auth/sign-out" && pathname !== "/api/mcp";
}

/** The refusal shown for any change while viewing as `name`. */
export const readOnlyError = (name: string) => new Forbidden(msg("impersonation.errors.readOnly", { name }));
