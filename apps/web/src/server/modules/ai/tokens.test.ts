import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listModels, type ProviderConfig } from "./client.ts";
import {
  contextWindowFor,
  estimatedContextWindow,
  listedContextWindow,
  rememberContextWindow,
  resetContextWindowsForTests,
  totalTokens,
} from "./tokens.ts";

const call = (inputTokens: number, outputTokens: number, reported = true) => ({ inputTokens, outputTokens, reported });

describe("totalTokens", () => {
  it("sums every round and keeps the largest single request as the context", () => {
    expect(totalTokens([call(1_000, 40), call(2_500, 10), call(1_800, 210)])).toEqual({
      inputTokens: 5_300,
      outputTokens: 260,
      maxInputTokens: 2_500,
      calls: 3,
      reported: true,
    });
  });

  it("is not reported when one call lacks usage, or when there was no call", () => {
    expect(totalTokens([call(1_000, 40), call(0, 0, false)]).reported).toBe(false);
    expect(totalTokens([])).toEqual({ inputTokens: 0, outputTokens: 0, maxInputTokens: 0, calls: 0, reported: false });
  });
});

describe("context window", () => {
  const cfg: ProviderConfig = { kind: "openai", baseUrl: "https://openrouter.example/api/v1", apiKey: "k", model: null };
  beforeEach(() => resetContextWindowsForTests());
  afterEach(() => vi.restoreAllMocks());

  it("reads the window from the fields model lists use", () => {
    expect(listedContextWindow({ id: "a", context_length: 131_072 })).toBe(131_072);
    expect(listedContextWindow({ id: "a", top_provider: { context_length: 64_000 } })).toBe(64_000);
    expect(listedContextWindow({ id: "claude-x", max_input_tokens: 200_000 })).toBe(200_000);
    expect(listedContextWindow({ id: "a", max_model_len: 32_768 })).toBe(32_768);
    expect(listedContextWindow({ id: "a", limit: { context: 400_000, output: 128_000 } })).toBe(400_000);
    expect(listedContextWindow({ id: "a", context_length: "lots" })).toBeNull();
    expect(listedContextWindow({ id: "a", context_length: 0 })).toBeNull();
    expect(listedContextWindow(null)).toBeNull();
  });

  it("estimates well-known families, also behind a router prefix, and knows nothing about others", () => {
    expect(estimatedContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(estimatedContextWindow("anthropic/claude-opus-4")).toBe(200_000);
    expect(estimatedContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(estimatedContextWindow("GPT-4.1-mini")).toBe(1_047_576);
    expect(estimatedContextWindow("o3")).toBe(200_000);
    expect(estimatedContextWindow("o4-mini")).toBe(200_000);
    expect(estimatedContextWindow("ollama-local")).toBeNull();
    expect(estimatedContextWindow("mock-model")).toBeNull();
  });

  it("prefers the window the provider listed, else marks the estimate, else has none", () => {
    expect(contextWindowFor({ ...cfg, model: "gpt-4o" })).toEqual({ tokens: 128_000, estimated: true });
    rememberContextWindow(cfg, "gpt-4o", 120_000);
    expect(contextWindowFor({ ...cfg, model: "gpt-4o" })).toEqual({ tokens: 120_000, estimated: false });
    // Another address may serve the same id with another window.
    expect(contextWindowFor({ ...cfg, baseUrl: "https://other.example/v1", model: "gpt-4o" })).toEqual({
      tokens: 128_000,
      estimated: true,
    });
    expect(contextWindowFor({ ...cfg, model: "mock-model" })).toBeNull();
    expect(contextWindowFor(cfg)).toBeNull();
  });

  it("learns the windows from the model list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "mock-model", context_length: 32_000 }, { id: "plain" }] }),
    );
    const models = await listModels(cfg);
    expect(models).toEqual([
      { id: "mock-model", price: null, contextWindow: 32_000 },
      { id: "plain", price: null },
    ]);
    expect(contextWindowFor({ ...cfg, model: "mock-model" })).toEqual({ tokens: 32_000, estimated: false });
    expect(contextWindowFor({ ...cfg, model: "plain" })).toBeNull();
  });
});
