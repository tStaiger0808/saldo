import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "../i18n/index.ts";
import type { ChatUsage } from "../server/modules/ai/index.ts";
import { AI_DETAILS_KEY, aiDetailsShown, chatUsageLine, compactTokens, setAiDetailsShown } from "./ai-details.ts";
import { formatter } from "./format.ts";

const usage = (over: Partial<ChatUsage> = {}): ChatUsage => ({
  providerName: "OpenAI",
  model: "gpt-4o",
  mode: "tools",
  inputTokens: 1_234,
  outputTokens: 210,
  calls: 1,
  maxInputTokens: 1_234,
  reported: true,
  contextWindow: { tokens: 128_000, estimated: false },
  ...over,
});

const spaced = (text: string | null) => text?.replace(/[\u00a0\u202f]/g, " ") ?? null;
const de = (u: ChatUsage) => spaced(chatUsageLine(u, translator("de"), formatter("de")));

describe("chatUsageLine", () => {
  it("names context, answer and the share of the window in the reader's language", () => {
    expect(de(usage())).toBe("1.234 Tokens Kontext · 210 Antwort · 1 % von 128k Kontext");
    expect(spaced(chatUsageLine(usage(), translator("en"), formatter("en")))).toBe(
      "1,234 context tokens · 210 answer · 1% of 128k context",
    );
    expect(de(usage({ maxInputTokens: 400, inputTokens: 400 }))).toBe("400 Tokens Kontext · 210 Antwort · 0,3 % von 128k Kontext");
    expect(de(usage({ maxInputTokens: 40, inputTokens: 40 }))).toBe("40 Tokens Kontext · 210 Antwort · < 0,1 % von 128k Kontext");
  });

  it("takes the largest request as the context of tool rounds and adds their count and total", () => {
    expect(de(usage({ inputTokens: 9_000, outputTokens: 300, maxInputTokens: 4_321, calls: 3 }))).toBe(
      "4.321 Tokens Kontext · 300 Antwort · 3 Anfragen, zusammen 9.300 Tokens · 3,4 % von 128k Kontext",
    );
  });

  it("marks an estimated window and leaves out an unknown one", () => {
    expect(de(usage({ contextWindow: { tokens: 1_047_576, estimated: true } }))).toBe(
      "1.234 Tokens Kontext · 210 Antwort · 0,1 % von ≈1M Kontext",
    );
    expect(de(usage({ contextWindow: null }))).toBe("1.234 Tokens Kontext · 210 Antwort");
  });

  it("shows answers stored with fewer details, and nothing without reported usage", () => {
    const { maxInputTokens: _, reported: __, contextWindow: ___, ...stored } = usage();
    expect(de(stored)).toBe("1.234 Tokens Kontext · 210 Antwort");
    expect(de({ ...stored, calls: 2 })).toBe("210 Antwort · 2 Anfragen, zusammen 1.444 Tokens");
    expect(de(usage({ reported: false }))).toBeNull();
    expect(de(usage({ inputTokens: 0, outputTokens: 0, maxInputTokens: 0 }))).toBeNull();
  });
});

describe("compactTokens", () => {
  it("shortens window sizes", () => {
    const f = formatter("de");
    expect(compactTokens(f, 128_000)).toBe("128k");
    expect(compactTokens(f, 200_000)).toBe("200k");
    expect(compactTokens(f, 1_500_000)).toBe("1,5M");
    expect(compactTokens(formatter("en"), 1_500_000)).toBe("1.5M");
    expect(compactTokens(f, 800)).toBe("800");
  });
});

describe("AI details setting", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is on for superusers and off for everyone else until the person chooses", () => {
    expect(aiDetailsShown("superuser")).toBe(true);
    expect(aiDetailsShown("familyAdmin")).toBe(false);
    expect(aiDetailsShown("member")).toBe(false);
    setAiDetailsShown(true);
    expect(storage.get(AI_DETAILS_KEY)).toBe("on");
    expect(aiDetailsShown("member")).toBe(true);
    setAiDetailsShown(false);
    expect(aiDetailsShown("superuser")).toBe(false);
  });
});
