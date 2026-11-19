import { beforeEach, describe, expect, it } from "vitest";
import { withBodyLimits } from "./server/body-limit.ts";
import { bankLogoResponse } from "./server/modules/banking/index.ts";
import { resetDb } from "./server/test-helpers.ts";
import { startInstance } from "./start.ts";

type Handler = (request: Request) => Promise<Response>;
type Ctx = { response: Response };
type RequestServer = (options: {
  request: Request;
  pathname: string;
  context: object;
  next: () => Promise<Ctx>;
}) => Promise<Ctx | Response>;

/**
 * The app as server.ts serves it: the body limit around the request middleware start.ts registers, in order, around a
 * route handler, as TanStack Start runs them.
 */
async function pipeline(handler: Handler): Promise<Handler> {
  const middleware = ((await startInstance.getOptions()).requestMiddleware ?? []) as unknown as { options: { server: RequestServer } }[];
  return withBodyLimits(async (request) => {
    const run = async (index: number): Promise<Ctx> => {
      const current = middleware[index];
      if (!current) return { response: await handler(request) };
      const pathname = new URL(request.url).pathname;
      const result = await current.options.server({ request, pathname, context: {}, next: () => run(index + 1) });
      return result instanceof Response ? { response: result } : result;
    };
    return (await run(0)).response;
  });
}

const ORIGIN = "https://saldo.test";

/** A body sent in chunks without Content-Length, as `Transfer-Encoding: chunked` arrives. */
function chunked(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const chunk = new Uint8Array(Math.min(64 * 1024, totalBytes - sent)).fill(97);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

const post = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", ...headers },
    body,
    duplex: "half",
  } as RequestInit);

describe("request pipeline", () => {
  beforeEach(resetDb);

  it("keeps the strict policy and caching of a bank logo instead of the app-wide defaults", async () => {
    const app = await pipeline(async () => bankLogoResponse({ contentType: "image/svg+xml", data: Buffer.from("<svg/>") }));
    const response = await app(new Request(`${ORIGIN}/api/bank-logo/by-name?country=DE&name=x`));
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(response.headers.get("x-frame-options")).toBe("DENY");

    const page = await (await pipeline(async () => new Response("ok")))(new Request(`${ORIGIN}/api/health`));
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a chunked body over the limit while it streams, for every route", async () => {
    let read = 0;
    const handler: Handler = async (request) => {
      read = (await request.arrayBuffer()).byteLength;
      return new Response("read");
    };
    const app = await pipeline(handler);
    const big = await app(post("/_serverFn/x", chunked(3 * 1024 * 1024), { "content-type": "application/json" }));
    expect(big.status).toBe(413);
    expect(read).toBe(0);
    const csv = await app(post("/api/accounts/1/import.csv", chunked(2 * 1024 * 1024 + 128 * 1024), { "content-type": "text/csv" }));
    expect(csv.status).toBe(413);
    const fine = await app(post("/api/accounts/1/import.csv", chunked(1024 * 1024 + 1), { "content-type": "text/csv" }));
    expect(fine.status).toBe(200);
  });

  it("refuses cross-origin and origin-less writes to server functions and API routes", async () => {
    const app = await pipeline(async () => new Response("ran"));
    const cases: [Record<string, string>, number][] = [
      [{ "sec-fetch-site": "same-site", origin: "http://192.0.2.1:9999" }, 403],
      [{ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, 403],
      [{ origin: "https://evil.example" }, 403],
      [{}, 403],
      [{ "sec-fetch-site": "same-origin", origin: ORIGIN }, 200],
    ];
    for (const path of ["/_serverFn/abc", "/api/accounts/1/import.csv", "/api/auth/sign-in/username"]) {
      for (const [headers, status] of cases) {
        const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: "{}" });
        expect({ path, headers, status: (await app(request)).status }).toEqual({ path, headers, status });
      }
    }
    // MCP clients authenticate with a bearer token; only that exact endpoint skips the check.
    const mcp = new Request(`${ORIGIN}/api/mcp`, { method: "POST", body: "{}" });
    expect((await app(mcp)).status).toBe(200);
    const lookalike = new Request(`${ORIGIN}/api/mcp-admin`, { method: "POST", body: "{}" });
    expect((await app(lookalike)).status).toBe(403);
  });
});
