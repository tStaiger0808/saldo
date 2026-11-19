import { createFileRoute } from "@tanstack/react-router";
import { t } from "../../../i18n/index.ts";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { browserLocale } from "../../../server/locale.ts";
import { MAX_AVATAR_BYTES, readAvatar, setAvatar } from "../../../server/modules/avatars/index.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * GET shows a picture inline; it is only ever one of the sniffed image types, and the sandbox keeps anything else from
 * running. The URL changes with every new picture (`?v=`), so it may be cached for good. POST takes the own picture as the
 * raw request body (up to 2 MB, above the limit of server functions).
 */
export const Route = createFileRoute("/api/avatars/$userId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return new Response(t(browserLocale(request.headers), "errors.notSignedIn"), { status: 401 });
        try {
          const avatar = await readAvatar(db(), user, params.userId);
          return new Response(new Uint8Array(avatar.data), {
            headers: {
              "Content-Type": avatar.contentType,
              "Content-Length": String(avatar.data.byteLength),
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        } catch (error) {
          if (error instanceof UserError) return new Response(error.localized(user.locale), { status: error.status });
          throw error;
        }
      },
      POST: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return json({ error: t(browserLocale(request.headers), "errors.notSignedIn") }, 401);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_AVATAR_BYTES) {
          return json({ error: t(user.locale, "personal.avatar.errors.tooLarge") }, 413);
        }
        try {
          const bytes = new Uint8Array(await request.arrayBuffer());
          return json({ url: await setAvatar(db(), user, params.userId, bytes) });
        } catch (error) {
          if (error instanceof UserError) return json({ error: error.localized(user.locale) }, error.status);
          throw error;
        }
      },
    },
  },
});
