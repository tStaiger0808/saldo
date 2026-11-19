import { afterEach, describe, expect, it } from "vitest";
import { FAKE_TR_PHONE, startFakeTradeRepublic } from "./testing/fake-trade-republic.ts";
import {
  applyDelta,
  assertAllowedRequest,
  assertAllowedTopic,
  mapTimelineItem,
  TR_REST_ALLOWLIST,
  TR_TOPIC_ALLOWLIST,
  TrSessionExpired,
} from "./trade-republic.ts";
import type { TanChallenge } from "./types.ts";

const PHONE = FAKE_TR_PHONE;
const IBAN = "DE11100110012620000000";

let fake: ReturnType<typeof startFakeTradeRepublic> | null = null;
afterEach(() => {
  fake?.stop();
  fake = null;
});

function approvals() {
  const seen: TanChallenge[] = [];
  return {
    seen,
    onTan: async (challenge: TanChallenge) => {
      seen.push(challenge);
      return "";
    },
  };
}

describe("Trade Republic login", () => {
  it("logs in with phone and PIN and waits for the approval in the app", async () => {
    fake = startFakeTradeRepublic();
    const { seen, onTan } = approvals();
    const session = await fake.client().login(PHONE, "1234", "device-1", onTan);
    expect(session.cookies).toMatchObject({ tr_session: "s1", tr_refresh: "r1" });
    expect(session.deviceId).toBe("device-1");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ decoupled: true, text: expect.stringContaining("Trade-Republic-App") });
  });

  it("reports a rejected PIN and never waits for an approval", async () => {
    fake = startFakeTradeRepublic();
    const { seen, onTan } = approvals();
    await expect(fake.client().login(PHONE, "9999", "device-1", onTan)).rejects.toMatchObject({
      message: "Trade Republic hat Telefonnummer oder PIN abgelehnt.",
    });
    expect(seen).toEqual([]);
  });

  it("reuses a stored session without a second factor and reports an expired one", async () => {
    fake = startFakeTradeRepublic();
    const client = fake.client();
    const refreshed = await client.refresh({ cookies: { tr_session: "s1", tr_refresh: "r1" }, deviceId: "d" });
    expect(refreshed.cookies).toEqual({ tr_session: "s2", tr_refresh: "r1" });
    fake.state.refreshValid = false;
    await expect(client.refresh(refreshed)).rejects.toBeInstanceOf(TrSessionExpired);
    await expect(client.refresh({ cookies: {}, deviceId: "d" })).rejects.toBeInstanceOf(TrSessionExpired);
  });
});

describe("Trade Republic data", () => {
  it("reads IBAN, cash, the timeline back to the start date and the valued positions", async () => {
    fake = startFakeTradeRepublic();
    const client = fake.client();
    const session = { cookies: { tr_session: "s1", tr_refresh: "r1" }, deviceId: "d" };
    const { facts } = await client.accountFacts(session);
    expect(facts).toEqual({ iban: IBAN, securitiesAccountNumber: "0123456789" });
    expect(client.remoteAccounts(facts).map((a) => [a.ref, a.iban, a.type])).toEqual([
      ["cash", IBAN, "CACC"],
      ["depot", null, "DEPOT"],
    ]);

    const snapshot = await client.snapshot(session, facts, { cash: true, depot: true }, "2026-01-01", "2026-11-15");
    expect(snapshot.cash).toEqual({ amountCents: 152_037, date: "2026-11-15" });
    expect(snapshot.bookings).toEqual([
      {
        bookingDate: "2026-11-14",
        valueDate: "2026-11-14",
        amountCents: -2345,
        currency: "EUR",
        counterparty: "REWE",
        counterpartyIban: null,
        purpose: "Kartenzahlung",
        providerId: "tr:t-card",
      },
      expect.objectContaining({
        amountCents: -10_000,
        purpose: "Sparplan ausgeführt · Sparplan ausgeführt · IE00B4L5Y983",
        providerId: "tr:t-plan",
      }),
      // 23:30 UTC on 31 October is 1 November in Berlin.
      expect.objectContaining({ bookingDate: "2026-11-01", amountCents: 412, purpose: "Zinsen", providerId: "tr:t-interest" }),
    ]);
    expect(snapshot.holdings).toEqual([
      {
        isin: "IE00B4L5Y983",
        name: "iShares Core MSCI World",
        quantity: 12.5,
        price: 100.2,
        currency: "EUR",
        valueCents: 125_250,
        costBasisCents: 100_000,
        asOf: "2026-11-15",
      },
      // No quote: valued at cost.
      {
        isin: "US0378331005",
        name: "Apple",
        quantity: 2,
        price: null,
        currency: "EUR",
        valueCents: 30_000,
        costBasisCents: 30_000,
        asOf: "2026-11-15",
      },
    ]);
    expect(snapshot.depotTotal).toEqual({ amountCents: 155_250, date: "2026-11-15" });
    expect(fake.state.sockets).toEqual(["tr_session=s1; tr_refresh=r1"]);
  });

  it("only subscribes to what the linked accounts need", async () => {
    fake = startFakeTradeRepublic();
    const session = { cookies: { tr_session: "s1" }, deviceId: "d" };
    const facts = { iban: IBAN, securitiesAccountNumber: "0123456789" };
    await fake.client().snapshot(session, facts, { cash: false, depot: true }, "2026-01-01", "2026-11-15");
    expect(fake.state.topics).not.toContain("timelineTransactions");
    expect(fake.state.topics).not.toContain("cash");
  });

  it("turns an authentication error on the socket and a refused handshake into an expired session", async () => {
    fake = startFakeTradeRepublic();
    const facts = { iban: IBAN, securitiesAccountNumber: "0123456789" };
    fake.state.socketAuthError = true;
    await expect(
      fake
        .client()
        .snapshot({ cookies: { tr_session: "s1" }, deviceId: "d" }, facts, { cash: true, depot: false }, "2026-01-01", "2026-11-15"),
    ).rejects.toBeInstanceOf(TrSessionExpired);
    await expect(
      fake.client().snapshot({ cookies: {}, deviceId: "d" }, facts, { cash: true, depot: false }, "2026-01-01", "2026-11-15"),
    ).rejects.toBeInstanceOf(TrSessionExpired);
  });
});

