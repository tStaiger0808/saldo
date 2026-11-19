import { DEFAULT_LOCALE, type Locale, matchAcceptLanguage } from "../i18n/locales.ts";

/**
 * What "automatic" resolves to, and the language before sign-in: the browser's preferred supported language, else
 * German. Once signed in, the profile setting applies.
 */
export function browserLocale(headers: Headers): Locale {
  return matchAcceptLanguage(headers.get("accept-language")) ?? DEFAULT_LOCALE;
}
