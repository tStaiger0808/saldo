import { BankError, ReauthRequired } from "@saldo/banking";
import { DEFAULT_LOCALE, hasMessage, type Locale, msg, render, type Translatable } from "../../../i18n/index.ts";
import { UserError } from "../../errors.ts";

/** Our own texts raised as bank errors: they take the bank-error paths (status, rollback) but stay translatable. */
export class SaldoBankError extends BankError {
  constructor(readonly text: Translatable) {
    super(render(DEFAULT_LOCALE, text));
  }
}

export class SaldoReauthRequired extends ReauthRequired {
  constructor(readonly text: Translatable) {
    super(render(DEFAULT_LOCALE, text));
  }
}

export type Text = Translatable | string;

/** What a failed bank run tells the reader; bank and driver details stay as the provider sent them. */
export function failureText(error: unknown): Text {
  if (error instanceof SaldoBankError || error instanceof SaldoReauthRequired || error instanceof UserError) return error.text;
  // The provider throws a bare ReauthRequired only for an expired or revoked consent.
  if (error instanceof ReauthRequired) return msg("banking.errors.consentExpired");
  if (error instanceof BankError) return error.message;
  return msg("banking.errors.unexpected");
}

/** A translatable text survives a text column as JSON and is rendered in the reader's language later. */
export function storeText(text: Text): string {
  return typeof text === "string" ? text : JSON.stringify(text);
}

export function readText(stored: string, locale: Locale): string {
  if (!stored.startsWith("{")) return stored;
  try {
    const parsed = JSON.parse(stored) as Partial<Translatable>;
    if (typeof parsed.key === "string" && hasMessage(parsed.key)) return render(locale, { key: parsed.key, vars: parsed.vars });
  } catch {
    // Plain text that happens to start with a brace.
  }
  return stored;
}

// Restricted Enable Banking apps only reach accounts the app owner linked in the Control Panel; these are the ways
// that refusal is worded. Anything else stays the provider's own message.
const RESTRICTED_APP =
  /\b(not (been )?linked|accounts? (is |are )?not linked|link(ed)? accounts? first|restricted (mode|app|application)|unlinked account)/i;

export function isRestrictedAppError(text: string): boolean {
  return RESTRICTED_APP.test(text);
}