describe("Trade Republic read-only allowlist", () => {
  it("refuses orders, savings plan changes, payouts and settings before anything is sent", () => {
    for (const topic of [
      "simpleCreateOrder",
      "cancelOrder",
      "createSavingsPlan",
      "changeSavingsPlan",
      "cancelSavingsPlan",
      "createPriceAlarm",
      "addToWatchlist",
    ]) {
      expect(() => assertAllowedTopic(topic), topic).toThrow(/allowlist/);
    }
    for (const [method, path] of [
      ["POST", "/api/v1/payout"],
      ["POST", "/api/v1/payout/p/code"],
      ["POST", "/api/v2/auth/web/session"],
      ["POST", "/api/v1/auth/account/reset/device"],
      ["GET", "/api/v1/auth/account/change/email"],
      ["POST", "/api/v2/auth/account"],
    ] as const) {
      expect(() => assertAllowedRequest(method, path), path).toThrow(/allowlist/);
    }
    expect([...TR_TOPIC_ALLOWLIST].sort()).toEqual(["cash", "compactPortfolioByType", "instrument", "ticker", "timelineTransactions"]);
    expect(TR_REST_ALLOWLIST.every((entry) => entry.path.source.includes("auth"))).toBe(true);
  });

  it("sends nothing outside the allowlist during a full login and sync", async () => {
    fake = startFakeTradeRepublic();
    const client = fake.client();
    const session = await client.login(PHONE, "1234", "d", approvals().onTan);
    const { facts } = await client.accountFacts(await client.refresh(session));
    await client.snapshot(session, facts, { cash: true, depot: true }, "2026-01-01", "2026-11-15");
    for (const call of fake.state.rest) {
      const [method = "", path = ""] = call.split(" ");
      expect(() => assertAllowedRequest(method, path)).not.toThrow();
    }
    expect(fake.state.topics.every((topic) => TR_TOPIC_ALLOWLIST.has(topic))).toBe(true);
  });
});

describe("Trade Republic protocol", () => {
  it("rebuilds delta answers", () => {
    expect(applyDelta('{"a":1,"b":2}', "=5\t-1\t+3\t=7")).toBe('{"a":3,"b":2}');
    expect(applyDelta('{"name":"x"}', "=9\t-1\t+Hello+W%C3%B6rld\t=2")).toBe('{"name":"Hello Wörld"}');
  });

  it("skips events without a cash movement", () => {
    const base = { id: "x", timestamp: "2026-11-02T08:00:00.000+0000", title: "t", status: "EXECUTED", amount: { value: -5 } };
    expect(mapTimelineItem({ ...base, eventType: "ORDER_CREATED" })).toBeNull();
    expect(mapTimelineItem({ ...base, eventType: "BENEFITS_SAVEBACK_EXECUTION" })).toBeNull();
    expect(mapTimelineItem({ ...base, eventType: "CARD_SUCCESSFUL_TRANSACTION", status: "CANCELED" })).toBeNull();
    expect(mapTimelineItem({ ...base, eventType: "ORDER_EXECUTED" })?.purpose).toBe("Wertpapierkauf");
    expect(mapTimelineItem({ ...base, eventType: "ORDER_EXECUTED", amount: { value: 5 } })?.purpose).toBe("Wertpapierverkauf");
    expect(mapTimelineItem({ ...base, eventType: "SOMETHING_NEW" })).toMatchObject({ amountCents: -500, purpose: "" });
  });
});
