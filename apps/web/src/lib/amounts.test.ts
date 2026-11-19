import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES } from "../i18n/locales.ts";
import { amountsHidden, maskAmounts, setAmountsHidden, splitAmounts, subscribeAmounts } from "./amounts.ts";
import { formatter } from "./format.ts";
import { AMOUNTS_KEY, HEAD_SCRIPT } from "./theme.ts";

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

describe("hidden amounts store", () => {
  it("sets the attribute, remembers the choice and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAmounts(listener);
    expect(amountsHidden()).toBe(false);

    setAmountsHidden(true);
    expect(root.dataset.amounts).toBe("hidden");
    expect(storage.get(AMOUNTS_KEY)).toBe("hidden");
    expect(amountsHidden()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setAmountsHidden(false);
    expect("amounts" in root.dataset).toBe(false);
    expect(storage.get(AMOUNTS_KEY)).toBe("shown");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setAmountsHidden(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("still toggles when the browser refuses storage", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    setAmountsHidden(true);
    expect(amountsHidden()).toBe(true);
  });

  it("is applied by the head script before the first paint", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    storage.set(AMOUNTS_KEY, "hidden");
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.amounts).toBe("hidden");

    root.dataset = {};
    storage.set(AMOUNTS_KEY, "shown");
    new Function(HEAD_SCRIPT)();
    expect(root.dataset.amounts).toBeUndefined();
  });

  it("is off on the server", () => {
    vi.unstubAllGlobals();
    expect(amountsHidden()).toBe(false);
  });
});

describe("amounts in free text", () => {
  it("finds every amount the Formatter writes, in every locale and currency", () => {
    for (const locale of LOCALES) {
      const f = formatter(locale);
      for (const amount of [
        f.euro(123_456),
        f.euro(-123_456),
        f.signed(-123_456_789),
        f.signed(500),
        f.euro(4200, "USD"),
        f.euro(4200, "CHF"),
        f.micro(123, "USD"),
      ]) {
        const text = `Am ${f.date("2026-11-03")} ${amount}, 41 Buchungen (12 %).`;
        expect(
          splitAmounts(text).filter((p) => p.money),
          `${locale}: ${amount}`,
        ).toEqual([{ text: amount, money: true }]);
      }
    }
  });

  it("leaves dates, counts, percentages and bank names alone", () => {
    expect(splitAmounts("ING 12,00 € am 01.11.2026, 3 Buchungen, 25 %")).toEqual([
      { text: "ING ", money: false },
      { text: "12,00 €", money: true },
      { text: " am 01.11.2026, 3 Buchungen, 25 %", money: false },
    ]);
    expect(splitAmounts("Keine Beträge")).toEqual([{ text: "Keine Beträge", money: false }]);
  });

  it("masks the amounts of a label", () => {
    expect(maskAmounts("März: Einnahmen 1.234,56 €, Ausgaben −99,00 €", "verborgen")).toBe("März: Einnahmen verborgen, Ausgaben verborgen");
  });
});
