import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { readOnlyRequests, readOnlyWhileImpersonating } from "./server/middleware.ts";
import { requestMeta, withRequestMeta } from "./server/modules/audit/context.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// SSR hydration uses inline scripts, so the policy restricts framing, plugins and form targets instead of scripts.
const CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

// Body sizes are capped in server.ts, where the bytes are counted as they are read.
const securityHeaders = createMiddleware().server(async ({ next, request }) => {
  const result = await next();
  const headers = result.response.headers;
  // A route's own, stricter policy (inert SVG bank logos) and its own caching stay.
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  const path = new URL(request.url).pathname;
  if ((path.startsWith("/api/") || path.startsWith("/_serverFn")) && !headers.has("Cache-Control"))
    headers.set("Cache-Control", "no-store");
  return result;
});

const csrf = createCsrfMiddleware({
  // MCP clients authenticate with a bearer token, not a cookie, so cross-site checks do not apply there.
  filter: ({ request }) => !SAFE_METHODS.has(request.method) && new URL(request.url).pathname !== "/api/mcp",
});

// Audit events written anywhere in the request (or in a job it starts) carry its client address and user agent.
const audit = createMiddleware().server(({ next, request }) => withRequestMeta(requestMeta(request), () => next()));

// After `audit`: resolving the session there notes a superuser's view of someone else for the audit events.
export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, csrf, audit, readOnlyRequests],
  functionMiddleware: [readOnlyWhileImpersonating],
}));
