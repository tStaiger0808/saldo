import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { openDownload } from "../../../server/modules/backup/index.ts";

/** One archive streamed from its target (superusers only, audited); the archive stays encrypted. */
export const Route = createFileRoute("/api/backup/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return new Response(t(browserLocale(request.headers), "errors.notSignedIn"), { status: 401 });
        const params = new URL(request.url).searchParams;
        try {
          const { stream, size, name } = await openDownload(db(), user, {
            targetId: params.get("target") ?? "",
            name: params.get("name") ?? "",
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(size),
              "Content-Disposition": `attachment; filename="${name}"`,
            },
          });
        } catch (error) {
          if (error instanceof UserError) return new Response(error.localized(user.locale), { status: error.status });
          if (error instanceof Error && error.message.startsWith("[")) {
            return new Response(t(user.locale, "backup.errors.archiveName"), { status: 400 });
          }
          throw error;
        }
      },
    },
  },
});
