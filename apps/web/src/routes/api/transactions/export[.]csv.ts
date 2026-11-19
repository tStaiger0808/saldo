import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { exportCsv, filterInput } from "../../../server/modules/transactions/index.ts";

function filtersFrom(url: URL) {
  const p = url.searchParams;
  const num = (key: string) => (p.get(key) ? Number(p.get(key)) : null);
  return filterInput.parse({
    groupId: num("group"),
    accountId: num("account"),
    categoryId: num("category"),
    tagId: num("tag"),
    uncategorized: p.get("uncategorized") === "1",
    unread: p.get("unread") === "1",
    aiSuggested: p.get("ai") === "1",
    includeTransfers: p.get("transfers") !== "0",
    q: p.get("q"),
    dateFrom: p.get("from"),
    dateTo: p.get("to"),
    minAmountCents: num("min"),
    maxAmountCents: num("max"),
    absMinCents: num("absMin"),
    absMaxCents: num("absMax"),
  });
}

export const Route = createFileRoute("/api/transactions/export.csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return new Response(t(browserLocale(request.headers), "errors.notSignedIn"), { status: 401 });
        try {
          const csv = await exportCsv(db(), user, filtersFrom(new URL(request.url)));
          return new Response(csv, {
            headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="buchungen.csv"' },
          });
        } catch (error) {
          if (error instanceof UserError) return new Response(error.localized(user.locale), { status: error.status });
          throw error;
        }
      },
    },
  },
});
