import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import { sha256 } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import { mcpTokens, user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { isSuperuser, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";

const TOKEN_PREFIX = "fwm_";
const DISPLAY_LENGTH = 12;
const MAX_TOKENS_PER_USER = 20;
const TOKEN_PATTERN = /^fwm_[A-Za-z0-9_-]{43}$/;
/** A token works for a year; a new one is quickly made, a forgotten one should not stay valid forever. */
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export const tokenInput = z.object({ name: z.string().trim().min(1).max(64) });

export type TokenRow = {
  id: number;
  name: string;
  prefix: string;
  userId: string;
  username: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Null for tokens created before tokens expired. */
  expiresAt: string | null;
};

/** The plaintext token is returned exactly once; only its SHA-256 is stored. */
export async function createToken(db: Db, viewer: Viewer, input: z.input<typeof tokenInput>): Promise<TokenRow & { token: string }> {
  const { name } = tokenInput.parse(input);
  const own = await db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.userId, viewer.id));
  if (own.length >= MAX_TOKENS_PER_USER) throw new UserError(msg("settings.errors.tokenLimit", { max: MAX_TOKENS_PER_USER }));
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(mcpTokens)
    .values({
      userId: viewer.id,
      name,
      tokenHash: sha256(token),
      prefix: token.slice(0, DISPLAY_LENGTH),
      expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
    })
    .returning();
  if (!row) throw new UserError(msg("settings.errors.tokenCreateFailed"));
  const [owner] = await db.select({ username: user.username }).from(user).where(eq(user.id, viewer.id));
  await record(db, { action: "settings.mcpTokenCreated", actor: viewer, target: { type: "mcp_token", id: row.id }, details: { name } });
  return { ...tokenOut(row, owner?.username ?? null), token };
}

function tokenOut(row: typeof mcpTokens.$inferSelect, username: string | null): TokenRow {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    userId: row.userId,
    username,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** Everyone sees their own tokens, a superuser everyone's. */
export async function listTokens(db: Db, viewer: Viewer): Promise<TokenRow[]> {
  const rows = await db
    .select({ token: mcpTokens, username: user.username })
    .from(mcpTokens)
    .innerJoin(user, eq(user.id, mcpTokens.userId))
    .where(isSuperuser(viewer) ? undefined : eq(mcpTokens.userId, viewer.id))
    .orderBy(desc(mcpTokens.createdAt), desc(mcpTokens.id));
  return rows.map((r) => tokenOut(r.token, r.username));
}

export async function revokeToken(db: Db, viewer: Viewer, id: number): Promise<void> {
  const scope = isSuperuser(viewer) ? eq(mcpTokens.id, id) : and(eq(mcpTokens.id, id), eq(mcpTokens.userId, viewer.id));
  const [deleted] = await db.delete(mcpTokens).where(scope).returning({ id: mcpTokens.id, name: mcpTokens.name });
  if (!deleted) throw new NotFound(msg("settings.errors.tokenNotFound"));
  await record(db, {
    action: "settings.mcpTokenRevoked",
    actor: viewer,
    target: { type: "mcp_token", id: deleted.id },
    details: { name: deleted.name },
  });
}

/** Resolves a bearer token that has not expired to its owner, with the owner's current role. */
export async function tokenOwner(db: Db, authorization: string | null): Promise<Viewer | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "")?.[1];
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({ id: mcpTokens.id, userId: user.id, role: user.role })
    .from(mcpTokens)
    .innerJoin(user, eq(user.id, mcpTokens.userId))
    .where(and(eq(mcpTokens.tokenHash, sha256(token)), or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date()))));
  if (!row) return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.id));
  return { id: row.userId, role: row.role };
}
