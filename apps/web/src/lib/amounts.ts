import { useSyncExternalStore } from "react";
import { AMOUNTS_KEY } from "./theme.ts";

/**
 * Hidden money amounts ("privacy mode") live only in the browser (localStorage). `<html data-amounts="hidden">` carries
 * the choice: the head script sets it before the first paint, the CSS turns every `.money` element into a bar of one
 * width from it, and components that also need to hide amounts from screen readers subscribe here.
 */
const listeners = new Set<() => void>();

export function amountsHidden(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.amounts === "hidden";
}

export function setAmountsHidden(hidden: boolean): void {
  const root = document.documentElement;
  if (hidden) root.dataset.amounts = "hidden";
  else delete root.dataset.amounts;
  try {
    localStorage.setItem(AMOUNTS_KEY, hidden ? "hidden" : "shown");
  } catch {
    // Private mode: the choice lasts until the next reload.
  }
  for (const listener of listeners) listener();
}

export function subscribeAmounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAmountsHidden(): boolean {
  return useSyncExternalStore(subscribeAmounts, amountsHidden, () => false);
}

// A money amount as the Formatter writes it in every locale: a number with a currency sign or ISO code before or after it.
// Only known codes, so a bank name next to a number ("ING 12,00 €") is not taken for one.
const CURRENCY = /(?:[$€£¥][A-Z]{0,2}|[A-Z]{0,2}[$€£¥]|\b(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF)\b)/.source;
const NUMBER = /\d(?:[\d.,'’\u00a0\u202f]*\d)?/.source;
const GAP = /[ \u00a0\u202f]?/.source;
// A sign right before a number belongs to that number ("2026 €12.00" is a date and an English amount).
const MONEY = new RegExp(`[+−-]?(?:${CURRENCY}${GAP}${NUMBER}|${NUMBER}${GAP}${CURRENCY}(?![\u00a0\u202f]?\\d))`, "g");

/** Splits free text (notifications, AI answers, audit lines) into plain parts and money amounts. */
export function splitAmounts(text: string): { text: string; money: boolean }[] {
  const parts: { text: string; money: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(MONEY)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), money: false });
    parts.push({ text: match[0], money: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), money: false });
  return parts;
}

/** Replaces every money amount in a text, for strings that cannot show the mask such as `aria-label`s. */
export function maskAmounts(text: string, placeholder: string): string {
  return text.replace(MONEY, placeholder);
}
