import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { readContractDocument } from "../../../server/modules/contracts/index.ts";

/** RFC 6266: an ASCII fallback and the full name in UTF-8. */
function attachment(fileName: string): string {
  const fallback = fileName.normalize("NFKD").replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Always a download, never shown inline, so a crafted file cannot run in Saldo's origin. */
export const Route = createFileRoute("/api/contract-documents/$documentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return new Response(t(browserLocale(request.headers), "errors.notSignedIn"), { status: 401 });
        const id = Number(params.documentId);
        if (!Number.isSafeInteger(id)) return new Response(t(user.locale, "contracts.documents.errors.notFound"), { status: 404 });
        try {
          const file = await readContractDocument(db(), user, id);
          return new Response(new Uint8Array(file.data), {
            headers: {
              "Content-Type": file.contentType,
              "Content-Length": String(file.data.byteLength),
              "Content-Disposition": attachment(file.fileName),
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "Cache-Control": "private, no-store",
            },
          });
        } catch (error) {
          if (error instanceof UserError) return new Response(error.localized(user.locale), { status: error.status });
          throw error;
        }
      },
    },
  },
});
