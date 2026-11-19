/**
 * Token counts of an answer and the context window they have to fit into. Only counts, never prompt contents.
 * The window comes from the provider's model list when it names one; otherwise a small table of well-known model
 * families gives an estimate, and an unknown model has none.
 */
import type { ProviderConfig, Usage } from "./client.ts";

export type ContextWindow = { tokens: number; estimated: boolean };

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  /** The largest single request: with tool rounds, each round resends the conversation, so this is what hits the window. */
  maxInputTokens: number;
  calls: number;
  /** False as soon as one call came back without usage; the sums are then incomplete. */
  reported: boolean;
};

export function totalTokens(calls: readonly Pick<Usage, "inputTokens" | "outputTokens" | "reported">[]): TokenTotals {
  return {
    inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    maxInputTokens: calls.reduce((max, c) => Math.max(max, c.inputTokens), 0),
    calls: calls.length,
    reported: calls.length > 0 && calls.every((c) => c.reported),
  };
}

const positive = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

/**
 * The window a model list entry names: OpenRouter `context_length` (also under `top_provider`), Anthropic
 * `max_input_tokens`, vLLM `max_model_len`, LM Studio `max_context_length`, models.dev and OpenCode `limit.context`.
 */
export function listedContextWindow(item: unknown): number | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Record<string, unknown>;
  const nested = (key: string, field: string) => {
    const value = entry[key];
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;
  };
  for (const candidate of [
    entry.context_length,
    entry.context_window,
    entry.max_input_tokens,
    entry.max_model_len,
    entry.max_context_length,
    nested("limit", "context"),
    nested("top_provider", "context_length"),
  ]) {
    const tokens = positive(candidate);
    if (tokens !== null) return tokens;
  }
  return null;
}

/** Hosted model families with a stable window; ids are matched without a router prefix ("anthropic/claude-…"). */
const KNOWN_WINDOWS: [RegExp, number][] = [
  [/^claude-/, 200_000],
  [/^gpt-5/, 400_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128_000],
  [/^gpt-4-turbo/, 128_000],
  [/^o[134](-|$)/, 200_000],
  [/^gemini-(1\.5|2|3)/, 1_048_576],
  [/^deepseek-/, 128_000],
];

export function estimatedContextWindow(model: string): number | null {
  const id = model.toLowerCase().split("/").at(-1) ?? "";
  return KNOWN_WINDOWS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

const listed = new Map<string, number>();
const windowKey = (cfg: Pick<ProviderConfig, "kind" | "baseUrl">, model: string) => `${cfg.kind}|${cfg.baseUrl}|${model}`;

/** Learned whenever the model list is read (saving or testing a provider, the model picker); kept until the process restarts. */
export function rememberContextWindow(cfg: Pick<ProviderConfig, "kind" | "baseUrl">, model: string, tokens: number): void {
  listed.set(windowKey(cfg, model), tokens);
}

export function contextWindowFor(cfg: Pick<ProviderConfig, "kind" | "baseUrl" | "model">): ContextWindow | null {
  if (!cfg.model) return null;
  const exact = listed.get(windowKey(cfg, cfg.model));
  if (exact !== undefined) return { tokens: exact, estimated: false };
  const estimate = estimatedContextWindow(cfg.model);
  return estimate === null ? null : { tokens: estimate, estimated: true };
}

export function resetContextWindowsForTests(): void {
  listed.clear();
}
