import { z } from "zod";
import { DEFAULT_LOCALE, hasMessage, type Locale, msg, render, type Translatable, translate } from "../i18n/index.ts";

/**
 * Errors whose message is safe to show to the user; everything else is reported as a generic failure.
 * The text is a translatable key (`msg("area.errors.x", vars)`) or, for text from outside such as a bank's own error,
 * a plain string. `message` holds the German text until the middleware translates it for the reader.
 */
export class UserError extends Error {
  readonly text: Translatable | string;

  constructor(
    text: Translatable | string,
    readonly status = 400,
  ) {
    super(render(DEFAULT_LOCALE, text));
    this.text = text;
  }

  localized(locale: Locale): string {
    return render(locale, this.text);
  }
}

export class NotFound extends UserError {
  constructor(text: Translatable | string = msg("errors.notFound")) {
    super(text, 404);
  }
}

export class Forbidden extends UserError {
  constructor(text: Translatable | string = msg("errors.adminOnly")) {
    super(text, 403);
  }
}

/** The reader-facing text of any error: translated for a UserError, the given fallback for anything else. */
export function userMessage(error: unknown, locale: Locale, fallback: Translatable = msg("common.genericError")): string {
  return error instanceof UserError ? error.localized(locale) : render(locale, fallback);
}

/**
 * A thrown UserError reaches the client with its message only, so the middleware translates it here for the reader.
 * Zod issues whose message is a message key become a UserError the same way; other issues pass through unchanged.
 */
export function localizeError(error: unknown, locale: Locale): unknown {
  if (error instanceof UserError) {
    error.message = error.localized(locale);
    return error;
  }
  const first = firstIssueMessage(error);
  if (first && hasMessage(first)) return new UserError(translate(locale, first));
  return error;
}

// Validators of server functions throw a plain Error with the issues as JSON; modules' own parse() a ZodError.
function firstIssueMessage(error: unknown): string | undefined {
  if (error instanceof z.ZodError) return error.issues[0]?.message;
  if (!(error instanceof Error) || !error.message.startsWith("[")) return undefined;
  try {
    return (JSON.parse(error.message) as { message?: string }[])[0]?.message;
  } catch {
    return undefined;
  }
}
