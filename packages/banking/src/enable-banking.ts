/** Read-only client for the Enable Banking API (https://enablebanking.com/docs/api/reference/). */
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { toCents } from "@saldo/core";
import { z } from "zod";
import {
  BankError,
  isoDay,
  type RawBooking,
  type RawPendingBooking,
  ReauthRequired,
  type RemoteAccount,
  type RemoteBalance,
} from "./types.ts";

export const ENABLE_BANKING_API_URL = "https://api.enablebanking.com";
const TIMEOUT_MS = 60_000;
const JWT_LIFETIME_SECONDS = 3600;
const MAX_PAGES = 200;
const SESSION_GONE_CODES = new Set(["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST"]);
const BALANCE_PREFERENCE = ["CLBD", "ITBD", "CLAV", "ITAV", "XPCD", "OPBD", "OPAV", "PRCD", "VALU", "INFO", "OTHR"];

export type EnableBankingOptions = {
  appId: string;
  privateKeyPem: string;
  baseUrl?: string;
  /** Psu-Ip-Address / Psu-User-Agent of the person in front of the browser, sent with account data requests. */
  psuHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  now?: () => number;
};

export type ApplicationInfo = { name: string; environment: string; active: boolean; redirectUrls: string[] };

export type Aspsp = {
  name: string;
  country: string;
  logo: string | null;
  maximumConsentValidity: number | null;
  sandbox: boolean;
  beta: boolean;
};

export type EnableBankingSession = { sessionId: string; validUntil: Date | null; accounts: RemoteAccount[] };

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function parsePrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem.trim());
    if (key.asymmetricKeyType === "rsa") return key;
  } catch {
    // Reported below with a message the user can act on.
  }
  throw new BankError("Der private Schlüssel ist kein gültiger RSA-Schlüssel im PEM-Format");
}

