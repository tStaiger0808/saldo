import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAuthRequest } from "./auth.ts";
import { clientIp, parseTrustedProxy } from "./client-ip.ts";
import { db } from "./db/index.ts";
import { auditEvents } from "./db/schema.ts";
import { resetEnvForTests } from "./env.ts";
import { requestMeta, withRequestMeta } from "./modules/audit/index.ts";
import { makeUser, resetDb } from "./test-helpers.ts";

const ORIGIN = "https://saldo.test";

/** A request as the server hands it over: `ip` is the socket peer. */
function fromPeer(peer: string, path: string, body: object, headers: Record<string, string> = {}): Request {
  const request = new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": "vitest", ...headers },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "ip", { value: peer });
  return request;
}

/** The auth route inside start.ts's audit middleware, which notes the client address for audit events. */
const route = (request: Request) => withRequestMeta(requestMeta(request), () => handleAuthRequest(request));

const wrongSignIn = (peer: string, forwarded?: string) =>
  route(
    fromPeer(
      peer,
      "/sign-in/username",
      { username: "probe", password: "wrong-password-123" },
      forwarded ? { "x-forwarded-for": forwarded } : {},
    ),
  );

function setTrustedProxy(value: string | undefined): void {
  if (value === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = value;
  resetEnvForTests();
}

describe("sign-in throttle and the client address", () => {
  beforeEach(async () => {
    await resetDb();
    await makeUser("probe", "member");
  });
  afterEach(() => setTrustedProxy(undefined));

  it("ignores X-Forwarded-For without a trusted proxy, so rotating it does not reset the limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await wrongSignIn("192.0.2.11", `198.51.100.${10 + i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("keys the limit on the forwarded client behind a trusted proxy", async () => {
    setTrustedProxy("on");
    for (let i = 0; i < 10; i++) expect((await wrongSignIn("127.0.0.1", "203.0.113.21")).status).toBe(401);
    expect((await wrongSignIn("127.0.0.1", "203.0.113.21")).status).toBe(429);
    // A client-supplied entry in front of the proxy's does not open a new bucket.
    expect((await wrongSignIn("127.0.0.1", "198.51.100.1, 203.0.113.21")).status).toBe(429);
    expect((await wrongSignIn("127.0.0.1", "203.0.113.22")).status).toBe(401);
  });

  it("records the socket address in the audit log, not a forged header", async () => {
    await wrongSignIn("192.0.2.33", "198.51.100.99");
    const rows = await db().select().from(auditEvents);
    expect(rows.map((r) => r.ip)).toEqual(["192.0.2.33"]);
  });
});

describe("clientIp", () => {
  const request = (peer: string | null, forwarded?: string) => {
    const r = new Request("https://saldo.test/", { headers: forwarded ? { "x-forwarded-for": forwarded } : {} });
    if (peer !== null) Object.defineProperty(r, "ip", { value: peer });
    return r;
  };
  const trust = (value: string) => parseTrustedProxy(value) ?? { mode: "off" as const };

  it("is the socket peer when no proxy is trusted", () => {
    expect(clientIp(request("::ffff:192.0.2.1", "198.51.100.1"), trust("off"))).toBe("192.0.2.1");
    expect(clientIp(request(null, "198.51.100.1"), trust("off"))).toBeNull();
  });

  it("takes the entry the trusted hops added", () => {
    expect(clientIp(request("10.0.0.2", "198.51.100.1, 203.0.113.5"), trust("on"))).toBe("203.0.113.5");
    expect(clientIp(request("10.0.0.2", "198.51.100.1, 203.0.113.5, 10.0.0.9"), trust("2"))).toBe("203.0.113.5");
    expect(clientIp(request("10.0.0.2"), trust("on"))).toBe("10.0.0.2");
    expect(clientIp(request("10.0.0.2", "not-an-ip"), trust("on"))).toBe("10.0.0.2");
  });

  it("believes the header only from listed proxies and skips them from the right", () => {
    const proxies = trust("172.16.0.0/12, 127.0.0.1");
    expect(clientIp(request("192.0.2.7", "198.51.100.1"), proxies)).toBe("192.0.2.7");
    expect(clientIp(request("172.18.0.3", "198.51.100.1, 203.0.113.5, 172.18.0.4"), proxies)).toBe("203.0.113.5");
    expect(clientIp(request("127.0.0.1", "203.0.113.5"), proxies)).toBe("203.0.113.5");
  });

  it("rejects settings it cannot read", () => {
    expect(parseTrustedProxy("0")).toBeNull();
    expect(parseTrustedProxy("11")).toBeNull();
    expect(parseTrustedProxy("10.0.0.0/33")).toBeNull();
    expect(parseTrustedProxy("proxy.lan")).toBeNull();
    expect(parseTrustedProxy("fd00::/8,10.0.0.1")).not.toBeNull();
  });
});
