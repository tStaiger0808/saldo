import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../../i18n/index.ts";
import { sessionUser } from "../../../../server/auth.ts";
import { db } from "../../../../server/db/index.ts";
import { UserError } from "../../../../server/errors.ts";
import { browserLocale } from "../../../../server/locale.ts";
import { addContractDocument, MAX_DOCUMENT_BYTES } from "../../../../server/modules/contracts/index.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The file travels as the raw request body (up to 10 MB, above the limit of server functions), its name in the query. */
export const Route = createFileRoute("/api/contracts/$contractId/documents")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return json({ error: t(browserLocale(request.headers), "errors.notSignedIn") }, 401);
        const contractId = Number(params.contractId);
        if (!Number.isSafeInteger(contractId)) return json({ error: t(user.locale, "contracts.errors.notFound") }, 404);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) {
          return json({ error: t(user.locale, "contracts.documents.errors.tooLarge") }, 413);
        }
        const fileName = (new URL(request.url).searchParams.get("name") ?? "").slice(0, 255);
        try {
          const bytes = new Uint8Array(await request.arrayBuffer());
          return json({ id: await addContractDocument(db(), user, { contractId, fileName, bytes }) });
        } catch (error) {
          if (error instanceof UserError) return json({ error: error.localized(user.locale) }, error.status);
          throw error;
        }
      },
    },
  },
});
