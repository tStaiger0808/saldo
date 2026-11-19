/** How a tag got onto a booking; a person's tags are never removed by the AI or by rules. */
import { fold } from "./text.ts";

export type TagSource = "manual" | "rule" | "ai";

export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_ANSWER = 3;
/** Upper bound of the setting "at most N new tags per run". */
export const MAX_NEW_TAGS_PER_RUN = 20;
const MAX_TAG_WORDS = 3;

/** Identity of a tag or category name regardless of case, accents, punctuation and spacing ("Home-Office" = "home office"). */
export const tagKey = (name: string): string => fold(name);

/** A proposal as a tag name: trimmed, single spaces, no quotes or leading "#", first letter upper case; null when unusable. */
export function cleanTagName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/["„“”'`*]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/^#+\s*/, "");
  if (!tagKey(name) || name.length > MAX_TAG_LENGTH || name.split(" ").length > MAX_TAG_WORDS) return null;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

// Words that make a counterparty an organisation rather than a person.
const ORGANISATION_WORDS = new Set(
  (
    "gmbh mbh ag kg ug se ev eg ohg gbr kgaa ltd inc llc sa sarl srl spa bv nv plc ab as oy co " +
    "bank sparkasse volksbank raiffeisenbank versicherung stadtwerke verlag markt supermarkt apotheke shop store " +
    "gasthof gasthaus restaurant hotel cafe bistro bar pizzeria baeckerei backerei metzgerei tankstelle " +
    "service services online holding group gruppe verein schule kita stadt gemeinde finanzamt kasse krankenkasse " +
    "praxis klinik zentrum center club studio"
  ).split(" "),
);

/** The name parts of a counterparty that looks like a private person ("Max Mustermann", "Mustermann, Max"), else none. */
export function personNameParts(counterparty: string): string[] {
  if (/\d/.test(counterparty)) return [];
  const words = fold(counterparty).split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4 || words.some((w) => ORGANISATION_WORDS.has(w))) return [];
  return words.filter((w) => w.length >= 3);
}

/** IBANs, long numbers, e-mail addresses, mostly digits or the name of the paying person do not belong in a tag. */
export function looksPersonal(name: string, counterparty = ""): boolean {
  const compact = name.replace(/\s+/g, "");
  const digits = (compact.match(/\p{N}/gu) ?? []).length;
  if (/[A-Z]{2}\d{2}[A-Z0-9]{4,}/i.test(compact) || /\d{5,}/.test(compact) || name.includes("@")) return true;
  if (digits * 2 >= compact.length) return true;
  const parts = personNameParts(counterparty);
  const words = tagKey(name).split(" ");
  return parts.some((part) => words.includes(part));
}

export type TagProposals = { existing: number[]; fresh: string[] };

/**
 * Sorts the model's tag answer for one booking or payee: names matching an existing tag reuse it, names matching a
 * category are dropped, and the rest become new tag names only when creating tags is allowed and they look harmless.
 * At most `MAX_TAGS_PER_ANSWER` names are looked at.
 */
export function resolveTagProposals(
  answer: unknown,
  context: {
    tags: readonly { id: number; name: string }[];
    categories: readonly { name: string }[];
    counterparty: string;
    allowNew: boolean;
  },
): TagProposals {
  const existing: number[] = [];
  const fresh: string[] = [];
  const freshKeys = new Set<string>();
  const categoryKeys = new Set(context.categories.map((c) => tagKey(c.name)));
  for (const raw of (Array.isArray(answer) ? answer : []).slice(0, MAX_TAGS_PER_ANSWER)) {
    const name = cleanTagName(raw);
    if (!name) continue;
    const key = tagKey(name);
    const match = context.tags.find((t) => tagKey(t.name) === key);
    if (match) {
      if (!existing.includes(match.id)) existing.push(match.id);
    } else if (context.allowNew && !categoryKeys.has(key) && !freshKeys.has(key) && !looksPersonal(name, context.counterparty)) {
      freshKeys.add(key);
      fresh.push(name);
    }
  }
  return { existing, fresh };
}
