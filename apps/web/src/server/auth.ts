import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { username } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { isLocale, type Locale, resolveLocale } from "../i18n/locales.ts";
import { withResolvedClientIp } from "./client-ip.ts";
import { db, schema } from "./db/index.ts";
import { ROLES, type Role } from "./db/schema.ts";
import { env, trustedOrigins } from "./env.ts";
import { AUDITED_AUTH_PATHS, noteImpersonation, recordAuthEvent, SIGN_IN_PATHS } from "./modules/audit/index.ts";
import { ensureDefaultDashboards } from "./modules/dashboards/index.ts";
import { activeImpersonation, endImpersonation } from "./modules/impersonation/index.ts";
import { endStandingAccess } from "./modules/users/index.ts";

/**
 * Login name, the name others see and the email are set by superusers and family admins only (modules/users); the own
 * display name goes through setOwnNameFn.
 */
const NOT_SELF_SERVICE = new Set(["/update-user", "/change-email"]);

function createAuth() {
  const { APP_URL, AUTH_SECRET } = env();
  return betterAuth({
    baseURL: APP_URL,
    trustedOrigins: trustedOrigins(),
    secret: AUTH_SECRET,
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    // Logins are created by superusers and family admins only (modules/users), never by sign-up.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 256 },
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "member", input: false },
        locale: { type: "string", required: false, input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 900, max: env().SIGN_IN_LIMIT },
        "/sign-in/email": { window: 900, max: env().SIGN_IN_LIMIT },
      },
    },
    // handleAuthRequest puts the resolved client address (server/client-ip.ts) into X-Forwarded-For as its only entry.
    advanced: { useSecureCookies: APP_URL.startsWith("https://"), ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    hooks: {
      // The session is gone once sign-out ran, so its owner is read before.
      before: createAuthMiddleware(async (ctx) => {
        if (NOT_SELF_SERVICE.has(ctx.path)) throw new APIError("FORBIDDEN", { message: "Not available" });
        if (ctx.path !== "/sign-out") return;
        const session = await getSessionFromCtx(ctx).catch(() => null);
        if (!session) return;
        await endImpersonation(db(), session.session.id, "signOut");
        await recordAuthEvent(db(), { path: ctx.path, body: null, failed: false, user: session.user });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-out" || !AUDITED_AUTH_PATHS.has(ctx.path)) return;
        const user = ctx.context.newSession?.user ?? ctx.context.session?.user ?? null;
        const failed = isAPIError(ctx.context.returned);
        if (ctx.path === "/change-password" && user && !failed) await endStandingAccess(db(), user.id);
        if (SIGN_IN_PATHS.has(ctx.path) && user && !failed) await firstDashboards(user as UserFields, ctx.headers);
        await recordAuthEvent(db(), {
          path: ctx.path,
          body: ctx.body,
          failed,
          user,
        });
      }),
    },
    plugins: [username(), tanstackStartCookies()],
  });
}

/** GET requests never write, so a user's default dashboards are set up when they sign in. */
async function firstDashboards(user: UserFields, headers: Headers | undefined): Promise<void> {
  try {
    await ensureDefaultDashboards(db(), toSessionUser(user, headers ?? new Headers()));
  } catch (error) {
    console.error("Could not set up the default dashboards", error);
  }
}

type Auth = ReturnType<typeof createAuth>;

/** The /api/auth route: better-auth's rate limits and sessions see the client address Saldo trusts, never a raw header. */
export function handleAuthRequest(request: Request): Promise<Response> {
  return auth().handler(withResolvedClientIp(request));
}
let instance: Auth | undefined;

export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}

/**
 * `locale` is the language this request is answered in; `localePreference` the stored choice (null follows the browser).
 * `impersonation` is set while a superuser views Saldo as this user: who they are and when the view ends.
 */
export type SessionUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  locale: Locale;
  localePreference: Locale | null;
  impersonation?: { actorId: string; actorName: string; expiresAt: string };
};

type UserFields = { id: string; name: string; username?: string | null; role?: string | null; locale?: string | null };

function toSessionUser(user: UserFields, headers: Headers): SessionUser {
  const localePreference = isLocale(user.locale) ? user.locale : null;
  return {
    id: user.id,
    username: user.username ?? user.name,
    name: user.name,
    role: ROLES.find((r) => r === user.role) ?? "member",
    locale: resolveLocale(localePreference, headers.get("accept-language")),
    localePreference,
  };
}

/** The signed-in person themselves, never the one a superuser views Saldo as; for starting and ending that view. */
export async function signedInSession(headers: Headers): Promise<{ sessionId: string; user: SessionUser } | null> {
  const result = await auth().api.getSession({ headers });
  return result ? { sessionId: result.session.id, user: toSessionUser(result.user as UserFields, headers) } : null;
}

/** Whom the request acts for: the signed-in user, or the person their superuser session views Saldo as (read-only). */
export async function sessionUser(headers: Headers): Promise<SessionUser | null> {
  const signedIn = await signedInSession(headers);
  if (!signedIn) return null;
  const { sessionId, user: actor } = signedIn;
  const active = await activeImpersonation(db(), sessionId, actor);
  if (!active) return actor;
  noteImpersonation({ targetUserId: active.target.id, actorName: actor.username });
  return {
    ...toSessionUser(active.target, headers),
    impersonation: { actorId: actor.id, actorName: actor.username, expiresAt: active.expiresAt.toISOString() },
  };
}
