import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnableBankingClient, makeJwt, mapPendingTransaction, mapTransaction, parsePrivateKey } from "./enable-banking.ts";
import { BankError, ReauthRequired } from "./types.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodePart(part: string | undefined): unknown {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString());
}

type Call = { url: URL; init: RequestInit };

function fakeFetch(handler: (url: URL, init: RequestInit) => Response, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Enable Banking JWT", () => {
  it("carries the documented header and claims and verifies with the public key", () => {
    const token = makeJwt("app-123", PEM, 1_800_000_000);
    const [header, payload, signature] = token.split(".");
    expect(decodePart(header)).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    expect(decodePart(payload)).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });

  it("rejects keys that are not RSA private keys", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => parsePrivateKey(ec)).toThrow(BankError);
    expect(() => parsePrivateKey("nonsense")).toThrow(BankError);
  });
});

describe("Enable Banking mapping", () => {
  it("signs by indicator, picks the counterparty by direction and joins the remittance", () => {
    const outgoing = mapTransaction({
      entry_reference: "ref-1",
      transaction_amount: { amount: "23.45", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      status: "BOOK",
      booking_date: "2026-11-10",
      value_date: "2026-11-11",
      creditor: { name: "REWE Markt GmbH" },
      creditor_account: { iban: "DE11500105170000000001" },
      debtor: { name: "Ich selbst" },
      remittance_information: ["REWE SAGT DANKE", "Karte 1234"],
    });
    expect(outgoing).toEqual({
      bookingDate: "2026-11-10",
      valueDate: "2026-11-11",
      amountCents: -2345,
      currency: "EUR",
      counterparty: "REWE Markt GmbH",
      counterpartyIban: "DE11500105170000000001",
      purpose: "REWE SAGT DANKE Karte 1234",
      providerId: "ref-1",
    });
    const incoming = mapTransaction({
      transaction_id: "tx-9",
      transaction_amount: { amount: "-3520.00", currency: "EUR" },
      credit_debit_indicator: "CRDT",
      booking_date: "2026-10-28",
      debtor: { name: "Muster GmbH" },
      debtor_account: { iban: "DE02120300000000202051" },
    });
    expect(incoming).toMatchObject({ amountCents: 352_000, counterparty: "Muster GmbH", providerId: "tx-9", purpose: "" });
    expect(mapTransaction({ status: "PDNG", booking_date: "2026-11-01", transaction_amount: { amount: "1" } })).toBeNull();
    expect(mapTransaction({ status: "BOOK", transaction_amount: { amount: "1" } })).toBeNull();
  });

  it("maps announced (PDNG) entries apart from booked ones, with or without a date", () => {
    const card = {
      entry_reference: "pend-1",
      transaction_amount: { amount: "34.56", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      status: "PDNG",
      transaction_date: "2026-11-14",
      creditor: { name: "Bio-Laden Sonthofen" },
      creditor_account: { iban: "DE11500105170000000001" },
      remittance_information: ["Kartenzahlung girocard"],
    };
    expect(mapPendingTransaction(card)).toEqual({
      bookingDate: "2026-11-14",
      valueDate: null,
      amountCents: -3456,
      currency: "EUR",
      counterparty: "Bio-Laden Sonthofen",
      purpose: "Kartenzahlung girocard",
    });
    expect(mapTransaction(card)).toBeNull();
    const undated = mapPendingTransaction({ status: "PDNG", credit_debit_indicator: "CRDT", transaction_amount: { amount: "5" } });
    expect(undated).toMatchObject({ bookingDate: null, amountCents: 500 });
    for (const status of ["BOOK", "HOLD", "CNCL", "RJCT", "SCHD", "OTHR", undefined]) {
      expect(mapPendingTransaction({ ...card, status })).toBeNull();
    }
  });
});

describe("Enable Banking client", () => {
  it("pages through transactions with the continuation key and sends PSU headers", async () => {
    const calls: Call[] = [];
    const txn = (ref: string, amount: string) => ({
      entry_reference: ref,
      transaction_amount: { amount, currency: "EUR" },
      credit_debit_indicator: "DBIT",
      status: "BOOK",
      booking_date: "2026-11-10",
    });
    const client = new EnableBankingClient({
      appId: "app",
      privateKeyPem: PEM,
      baseUrl: "https://eb.test/",
      psuHeaders: { "Psu-Ip-Address": "192.0.2.1", "Psu-User-Agent": "test" },
      fetch: fakeFetch(
        (url) =>
          url.searchParams.get("continuation_key")
            ? json({ transactions: [txn("t3", "3.00")], continuation_key: null })
            : json({ transactions: [txn("t1", "1.00"), txn("t2", "2.00")], continuation_key: "k" }),
        calls,
      ),
    });
    const { bookings, pending } = await client.transactions("uid-1", "2026-01-01");
    expect(bookings.map((b) => b.amountCents)).toEqual([-100, -200, -300]);
    expect(pending).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.toString()).toBe("https://eb.test/accounts/uid-1/transactions?date_from=2026-01-01");
    expect(calls[1]?.url.searchParams.get("continuation_key")).toBe("k");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Psu-Ip-Address"]).toBe("192.0.2.1");
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("collects announced entries from every page and drops one that arrives booked as well", async () => {
    const calls: Call[] = [];
    const entry = (ref: string | null, amount: string, status: string) => ({
      entry_reference: ref,
      transaction_amount: { amount, currency: "EUR" },
      credit_debit_indicator: "DBIT",
      status,
      booking_date: "2026-11-14",
    });
    const client = new EnableBankingClient({
      appId: "app",
      privateKeyPem: PEM,
      fetch: fakeFetch(
        (url) =>
          url.searchParams.get("continuation_key")
            ? json({ transactions: [entry("p2", "2.00", "PDNG"), entry("p1", "1.00", "BOOK")], continuation_key: null })
            : json({
                transactions: [entry("p1", "1.00", "PDNG"), entry(null, "3.00", "PDNG"), entry("b", "9.00", "BOOK")],
                continuation_key: "k",
              }),
        calls,
      ),
    });
    const { bookings, pending } = await client.transactions("uid-1", "2026-11-01");
    expect(bookings.map((b) => b.providerId)).toEqual(["b", "p1"]);
    expect(pending.map((p) => p.amountCents)).toEqual([-300, -200]);
    expect(calls.every((c) => !c.url.searchParams.has("transaction_status"))).toBe(true);
  });

  it("prefers the booked closing balance", async () => {
    const client = new EnableBankingClient({
      appId: "app",
      privateKeyPem: PEM,
      fetch: fakeFetch(() =>
        json({
          balances: [
            { balance_type: "ITAV", balance_amount: { amount: "1.00" } },
            { balance_type: "CLBD", balance_amount: { amount: "-12.34" }, reference_date: "2026-11-14" },
          ],
        }),
      ),
    });
    expect(await client.balance("uid")).toEqual({ amountCents: -1234, date: "2026-11-14" });
  });

  it("maps expired sessions to ReauthRequired, 429 to a rate limit and network errors to BankError", async () => {
    const respond = (response: () => Response) => new EnableBankingClient({ appId: "a", privateKeyPem: PEM, fetch: fakeFetch(response) });
    await expect(respond(() => json({ error: "EXPIRED_SESSION", message: "gone" }, 401)).balance("x")).rejects.toBeInstanceOf(
      ReauthRequired,
    );
    await expect(respond(() => json({ message: "slow down" }, 429)).balance("x")).rejects.toMatchObject({
      message: expect.stringContaining("begrenzt"),
    });
    const offline = new EnableBankingClient({
      appId: "a",
      privateKeyPem: PEM,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(offline.application()).rejects.toMatchObject({ message: expect.stringContaining("nicht erreichbar"), status: 502 });
  });
});
