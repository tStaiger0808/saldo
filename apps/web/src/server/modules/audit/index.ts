/**
 * Admin audit log: who did what and when. `record()` never throws, so a failing log write cannot break the action
 * it describes. Events carry small, secret-free details only: no passwords, keys, PINs, tokens or chat content.
 */
import { csvCell } from "@saldo/core";
import { and, desc, eq, gte, ilike, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, t } from "../../../i18n/index.ts";
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  type AuditAction,
  type AuditCategory,
  type AuditDetails,
  type AuditDetailValue,
  type AuditOutcome,
  categoryOf,
} from "../../../lib/audit.ts";
import { boundedDate } from "../../dates.ts";
import type { Db } from "../../db/index.ts";
import { auditEvents, user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { UserError } from "../../errors.ts";
import { requireSuperuser, type Viewer } from "../access/index.ts";
import { currentImpersonation, currentRequestMeta, type RequestMeta } from "./context.ts";

export { noteImpersonation, type RequestMeta, requestMeta, withRequestMeta } from "./context.ts";

export type AuditEventInput = {
  action: AuditAction;
  /** Who acted; null for unattended runs (scheduler) and anonymous attempts. */
  actor?: { id: string } | null;
  /** Defaults to the actor's current name; set it for attempts without a user (failed sign-in). */
  username?: string | null;
  outcome?: AuditOutcome;
  target?: { type: string; id: string | number } | null;
  /** Undefined values are left out. */
  details?: Record<string, AuditDetailValue | undefined>;
  /** Defaults to the request the event happens in. */
  request?: RequestMeta;
};

const MAX_DETAIL_KEYS = 24;
const MAX_TEXT = 200;
const MAX_LIST = 20;

function clean(details: AuditEventInput["details"]): AuditDetails {
  const out: AuditDetails = {};
  for (const [key, value] of Object.entries(details ?? {}).slice(0, MAX_DETAIL_KEYS)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value)
      ? value.slice(0, MAX_LIST).map((v) => String(v).slice(0, MAX_TEXT))
      : typeof value === "string"
        ? value.slice(0, MAX_TEXT)
        : (value as AuditDetailValue);
  }
  return out;
}

async function currentName(db: Db, id: string): Promise<string | null> {
  const [row] = await db
    .select({ display: user.displayUsername, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.id, id));
  return row ? (row.display ?? row.username ?? row.name) : null;
}

export async function record(db: Db, event: AuditEventInput): Promise<void> {
  await recordEvent(db, event);
}

