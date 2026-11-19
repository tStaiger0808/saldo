/**
 * Experimental read-only client for the givve® Card portal (card.givve.com), which offers no PSD2 or FinTS access.
 * Login and endpoints follow givve's public API documentation (developer.givve.com, role `voucher_owner`) and what the
 * public portal and the MIT-licensed MoneyMoney extension "Givve Prepaid" send; untested against a real card.
 *
 * Every request passes an allowlist first: only the login and reads of the holder's own cards and their transactions.
 */
import { z } from "zod";
import {
  BankError,
  BlockedRequest,
  isoDay,
  type RawBooking,
  ReauthRequired,
  type RemoteAccount,
  type RemoteBalance,
  type TanHandler,
} from "./types.ts";

export const GIVVE_API_URL = "https://www.givve.com/api";
const CLIENT_ID = "givve-card-web";
const USER_AGENT = "givve Card/8.1.1 (web)";
const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 250;
const MAX_PAGES = 100;

export const GIVVE_ALLOWLIST: readonly { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "POST", path: /^\/authorizations$/ },
  { method: "GET", path: /^\/voucher_owners\/me\/vouchers$/ },
  { method: "GET", path: /^\/voucher_owners\/me\/vouchers\/[\w-]+$/ },
  { method: "GET", path: /^\/voucher_owners\/me\/vouchers\/[\w-]+\/transaction_groups$/ },
];

export function assertGivveAllowed(method: string, path: string): void {
  if (!GIVVE_ALLOWLIST.some((entry) => entry.method === method && entry.path.test(path))) throw new BlockedRequest(`${method} ${path}`);
}

export class GivveSessionExpired extends ReauthRequired {
  constructor() {
    super("Die Anmeldung bei givve ist abgelaufen. Bitte erneut anmelden.");
    this.name = "GivveSessionExpired";
  }
}

/** Stored encrypted between runs. `expiresAt` comes from the access token's `exp`. */
export type GivveSession = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

const authSchema = z.looseObject({
  data: z
    .looseObject({
      access_token: z.string().nullish(),
      refresh_token: z.string().nullish(),
      auth_status: z.string().nullish(),
    })
    .nullish(),
  error: z.unknown().optional(),
});

const moneySchema = z.looseObject({ cents: z.number().int(), currency: z.string().nullish() });
const stringish = z.union([z.string(), z.array(z.string())]).nullish();

const voucherSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  balance: moneySchema.nullish(),
  currency: z.string().nullish(),
  number: z.string().nullish(),
  category: z.string().nullish(),
  state: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const vouchersSchema = z.looseObject({ data: z.array(voucherSchema).nullish() });
const voucherOneSchema = z.looseObject({ data: voucherSchema });

const groupSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  first_booked_at: z.string().nullish(),
  latest_booked_at: z.string().nullish(),
  status: stringish,
  category: stringish,
  amount: moneySchema.nullish(),
  description: z.string().nullish(),
  merchant_name: z.string().nullish(),
});

const groupsSchema = z.looseObject({
  data: z.array(z.unknown()).nullish(),
  links: z.looseObject({ next: z.string().nullish() }).nullish(),
});

const list = (value: string | string[] | null | undefined) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Only settled purchases, loads and adjustments: status "ok", no invalid amounts, nothing informational. Amounts arrive
 * signed (purchases negative) in the portal's answers.
 */
export function mapTransactionGroup(input: unknown, currency = "EUR"): RawBooking | null {
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return null;
  const g = parsed.data;
  const amount = g.amount;
  if (!amount) return null;
  const status = list(g.status).map((s) => s.toLowerCase());
  const category = list(g.category).map((c) => c.toLowerCase());
  if (!status.includes("ok") || status.includes("invalid_amount")) return null;
  if (category.some((c) => c.includes("informational") || c.includes("status_change"))) return null;
  if (amount.cents === 0) return null;
  const day = isoDay(g.first_booked_at) ?? isoDay(g.latest_booked_at);
  if (!day) return null;
  return {
    bookingDate: day,
    valueDate: isoDay(g.latest_booked_at),
    amountCents: amount.cents,
    currency: amount.currency || currency,
    counterparty: g.merchant_name ?? "",
    counterpartyIban: null,
    purpose: g.description ?? category.join(", "),
    providerId: `givve:${g.id}`,
  };
}

