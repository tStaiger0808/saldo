/** Supported languages and how a request picks one; free of messages so the schema and config can import it. */
export const LOCALES = ["de", "en", "fr", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "de";

/** Each language in its own name, so a reader finds theirs whatever the interface language is. */
export const LOCALE_NAMES: Record<Locale, string> = { de: "Deutsch", en: "English", fr: "Français", it: "Italiano" };

/** The regional variant used for Intl formatting (currency, dates, numbers). */
export const INTL_LOCALES: Record<Locale, string> = { de: "de-DE", en: "en-GB", fr: "fr-FR", it: "it-IT" };

/** Cookie with the language picked on the sign-in page, where no user setting exists yet. */

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Best supported match of an `Accept-Language` header, by quality and then order; null if nothing fits. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { language: tag.trim().toLowerCase().split("-")[0] ?? "", quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((entry) => entry.language).find(isLocale) ?? null;
}

/** The user's choice wins, then the language the browser asks for, then German. */
export function resolveLocale(preference: Locale | null | undefined, acceptLanguage: string | null | undefined): Locale {
  return preference ?? matchAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
