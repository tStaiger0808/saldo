import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n/index.ts";
import {
  adjacentTab,
  ariaKeyshortcuts,
  assign,
  type Bindings,
  capture,
  comboProblem,
  defaultBindings,
  detectMac,
  findConflict,
  formatCombo,
  formatSingle,
  matchShortcut,
  type Overrides,
  parseCombo,
  parseOverrides,
  resolveBindings,
  SHORTCUTS,
  serializeOverrides,
  worksWhileTyping,
} from "./shortcuts.ts";

type Mods = Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>>;
const press = (code: string, key: string, mods: Mods = {}) => ({
  code,
  key,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});
const combo = (text: string) => {
  const parsed = parseCombo(text);
  if (!parsed) throw new Error(text);
  return parsed;
};

const WIN = defaultBindings(false);
const MAC = defaultBindings(true);
const none: Overrides = { combo: {}, single: {} };

describe("display", () => {
  const names = (locale: keyof typeof MESSAGES) => MESSAGES[locale].shortcuts.modifiers;

  it("writes macOS symbols in Apple's order ⌃⌥⇧⌘ without separators", () => {
    expect(formatCombo(combo("Alt+Shift+KeyR"), true, names("de"))).toBe("⌥⇧R");
    expect(formatCombo(combo("Meta+KeyK"), true, names("de"))).toBe("⌘K");
    expect(formatCombo(combo("Control+Alt+Shift+Meta+Digit3"), true, names("en"))).toBe("⌃⌥⇧⌘3");
    expect(formatCombo(combo("Alt+Shift+ArrowRight"), true, names("fr"))).toBe("⌥⇧→");
  });

  it("names the modifiers in the language elsewhere", () => {
    const r = combo("Alt+Shift+KeyR");
    expect(formatCombo(r, false, names("de"))).toBe("Alt+Umschalt+R");
    expect(formatCombo(r, false, names("en"))).toBe("Alt+Shift+R");
    expect(formatCombo(r, false, names("fr"))).toBe("Alt+Maj+R");
    expect(formatCombo(r, false, names("it"))).toBe("Alt+Maiusc+R");
    expect(formatCombo(combo("Control+KeyK"), false, names("de"))).toBe("Strg+K");
    expect(formatCombo(combo("Control+KeyK"), false, names("en"))).toBe("Ctrl+K");
    expect(formatCombo(combo("Alt+Shift+ArrowLeft"), false, names("it"))).toBe("Alt+Maiusc+←");
  });

  it("prints letters as the keyboard layout has them", () => {
    const azerty = new Map([["KeyQ", "a"]]);
    expect(formatCombo(combo("Alt+Shift+KeyQ"), false, names("fr"), azerty)).toBe("Alt+Maj+A");
    expect(formatCombo(combo("Alt+Shift+KeyQ"), true, names("fr"), azerty)).toBe("⌥⇧A");
  });

  it("shows single keys in capitals and keeps signs", () => {
    expect(formatSingle("r")).toBe("R");
    expect(formatSingle("?")).toBe("?");
    expect(formatSingle("ß")).toBe("ß");
  });

  it("describes the keys for aria-keyshortcuts in the standard syntax", () => {
    expect(ariaKeyshortcuts(WIN, "sync", false)).toBe("Alt+Shift+R");
    expect(ariaKeyshortcuts(WIN, "sync", true)).toBe("Alt+Shift+R R");
    expect(ariaKeyshortcuts(WIN, "palette", false)).toBe("Control+K");
    expect(ariaKeyshortcuts(MAC, "palette", false)).toBe("Meta+K");
    expect(ariaKeyshortcuts(MAC, "next-tab", false)).toBe("Alt+Shift+ArrowRight");
    expect(ariaKeyshortcuts(WIN, "help", false)).toBeUndefined();
    expect(ariaKeyshortcuts(WIN, "help", true)).toBe("?");
  });

  it("detects macOS from the platform", () => {
    expect(detectMac("macOS")).toBe(true);
    expect(detectMac("MacIntel")).toBe(true);
    expect(detectMac("iPad")).toBe(true);
    expect(detectMac("Windows")).toBe(false);
    expect(detectMac("Linux x86_64")).toBe(false);
  });
});

