import { describe, expect, it } from "vitest";
import { assertGivveAllowed, GIVVE_ALLOWLIST, GivveClient, GivveSessionExpired, mapTransactionGroup } from "./givve.ts";
import type { TanChallenge } from "./types.ts";

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp, aud: "voucher_owner" })).toString("base64url")}.s`;
const NOW = new Date("2026-11-15T12:00:00Z");
const LATER = Math.floor(NOW.getTime() / 1000) + 3600;

/** A stand-in for www.givve.com/api with the e-mail one-time code step; it records every request. */
function fakeGivve() {
  const calls: { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null }[] = [];
  const state = { refreshWorks: true };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/api/, "");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, query: url.searchParams, body });
    const auth = new Headers(init.headers).get("authorization");
    if (method === "POST" && path === "/authorizations") {
      if (body?.identifier === "refresh-1")
        return state.refreshWorks
          ? json({ data: { access_token: jwt(LATER), refresh_token: "refresh-2", auth_status: "authenticated" } })
          : json({}, 401);
      if (body?.identifier !== "ich@example.org" || body?.password !== "geheim") return json({ error: "Invalid email or password" }, 401);
      if (body.otp === undefined) return json({ data: { access_token: null, auth_status: "otp_required" } }, 202);
      if (body.otp !== "123456") return json({ error: "unauthorized" }, 401);
      return json({ data: { token_type: "bearer", access_token: jwt(LATER), refresh_token: "refresh-1", auth_status: "authenticated" } });
    }
    if (!auth?.startsWith("Bearer ")) return json({}, 401);
    if (path === "/voucher_owners/me/vouchers")
      return json({ data: [{ id: "v1", number: "521965******6363", balance: { cents: 4321, currency: "EUR" } }] });
    if (path === "/voucher_owners/me/vouchers/v1")
      return json({ data: { id: "v1", balance: { cents: 4321, currency: "EUR" }, updated_at: "2026-11-14T10:00:00+01:00" } });
    if (path === "/voucher_owners/me/vouchers/v1/transaction_groups")
      return json({
        data: [
          {
            id: "g1",
            first_booked_at: "2026-11-10T12:00:00+01:00",
            status: ["ok"],
            category: ["purchase"],
            amount: { cents: -5330, currency: "EUR" },
            merchant_name: "REWE",
          },
          {
            id: "g2",
            first_booked_at: "2026-11-01T08:00:00+01:00",
            status: ["ok"],
            category: ["balance_adjustment", "load"],
            amount: { cents: 5000 },
            description: "Aufladung",
          },
          {
            id: "g3",
            first_booked_at: "2026-11-11T08:00:00+01:00",
            status: ["merchant_not_allowed"],
            category: ["purchase"],
            amount: { cents: -100 },
          },
          { id: "g4", first_booked_at: "2026-11-12T08:00:00+01:00", status: ["ok"], category: ["informational"], amount: { cents: -1 } },
        ],
        links: { next: null },
      });
    return json({}, 404);
  }) as typeof fetch;
  return { calls, state, client: new GivveClient({ fetch: fetchFn, now: () => NOW }) };
}

describe("givve", () => {
  it("logs in with e-mail, password and the one-time code from the e-mail", async () => {
    const fake = fakeGivve();
    const challenges: TanChallenge[] = [];
    const session = await fake.client.login("ich@example.org", "geheim", async (c) => {
      challenges.push(c);
      return "123456";
    });
    expect(session).toMatchObject({ refreshToken: "refresh-1", expiresAt: new Date(LATER * 1000).toISOString() });
    expect(challenges).toEqual([{ text: expect.stringContaining("E-Mail"), decoupled: false, imageDataUrl: null }]);
    expect(fake.calls.map((c) => c.body?.otp)).toEqual([undefined, "123456"]);
    await expect(fake.client.login("ich@example.org", "falsch", async () => "1")).rejects.toMatchObject({ status: 400 });
  });

  it("reuses a valid token, renews an expired one and reports when that fails", async () => {
    const fake = fakeGivve();
    const valid = { accessToken: jwt(LATER), refreshToken: "refresh-1", expiresAt: new Date(LATER * 1000).toISOString() };
    expect(await fake.client.resume(valid)).toBe(valid);
    expect(fake.calls).toHaveLength(0);
    const expired = { ...valid, expiresAt: "2026-11-15T11:00:00.000Z" };
    expect((await fake.client.resume(expired)).refreshToken).toBe("refresh-2");
    fake.state.refreshWorks = false;
    await expect(fake.client.resume(expired)).rejects.toBeInstanceOf(GivveSessionExpired);
  });

  it("lists cards and reads balance and settled transactions only", async () => {
    const fake = fakeGivve();
    const session = { accessToken: jwt(LATER), refreshToken: null, expiresAt: null };
    expect(await fake.client.cards(session)).toEqual([
      { ref: "v1", iban: null, name: "givve Card 6363", currency: "EUR", product: "givve Prepaid", type: "PREPAID" },
    ]);
    expect(await fake.client.balance(session, "v1", "2026-11-15")).toEqual({ amountCents: 4321, date: "2026-11-14" });
    const bookings = await fake.client.transactions(session, "v1", "2026-10-01");
    expect(bookings.map((b) => [b.providerId, b.amountCents, b.counterparty || b.purpose])).toEqual([
      ["givve:g1", -5330, "REWE"],
      ["givve:g2", 5000, "Aufladung"],
    ]);
    expect(fake.calls.at(-1)?.query.get("filter[latest_booked_at][$gte]")).toBe("2026-10-01T00:00:00Z");
  });

  it("allows only the login and reads of the holder's cards", () => {
    for (const [method, path] of [
      ["POST", "/voucher_owners/me/vouchers/v1/pin"],
      ["GET", "/voucher_owners/me/vouchers/v1/pin"],
      ["POST", "/vouchers/v1/loads"],
      ["DELETE", "/voucher_owners/me"],
      ["GET", "/customers"],
    ] as const) {
      expect(() => assertGivveAllowed(method, path), path).toThrow(/allowlist/);
    }
    expect(GIVVE_ALLOWLIST.filter((e) => e.method === "POST").map((e) => e.path.source)).toEqual(["^\\/authorizations$"]);
    expect(
      mapTransactionGroup({ id: "x", status: "ok", category: "purchase", first_booked_at: "2026-11-01", amount: { cents: -1 } }),
    ).toMatchObject({
      amountCents: -1,
    });
  });
});
