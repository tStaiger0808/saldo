export function normalize(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Lower case without accents and punctuation, e.g. "PayPal (Europe) S.à r.l." → "paypal europe s a r l". */
export function fold(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Card payments of some banks (comdirect) carry no payee; the merchant is the first part of the purpose,
 * e.g. "CAMPING INTERNAZIONALE LA, LAZISE; IT; Karte Nr. …; Kartenzahlung" → "CAMPING INTERNAZIONALE LA".
 */
export function payeeFromPurpose(purpose: string | null | undefined): string {
  const text = purpose ?? "";
  if (!/kartenzahlung|karte nr\./i.test(text)) return "";
  const first =
    text
      .split(";")
      .map((part) => part.trim())
      .find((part) => part && !/^karte nr\./i.test(part)) ?? "";
  return first
    .replace(/,[^,]*$/, "")
    .replace(/\s+[A-Z]{0,3}[*.]\d[\w-]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizeIban(iban: string | null | undefined): string {
  return (iban ?? "").replace(/\s+/g, "").toUpperCase();
}

// Spreadsheets skip leading whitespace before they look for a formula, so it is looked past here, too.
const FORMULA_START = /^(?:[\t\r]|\s*[=+\-@])/;

/** Bank texts are attacker-controlled; keeps spreadsheets from evaluating a CSV cell as a formula. */
export function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  return FORMULA_START.test(text) ? `'${text}` : text;
}
