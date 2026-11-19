/** Folds case and accents, so "uber" finds "Über" and "cafe" finds "Café". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Every word of the query occurs somewhere in one of the texts. */
export function matches(query: string, ...texts: (string | null | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const haystack = fold(texts.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
}

/** An IBAN that ends with the typed digits, e.g. "4321" for the last four. */
export function ibanEndsWith(iban: string | null | undefined, query: string): boolean {
  const digits = query.replace(/\s/g, "");
  return Boolean(iban) && /^\d{2,}$/.test(digits) && (iban ?? "").replace(/\s/g, "").endsWith(digits);
}

/**
 * A query that is an amount ("12,50", "1.234,56 €", "-8") in cents without sign, else null. A separator followed by
 * one or two digits at the end is the decimal mark; any other separator groups thousands.
 */
export function parseAmountQuery(query: string): number | null {
  const text = query
    .trim()
    .replace(/^[-+−]\s*/, "")
    .replace(/\s*(€|EUR)$/i, "");
  if (!/^\d[\d.,'’\u00a0\u202f ]*$/.test(text)) return null;
  const decimal = /[.,](\d{1,2})$/.exec(text);
  const whole = (decimal ? text.slice(0, decimal.index) : text).replace(/[.,'’\u00a0\u202f ]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const cents = Number(whole) * 100 + (decimal ? Number((decimal[1] ?? "").padEnd(2, "0")) : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

const RECENT_KEY = "fw-zuletzt";
const RECENT_MAX = 6;

export function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Remembers a visited path (without search) in this browser, newest first. */
export function rememberRecent(path: string): void {
  const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode: no recent pages.
  }
}
