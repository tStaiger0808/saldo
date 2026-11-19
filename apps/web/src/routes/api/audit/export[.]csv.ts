import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { auditCsv, auditFilterInput } from "../../../server/modules/audit/index.ts";

function filtersFrom(url: URL) {
  const p = url.searchParams;
  return auditFilterInput.parse({
    userId: p.get("user"),
    category: p.get("category"),
    outcome: p.get("outcome"),
    dateFrom: p.get("from"),
    dateTo: p.get("to"),
    q: p.get("q"),
  });
}

export const Route = createFileRoute("/api/audit/export.csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return new Response(t(browserLocale(request.headers), "errors.notSignedIn"), { status: 401 });
        try {
          const csv = await auditCsv(db(), user, filtersFrom(new URL(request.url)));
          return new Response(csv, {
            headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="protokoll.csv"' },
          });
        } catch (error) {
          if (error instanceof UserError) return new Response(error.localized(user.locale), { status: error.status });
          throw error;
        }
      },
    },
  },
});
