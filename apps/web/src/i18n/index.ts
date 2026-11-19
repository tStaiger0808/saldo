import { de } from "./de.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { INTL_LOCALES, LOCALES, type Locale } from "./locales.ts";

export * from "./locales.ts";

/** A message with plural forms, chosen by the `count` variable through `Intl.PluralRules`; `other` is required. */
export type PluralForms = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };

// A group key must never be called `other`: an object with `other` is a plural message.
type Widen<T> = T extends string ? string : T extends { readonly other: string } ? PluralForms : { -readonly [K in keyof T]: Widen<T[K]> };

/** The shape every locale has to fill; `de.ts` is the source. */
export type Messages = Widen<typeof de>;

type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string | { readonly other: string } ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
// A mapped type over the keys; intersecting one object per key exceeds the compiler's complexity limit at ~2000 messages.
type At<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never;

export type MessageKey = Paths<typeof de>;
type FlatMessages = { [K in MessageKey]: At<typeof de, K> };

type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
type FormPlaceholders<M> = M extends string ? Placeholders<M> : "count" | Placeholders<M[keyof M]>;
/** A nested `Translatable` is rendered in the same language, e.g. the reason inside a wrapping error. */
export type VarValue = string | number | Translatable;
export type Vars<K extends MessageKey> = Record<FormPlaceholders<FlatMessages[K]>, VarValue>;

/** Arguments after the key: none when the message has no placeholders, otherwise all of them. */
export type VarsArg<K extends MessageKey> = [FormPlaceholders<FlatMessages[K]>] extends [never] ? [vars?: undefined] : [vars: Vars<K>];

export type Translate = <K extends MessageKey>(key: K, ...vars: VarsArg<K>) => string;

/** A message that is translated later, once the reader's language is known (errors, notifications). */
export type Translatable = { key: MessageKey; vars?: Record<string, VarValue> };

export function msg<K extends MessageKey>(key: K, ...vars: VarsArg<K>): Translatable {
  return vars[0] ? { key, vars: vars[0] } : { key };
}

export const MESSAGES: Record<Locale, Messages> = { de, en, fr, it };

function lookup(messages: Messages, key: string): string | PluralForms | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && typeof (node as PluralForms).other === "string") return node as PluralForms;
  return undefined;
}

export function hasMessage(key: string): key is MessageKey {
  return lookup(de, key) !== undefined;
}

const perLocale = <T>(make: (tag: string) => T) =>
  Object.fromEntries(LOCALES.map((locale) => [locale, make(INTL_LOCALES[locale])])) as Record<Locale, T>;
const pluralRules = perLocale((tag) => new Intl.PluralRules(tag));
const numberFormats = perLocale((tag) => new Intl.NumberFormat(tag));

/** Fills a message for one locale: the plural form by `vars.count`, then the `{name}` placeholders. */
export function formatMessage(locale: Locale, message: string | PluralForms, vars?: Record<string, VarValue>): string {
  let text: string;
  if (typeof message === "string") text = message;
  else {
    const count = Number(vars?.count ?? 0);
    const category = (count === 0 && message.zero ? "zero" : pluralRules[locale].select(count)) as keyof PluralForms;
    text = message[category] ?? message.other;
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    if (typeof value === "number") return numberFormats[locale].format(value);
    return typeof value === "string" ? value : translate(locale, value.key, value.vars);
  });
}

/** Translates without type checks on key and variables; for keys that arrive as data (errors, stored notifications). */
export function translate(locale: Locale, key: string, vars?: Record<string, VarValue>): string {
  const message = lookup(MESSAGES[locale], key) ?? lookup(de, key);
  return message === undefined ? key : formatMessage(locale, message, vars);
}

export function t<K extends MessageKey>(locale: Locale, key: K, ...vars: VarsArg<K>): string {
  return translate(locale, key, vars[0]);
}

export function translator(locale: Locale): Translate {
  return (key, ...vars) => translate(locale, key, vars[0]);
}

export function render(locale: Locale, message: Translatable | string): string {
  return typeof message === "string" ? message : translate(locale, message.key, message.vars);
}
