import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDED_KEY, foldedIds, isFolded, setFolded } from "./fold.ts";

let storage: Map<string, string>;
let root: { dataset: Record<string, string | undefined> };

beforeEach(() => {
  storage = new Map();
  root = { dataset: {} };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("foldedIds", () => {
  it("keeps only known ids", () => {
    expect(foldedIds("konten-verlauf  __proto__ konto-verlauf")).toEqual(["konten-verlauf", "konto-verlauf"]);
    expect(foldedIds(null)).toEqual([]);
  });
});

describe("setFolded", () => {
  it("updates the attribute and storage together and drops the attribute when nothing is folded", () => {
    setFolded("konten-verlauf", true);
    setFolded("konten-angefangen", true);
    expect(root.dataset.folded).toBe("konten-verlauf konten-angefangen");
    expect(storage.get(FOLDED_KEY)).toBe("konten-verlauf konten-angefangen");
    expect(isFolded("konten-verlauf")).toBe(true);
    expect(isFolded("konto-verlauf")).toBe(false);

    setFolded("konten-verlauf", false);
    setFolded("konten-angefangen", false);
    expect(root.dataset.folded).toBeUndefined();
    expect(storage.get(FOLDED_KEY)).toBe("");
  });

  it("still folds for the session when the browser refuses storage", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    setFolded("konto-verlauf", true);
    expect(isFolded("konto-verlauf")).toBe(true);
  });
});
