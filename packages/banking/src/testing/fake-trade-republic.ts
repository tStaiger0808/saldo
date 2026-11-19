/** A stand-in for api.traderepublic.com (REST and WebSocket) on a local port, for tests only; never the real service. */
import { TradeRepublicClient } from "../trade-republic.ts";

type ServerSocket = { data: { cookie: string }; send(text: string): void; close(): void };
type BunServer = { port: number; stop(force?: boolean): void };
type BunApi = {
  serve(options: {
    port: number;
    hostname: string;
    fetch(
      request: Request,
      server: { upgrade(request: Request, options: { data: unknown }): boolean },
    ): Response | Promise<Response | undefined> | undefined;
    websocket: { message(ws: ServerSocket, message: string | Uint8Array): void };
  }): BunServer;
};

export const FAKE_TR_PHONE = "+4915112345678";
export const FAKE_TR_PIN = "1234";

export const FAKE_TR_TIMELINE = [
  {
    id: "t-card",
    timestamp: "2026-11-14T18:05:00.000+0000",
    title: "REWE",
    subtitle: null,
    status: "EXECUTED",
    eventType: "CARD_SUCCESSFUL_TRANSACTION",
    amount: { value: -23.45, currency: "EUR", fractionDigits: 2 },
  },
  {
    id: "t-plan",
    timestamp: "2026-11-02T08:00:00.000+0000",
    title: "iShares Core MSCI World",
    subtitle: "Sparplan ausgeführt",
    icon: "logos/IE00B4L5Y983/v2",
    status: "EXECUTED",
    eventType: "SAVINGS_PLAN_EXECUTED",
    amount: { value: -100, currency: "EUR", fractionDigits: 2 },
  },
  {
    id: "t-created",
    timestamp: "2026-11-01T08:00:00.000+0000",
    title: "Order",
    status: "EXECUTED",
    eventType: "ORDER_CREATED",
    amount: { value: -50, currency: "EUR" },
  },
  {
    id: "t-interest",
    timestamp: "2026-10-31T23:30:00.000+0000",
    title: "Zinsen",
    status: "EXECUTED",
    eventType: "INTEREST_PAYOUT",
    amount: { value: 4.12, currency: "EUR" },
  },
  {
    id: "t-cancelled",
    timestamp: "2026-10-30T10:00:00.000+0000",
    title: "Apple",
    status: "CANCELED",
    eventType: "ORDER_EXECUTED",
    amount: { value: -500, currency: "EUR" },
  },
  {
    id: "t-old",
    timestamp: "2025-01-01T10:00:00.000+0000",
    title: "Einzahlung",
    status: "EXECUTED",
    eventType: "INCOMING_TRANSFER",
    amount: { value: 1000, currency: "EUR" },
  },
];

