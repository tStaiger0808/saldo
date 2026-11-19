import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { MAX_UPLOAD_BYTES, uploadRestoreArchive } from "../../../server/modules/backup/index.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** An archive to restore, streamed to disk as the raw request body (up to 2 GB); its name in the query. */
export const Route = createFileRoute("/api/backup/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return json({ error: t(browserLocale(request.headers), "errors.notSignedIn") }, 401);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
          return json({ error: t(user.locale, "backup.errors.uploadTooLarge") }, 413);
        }
        if (!request.body) return json({ error: t(user.locale, "backup.errors.notAnArchive") }, 400);
        const name = new URL(request.url).searchParams.get("name") ?? "";
        try {
          return json(await uploadRestoreArchive(user, request.body, name));
        } catch (error) {
          if (error instanceof UserError) return json({ error: error.localized(user.locale) }, error.status);
          throw error;
        }
      },
    },
  },
});
