import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../../i18n/index.ts";
import { sessionUser } from "../../../../server/auth.ts";
import { db } from "../../../../server/db/index.ts";
import { UserError } from "../../../../server/errors.ts";
import { browserLocale } from "../../../../server/locale.ts";
import { csvMappingSchema, importCsvBookings, MAX_CSV_BYTES } from "../../../../server/modules/accounts/index.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The file travels as the raw request body (up to 2 MB, above the limit of server functions), the mapping in the query. */
export const Route = createFileRoute("/api/accounts/$accountId/import.csv")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return json({ error: t(browserLocale(request.headers), "errors.notSignedIn") }, 401);
        const accountId = Number(params.accountId);
        if (!Number.isSafeInteger(accountId)) return json({ error: t(user.locale, "errors.accountNotFound") }, 404);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_CSV_BYTES) {
          return json({ error: t(user.locale, "accounts.errors.csvTooLarge") }, 413);
        }
        let mapping: unknown;
        try {
          mapping = JSON.parse(new URL(request.url).searchParams.get("mapping") ?? "");
        } catch {
          mapping = null;
        }
        const parsed = csvMappingSchema.safeParse(mapping);
        if (!parsed.success) return json({ error: t(user.locale, "accounts.errors.csvMapping") }, 400);
        try {
          return json(await importCsvBookings(db(), user, { accountId, content: await request.text(), mapping: parsed.data }));
        } catch (error) {
          if (error instanceof UserError) return json({ error: error.localized(user.locale) }, error.status);
          throw error;
        }
      },
    },
  },
});