/** RS256 JWT as documented by Enable Banking: kid = application id, valid for at most an hour. */
export function makeJwt(appId: string, key: KeyObject | string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const privateKey = typeof key === "string" ? parsePrivateKey(key) : key;
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = base64url(
    JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nowSeconds, exp: nowSeconds + JWT_LIFETIME_SECONDS }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

const nullishString = z.string().nullish();

const applicationSchema = z.looseObject({
  name: nullishString,
  environment: nullishString,
  active: z.boolean().nullish(),
  redirect_urls: z.array(z.string()).nullish(),
});

const aspspsSchema = z.looseObject({
  aspsps: z
    .array(
      z.looseObject({
        name: z.string(),
        country: nullishString,
        logo: nullishString,
        maximum_consent_validity: z.number().nullish(),
        sandbox: z.boolean().nullish(),
        beta: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

const authSchema = z.looseObject({ url: z.string().min(1) });

const accountIdSchema = z.looseObject({ iban: nullishString }).nullish();

const sessionSchema = z.looseObject({
  session_id: z.string().min(1),
  access: z.looseObject({ valid_until: nullishString }).nullish(),
  accounts: z
    .array(
      z.union([
        z.string(),
        z.looseObject({
          uid: nullishString,
          account_id: accountIdSchema,
          name: nullishString,
          product: nullishString,
          cash_account_type: nullishString,
          currency: nullishString,
        }),
      ]),
    )
    .nullish(),
});

const amountSchema = z.looseObject({ amount: z.union([z.string(), z.number()]).nullish(), currency: nullishString }).nullish();

const balancesSchema = z.looseObject({
  balances: z.array(z.looseObject({ balance_amount: amountSchema, balance_type: nullishString, reference_date: nullishString })).nullish(),
});

const partySchema = z.looseObject({ name: nullishString }).nullish();

export const transactionSchema = z.looseObject({
  entry_reference: nullishString,
  transaction_id: nullishString,
  transaction_amount: amountSchema,
  credit_debit_indicator: nullishString,
  status: nullishString,
  booking_date: nullishString,
  value_date: nullishString,
  transaction_date: nullishString,
  creditor: partySchema,
  creditor_account: accountIdSchema,
  debtor: partySchema,
  debtor_account: accountIdSchema,
  remittance_information: z.union([z.array(z.string()), z.string()]).nullish(),
  note: nullishString,
});

const transactionsSchema = z.looseObject({
  transactions: z.array(z.unknown()).nullish(),
  continuation_key: nullishString,
});

const errorSchema = z.looseObject({
  message: z.unknown().optional(),
  error: z.unknown().optional(),
  code: z.unknown().optional(),
  detail: z.unknown().optional(),
});

function cents(amount: string | number | null | undefined): number {
  try {
    return toCents(amount ?? "0");
  } catch {
    throw new BankError(`Unlesbarer Betrag von Enable Banking: ${String(amount).slice(0, 40)}`);
  }
}

type Transaction = z.infer<typeof transactionSchema>;

/** The sign comes from the indicator because the sign convention of `amount` is not documented. */
function mapCommon(t: Transaction): Omit<RawBooking, "bookingDate" | "providerId"> {
  const amount = Math.abs(cents(t.transaction_amount?.amount));
  const outgoing = t.credit_debit_indicator === "DBIT";
  const party = outgoing ? t.creditor : t.debtor;
  const partyAccount = outgoing ? t.creditor_account : t.debtor_account;
  const remittance = t.remittance_information;
  const purpose = Array.isArray(remittance) ? remittance.join(" ") : (remittance ?? "");
  return {
    valueDate: isoDay(t.value_date),
    amountCents: outgoing ? -amount : amount,
    currency: t.transaction_amount?.currency || "EUR",
    counterparty: party?.name ?? "",
    counterpartyIban: partyAccount?.iban ?? null,
    purpose: purpose || t.note || "",
  };
}

const firstDay = (t: Transaction) => isoDay(t.booking_date) ?? isoDay(t.value_date) ?? isoDay(t.transaction_date);

/** Booked entries only (status BOOK, or none given). */
export function mapTransaction(input: unknown): RawBooking | null {
  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success || (parsed.data.status ?? "BOOK") !== "BOOK") return null;
  const bookingDate = firstDay(parsed.data);
  if (!bookingDate) return null;
  return { ...mapCommon(parsed.data), bookingDate, providerId: parsed.data.entry_reference || parsed.data.transaction_id || null };
}

/** Announced entries (status PDNG, ISO 20022 "expected"); some banks give them no date yet. */
export function mapPendingTransaction(input: unknown): RawPendingBooking | null {
  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success || parsed.data.status !== "PDNG") return null;
  const { counterpartyIban: _, ...common } = mapCommon(parsed.data);
  return { ...common, bookingDate: firstDay(parsed.data) };
}

export type AccountTransactions = { bookings: RawBooking[]; pending: RawPendingBooking[] };

export class EnableBankingClient {
  private readonly key: KeyObject;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: EnableBankingOptions) {
    this.key = parsePrivateKey(options.privateKeyPem);
    this.baseUrl = (options.baseUrl ?? ENABLE_BANKING_API_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown; psu?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${makeJwt(this.options.appId, this.key, Math.floor(this.now() / 1000))}`,
      Accept: "application/json",
      ...(init.psu ? this.options.psuHeaders : {}),
    };
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
      throw new BankError("Enable Banking ist nicht erreichbar. Bitte später erneut versuchen.", 502);
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = null;
    }
    if (!response.ok) throw this.failure(response.status, body, text);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BankError("Unerwartete Antwort von Enable Banking", 502);
    return parsed.data;
  }

  private failure(status: number, body: unknown, text: string): BankError {
    const details = errorSchema.safeParse(body);
    const pick = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
    const code = details.success ? pick(details.data.error, details.data.code).toUpperCase() : "";
    const message = (details.success ? pick(details.data.message, details.data.detail, details.data.error) : "") || text.slice(0, 200);
    if (SESSION_GONE_CODES.has(code) || ((status === 401 || status === 403) && code.includes("SESSION"))) return new ReauthRequired();
    if (status === 429) return new BankError("Die Bank begrenzt Abrufe gerade. Bitte später erneut synchronisieren.", 429);
    const extra = details.success ? pick(details.data.detail) : "";
    const full = [code && !message.toUpperCase().includes(code) ? `${code}` : "", message, extra && extra !== message ? extra : ""]
      .filter(Boolean)
      .join(" – ");
    return new BankError(`Enable Banking antwortet mit ${status}${full ? `: ${full.slice(0, 400)}` : ""}`, status);
  }

  async application(): Promise<ApplicationInfo> {
    const data = await this.request(applicationSchema, "GET", "/application");
    return {
      name: data.name ?? "",
      environment: data.environment ?? "",
      active: data.active ?? false,
      redirectUrls: data.redirect_urls ?? [],
    };
  }

  async banks(country: string): Promise<Aspsp[]> {
    const data = await this.request(aspspsSchema, "GET", "/aspsps", { query: { country, psu_type: "personal" } });
    return (data.aspsps ?? []).map((a) => ({
      name: a.name,
      country: a.country ?? country,
      logo: a.logo ?? null,
      maximumConsentValidity: a.maximum_consent_validity ?? null,
      sandbox: a.sandbox ?? false,
      beta: a.beta ?? false,
    }));
  }

  async startAuthorization(input: {
    bank: string;
    country: string;
    redirectUrl: string;
    state: string;
    validUntil: Date;
  }): Promise<string> {
    const data = await this.request(authSchema, "POST", "/auth", {
      body: {
        access: { valid_until: input.validUntil.toISOString() },
        aspsp: { name: input.bank, country: input.country },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: "personal",
      },
    });
    return data.url;
  }

  async createSession(code: string): Promise<EnableBankingSession> {
    const data = await this.request(sessionSchema, "POST", "/sessions", { body: { code } });
    const accounts: RemoteAccount[] = [];
    for (const a of data.accounts ?? []) {
      if (typeof a === "string") {
        accounts.push({ ref: a, iban: null, name: "Konto", currency: null });
      } else if (a.uid) {
        const iban = a.account_id?.iban ?? null;
        accounts.push({
          ref: a.uid,
          iban,
          name: a.name || a.product || iban || "Konto",
          currency: a.currency ?? null,
          product: a.product ?? null,
          type: a.cash_account_type ?? null,
        });
      }
    }
    const until = data.access?.valid_until ? new Date(data.access.valid_until) : null;
    return { sessionId: data.session_id, validUntil: until && !Number.isNaN(until.getTime()) ? until : null, accounts };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(z.unknown(), "DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async balance(accountUid: string, today = new Date().toISOString().slice(0, 10)): Promise<RemoteBalance | null> {
    const data = await this.request(balancesSchema, "GET", `/accounts/${encodeURIComponent(accountUid)}/balances`, { psu: true });
    const balances = data.balances ?? [];
    const rank = (type: string | null | undefined) => {
      const index = BALANCE_PREFERENCE.indexOf(type ?? "OTHR");
      return index === -1 ? BALANCE_PREFERENCE.length : index;
    };
    const best = [...balances].sort((a, b) => rank(a.balance_type) - rank(b.balance_type))[0];
    if (!best) return null;
    return { amountCents: cents(best.balance_amount?.amount), date: isoDay(best.reference_date) ?? today };
  }

  /**
   * Booked and announced entries; the API returns every status unless `transaction_status` narrows it. An announced
   * entry whose entry_reference also arrives booked is the same payment caught mid-booking and is left out.
   */
  async transactions(accountUid: string, dateFrom: string): Promise<AccountTransactions> {
    const bookings: RawBooking[] = [];
    const booked = new Set<string>();
    const announced: { ref: string | null; booking: RawPendingBooking }[] = [];
    let continuation: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = { date_from: dateFrom };
      if (continuation) query.continuation_key = continuation;
      const data = await this.request(transactionsSchema, "GET", `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
        query,
        psu: true,
      });
      for (const t of data.transactions ?? []) {
        const ref = transactionSchema.safeParse(t).data?.entry_reference || null;
        const booking = mapTransaction(t);
        if (booking) {
          bookings.push(booking);
          if (ref) booked.add(ref);
          continue;
        }
        const pending = mapPendingTransaction(t);
        if (pending) announced.push({ ref, booking: pending });
      }
      continuation = data.continuation_key ?? null;
      if (!continuation) {
        return { bookings, pending: announced.filter((a) => !a.ref || !booked.has(a.ref)).map((a) => a.booking) };
      }
    }
    throw new BankError("Zu viele Seiten beim Abruf der Umsätze");
  }
}
