/**
 * WCAG contrast check of the colour tokens in src/styles.css for every theme in light and dark mode.
 * Run with `bun scripts/contrast.ts`; exits with 1 when a required pair falls below its minimum.
 */
import { readFileSync } from "node:fs";
import { THEMES } from "../src/lib/theme.ts";

const MODES = ["light", "dark"] as const;

type Tokens = Record<string, string>;
type Rule = { attributes: [string, string, string][]; specificity: number; tokens: Tokens };

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Top-level rules whose selector is only `:root` and attribute selectors on it, e.g. [data-theme|="leinen"][data-mode="dark"].
const RULES: Rule[] = [...css.matchAll(/(?<=^|\})\s*((?::root)?(?:\[[\w-]+[|^]?="[^"]*"\])*)\s*\{([^{}]*)\}/g)]
  .filter((match) => match[1])
  .map((match) => {
    const selector = match[1] as string;
    const attributes = [...selector.matchAll(/\[([\w-]+)([|^]?=)"([^"]*)"\]/g)].map((a) => [a[1], a[2], a[3]] as [string, string, string]);
    const tokens: Tokens = {};
    for (const [, name, value] of (match[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      tokens[name as string] = (value as string).trim();
    return { attributes, specificity: attributes.length + (selector.startsWith(":root") ? 1 : 0), tokens };
  });

function matches([name, op, expected]: [string, string, string], root: Record<string, string>): boolean {
  const actual = root[name] ?? "";
  if (op === "|=") return actual === expected || actual.startsWith(`${expected}-`);
  if (op === "^=") return actual.startsWith(expected);
  return actual === expected;
}

/** The custom properties `<html data-theme data-mode>` ends up with, in cascade order (specificity, then source order). */
function tokensFor(theme: string, mode: string): Tokens {
  const root = { "data-theme": theme, "data-mode": mode };
  const applying = RULES.filter((rule) => rule.attributes.every((a) => matches(a, root)));
  const ordered = applying
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.specificity - b.rule.specificity || a.index - b.index);
  return Object.assign({}, ...ordered.map(({ rule }) => rule.tokens));
}

function resolve(tokens: Tokens, name: string, depth = 0): string {
  const value = tokens[name];
  if (!value) throw new Error(`Token ${name} fehlt`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref && depth < 10 ? resolve(tokens, ref[1] as string, depth + 1) : value;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Keine Farbe: ${hex}`);
  const channels = [0, 2, 4].map((i) => Number.parseInt((m[1] as string).slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum, where, only in this variant]
const PAIRS: [string, string, number, string, string?][] = [
  ["--ink", "--ground", 4.5, "Text auf Grund"],
  ["--ink", "--surface", 4.5, "Text auf Karte"],
  ["--ink", "--line-soft", 4.5, "Text auf Hover/Chat"],
  ["--ink-2", "--surface", 4.5, "Zweiter Text"],
  ["--muted", "--surface", 4.5, "Grauer Text auf Karte"],
  ["--muted", "--ground", 4.5, "Grauer Text auf Grund"],
  ["--muted", "--accent-soft", 4.5, "Hinweis im aktiven Bereich"],
  ["--link", "--surface", 4.5, "Link auf Karte"],
  ["--link", "--ground", 4.5, "Link auf Grund"],
  ["--accent-ink", "--surface", 4.5, "Akzentschrift"],
  ["--accent-ink", "--accent-soft", 4.5, "Akzentschrift auf Akzentfläche"],
  ["--accent-ink", "--accent-tint", 4.5, "Akzentschrift auf Tönung"],
  ["--muted", "--accent-tint", 4.5, "Grauer Text auf Kennzahl-Kachel"],
  ["--danger-ink", "--accent-tint", 4.5, "Verschlechterung auf Kennzahl-Kachel"],
  ["--accent", "--accent-tint", 3, "Verlaufslinie auf Kennzahl-Kachel"],
  ["--accent-fg", "--accent", 4.5, "Hauptknopf"],
  ["--accent-fg", "--accent-hover", 4.5, "Hauptknopf beim Überfahren"],
  ["--warn-ink", "--warn-soft", 4.5, "Warnung"],
  ["--info-ink", "--info-soft", 4.5, "Hinweis"],
  ["--info-ink", "--surface", 4.5, "Übertrag-Merkmal"],
  ["--danger-ink", "--danger-soft", 4.5, "Fehler"],
  ["--danger-ink", "--surface", 4.5, "Gefahrknopf"],
  ["--surface", "--danger-ink", 4.5, "Bestätigung Löschen"],
  ["--nav-ink", "--nav", 4.5, "Navigation"],
  ["--nav-ink", "--nav-active", 4.5, "Navigation auf aktiver Fläche"],
  ["--nav-ink-strong", "--nav-active", 4.5, "Aktiver Menüpunkt"],
  ["--nav", "--brand", 4.5, "Zähler und Zeichen"],
  ["--tip-text", "--tip-bg", 4.5, "Tooltip"],
  ["--accent", "--surface", 3, "Fokusring, Kästchen, Punkt"],
  ["--accent", "--ground", 3, "Fokusring auf Grund"],
  ["--brand", "--nav", 3, "Fokusring in der Navigation"],
  ["--brand", "--nav-active", 3, "Abruf-Symbol auf aktivem Menüpunkt"],
  // Only the dark bar of Leinen Nacht draws these borders strongly; elsewhere label and icon identify the controls.
  ["--nav-control", "--nav", 3, "Rahmen von Suche, Avatar und Menüknopf", "leinen-nacht/light"],
  ["--control", "--surface", 3, "Rahmen von Feldern"],
  ["--warn-dot", "--surface", 3, "Statuspunkt Warnung"],
  ["--warn-ink", "--surface", 4.5, "Hervorgehobener Status Warnung"],
  ["--ink-2", "--line-soft", 4.5, "Status ohne Ton, Zeile beim Überfahren"],
  ["--muted", "--line-soft", 4.5, "Grauer Text, Tag und Zeit in überfahrener Zeile"],
  ["--accent-ink", "--line-soft", 4.5, "Eingang in überfahrener Zeile"],
  ["--danger-ink", "--line-soft", 4.5, "Gefahrtext in überfahrener Zeile"],
  ["--amount-in", "--surface", 4.5, "Eingang auf Karte"],
  ["--amount-in", "--ground", 4.5, "Eingang auf Grund"],
  ["--amount-in", "--line-soft", 4.5, "Eingang in überfahrener Zeile und Chat"],
  ["--amount-in", "--accent-tint", 4.5, "Eingang auf Kennzahl-Kachel und neuer Buchung"],
  ["--amount-in", "--accent-soft", 4.5, "Eingang in eigener Chatnachricht"],
  ["--amount-out", "--surface", 4.5, "Ausgang auf Karte"],
  ["--amount-out", "--ground", 4.5, "Ausgang auf Grund"],
  ["--amount-out", "--line-soft", 4.5, "Ausgang in überfahrener Zeile und Chat"],
  ["--amount-out", "--accent-tint", 4.5, "Ausgang auf Kennzahl-Kachel und neuer Buchung"],
  ["--amount-out", "--accent-soft", 4.5, "Ausgang in eigener Chatnachricht"],
  ["--ink-2", "--accent-tint", 4.5, "Tageskopf im Kontoverlauf"],
  ["--warn-dot", "--ground", 3, "Rahmen der Ansehen-Leiste"],
  ["--nav-ink-strong", "--nav", 4.5, "Name in der Navigation"],
  ["--accent", "--accent-soft", 3, "Rahmen gewählter Chip"],
  ["--accent", "--line-soft", 3, "Fokusring auf überfahrener Zeile, Griff im Verlaufsregler"],
  ["--s1", "--surface", 3, "Saldolinie im Kontoverlauf"],
  ["--amount-mask", "--surface", 3, "Verborgener Betrag auf Karte"],
  ["--amount-mask", "--ground", 3, "Verborgener Betrag auf Grund"],
  ["--amount-mask", "--accent-tint", 3, "Verborgener Betrag auf Kennzahl-Kachel und Tageskopf"],
  ["--amount-mask", "--line-soft", 3, "Verborgener Betrag in überfahrener Zeile"],
  ["--amount-mask", "--tip-bg", 3, "Verborgener Betrag im Diagramm-Tooltip"],
  ["--amount-mask", "--accent-soft", 3, "Verborgener Betrag in Erfolgsmeldung"],
  ["--amount-mask", "--info-soft", 3, "Verborgener Betrag in Hinweis"],
  ["--amount-mask", "--warn-soft", 3, "Verborgener Betrag in Warnung"],
];

const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

let failures = 0;
const notes: string[] = [];
for (const { id: theme } of THEMES) {
  for (const mode of MODES) {
    const tokens = tokensFor(theme, mode);
    for (const [fg, bg, min, where, only] of PAIRS) {
      if (only && only !== `${theme}/${mode}`) continue;
      const ratio = contrast(resolve(tokens, fg), resolve(tokens, bg));
      if (ratio < min) {
        failures += 1;
        console.log(`FEHLER ${theme}/${mode}: ${where} (${fg} auf ${bg}) ${ratio.toFixed(2)} < ${min}`);
      }
    }
    for (const s of SERIES) {
      const ratio = contrast(resolve(tokens, s), resolve(tokens, "--surface"));
      if (ratio < 3)
        notes.push(`${theme}/${mode}: ${s} ${ratio.toFixed(2)} : 1 gegen die Karte (Werte stehen zusätzlich als Text und in der Tabelle)`);
    }
  }
}
if (notes.length > 0) console.log(`Hinweise zu Diagrammreihen:\n  ${[...new Set(notes)].join("\n  ")}`);
console.log(
  failures === 0
    ? `Alle ${PAIRS.length} Paare in ${THEMES.length * MODES.length} Varianten erfüllen WCAG 2.1 AA.`
    : `${failures} Paare zu schwach.`,
);
process.exit(failures === 0 ? 0 : 1);
