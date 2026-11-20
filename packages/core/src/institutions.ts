/**
 * Recognizes an own account's institution in the counterparty of another booking, using only the names the account
 * carries itself (bank, account and connection name), so no bank or wallet has to be known in advance.
 */
import { fold } from "./text.ts";

const LEGAL_AND_REGION = new Set(
  (
    "sarl sca scs et cie gmbh mbh ag se kg kgaa co ohg ug eg ev sa nv bv ab as asa oy spa srl sl ltd limited inc plc " +
    "llc corp europe eu de deutschland germany international und and"
  ).split(" "),
);
const ACCOUNT_WORDS = new Set(
  (
    "konto girokonto giro tagesgeld tagesgeldkonto sparkonto festgeld festgeldkonto depot verrechnungskonto " +
    "gemeinschaftskonto kreditkarte karte card visa mastercard account checking savings extra mein meine privat"
  ).split(" "),
);
/** Alone these name a whole family of institutions; "Sparkasse Allgäu" is a key, "Sparkasse" is not. */
const GENERIC_ONLY = new Set(["bank", "banking", "sparkasse", "volksbank", "raiffeisenbank", "fints"]);

function tokens(text: string | null | undefined): string[] {
  return fold(text)
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u")
    .replace(/ß/g, "ss")
    .split(" ")
    .filter((t) => t.length > 1 && !LEGAL_AND_REGION.has(t) && !ACCOUNT_WORDS.has(t));
}

/** Token sequences that identify an institution, e.g. "PayPal (Europe) S.à r.l. et Cie, S.C.A." → [["paypal"]]. */
export function institutionKeys(names: readonly (string | null | undefined)[]): string[][] {
  const keys = new Map<string, string[]>();
  for (const name of names) {
    const key = tokens(name);
    if (key.join("").length < 3 || !key.some((t) => /\p{L}/u.test(t)) || key.every((t) => GENERIC_ONLY.has(t))) continue;
    keys.set(key.join(" "), key);
  }
  return [...keys.values()];
}

/** Whether one of the keys appears as whole words in the text, ignoring legal forms, accents and punctuation. */
export function namesInstitution(text: string | null | undefined, keys: readonly string[][]): boolean {
  const words = tokens(text);
  return keys.some((key) => words.some((_, at) => key.every((word, i) => words[at + i] === word)));
}