/** Records everything it receives; `state` switches failures and the IBAN of the cash account. */
export function startFakeTradeRepublic(options: { iban?: string } = {}) {
  const Bun = (globalThis as unknown as { Bun: BunApi }).Bun;
  const state = {
    iban: options.iban ?? "DE11100110012620000000",
    pendingPolls: 2,
    refreshValid: true,
    socketAuthError: false,
    rest: [] as string[],
    topics: [] as string[],
    sockets: [] as string[],
  };
  const json = (body: unknown, status = 200, cookies: string[] = []) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const c of cookies) headers.append("Set-Cookie", c);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, srv) {
      const url = new URL(request.url);
      const cookie = request.headers.get("cookie") ?? "";
      if (request.headers.get("upgrade") === "websocket") {
        srv.upgrade(request, { data: { cookie } });
        return undefined;
      }
      state.rest.push(`${request.method} ${url.pathname}`);
      switch (`${request.method} ${url.pathname}`) {
        case "POST /api/v2/auth/web/login": {
          if (!request.headers.get("x-tr-device-info") || request.headers.get("x-tr-platform") !== "web-pro") {
            return json({ errors: [{ errorCode: "MISSING_REQUIRED_HEADER" }] }, 400);
          }
          const body = (await request.json()) as { phoneNumber: string; pin: string };
          if (body.phoneNumber !== FAKE_TR_PHONE || body.pin !== FAKE_TR_PIN) return json({ errors: [{ errorCode: "PIN_INVALID" }] }, 401);
          return json({ processId: "proc-1", countdownInSeconds: 120 });
        }
        case "GET /api/v2/auth/web/login/processes/proc-1":
          if (state.pendingPolls-- > 0) return json({ status: "PENDING", requiredAction: null });
          return json({ status: "COMPLETED" }, 200, ["tr_session=s1; Path=/; HttpOnly", "tr_refresh=r1; Path=/; HttpOnly"]);
        case "GET /api/v1/auth/web/session":
          if (!state.refreshValid || !cookie.includes("tr_refresh=r1")) return json({ errors: [{ errorCode: "UNAUTHORIZED" }] }, 401);
          return json({}, 200, ["tr_session=s2; Path=/; HttpOnly"]);
        case "GET /api/v2/auth/account":
          if (!cookie.includes("tr_session=")) return json({}, 401);
          return json({ securitiesAccountNumber: "0123456789", cashAccount: { iban: state.iban, bic: "TRBKDEBBXXX" } });
        default:
          return json({ errors: [{ errorCode: "NOT_FOUND" }] }, 404);
      }
    },
    websocket: {
      message(ws, raw) {
        const text = String(raw);
        if (text.startsWith("connect ")) {
          state.sockets.push(ws.data.cookie);
          ws.send(ws.data.cookie.includes("tr_session=") ? "connected" : "rejected");
          return;
        }
        if (text.startsWith("unsub ")) return;
        const [, id, ...rest] = text.split(" ");
        const payload = JSON.parse(rest.join(" ")) as { type: string; after?: string | null; id?: string };
        state.topics.push(payload.type);
        if (state.socketAuthError) {
          ws.send(`${id} E ${JSON.stringify({ errors: [{ errorCode: "AUTHENTICATION_ERROR" }] })}`);
          return;
        }
        const answer = (body: unknown) => ws.send(`${id} A ${JSON.stringify(body)}`);
        switch (payload.type) {
          case "cash":
            return answer([{ accountNumber: "x", currencyId: "EUR", amount: "1520.37" }]);
          case "timelineTransactions":
            return payload.after
              ? answer({ items: FAKE_TR_TIMELINE.slice(3), cursors: { after: null } })
              : answer({ items: FAKE_TR_TIMELINE.slice(0, 3), cursors: { after: "page-2" } });
          case "compactPortfolioByType":
            return answer({
              categories: [
                {
                  categoryType: "stocksAndETFs",
                  positions: [
                    { isin: "IE00B4L5Y983", netSize: "12.5", averageBuyIn: "80.00", instrumentType: "fund" },
                    { isin: "US0378331005", netSize: "2", averageBuyIn: "150.00", instrumentType: "stock" },
                  ],
                },
              ],
            });
          case "instrument":
            return answer(
              payload.id === "IE00B4L5Y983"
                ? { shortName: "iShares Core MSCI World", typeId: "fund", exchangeIds: ["LSX"] }
                : { shortName: "Apple", typeId: "stock", exchangeIds: ["TDG"] },
            );
          case "ticker":
            if (payload.id === "IE00B4L5Y983.LSX") return answer({ last: { time: 1, price: "100.20", size: "1" } });
            return ws.send(`${id} E ${JSON.stringify({ errors: [{ errorCode: "FORBIDDEN" }] })}`);
          default:
            return ws.send(`${id} E ${JSON.stringify({ errors: [{ errorCode: "BAD_SUBSCRIPTION_TYPE" }] })}`);
        }
      },
    },
  });
  const base = `127.0.0.1:${server.port}`;
  return {
    state,
    stop: () => server.stop(true),
    client: () => new TradeRepublicClient({ baseUrl: `http://${base}`, wsUrl: `ws://${base}` }),
  };
}
