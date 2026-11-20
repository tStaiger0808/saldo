import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDED_KEY } from "./fold.ts";
import { DEFAULT_THEME, HEAD_SCRIPT, RENAMED_THEMES, readTheme, THEME_KEY, THEMES, themeFor } from "./theme.ts";

let storage: Map<string, string>;
let root: { dataset: Record<string, string | undefined> };

beforeEach(() => {
  storage = new Map();
  root = { dataset: {} };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const RENAMES = [
  ["quest", "leinen"],
  ["wald", "tanne"],
  ["ozean", "fjord"],
  ["pflaume", "holunder"],
  ["graphit", "schiefer"],
] as const;

describe("themeFor", () => {
  it("keeps current ids", () => {
    for (const { id } of THEMES) expect(themeFor(id)).toBe(id);
  });

  it("maps every renamed id to its new one", () => {
    for (const [old, renamed] of RENAMES) expect(themeFor(old)).toBe(renamed);
    expect(Object.keys(RENAMED_THEMES)).toHaveLength(RENAMES.length);
  });

  it("falls back to Leinen for nothing or unknown values", () => {
    expect(DEFAULT_THEME).toBe("leinen");
    for (const value of [null, "", "nacht", "toString", "__proto__", "LEINEN"]) expect(themeFor(value)).toBe("leinen");
  });

  it("is what the picker reads", () => {
    storage.set(THEME_KEY, "pflaume");
    expect(readTheme()).toBe("holunder");
  });
});

describe("head script", () => {
  it("applies a renamed theme and stores the new id once", () => {
    for (const [old, renamed] of RENAMES) {
      storage.set(THEME_KEY, old);
      new Function(HEAD_SCRIPT)();
      expect(root.dataset.theme).toBe(renamed);
      expect(storage.get(THEME_KEY)).toBe(renamed);
    }
  });

  it("applies current ids as they are and leaves unknown values to the default", () => {
    storage.set(THEME_KEY, "leinen-nacht");
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.theme).toBe("leinen-nacht");

    for (const value of ["nacht", "constructor"]) {
      storage.set(THEME_KEY, value);
      new Function(HEAD_SCRIPT)();
      expect(root.dataset.theme).toBe("leinen");
      expect(storage.get(THEME_KEY)).toBe(value);
    }

    storage.clear();
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.theme).toBe("leinen");
    expect(storage.has(THEME_KEY)).toBe(false);
  });

  it("still applies the new id when the browser refuses storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "graphit",
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.theme).toBe("schiefer");
  });

  it("marks the folded sections it knows and leaves the attribute out without any", () => {
    storage.set(FOLDED_KEY, "konto-verlauf toString konten-angefangen");
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.folded).toBe("konto-verlauf konten-angefangen");

    root.dataset = {};
    storage.set(FOLDED_KEY, "");
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.folded).toBeUndefined();
  });
});
