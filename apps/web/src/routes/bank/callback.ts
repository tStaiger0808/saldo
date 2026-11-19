import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../i18n/index.ts";
import { sessionUser } from "../../server/auth.ts";
import { db } from "../../server/db/index.ts";
import { UserError } from "../../server/errors.ts";
import { browserLocale } from "../../server/locale.ts";
import { completeAuthorization, psuHeaders } from "../../server/modules/banking/index.ts";
import { readOnlyError } from "../../server/modules/impersonation/index.ts";

// The accounts page lists the new accounts of the connection, shows the outcome and opens the running sync.
const SETTINGS_PAGE = "/konten";

function backToSettings(request: Request, outcome: "ok" | "hinweis" | "fehler", message: string, jobId?: string): Response {
  // Code and state are one-time secrets, so only the outcome is logged.
  console.info(`Bank callback: ${outcome === "fehler" ? `failed – ${message}` : `authorization completed (${outcome})`}`);
  const target = new URL(SETTINGS_PAGE, request.url);
  target.searchParams.set("abruf", outcome);
  target.searchParams.set("meldung", message);
  if (jobId) target.searchParams.set("auftrag", jobId);
  return new Response(null, { status: 303, headers: { Location: `${target.pathname}${target.search}` } });
}

/** Return address registered with Enable Banking; the bank sends the browser here with code and state. */
export const Route = createFileRoute("/bank/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return backToSettings(request, "fehler", t(browserLocale(request.headers), "banking.callback.signIn"));
        const { locale } = user;
        // Also checked here: the request guard matches this path exactly and must not depend on how the router normalizes it.
        if (user.impersonation) {
          return backToSettings(request, "fehler", readOnlyError(user.name || user.username).localized(locale));
        }
        const query = new URL(request.url).searchParams;
        try {
          const result = await completeAuthorization(
            db(),
            user,
            {
              code: query.get("code") ?? undefined,
              state: query.get("state") ?? undefined,
              error: query.get("error") ?? undefined,
              errorDescription: query.get("error_description") ?? undefined,
            },
            await psuHeaders(request),
          );
          return backToSettings(request, result.tone === "ok" ? "ok" : "hinweis", result.message, result.job?.id);
        } catch (error) {
          if (error instanceof UserError) return backToSettings(request, "fehler", error.localized(locale));
          console.error(`Bank callback failed: ${error instanceof Error ? error.name : typeof error}`);
          return backToSettings(request, "fehler", t(locale, "banking.callback.failed"));
        }
      },
    },
  },
});
