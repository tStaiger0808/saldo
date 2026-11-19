/**
 * Read-only client for Trade Republic's unofficial web interface (no PSD2, no FinTS). The protocol facts (web login v2
 * with app approval, cookie session, WebSocket topics and their delta encoding) follow the public documentation of the
 * MIT-licensed pytr project (github.com/pytr-org/pytr); this is an independent implementation.
 *
 * Every REST call and every WebSocket topic passes an allowlist first: nothing that places orders, moves money or
 * changes settings can be sent, whatever a caller asks for.
 */
import { toCents } from "@saldo/core";
import { z } from "zod";
import {
  BankError,
  BlockedRequest,
  cookieHeader,
  mergeCookies,
  type RawBooking,
  type RawHolding,
  ReauthRequired,
  type RemoteAccount,
  type RemoteBalance,
  type TanHandler,
} from "./types.ts";

export const TR_API_URL = "https://api.traderepublic.com";
export const TR_WS_URL = "wss://api.traderepublic.com";
const APP_VERSION = "2.2631.13";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 200;
const PARALLEL = 8;
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/** The only REST calls this client makes: login, its approval, the session refresh and the account facts. */
export const TR_REST_ALLOWLIST: readonly { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "POST", path: /^\/api\/v2\/auth\/web\/login$/ },
  { method: "GET", path: /^\/api\/v2\/auth\/web\/login\/processes\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/v2\/auth\/web\/login\/processes\/[\w-]+\/authenticator-verification$/ },
  { method: "GET", path: /^\/api\/v1\/auth\/web\/session$/ },
  { method: "GET", path: /^\/api\/v2\/auth\/account$/ },
];

/** The only WebSocket topics this client subscribes to; all of them only read. */
export const TR_TOPIC_ALLOWLIST: ReadonlySet<string> = new Set([
  "cash",
  "compactPortfolioByType",
  "timelineTransactions",
  "instrument",
  "ticker",
]);

export function assertAllowedRequest(method: string, path: string): void {
  if (!TR_REST_ALLOWLIST.some((entry) => entry.method === method && entry.path.test(path))) {
    throw new BlockedRequest(`${method} ${path}`);
  }
}

export function assertAllowedTopic(type: unknown): void {
  if (typeof type !== "string" || !TR_TOPIC_ALLOWLIST.has(type)) throw new BlockedRequest(`topic ${String(type)}`);
}

/** The session ended (refresh refused, or the socket reports AUTHENTICATION_ERROR): a new login with app approval is due. */
export class TrSessionExpired extends ReauthRequired {
  constructor() {
    super("Die Anmeldung bei Trade Republic ist abgelaufen. Bitte erneut anmelden.");
    this.name = "TrSessionExpired";
  }
}

/** What is stored (encrypted) between runs: the cookie jar and the device id Trade Republic knows this client by. */
export type TrSession = { cookies: Record<string, string>; deviceId: string };

/** The minimal socket this client needs; Bun's WebSocket takes request headers, which carry the session cookies. */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const bunSocket: SocketFactory = (url, headers) => {
  const WithHeaders = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike;
  return new WithHeaders(url, { headers });
};

export type TradeRepublicOptions = {
  baseUrl?: string;
  wsUrl?: string;
  fetch?: typeof fetch;
  socket?: SocketFactory;
  timeZone?: string;
};

const errorsSchema = z.looseObject({
  errors: z.array(z.looseObject({ errorCode: z.string().nullish(), errorMessage: z.unknown().optional() })).nullish(),
});

const loginSchema = z.looseObject({ processId: z.string().min(1) });
const processSchema = z.looseObject({ status: z.string().nullish(), requiredAction: z.string().nullish() });
const accountSchema = z.looseObject({
  securitiesAccountNumber: z.union([z.string(), z.number()]).nullish(),
  cashAccount: z.looseObject({ iban: z.string().nullish() }).nullish(),
});

const decimal = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: "not a number" });
    return z.NEVER;
  }
  return n;
});

