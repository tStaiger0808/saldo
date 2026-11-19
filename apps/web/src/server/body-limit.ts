import { t } from "../i18n/index.ts";
import { browserLocale } from "./locale.ts";

const MAX_BODY_BYTES = 1024 * 1024;
// CSV imports send the file itself (up to 2 MB); the route checks the exact limit.
const CSV_IMPORT = /^\/api\/accounts\/\d+\/import\.csv$/;
const MAX_CSV_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024;
// Contract documents send the file itself (up to 10 MB); the route checks the exact limit.
const CONTRACT_DOCUMENT_UPLOAD = /^\/api\/contracts\/\d+\/documents$/;
const MAX_DOCUMENT_BODY_BYTES = 10 * 1024 * 1024 + 64 * 1024;
// Profile pictures send the image itself (up to 2 MB); the route checks the exact limit.
const AVATAR_UPLOAD = /^\/api\/avatars\/[^/]+$/;
const MAX_AVATAR_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024;
// Archives to restore stream to disk (up to 2 GB); the route checks the exact limit.
const BACKUP_UPLOAD = /^\/api\/backup\/upload$/;
const MAX_BACKUP_BODY_BYTES = 2 * 1024 * 1024 * 1024 + 64 * 1024;
const READERS = new Set(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

type Fetch = (request: Request) => Response | Promise<Response>;
type Overrun = { exceeded: boolean };

export function bodyLimit(pathname: string): number {
  if (CSV_IMPORT.test(pathname)) return MAX_CSV_BODY_BYTES;
  if (CONTRACT_DOCUMENT_UPLOAD.test(pathname)) return MAX_DOCUMENT_BODY_BYTES;
  if (AVATAR_UPLOAD.test(pathname)) return MAX_AVATAR_BODY_BYTES;
  if (BACKUP_UPLOAD.test(pathname)) return MAX_BACKUP_BODY_BYTES;
  return MAX_BODY_BYTES;
}

function countingStream(body: ReadableStream<Uint8Array>, limit: number, overrun: Overrun): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      size += value.byteLength;
      if (size > limit) {
        overrun.exceeded = true;
        const error = new RangeError("Request body too large");
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * The request with every way of reading its body going through a byte counter. A Proxy rather than a new Request keeps
 * what the server put on the original, such as the socket address (`ip`).
 */
function limitedRequest(request: Request, limit: number, overrun: Overrun): Request {
  let limited: Response | undefined;
  const body = () => {
    limited ??= new Response(request.body && countingStream(request.body, limit, overrun), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    });
    return limited;
  };
  return new Proxy(request, {
    get(target, prop) {
      if (prop === "body") return body().body;
      if (prop === "bodyUsed") return limited?.bodyUsed ?? target.bodyUsed;
      if (typeof prop === "string" && READERS.has(prop)) return () => (body() as unknown as Record<string, () => unknown>)[prop]?.();
      if (prop === "clone") return () => limitedRequest(target.clone(), limit, overrun);
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Caps request bodies by the bytes actually read, also when they arrive chunked without Content-Length: reading stops at
 * the limit and the answer is a 413, whatever the handler made of the cut-off body.
 */
export function withBodyLimits(fetch: Fetch): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!request.body) return fetch(request);
    const limit = bodyLimit(new URL(request.url).pathname);
    const tooLarge = () => new Response(t(browserLocale(request.headers), "errors.requestTooLarge"), { status: 413 });
    if (Number(request.headers.get("content-length") ?? 0) > limit) {
      await request.body.cancel().catch(() => undefined);
      return tooLarge();
    }
    const overrun: Overrun = { exceeded: false };
    let response: Response;
    try {
      response = await fetch(limitedRequest(request, limit, overrun));
    } catch (error) {
      if (overrun.exceeded) return tooLarge();
      throw error;
    }
    if (!overrun.exceeded) return response;
    await response.body?.cancel().catch(() => undefined);
    return tooLarge();
  };
}
