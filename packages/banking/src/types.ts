/** A failure the user can act on; the message is German and safe to show. */
export class BankError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BankError";
  }
}

/** The bank consent or session is gone; the connection has to be authorized again. */
export class ReauthRequired extends BankError {
  constructor(message = "Die Freigabe bei der Bank ist abgelaufen. Bitte Verbindung erneuern.") {
    super(message);
    this.name = "ReauthRequired";
  }
}

/** One booking as every provider delivers it; amounts are signed cents (debits negative). */
export type RawBooking = {
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  providerId: string | null;
};

/**
 * A booking the bank has announced but not booked yet. It has no stable id: each sync delivers the full current set,
 * which replaces the stored one.
 */
export type RawPendingBooking = Omit<RawBooking, "bookingDate" | "providerId" | "counterpartyIban"> & { bookingDate: string | null };

/** `product` and `type` (ISO 20022 cash account type such as CACC, SVGS, CARD) help to guess the kind of account. */
export type RemoteAccount = {
  ref: string;
  iban: string | null;
  name: string;
  currency: string | null;
  product?: string | null;
  type?: string | null;
};

export type RemoteBalance = { amountCents: number; date: string };

/** One depot position; `price` is per unit in `currency` ("%" for bonds quoted in percent of the nominal value). */
export type RawHolding = {
  isin: string | null;
  name: string;
  quantity: number;
  price: number | null;
  currency: string;
  valueCents: number;
  costBasisCents: number | null;
  asOf: string;
};

export type TanChallenge = { text: string; decoupled: boolean; imageDataUrl: string | null };

/** Returns the TAN for a challenge ("" for app approvals once the caller has waited) or throws to abort. */
export type TanHandler = (challenge: TanChallenge) => Promise<string>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A request the read-only allowlist of an unofficial client refuses; it never reaches the network. */
export class BlockedRequest extends Error {
  constructor(what: string) {
    super(`Blocked by the read-only allowlist: ${what}`);
    this.name = "BlockedRequest";
  }
}

/** Collects Set-Cookie values; the jar is what an unofficial provider's session consists of. */
export function mergeCookies(jar: Record<string, string>, response: Response): Record<string, string> {
  const next = { ...jar };
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair?.indexOf("=") ?? -1;
    if (!pair || at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === "" || /max-age=0\b/i.test(line)) delete next[name];
    else next[name] = value;
  }
  return next;
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function isoDay(value: string | null | undefined): string | null {
  const day = value?.slice(0, 10);
  return day && ISO_DAY.test(day) ? day : null;
}
