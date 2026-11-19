import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { msg } from "../i18n/index.ts";
import { type SessionUser, sessionUser } from "./auth.ts";
import { Forbidden, localizeError, UserError } from "./errors.ts";
import { browserLocale } from "./locale.ts";
import { readOnlyError, refusedWhileImpersonating, serverFnAllowedWhileImpersonating } from "./modules/impersonation/index.ts";

async function requireSession(): Promise<SessionUser> {
  const headers = getRequest().headers;
  const user = await sessionUser(headers);
  if (!user) throw localizeError(new UserError(msg("errors.notSignedIn"), 401), browserLocale(headers));
  return user;
}

async function withUser<T>(user: SessionUser, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw localizeError(error, user.locale);
  }
}

/** Any signed-in user; visibility is enforced by modules/access in each module. */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await requireSession();
  return withUser(user, () => next({ context: { user } }));
});

/** Instance-wide settings: banking access, SMTP, AI providers, audit log. */
export const superuserMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await requireSession();
  if (user.role !== "superuser") throw localizeError(new Forbidden(msg("errors.superuserOnly")), user.locale);
  return withUser(user, () => next({ context: { user } }));
});

/** Household administration (groups, categories, tags, rules, members): superusers and family admins. */
export const householdAdminMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await requireSession();
  if (user.role !== "superuser" && user.role !== "familyAdmin") throw localizeError(new Forbidden(), user.locale);
  return withUser(user, () => next({ context: { user } }));
});

/**
 * Registered for every server function in start.ts: while a superuser views Saldo as someone else, only reads and
 * ending that view run. Each function's own middleware still decides who may call it.
 */
export const readOnlyWhileImpersonating = createMiddleware({ type: "function" }).server(async ({ next, method, serverFnMeta }) => {
  const request = getRequest();
  if (serverFnAllowedWhileImpersonating(method, serverFnMeta, request.method)) return next();
  const user = await sessionUser(request.headers);
  if (user?.impersonation) throw localizeError(readOnlyError(user.name || user.username), user.locale);
  return next();
});

/** The same for every other request (server routes, the auth API), registered as request middleware in start.ts. */
export const readOnlyRequests = createMiddleware().server(async ({ next, request }) => {
  if (!refusedWhileImpersonating(request.method, new URL(request.url).pathname)) return next();
  const user = await sessionUser(request.headers);
  if (!user?.impersonation) return next();
  const message = readOnlyError(user.name || user.username).localized(user.locale);
  // Saldo's own routes read `error`, the better-auth client reads `message`.
  return Response.json({ error: message, message }, { status: 403 });
});
