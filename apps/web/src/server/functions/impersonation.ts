import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { msg } from "../../i18n/index.ts";
import { signedInSession } from "../auth.ts";
import { db } from "../db/index.ts";
import { localizeError, UserError } from "../errors.ts";
import { browserLocale } from "../locale.ts";
import { superuserMiddleware } from "../middleware.ts";
import { endImpersonation, startImpersonation, startImpersonationInput } from "../modules/impersonation/index.ts";

async function requireSignedIn() {
  const headers = getRequest().headers;
  const session = await signedInSession(headers);
  if (!session) throw localizeError(new UserError(msg("errors.notSignedIn"), 401), browserLocale(headers));
  return session;
}

export const startImpersonationFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(startImpersonationInput)
  .handler(async ({ data, context }) => {
    const { sessionId } = await requireSignedIn();
    await startImpersonation(db(), context.user, sessionId, data);
  });

/** Works on the superuser's own session, so it is the one change allowed while viewing as someone else. */
export const stopImpersonationFn = createServerFn({ method: "POST" }).handler(async () => {
  const { sessionId } = await requireSignedIn();
  await endImpersonation(db(), sessionId, "stopped");
});
