import { useSyncExternalStore } from "react";
import type { Translate } from "../i18n/index.ts";
import type { ChatUsage } from "../server/modules/ai/index.ts";
import type { Formatter } from "./format.ts";
import type { Role } from "./labels.ts";

/**
 * Whether AI answers and AI tasks show their token counts, a per-browser choice. Without one stored, superusers (who
 * set up and pay for the providers) see them and everyone else does not.
 */
export const AI_DETAILS_KEY = "fw-ki-details";

const listeners = new Set<() => void>();
// Where storage is blocked (private mode) the choice lasts until the next reload.
let chosen: boolean | null = null;

function stored(): boolean | null {
  try {
    const value = localStorage.getItem(AI_DETAILS_KEY);
    if (value === "on" || value === "off") return value === "on";
  } catch {}
  return chosen;
}

export const aiDetailsDefault = (role: Role): boolean => role === "superuser";

export function aiDetailsShown(role: Role): boolean {
  return stored() ?? aiDetailsDefault(role);
}

export function setAiDetailsShown(shown: boolean): void {
  chosen = shown;
  try {
    localStorage.setItem(AI_DETAILS_KEY, shown ? "on" : "off");
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only for people who may use the AI; the server renders the role's default. */
export function useAiDetails(user: { role: Role }, aiAllowed: boolean): boolean {
  const shown = useSyncExternalStore(
    subscribe,
    () => aiDetailsShown(user.role),
    () => aiDetailsDefault(user.role),
  );
  return aiAllowed && shown;
}

/** "128k", "1M": the usual short form of a window size, with the reader's decimal sign. */
export function compactTokens(f: Formatter, tokens: number): string {
  if (tokens >= 1_000_000) return `${f.decimal(tokens / 1_000_000, 1)}M`;
  if (tokens >= 1_000) return `${f.decimal(tokens / 1_000, 0)}k`;
  return f.integer(tokens);
}

const SMALLEST_SHARE = 0.001;

/**
 * "1.234 Tokens Kontext · 210 Antwort · 1 % von 128k Kontext" under an AI answer. The context is the largest single
 * request; several requests (tool rounds) add their count and total. Null when the provider reported no usage.
 */
export function chatUsageLine(usage: ChatUsage, t: Translate, f: Formatter): string | null {
  if (usage.reported === false || usage.inputTokens + usage.outputTokens === 0) return null;
  const context = usage.maxInputTokens ?? (usage.calls === 1 ? usage.inputTokens : null);
  const parts: string[] = [];
  if (context !== null) parts.push(t("ai.details.context", { tokens: context }));
  parts.push(t("ai.details.answer", { tokens: usage.outputTokens }));
  if (usage.calls > 1) parts.push(t("ai.details.calls", { count: usage.calls, tokens: usage.inputTokens + usage.outputTokens }));
  const window = usage.contextWindow;
  if (window && context !== null) {
    const ratio = context / window.tokens;
    const share = ratio > 0 && ratio < SMALLEST_SHARE ? `< ${f.percent(SMALLEST_SHARE, 1)}` : f.percent(ratio, 1);
    const size = compactTokens(f, window.tokens);
    parts.push(t(window.estimated ? "ai.details.windowEstimated" : "ai.details.window", { share, window: size }));
  }
  return parts.join(" · ");
}
