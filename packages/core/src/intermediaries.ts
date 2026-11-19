/**
 * Payment services, buy-now-pay-later providers, acquirers and card schemes pay on behalf of many merchants, so their
 * name says nothing about what was bought. Patterns run on `fold`ed counterparty names.
 */
import { fold } from "./text.ts";

export const PAYMENT_INTERMEDIARIES: readonly { name: string; pattern: RegExp }[] = [
  { name: "PayPal", pattern: /\bpaypal\b/ },
  { name: "Klarna", pattern: /\bklarna\b/ },
  { name: "Sofort", pattern: /^sofort\b/ },
  { name: "Riverty", pattern: /\briverty\b/ },
  { name: "AfterPay", pattern: /\bafter ?pay\b/ },
  { name: "Arvato Payment", pattern: /\barvato (payment|financial)\b/ },
  { name: "Ratepay", pattern: /\bratepay\b/ },
  { name: "SumUp", pattern: /\bsumup\b/ },
  { name: "Amazon Payments", pattern: /\bamazon payments?\b/ },
  { name: "Stripe", pattern: /\bstripe\b/ },
  { name: "Adyen", pattern: /\badyen\b/ },
  { name: "Mollie", pattern: /\bmollie\b/ },
  { name: "Unzer", pattern: /\b(unzer|heidelpay)\b/ },
  { name: "Computop", pattern: /\bcomputop\b/ },
  { name: "Payone", pattern: /\bpayone\b/ },
  { name: "Wirecard", pattern: /\bwirecard\b/ },
  { name: "Worldline", pattern: /\bworldline\b/ },
  { name: "Nexi", pattern: /\b(nexi|concardis)\b/ },
  { name: "Trustly", pattern: /\btrustly\b/ },
  { name: "Apple Pay", pattern: /\bapple pay\b/ },
  { name: "Google Pay", pattern: /\bgoogle pay(ment)?\b/ },
  { name: "Visa", pattern: /^visa\b/ },
  { name: "Mastercard", pattern: /^master ?card\b/ },
];

/**
 * The intermediary a counterparty stands for, or null. "PAYPAL *SPOTIFY" and "SumUp...Stadtle.Kebap/Immenstadt" already
 * name the merchant, so they count as that merchant's own counterparty.
 */
export function paymentIntermediary(counterparty: string | null | undefined): string | null {
  if (/\*\s*[\p{L}\p{N}]|^\s*\p{L}+\.{2,}\s*[\p{L}\p{N}]/u.test(counterparty ?? "")) return null;
  const text = fold(counterparty);
  if (!text) return null;
  return PAYMENT_INTERMEDIARIES.find((i) => i.pattern.test(text))?.name ?? null;
}

const MERCHANT_PATTERNS: RegExp[] = [
  // PayPal: ". Spotify AB, Ihr Einkauf bei Spotify AB"
  /\bihre?\s+(?:einkauf|bestellung|zahlung|r(?:ü|ue)ckzahlung|erstattung)\s+(?:bei|von|an)\s+([^,;]+)/iu,
  // PayPal: "PP.1234.PP . Spotify AB" or "PP.1234.PP/. Spotify AB"
  /\bPP\.\d+\.PP\s*\/?\s*\.\s*([^,;/]+)/iu,
  // Card-style wrappers: "PAYPAL *SPOTIFY 3531", "SumUp *Baeckerei Mayer"
  /\b(?:paypal|klarna|sumup|stripe|adyen|mollie|google|apple pay)\s*\*\s*([^,;/]+)/iu,
];

function cleanMerchant(raw: string): string {
  const words = raw.split(/\s+/).filter(Boolean);
  // Trailing references such as "35314369001" or "1043/PP" are not part of the name.
  while (words.length > 1 && /\d/.test(words.at(-1) ?? "")) words.pop();
  const name = words
    .join(" ")
    .replace(/^[\s.\-:/]+|[\s.\-:/]+$/g, "")
    .slice(0, 80);
  const letters = fold(name).replace(/[^\p{L}]/gu, "");
  if (letters.length < 3 || paymentIntermediary(name)) return "";
  return name;
}

/** The merchant a payment service booking was for, read from its purpose; "" when the text names none. */
export function merchantFromPurpose(purpose: string | null | undefined): string {
  const text = (purpose ?? "").split(/\s+/).filter(Boolean).join(" ");
  for (const pattern of MERCHANT_PATTERNS) {
    const found = cleanMerchant(text.match(pattern)?.[1] ?? "");
    if (found) return found;
  }
  return "";
}