const cashSchema = z.array(z.looseObject({ amount: decimal, currencyId: z.string().nullish() }));
const portfolioSchema = z.looseObject({
  categories: z
    .array(
      z.looseObject({
        positions: z
          .array(
            z.looseObject({
              isin: z.string(),
              name: z.string().nullish(),
              netSize: decimal,
              averageBuyIn: decimal.nullish(),
              instrumentType: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
});
const instrumentSchema = z.looseObject({
  shortName: z.string().nullish(),
  name: z.string().nullish(),
  typeId: z.string().nullish(),
  exchangeIds: z.array(z.string()).nullish(),
});
const tickerSchema = z.looseObject({ last: z.looseObject({ price: decimal }).nullish() });
const timelineItemSchema = z.looseObject({
  id: z.string().min(1),
  timestamp: z.string(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  icon: z.string().nullish(),
  status: z.string().nullish(),
  eventType: z.string().nullish(),
  hidden: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
  amount: z.looseObject({ value: decimal, currency: z.string().nullish() }).nullish(),
});
const timelineSchema = z.looseObject({
  items: z.array(z.unknown()).nullish(),
  cursors: z.looseObject({ after: z.string().nullish() }).nullish(),
});

/** Rebuilds a payload from the previous one: tab-separated `=n` (copy n chars), `-n` (skip n), `+text` (insert, URL-encoded). */
export function applyDelta(previous: string, delta: string): string {
  let cursor = 0;
  let result = "";
  for (const op of delta.split("\t")) {
    const rest = op.slice(1);
    if (op.startsWith("=")) {
      const n = Number(rest);
      result += previous.slice(cursor, cursor + n);
      cursor += n;
    } else if (op.startsWith("-")) {
      cursor += Number(rest);
    } else if (op.startsWith("+")) {
      try {
        result += decodeURIComponent(rest.replaceAll("+", " "));
      } catch {
        throw new BankError("Trade Republic hat eine unlesbare Änderung gesendet.");
      }
    }
  }
  return result;
}

/** The kind of a timeline event as a fixed text, so own-account rules (e.g. the depot's transfer patterns) can match it. */
const EVENT_LABELS: [RegExp, string | ((cents: number) => string)][] = [
  [/SAVINGS_?PLAN|SAVINGSPLAN/, "Sparplan ausgeführt"],
  [/SPARE_CHANGE|ROUND_?UP/, "Round-up ausgeführt"],
  [/ORDER_EXECUTED|TRADE_INVOICE|TRADE_EXECUTED|TRADE_CORRECTED|PRIVATE_MARKET/, (c) => (c < 0 ? "Wertpapierkauf" : "Wertpapierverkauf")],
  [/INTEREST/, "Zinsen"],
  [/^CREDIT$|CORPORATE_ACTION.*CASH|DIVIDEND/, (c) => (c < 0 ? "Steuern" : "Dividende")],
  [/TAX/, "Steuerkorrektur"],
  [/^CARD_.*(REFUND|OCT)/, "Kartenerstattung"],
  [/^CARD_.*ATM/, "Bargeldabhebung"],
  [/^CARD_/, "Kartenzahlung"],
  [/INCOMING|INBOUND|DEPOSIT/, "Einzahlung"],
  [/OUTGOING|OUTBOUND|P2P/, "Überweisung"],
];

// Events without a cash movement (orders placed or cancelled, documents, failed or pending executions, saveback perks).
const SKIPPED_EVENTS =
  /CREATED$|CANCEL|_FAILED|FAILED_|PENDING|DOCUMENT|REPORT|VERIFICATION|NEW_TR_IBAN|SAVEBACK|ACQUISITION_TRADE_PERK|SECURITIES_TRANSFER/;
const SKIPPED_EXCEPTIONS = new Set(["INTEREST_PAYOUT_CREATED", "SAVINGS_PLAN_INVOICE_CREATED", "PRIVATE_MARKETS_ORDER_CREATED"]);

function berlinDay(timestamp: string, timeZone: string): string | null {
  const date = new Date(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function cents(value: number): number {
  try {
    return toCents(value.toFixed(2));
  } catch {
    throw new BankError("Unlesbarer Betrag von Trade Republic");
  }
}

/** One timeline entry as a booking of the cash account, or null when it moved no money. Amounts arrive signed. */
export function mapTimelineItem(input: unknown, timeZone = "Europe/Berlin"): RawBooking | null {
  const parsed = timelineItemSchema.safeParse(input);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (item.hidden || item.deleted || !item.amount) return null;
  const status = (item.status ?? "EXECUTED").toUpperCase();
  if (status !== "EXECUTED") return null;
  const type = (item.eventType ?? "").toUpperCase();
  if (SKIPPED_EVENTS.test(type) && !SKIPPED_EXCEPTIONS.has(type)) return null;
  const amountCents = cents(item.amount.value);
  if (amountCents === 0) return null;
  const day = berlinDay(item.timestamp, timeZone);
  if (!day) return null;
  const label = EVENT_LABELS.find(([pattern]) => pattern.test(type))?.[1];
  const isin = item.icon?.split("/")[1];
  const purpose = [typeof label === "function" ? label(amountCents) : label, item.subtitle, isin && ISIN.test(isin) ? isin : null]
    .filter(Boolean)
    .join(" · ");
  return {
    bookingDate: day,
    valueDate: day,
    amountCents,
    currency: item.amount.currency || "EUR",
    counterparty: item.title ?? "",
    counterpartyIban: null,
    purpose,
    providerId: `tr:${item.id}`,
  };
}

type Pending = { type: string; previous: string; resolve: (value: unknown) => void; reject: (error: Error) => void };

/** One socket for a whole run: each request subscribes, takes the first full answer and unsubscribes again. */
class TrSocket {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private failure: Error | null = null;

  private constructor(private readonly socket: SocketLike) {}

  static open(factory: SocketFactory, url: string, cookies: Record<string, string>, locale: string): Promise<TrSocket> {
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = factory(url, { Cookie: cookieHeader(cookies), "User-Agent": USER_AGENT });
      } catch {
        reject(new BankError("Trade Republic ist nicht erreichbar. Bitte später erneut versuchen."));
        return;
      }
      const client = new TrSocket(socket);
      const timer = setTimeout(() => {
        socket.close();
        reject(new BankError("Trade Republic antwortet nicht."));
      }, TIMEOUT_MS);
      let connected = false;
      socket.onopen = () => {
        const hello = {
          locale,
          platformId: "webtrading",
          platformVersion: "chrome - 146.0.0",
          clientId: "app.traderepublic.com",
          clientVersion: "5582",
        };
        socket.send(`connect 31 ${JSON.stringify(hello)}`);
      };
      socket.onerror = () => {
        if (connected) return;
        clearTimeout(timer);
        reject(new BankError("Trade Republic ist nicht erreichbar. Bitte später erneut versuchen."));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!connected) reject(new TrSessionExpired());
        client.fail(new BankError("Trade Republic hat die Verbindung beendet."));
      };
      socket.onmessage = (event) => {
        const text = String(event.data);
        if (!connected) {
          clearTimeout(timer);
          if (text !== "connected") {
            socket.close();
            reject(new TrSessionExpired());
            return;
          }
          connected = true;
          resolve(client);
          return;
        }
        client.receive(text);
      };
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private receive(text: string): void {
    if (text.startsWith("echo")) return;
    const space = text.indexOf(" ");
    const id = Number(text.slice(0, space));
    const code = text.charAt(space + 1);
    const payload = text.slice(space + 2).trimStart();
    const request = this.pending.get(id);
    if (!request) return;
    if (code === "C") return;
    if (code === "E") {
      this.finish(id);
      const parsed = errorsSchema.safeParse(safeJson(payload));
      const errorCode = parsed.success ? (parsed.data.errors?.[0]?.errorCode ?? "") : "";
      request.reject(
        errorCode === "AUTHENTICATION_ERROR" || errorCode === "UNAUTHORIZED"
          ? new TrSessionExpired()
          : new BankError(`Trade Republic meldet einen Fehler bei „${request.type}“${errorCode ? ` (${errorCode})` : ""}.`),
      );
      return;
    }
    const full = code === "D" ? applyDelta(request.previous, payload) : payload;
    request.previous = full;
    const value = safeJson(full);
    if (value === undefined) {
      this.finish(id);
      request.reject(new BankError("Unlesbare Antwort von Trade Republic"));
      return;
    }
    this.finish(id);
    request.resolve(value);
  }

  private finish(id: number): void {
    if (!this.pending.delete(id)) return;
    try {
      this.socket.send(`unsub ${id}`);
    } catch {
      // The socket is closing; nothing left to unsubscribe from.
    }
  }

  request<T>(payload: { type: string } & Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    assertAllowedTopic(payload.type);
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(id);
        reject(new BankError(`Trade Republic antwortet nicht auf „${payload.type}“.`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        type: payload.type,
        previous: "",
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(`sub ${id} ${JSON.stringify(payload)}`);
    }).then((value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new BankError(`Unerwartete Antwort von Trade Republic auf „${payload.type}“.`);
      return parsed.data;
    });
  }

  close(): void {
    this.socket.close();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) results.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(work))));
  return results;
}

export type TrAccountFacts = { iban: string | null; securitiesAccountNumber: string | null };

export type TrSnapshot = { cash: RemoteBalance | null; bookings: RawBooking[]; holdings: RawHolding[]; depotTotal: RemoteBalance };

export const TR_CASH_REF = "cash";
export const TR_DEPOT_REF = "depot";

export class TradeRepublicClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly socket: SocketFactory;
  private readonly timeZone: string;

  constructor(options: TradeRepublicOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TR_API_URL).replace(/\/+$/, "");
    this.wsUrl = options.wsUrl ?? TR_WS_URL;
    this.fetchFn = options.fetch ?? fetch;
    this.socket = options.socket ?? bunSocket;
    this.timeZone = options.timeZone ?? "Europe/Berlin";
  }

  private headers(session: TrSession): Record<string, string> {
    const device = {
      stableDeviceId: session.deviceId,
      browser: "Chrome",
      browserVersion: "146",
      os: "Linux",
      osVersion: "",
      timezone: this.timeZone,
      timezoneOffset: -60,
      screen: "1920x1080",
      preferredLanguages: ["de-DE", "de"],
      numberOfCores: 8,
    };
    return {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "de-DE",
      "X-TR-Platform": "web-pro",
      "X-TR-App-Version": APP_VERSION,
      "X-TR-Device-Info": Buffer.from(JSON.stringify(device)).toString("base64"),
    };
  }

  /** Every REST call goes through here: allowlist first, then the request with the cookie jar, which it updates. */
  private async call(
    session: TrSession,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; session: TrSession }> {
    assertAllowedRequest(method, path);
    const headers = this.headers(session);
    if (Object.keys(session.cookies).length > 0) headers.Cookie = cookieHeader(session.cookies);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new BankError("Trade Republic ist nicht erreichbar. Bitte später erneut versuchen.", 502);
    }
    const text = await response.text();
    return {
      status: response.status,
      body: text ? safeJson(text) : null,
      session: { ...session, cookies: mergeCookies(session.cookies, response) },
    };
  }

  private loginFailure(status: number, body: unknown): BankError {
    const parsed = errorsSchema.safeParse(body);
    const code = parsed.success ? (parsed.data.errors?.[0]?.errorCode ?? "") : "";
    if (/PIN_INVALID|NUMBER_INVALID|USER_NOT_FOUND|UNAUTHORIZED/.test(code) || status === 401) {
      return new BankError("Trade Republic hat Telefonnummer oder PIN abgelehnt.", 400);
    }
    if (code === "TOO_MANY_REQUESTS" || status === 429) {
      return new BankError("Zu viele Anmeldeversuche bei Trade Republic. Bitte später erneut versuchen.", 429);
    }
    if (status === 405 || status === 426 || code === "MISSING_REQUIRED_HEADER" || code === "CLIENT_VERSION_OUTDATED") {
      return new BankError(
        "Trade Republic lehnt die Anmeldung dieses Clients ab; die inoffizielle Schnittstelle hat sich vermutlich geändert.",
      );
    }
    if (/PROCESS_GONE|NOT_FOUND|ALREADY_PROCESSED/.test(code))
      return new BankError("Die Anmeldung bei Trade Republic ist abgelaufen. Bitte erneut versuchen.");
    if (/VALIDATION_CODE/.test(code)) return new BankError("Der Code wurde von Trade Republic nicht akzeptiert.");
    return new BankError(`Trade Republic lehnt die Anmeldung ab (${code || status}).`);
  }

  /**
   * Web login: phone and PIN, then the approval Trade Republic pushes to the app (polled through `onTan` as a decoupled
   * challenge) or, for accounts with an authenticator, a typed code.
   */
  async login(phoneNumber: string, pin: string, deviceId: string, onTan: TanHandler): Promise<TrSession> {
    let session: TrSession = { cookies: {}, deviceId };
    const started = await this.call(session, "POST", "/api/v2/auth/web/login", { phoneNumber, pin });
    session = started.session;
    const login = loginSchema.safeParse(started.body);
    if (started.status >= 400 || !login.success) throw this.loginFailure(started.status, started.body);
    const process = `/api/v2/auth/web/login/processes/${encodeURIComponent(login.data.processId)}`;
    for (;;) {
      const polled = await this.call(session, "GET", process);
      session = polled.session;
      if (polled.status >= 400) throw this.loginFailure(polled.status, polled.body);
      const state = processSchema.safeParse(polled.body);
      const status = state.success ? (state.data.status ?? "").toUpperCase() : "";
      if ((status === "COMPLETED" || status === "CONFIRMED") && session.cookies.tr_session) return session;
      if (state.success && state.data.requiredAction === "AUTHENTICATOR_VERIFICATION") {
        const code = await onTan({ text: "Bitte den Code aus deiner Authenticator-App eingeben.", decoupled: false, imageDataUrl: null });
        const verified = await this.call(session, "POST", `${process}/authenticator-verification`, { code: code.trim() });
        session = verified.session;
        if (verified.status >= 400) throw this.loginFailure(verified.status, verified.body);
        continue;
      }
      await onTan({ text: "Bitte die Anmeldung in der Trade-Republic-App bestätigen.", decoupled: true, imageDataUrl: null });
    }
  }

  /** Renews a stored session without a second factor; throws TrSessionExpired when Trade Republic wants a new login. */
  async refresh(session: TrSession): Promise<TrSession> {
    if (!session.cookies.tr_refresh && !session.cookies.tr_session) throw new TrSessionExpired();
    const result = await this.call(session, "GET", "/api/v1/auth/web/session");
    if (result.status === 401 || result.status === 403) throw new TrSessionExpired();
    if (result.status >= 400) throw new BankError(`Trade Republic antwortet mit ${result.status}.`, result.status);
    return result.session;
  }

  async accountFacts(session: TrSession): Promise<{ facts: TrAccountFacts; session: TrSession }> {
    const result = await this.call(session, "GET", "/api/v2/auth/account");
    if (result.status === 401 || result.status === 403) throw new TrSessionExpired();
    const parsed = accountSchema.safeParse(result.body);
    if (result.status >= 400 || !parsed.success) throw new BankError("Trade Republic liefert keine Kontodaten.");
    const iban = parsed.data.cashAccount?.iban?.replace(/\s+/g, "").toUpperCase() || null;
    const number = parsed.data.securitiesAccountNumber;
    return { facts: { iban, securitiesAccountNumber: number == null ? null : String(number) }, session: result.session };
  }

  remoteAccounts(facts: TrAccountFacts): RemoteAccount[] {
    return [
      {
        ref: TR_CASH_REF,
        iban: facts.iban,
        name: "Trade Republic Verrechnungskonto",
        currency: "EUR",
        product: "Verrechnungskonto",
        type: "CACC",
      },
      { ref: TR_DEPOT_REF, iban: null, name: "Trade Republic Depot", currency: "EUR", product: "Wertpapierdepot", type: "DEPOT" },
    ];
  }

  /**
   * Reads what the linked accounts need over one socket: the cash balance and the timeline back to `since` for the cash
   * account, the positions with current quotes for the depot.
   */
  async snapshot(
    session: TrSession,
    facts: TrAccountFacts,
    want: { cash: boolean; depot: boolean },
    since: string,
    today: string,
  ): Promise<TrSnapshot> {
    const socket = await TrSocket.open(this.socket, this.wsUrl, session.cookies, "de");
    try {
      let cash: RemoteBalance | null = null;
      const bookings: RawBooking[] = [];
      if (want.cash) {
        const balances = await socket.request({ type: "cash" }, cashSchema);
        const eur = balances.find((b) => (b.currencyId ?? "EUR") === "EUR") ?? balances[0];
        cash = eur ? { amountCents: cents(eur.amount), date: today } : null;
        let after: string | null = null;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) throw new BankError("Zu viele Seiten in der Trade-Republic-Zeitleiste");
          const data: z.infer<typeof timelineSchema> = await socket.request({ type: "timelineTransactions", after }, timelineSchema);
          let older = false;
          for (const raw of data.items ?? []) {
            const booking = mapTimelineItem(raw, this.timeZone);
            if (booking && booking.bookingDate >= since) bookings.push(booking);
            const day = timelineItemSchema.safeParse(raw);
            const date = day.success ? berlinDay(day.data.timestamp, this.timeZone) : null;
            if (date && date < since) older = true;
          }
          after = data.cursors?.after ?? null;
          if (!after || older) break;
        }
      }
      const holdings: RawHolding[] = [];
      if (want.depot) {
        if (!facts.securitiesAccountNumber) throw new BankError("Trade Republic nennt keine Depotnummer.");
        const portfolio = await socket.request(
          { type: "compactPortfolioByType", secAccNo: facts.securitiesAccountNumber },
          portfolioSchema,
        );
        const positions = (portfolio.categories ?? []).flatMap((c) => c.positions ?? []).filter((p) => p.netSize > 0);
        holdings.push(...(await inBatches(positions, (p) => this.valuate(socket, p, today))));
      }
      const total = holdings.reduce((sum, h) => sum + h.valueCents, 0);
      return { cash, bookings, holdings, depotTotal: { amountCents: total, date: today } };
    } finally {
      socket.close();
    }
  }

  /** Quotes come from the instrument's first exchange (LSX by default); bonds are quoted in percent of the nominal value. */
  private async valuate(
    socket: TrSocket,
    position: { isin: string; name?: string | null; netSize: number; averageBuyIn?: number | null; instrumentType?: string | null },
    today: string,
  ): Promise<RawHolding> {
    const instrument = await socket.request({ type: "instrument", id: position.isin }, instrumentSchema).catch((error: unknown) => {
      if (error instanceof TrSessionExpired) throw error;
      return null;
    });
    const bond = /bond/i.test(instrument?.typeId ?? position.instrumentType ?? "");
    const exchange = instrument?.exchangeIds?.[0] ?? "LSX";
    const quote = await socket.request({ type: "ticker", id: `${position.isin}.${exchange}` }, tickerSchema).catch((error: unknown) => {
      if (error instanceof TrSessionExpired) throw error;
      return null;
    });
    const last = quote?.last?.price ?? null;
    const price = last === null ? null : bond ? last / 100 : last;
    const costBasisCents =
      typeof position.averageBuyIn === "number" ? cents(position.averageBuyIn * position.netSize * (bond ? 0.01 : 1)) : null;
    return {
      isin: position.isin,
      name: (instrument?.shortName || instrument?.name || position.name || position.isin).slice(0, 200),
      quantity: position.netSize,
      price,
      currency: bond ? "%" : "EUR",
      // Without a quote the position is valued at cost, so the depot total stays close instead of dropping it.
      valueCents: price === null ? (costBasisCents ?? 0) : cents(price * position.netSize),
      costBasisCents,
      asOf: today,
    };
  }
}