function tokenExpiry(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export type GivveOptions = { baseUrl?: string; fetch?: typeof fetch; now?: () => Date };

export class GivveClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(options: GivveOptions = {}) {
    this.baseUrl = (options.baseUrl ?? GIVVE_API_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async call(method: "GET" | "POST", path: string, init: { token?: string; body?: unknown; query?: Record<string, string> } = {}) {
    assertGivveAllowed(method, path);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Version": "v2",
      "User-Agent": USER_AGENT,
      Origin: "https://card.givve.com",
      Referer: "https://card.givve.com/",
    };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new BankError("givve ist nicht erreichbar. Bitte später erneut versuchen.", 502);
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  private session(body: unknown): GivveSession | null {
    const data = authSchema.safeParse(body).data?.data;
    if (!data?.access_token) return null;
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresAt: tokenExpiry(data.access_token) };
  }

  /** E-mail and password; givve then mails a one-time code, which `onTan` asks for (typed, not decoupled). */
  async login(email: string, password: string, onTan: TanHandler): Promise<GivveSession> {
    const body = { accessors: ["voucher_owner"], identifier: email, password, client_id: CLIENT_ID };
    let result = await this.call("POST", "/authorizations", { body });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (result.status === 401 || result.status === 403 || result.status === 422) {
        throw new BankError(
          attempt === 0 ? "givve hat E-Mail-Adresse oder Passwort abgelehnt." : "Der Code wurde von givve nicht akzeptiert.",
          400,
        );
      }
      if (result.status === 429) throw new BankError("Zu viele Anmeldeversuche bei givve. Bitte später erneut versuchen.", 429);
      const session = this.session(result.body);
      if (result.status < 300 && session) return session;
      const status = authSchema.safeParse(result.body).data?.data?.auth_status;
      if (status !== "otp_required") throw new BankError(`givve lehnt die Anmeldung ab (${result.status}).`);
      const otp = await onTan({ text: "Bitte den Code aus der E-Mail von givve eingeben.", decoupled: false, imageDataUrl: null });
      result = await this.call("POST", "/authorizations", { body: { ...body, otp: otp.trim() } });
    }
    throw new BankError("Die Anmeldung bei givve ist nicht gelungen.");
  }

  /** A valid access token is reused; an expired one is renewed with the refresh token where givve allows it. */
  async resume(session: GivveSession): Promise<GivveSession> {
    const valid = session.expiresAt === null || new Date(session.expiresAt).getTime() - 60_000 > this.now().getTime();
    if (valid) return session;
    if (!session.refreshToken) throw new GivveSessionExpired();
    const result = await this.call("POST", "/authorizations", {
      body: { accessors: ["voucher_owner"], identifier: session.refreshToken, client_id: CLIENT_ID },
    });
    const renewed = result.status < 300 ? this.session(result.body) : null;
    if (!renewed) throw new GivveSessionExpired();
    return renewed;
  }

  private async read<T>(schema: z.ZodType<T>, path: string, session: GivveSession, query?: Record<string, string>): Promise<T> {
    const result = await this.call("GET", path, { token: session.accessToken, query });
    if (result.status === 401) throw new GivveSessionExpired();
    if (result.status >= 400) throw new BankError(`givve antwortet mit ${result.status}.`, result.status);
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new BankError("Unerwartete Antwort von givve");
    return parsed.data;
  }

  async cards(session: GivveSession): Promise<RemoteAccount[]> {
    const data = await this.read(vouchersSchema, "/voucher_owners/me/vouchers", session, { "page[size]": "25" });
    return (data.data ?? []).map((v) => {
      const last4 = v.number?.replace(/\D/g, "").slice(-4);
      return {
        ref: v.id,
        iban: null,
        name: last4 ? `givve Card ${last4}` : "givve Card",
        currency: v.balance?.currency ?? v.currency ?? "EUR",
        product: "givve Prepaid",
        type: "PREPAID",
      };
    });
  }

  async balance(session: GivveSession, cardId: string, today: string): Promise<RemoteBalance | null> {
    const { data } = await this.read(voucherOneSchema, `/voucher_owners/me/vouchers/${encodeURIComponent(cardId)}`, session);
    return data.balance ? { amountCents: data.balance.cents, date: isoDay(data.updated_at) ?? today } : null;
  }

  async transactions(session: GivveSession, cardId: string, since: string): Promise<RawBooking[]> {
    const bookings: RawBooking[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.read(groupsSchema, `/voucher_owners/me/vouchers/${encodeURIComponent(cardId)}/transaction_groups`, session, {
        "page[number]": String(page),
        "page[size]": String(PAGE_SIZE),
        skip_meta_totals: "true",
        "filter[latest_booked_at][$gte]": `${since}T00:00:00Z`,
      });
      const items = data.data ?? [];
      for (const item of items) {
        const booking = mapTransactionGroup(item);
        if (booking) bookings.push(booking);
      }
      if (items.length < PAGE_SIZE || (data.links && !data.links.next)) return bookings;
    }
    throw new BankError("Zu viele Seiten beim Abruf der givve-Umsätze");
  }
}