/** `record` returning the event's id, or null when it could not be written, so details can be added later. */
export async function recordEvent(db: Db, event: AuditEventInput): Promise<number | null> {
  try {
    const meta = event.request ?? currentRequestMeta();
    const userId = event.actor?.id ?? null;
    const username = event.username ?? (userId ? await currentName(db, userId) : null);
    const impersonation = currentImpersonation();
    const details =
      impersonation && userId === impersonation.targetUserId
        ? { impersonatedBy: impersonation.actorName, ...event.details }
        : event.details;
    const [row] = await db
      .insert(auditEvents)
      .values({
        userId,
        username,
        action: event.action,
        outcome: event.outcome ?? "ok",
        targetType: event.target?.type ?? null,
        targetId: event.target ? String(event.target.id) : null,
        details: clean(details),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      })
      .returning({ id: auditEvents.id });
    return row?.id ?? null;
  } catch (error) {
    console.error(`Audit event not written: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}

/** Adds facts known only after the event was written (what an AI answer led to); never throws. */
export async function addAuditDetails(db: Db, id: number | null, details: AuditEventInput["details"]): Promise<void> {
  if (id === null) return;
  try {
    await db
      .update(auditEvents)
      .set({ details: sql`${auditEvents.details} || ${JSON.stringify(clean(details))}::jsonb` })
      .where(eq(auditEvents.id, id));
  } catch (error) {
    console.error(`Audit details not written: ${error instanceof Error ? error.name : typeof error}`);
  }
}

/** The message key of a failure when it carries no variables; variables and plain texts may echo bank or provider data. */
export function failureReason(error: unknown): string | null {
  const text: unknown = error instanceof UserError ? error.text : error;
  if (typeof text !== "object" || text === null || !("key" in text)) return null;
  const { key, vars } = text as { key: unknown; vars?: unknown };
  return typeof key === "string" && !vars ? key : null;
}

// ---- authentication (called from the better-auth hooks)

/** The client address and agent come from the request's audit context (start.ts), resolved like everywhere else. */
export type AuthHookEvent = {
  path: string;
  body: unknown;
  failed: boolean;
  user: { id: string } | null;
};

export const SIGN_IN_PATHS = new Set(["/sign-in/username", "/sign-in/email"]);
const REVOKE_PATHS = new Set(["/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);
export const AUDITED_AUTH_PATHS = new Set([...SIGN_IN_PATHS, ...REVOKE_PATHS, "/sign-out", "/change-password"]);

function attemptedName(body: unknown): string | null {
  const { username, email } = (body ?? {}) as { username?: unknown; email?: unknown };
  const name = typeof username === "string" ? username : typeof email === "string" ? email : "";
  return name.trim().slice(0, 64) || null;
}

/** Sign-ins (also failed ones, with the typed user name and never the password), sign-outs, password changes, revocations. */
export async function recordAuthEvent(db: Db, event: AuthHookEvent): Promise<void> {
  if (!AUDITED_AUTH_PATHS.has(event.path)) return;
  const outcome: AuditOutcome = event.failed ? "failed" : "ok";
  if (SIGN_IN_PATHS.has(event.path)) {
    if (!event.failed && event.user) return record(db, { action: "auth.signIn", actor: event.user });
    const attempted = attemptedName(event.body);
    const known = attempted ? await userIdByName(db, attempted) : null;
    return record(db, {
      action: "auth.signIn",
      actor: known ? { id: known } : null,
      // An unknown name is not a user; it stays in the details only.
      username: known ? undefined : null,
      outcome: "failed",
      details: { attemptedUsername: attempted },
    });
  }
  if (!event.user) return;
  if (event.path === "/sign-out") return record(db, { action: "auth.signOut", actor: event.user, outcome });
  if (event.path === "/change-password") return record(db, { action: "auth.passwordChanged", actor: event.user, outcome });
  return record(db, {
    action: "auth.sessionRevoked",
    actor: event.user,
    outcome,
    details: event.path === "/revoke-session" ? {} : { allSessions: true },
  });
}

async function userIdByName(db: Db, name: string): Promise<string | null> {
  try {
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.username, name.toLowerCase()));
    return row?.id ?? null;
  } catch {
    return null;
  }
}

// ---- reading (admins only)

export const auditFilterInput = z.object({
  userId: z.string().max(64).nullish(),
  category: z.enum(AUDIT_CATEGORIES).nullish(),
  outcome: z.enum(["ok", "failed"]).nullish(),
  dateFrom: boundedDate.nullish(),
  dateTo: boundedDate.nullish(),
  q: z.string().trim().max(100).nullish(),
});
export const auditListInput = auditFilterInput.extend({
  before: z.number().int().positive().nullish(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type AuditEventOut = {
  id: number;
  at: string;
  userId: string | null;
  username: string | null;
  action: string;
  category: AuditCategory | null;
  outcome: AuditOutcome;
  targetType: string | null;
  targetId: string | null;
  details: AuditDetails;
  ip: string | null;
  userAgent: string | null;
};

export type AuditPage = { items: AuditEventOut[]; nextBefore: number | null; retentionDays: number };

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// Days are server-local, like the scheduler's.
const dayStart = (iso: string) => new Date(`${iso}T00:00:00`);

function whereFor(viewer: Viewer, filters: z.infer<typeof auditFilterInput>, before?: number | null): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    filters.userId ? eq(auditEvents.userId, filters.userId) : undefined,
    filters.category ? ilike(auditEvents.action, `${filters.category}.%`) : undefined,
    filters.outcome ? eq(auditEvents.outcome, filters.outcome) : undefined,
    filters.dateFrom ? gte(auditEvents.at, dayStart(filters.dateFrom)) : undefined,
    filters.dateTo ? lt(auditEvents.at, new Date(dayStart(filters.dateTo).getTime() + 86_400_000)) : undefined,
    before ? lt(auditEvents.id, before) : undefined,
  ];
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const needle = filters.q.toLocaleLowerCase();
    const locale = viewer.locale ?? DEFAULT_LOCALE;
    // The action column holds keys, so the search also matches the reader's own wording of an action.
    const named = AUDIT_ACTIONS.filter((a) => t(locale, `audit.actions.${a}`).toLocaleLowerCase().includes(needle));
    conditions.push(
      or(
        ilike(auditEvents.username, pattern),
        ilike(auditEvents.ip, pattern),
        ilike(auditEvents.action, pattern),
        sql`${auditEvents.details}::text ilike ${pattern}`,
        named.length > 0 ? inArray(auditEvents.action, named) : undefined,
      ),
    );
  }
  return and(...conditions);
}

function out(row: typeof auditEvents.$inferSelect): AuditEventOut {
  return {
    id: row.id,
    at: row.at.toISOString(),
    userId: row.userId,
    username: row.username,
    action: row.action,
    category: categoryOf(row.action),
    outcome: row.outcome,
    targetType: row.targetType,
    targetId: row.targetId,
    details: row.details,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}

/** Newest first; `before` is the id of the last event already shown. */
export async function listAuditEvents(db: Db, viewer: Viewer, input: z.input<typeof auditListInput>): Promise<AuditPage> {
  requireSuperuser(viewer);
  const { before, limit, ...filters } = auditListInput.parse(input);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(whereFor(viewer, filters, before))
    .orderBy(desc(auditEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(out);
  return { items, nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null, retentionDays: env().AUDIT_RETENTION_DAYS };
}

const CSV_MAX_ROWS = 50_000;

/** The filtered log as a stable, machine-readable file: German headers, action keys, details as JSON. */
export async function auditCsv(db: Db, viewer: Viewer, input: z.input<typeof auditFilterInput>): Promise<string> {
  requireSuperuser(viewer);
  const filters = auditFilterInput.parse(input);
  const rows = await db.select().from(auditEvents).where(whereFor(viewer, filters)).orderBy(desc(auditEvents.id)).limit(CSV_MAX_ROWS);
  const quote = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ["Zeit", "Benutzer", "Aktion", "Ergebnis", "Ziel", "Details", "IP", "User-Agent"];
  const lines = rows.map((r) =>
    [
      r.at.toISOString(),
      csvCell(r.username),
      r.action,
      r.outcome,
      r.targetType ? csvCell(`${r.targetType}:${r.targetId ?? ""}`) : "",
      csvCell(JSON.stringify(r.details)),
      csvCell(r.ip),
      csvCell(r.userAgent),
    ]
      .map((v) => quote(v ?? ""))
      .join(";"),
  );
  await record(db, { action: "export.auditCsv", actor: viewer, details: { rows: rows.length } });
  return `﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

// ---- retention

/** Deletes events older than the retention period (`AUDIT_RETENTION_DAYS`); returns how many went. */
export async function pruneAuditEvents(db: Db, now: Date, days: number = env().AUDIT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const deleted = await db.delete(auditEvents).where(lt(auditEvents.at, cutoff)).returning({ id: auditEvents.id });
  return deleted.length;
}