describe("matching", () => {
  it("matches combinations by code, whatever Option makes of the key", () => {
    expect(matchShortcut(press("KeyR", "‰", { altKey: true, shiftKey: true }), MAC, false)).toBe("sync");
    expect(matchShortcut(press("KeyN", "Dead", { altKey: true, shiftKey: true }), MAC, false)).toBe("notifications");
    expect(matchShortcut(press("Digit3", "§", { altKey: true, shiftKey: true }), WIN, false)).toBe("go-transactions");
    expect(matchShortcut(press("ArrowRight", "ArrowRight", { altKey: true, shiftKey: true }), WIN, false)).toBe("next-tab");
    expect(matchShortcut(press("KeyR", "®", { altKey: true }), WIN, false)).toBeNull();
    expect(matchShortcut(press("KeyR", "r", { ctrlKey: true }), WIN, false)).toBeNull();
  });

  it("opens the palette with Ctrl+K, or ⌘K on macOS only", () => {
    expect(matchShortcut(press("KeyK", "k", { ctrlKey: true }), WIN, false)).toBe("palette");
    expect(matchShortcut(press("KeyK", "k", { metaKey: true }), MAC, false)).toBe("palette");
    expect(matchShortcut(press("KeyK", "k", { ctrlKey: true }), MAC, false)).toBeNull();
    expect(matchShortcut(press("KeyK", "k", { ctrlKey: true, shiftKey: true }), WIN, false)).toBeNull();
  });

  it("answers single keys only when they are turned on, by the typed character", () => {
    expect(matchShortcut(press("KeyR", "r"), WIN, false)).toBeNull();
    expect(matchShortcut(press("KeyR", "r"), WIN, true)).toBe("sync");
    expect(matchShortcut(press("Minus", "?", { shiftKey: true }), WIN, true)).toBe("help");
    expect(matchShortcut(press("Digit7", "/", { shiftKey: true }), WIN, true)).toBe("palette");
  });

  it("follows changed bindings", () => {
    const bindings = resolveBindings({ combo: { sync: "Control+Shift+KeyE" }, single: { sync: "x" } }, false);
    expect(matchShortcut(press("KeyE", "E", { ctrlKey: true, shiftKey: true }), bindings, false)).toBe("sync");
    expect(matchShortcut(press("KeyR", "R", { altKey: true, shiftKey: true }), bindings, false)).toBeNull();
    expect(matchShortcut(press("KeyX", "x"), bindings, true)).toBe("sync");
  });

  it("lets only Ctrl or ⌘ without Alt through in text fields", () => {
    expect(worksWhileTyping(press("KeyK", "k", { metaKey: true }))).toBe(true);
    expect(worksWhileTyping(press("KeyR", "‰", { altKey: true, shiftKey: true }))).toBe(false);
    expect(worksWhileTyping(press("ArrowLeft", "ArrowLeft", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("walks the tabs in order and wraps around", () => {
    expect(adjacentTab("/", 1)).toBe("/konten");
    expect(adjacentTab("/konten/12", 1)).toBe("/buchungen");
    expect(adjacentTab("/vertraege", 1)).toBe("/");
    expect(adjacentTab("/", -1)).toBe("/vertraege");
    expect(adjacentTab("/analyse", -1)).toBe("/buchungen");
    expect(adjacentTab("/einstellungen/tags", 1)).toBe("/");
    expect(adjacentTab("/persoenlich", -1)).toBe("/vertraege");
  });
});

describe("validation", () => {
  const problem = (text: string, mac = false) => comboProblem(combo(text), mac);

  it("keeps the defaults unique and free on both platforms", () => {
    for (const bindings of [WIN, MAC]) {
      const combos = Object.values(bindings.combo).filter(Boolean);
      expect(new Set(combos).size).toBe(combos.length);
      for (const value of combos) expect(problem(value as string, bindings === MAC)).toBeNull();
    }
    const singles = SHORTCUTS.flatMap((s) => (s.single ? [s.single] : []));
    expect(new Set(singles).size).toBe(singles.length);
  });

  it("refuses what the browser keeps", () => {
    for (const text of ["Control+KeyW", "Control+KeyT", "Control+KeyN", "Control+KeyR", "Control+KeyL", "Control+Digit1", "Control+Tab"]) {
      expect(problem(text), text).toBe("browser");
    }
    for (const text of ["Meta+KeyW", "Meta+KeyT", "Meta+KeyQ", "Meta+KeyL", "Meta+Digit9", "Control+Tab", "Meta+Shift+KeyT"]) {
      expect(problem(text, true), text).toBe("browser");
    }
    expect(problem("F5")).toBe("browser");
    expect(problem("Shift+F5")).toBe("browser");
    expect(problem("Alt+KeyF")).toBe("browser");
    expect(problem("Alt+ArrowLeft")).toBe("browser");
  });

  it("refuses text editing, system and screen reader keys", () => {
    expect(problem("Control+KeyC")).toBe("editing");
    expect(problem("Meta+Shift+KeyZ", true)).toBe("editing");
    expect(problem("Meta+Space", true)).toBe("system");
    expect(problem("Meta+Tab", true)).toBe("system");
    expect(problem("Meta+KeyH", true)).toBe("system");
    expect(problem("Control+ArrowRight", true)).toBe("system");
    expect(problem("Meta+KeyE")).toBe("system");
    expect(problem("Alt+Tab")).toBe("system");
    expect(problem("Control+Alt+ArrowRight", true)).toBe("screenReader");
    expect(problem("Control+Alt+KeyQ")).toBe("altGr");
  });

  it("refuses page keys and keys without a modifier in the combination slot", () => {
    expect(problem("Tab")).toBe("page");
    expect(problem("Enter")).toBe("page");
    expect(problem("Escape")).toBe("page");
    expect(problem("Space")).toBe("page");
    expect(problem("KeyR")).toBe("needsModifier");
    expect(problem("Shift+KeyR")).toBe("needsModifier");
    expect(problem("Alt+Shift+Minus")).toBe("unsupported");
  });

  it("allows other combinations, also ⌃ letters on macOS", () => {
    expect(problem("Control+Shift+KeyE")).toBeNull();
    expect(problem("Alt+Shift+F2")).toBeNull();
    expect(problem("Control+KeyW", true)).toBeNull();
    expect(problem("Meta+KeyK", true)).toBeNull();
  });

  it("reads a recorded key press per slot", () => {
    expect(capture(press("KeyE", "E", { ctrlKey: true, shiftKey: true }), "combo", false)).toMatchObject({
      kind: "ok",
      value: "Control+Shift+KeyE",
    });
    expect(capture(press("KeyE", "´", { altKey: true, shiftKey: true }), "combo", true)).toMatchObject({
      kind: "ok",
      value: "Alt+Shift+KeyE",
    });
    expect(capture(press("KeyW", "w", { metaKey: true }), "combo", true)).toMatchObject({ kind: "problem", problem: "browser" });
    expect(capture(press("KeyX", "x"), "combo", false)).toMatchObject({ kind: "problem", problem: "needsModifier" });
    expect(capture(press("KeyX", "x"), "single", false)).toMatchObject({ kind: "ok", value: "x" });
    expect(capture(press("Minus", "?", { shiftKey: true }), "single", false)).toMatchObject({ kind: "ok", value: "?" });
    expect(capture(press("KeyX", "x", { altKey: true }), "single", false)).toMatchObject({ kind: "problem", problem: "singleOnly" });
    expect(capture(press("Space", " "), "single", false)).toMatchObject({ kind: "problem", problem: "page" });
    expect(capture(press("Enter", "Enter"), "single", false)).toMatchObject({ kind: "problem", problem: "page" });
    expect(capture(press("F2", "F2"), "single", false)).toMatchObject({ kind: "problem", problem: "unsupported" });
    expect(capture(press("Escape", "Escape"), "combo", false).kind).toBe("cancel");
    expect(capture(press("Backspace", "Backspace"), "combo", false).kind).toBe("clear");
    expect(capture(press("Delete", "Delete"), "single", false).kind).toBe("clear");
    expect(capture(press("Tab", "Tab", { shiftKey: true }), "combo", false).kind).toBe("move");
    expect(capture(press("AltLeft", "Alt", { altKey: true }), "combo", false).kind).toBe("ignore");
  });
});

describe("bindings and storage", () => {
  const store = (data: unknown) => (typeof data === "string" ? data : JSON.stringify(data));

  it("falls back to the defaults for missing, broken or unknown entries", () => {
    expect(resolveBindings(parseOverrides(null), false)).toEqual(WIN);
    expect(resolveBindings(parseOverrides("{not json"), false)).toEqual(WIN);
    expect(resolveBindings(parseOverrides(store({ v: 99, combo: { sync: "Control+Shift+KeyE" } })), false)).toEqual(WIN);
    expect(resolveBindings(parseOverrides(store(["Control+KeyE"])), false)).toEqual(WIN);
    const odd = parseOverrides(store({ v: 1, combo: { gone: "Control+Shift+KeyE", sync: 7 }, single: "x" }));
    expect(odd).toEqual(none);
  });

  it("keeps valid changes and drops values that are no longer allowed", () => {
    const overrides = parseOverrides(
      store({
        v: 1,
        combo: { sync: "Control+Shift+KeyE", chat: "Control+KeyW", tasks: "Shift+Alt+KeyE" },
        single: { sync: "XY", tasks: "x" },
      }),
    );
    const bindings = resolveBindings(overrides, false);
    expect(bindings.combo.sync).toBe("Control+Shift+KeyE");
    expect(bindings.combo.chat).toBe(WIN.combo.chat);
    expect(bindings.combo.tasks).toBe(WIN.combo.tasks);
    expect(bindings.single.sync).toBe("r");
    expect(bindings.single.tasks).toBe("x");
  });

  it("never lets two actions share keys: a change wins over a default", () => {
    const bindings = resolveBindings({ combo: { chat: "Alt+Shift+KeyR", tasks: "Alt+Shift+KeyR" }, single: {} }, false);
    expect(bindings.combo.chat).toBe("Alt+Shift+KeyR");
    expect(bindings.combo.sync).toBeNull();
    expect(bindings.combo.tasks).toBe(WIN.combo.tasks);
  });

  it("stores only what differs from the defaults, versioned", () => {
    expect(serializeOverrides(none)).toBeNull();
    const changed = assign(none, false, "combo", "sync", "Control+Shift+KeyE");
    expect(JSON.parse(serializeOverrides(changed) ?? "")).toEqual({ v: 1, combo: { sync: "Control+Shift+KeyE" }, single: {} });
    expect(assign(changed, false, "combo", "sync", "Alt+Shift+KeyR")).toEqual(none);
    expect(assign(none, false, "single", "sync", null)).toEqual({ combo: {}, single: { sync: null } });
  });

  it("finds conflicts and swaps the keys", () => {
    expect(findConflict(WIN, "combo", "Alt+Shift+KeyR", "chat")).toBe("sync");
    expect(findConflict(WIN, "combo", "Alt+Shift+KeyR", "sync")).toBeNull();
    const swapped: Bindings = resolveBindings(assign(none, false, "combo", "chat", "Alt+Shift+KeyR", "sync"), false);
    expect(swapped.combo.chat).toBe("Alt+Shift+KeyR");
    expect(swapped.combo.sync).toBe("Alt+Shift+KeyC");
    const back = resolveBindings(
      assign(assign(none, false, "combo", "chat", "Alt+Shift+KeyR", "sync"), false, "combo", "chat", "Alt+Shift+KeyC", "sync"),
      false,
    );
    expect(back).toEqual(WIN);
  });

  it("resolves Mod per platform", () => {
    expect(WIN.combo.palette).toBe("Control+KeyK");
    expect(MAC.combo.palette).toBe("Meta+KeyK");
    expect(MAC.combo.sync).toBe("Alt+Shift+KeyR");
  });
});
