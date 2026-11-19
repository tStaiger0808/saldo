import { useSyncExternalStore } from "react";

/**
 * Keyboard shortcuts of the signed-in app. Every action has a combination with Ctrl, Alt (⌥) or ⌘ and a single key;
 * both can be changed per browser. Combinations match by `KeyboardEvent.code`, because Option changes `key` on macOS
 * (and starts dead keys), and are written like `aria-keyshortcuts` with codes: "Alt+Shift+KeyR". The defaults use
 * Alt+Shift: plain Alt opens browser menus on Windows and Linux and switches tabs on Linux. Their letters avoid A, Q,
 * W, Z, Y and M, which move between QWERTY, QWERTZ and AZERTY, and T, B, I, D, which Chrome or Firefox use with
 * Alt+Shift. The search palette answers Ctrl+K, or ⌘K on macOS, where Ctrl+K deletes to the end of the line.
 *
 * Single-key shortcuts (WCAG 2.1.4) are off until the person turns them on for this browser; they match by `key`,
 * so they follow the keyboard layout.
 */
export type ShortcutId =
  | "palette"
  | "help"
  | "sync"
  | "go-overview"
  | "go-accounts"
  | "go-transactions"
  | "go-analysis"
  | "go-contracts"
  | "go-settings"
  | "next-tab"
  | "prev-tab"
  | "chat"
  | "tasks"
  | "notifications"
  | "amounts"
  | "search"
  | "filter";

export type ShortcutGroup = "general" | "pages" | "bookings";

/** Every shortcut has two slots: the combination with a modifier and the single key. */
export type Slot = "combo" | "single";

/** `Mod` in `combo` is Ctrl, or ⌘ on macOS. */
export type Shortcut = { id: ShortcutId; group: ShortcutGroup; combo: string | null; single: string | null };

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", group: "general", combo: "Mod+KeyK", single: "/" },
  { id: "help", group: "general", combo: null, single: "?" },
  { id: "sync", group: "general", combo: "Alt+Shift+KeyR", single: "r" },
  { id: "chat", group: "general", combo: "Alt+Shift+KeyC", single: "c" },
  { id: "tasks", group: "general", combo: "Alt+Shift+KeyJ", single: "j" },
  { id: "notifications", group: "general", combo: "Alt+Shift+KeyN", single: "n" },
  { id: "amounts", group: "general", combo: "Alt+Shift+KeyH", single: "h" },
  { id: "go-overview", group: "pages", combo: "Alt+Shift+Digit1", single: "1" },
  { id: "go-accounts", group: "pages", combo: "Alt+Shift+Digit2", single: "2" },
  { id: "go-transactions", group: "pages", combo: "Alt+Shift+Digit3", single: "3" },
  { id: "go-analysis", group: "pages", combo: "Alt+Shift+Digit4", single: "4" },
  { id: "go-contracts", group: "pages", combo: "Alt+Shift+Digit5", single: "5" },
  { id: "go-settings", group: "pages", combo: "Alt+Shift+Digit6", single: "6" },
  { id: "next-tab", group: "pages", combo: "Alt+Shift+ArrowRight", single: null },
  { id: "prev-tab", group: "pages", combo: "Alt+Shift+ArrowLeft", single: null },
  { id: "search", group: "bookings", combo: "Alt+Shift+KeyS", single: "s" },
  { id: "filter", group: "bookings", combo: "Alt+Shift+KeyF", single: "f" },
];

const IDS = new Set<string>(SHORTCUTS.map((s) => s.id));
const SLOTS = ["combo", "single"] as const;

/** The top-bar tabs in their order, for "next tab" and "previous tab". */
export const TAB_PATHS = ["/", "/konten", "/buchungen", "/analyse", "/vertraege"] as const;
export type TabPath = (typeof TAB_PATHS)[number];

/** The tab `step` away from the one `pathname` belongs to, wrapping around; from any other page the first or last. */
export function adjacentTab(pathname: string, step: 1 | -1): TabPath {
  const index = TAB_PATHS.findIndex((p) => (p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(`${p}/`)));
  const count = TAB_PATHS.length;
  const next = index < 0 ? (step === 1 ? 0 : count - 1) : (index + step + count) % count;
  return TAB_PATHS[next] ?? TAB_PATHS[0];
}

type Modifier = "ctrl" | "alt" | "shift" | "meta";
export type Combo = Record<Modifier, boolean> & { code: string };

/** Also Apple's order ⌃⌥⇧⌘. */
const MODIFIERS: readonly [Modifier, string][] = [
  ["ctrl", "Control"],
  ["alt", "Alt"],
  ["shift", "Shift"],
  ["meta", "Meta"],
];

/** Keys a combination may end in: letters and digits are named by the layout map, the rest sit in the same place everywhere. */
const BINDABLE = /^(Key[A-Z]|Digit\d|Arrow(Left|Right|Up|Down)|F([1-9]|1[0-2]))$/;

type KeyInfo = Pick<KeyboardEvent, "code" | "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">;

export function comboOf(event: KeyInfo): Combo {
  return { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, code: event.code };
}

/** "Control+Alt+Shift+Meta+Code", in this order. */
export function comboString(combo: Combo): string {
  return [...MODIFIERS.filter(([m]) => combo[m]).map(([, name]) => name), combo.code].join("+");
}

/** Reads "Alt+Shift+KeyR"; `Mod` stands for ⌘ on macOS and Ctrl elsewhere. */
export function parseCombo(text: string, mac = false): Combo | null {
  const parts = text.split("+");
  const code = parts.pop();
  if (!code) return null;
  const combo: Combo = { ctrl: false, alt: false, shift: false, meta: false, code };
  for (const part of parts) {
    const modifier = part === "Mod" ? (mac ? "meta" : "ctrl") : MODIFIERS.find(([, name]) => name === part)?.[0];
    if (!modifier || combo[modifier]) return null;
    combo[modifier] = true;
  }
  return combo;
}

export type Problem = "page" | "browser" | "editing" | "system" | "screenReader" | "altGr" | "needsModifier" | "singleOnly" | "unsupported";

const PAGE_KEYS = new Set(["Tab", "Enter", "NumpadEnter", "Escape", "Space"]);
const EDITING_LETTERS = "ACVXYZ";
const BROWSER_LETTERS = "WTNQRLFGPSOHJDU";
const EDITING_SHIFT_LETTERS = "VZ";
const BROWSER_SHIFT_LETTERS = "TNWQRBOIJCAMDGPSY";
const DEVTOOLS_LETTERS = "IJCU";

const has = (letters: string, letter: string) => letter !== "" && letters.includes(letter);

/** Why the page, the browser or the system keeps a combination for itself, or null if it is free. */
export function reservedProblem(combo: Combo, mac: boolean): Problem | null {
  const { ctrl, alt, shift, meta, code } = combo;
  if (!ctrl && !alt && !meta && PAGE_KEYS.has(code)) return "page";
  if (code === "F5" || code === "F11" || code === "F12") return "browser";
  const letter = /^Key([A-Z])$/.exec(code)?.[1] ?? "";
  const digit = code.startsWith("Digit");
  const arrow = code.startsWith("Arrow");
  if (mac) {
    // ⌃⌥ is the VoiceOver modifier.
    if (ctrl && alt) return "screenReader";
    if (code === "Tab") return meta ? "system" : ctrl ? "browser" : null;
    if ((meta || ctrl) && code === "Space") return "system";
    if (ctrl && arrow) return "system";
    if (meta && ctrl && has("QF", letter)) return "system";
    if (meta && !ctrl && has("HM", letter)) return "system";
    if (meta && shift && /^Digit[3-6]$/.test(code)) return "system";
    if (meta && alt && has(DEVTOOLS_LETTERS, letter)) return "browser";
    if (meta && !ctrl && !alt && arrow) return "browser";
  } else {
    if (meta) return "system";
    if (ctrl && alt) return "altGr";
    if (alt && (code === "Tab" || code === "Space" || code === "F4")) return "system";
    if (ctrl && code === "Tab") return "browser";
    if (alt && !ctrl && !shift && (letter || digit || code === "ArrowLeft" || code === "ArrowRight" || code === "Home")) return "browser";
  }
  const mod = mac ? meta && !ctrl : ctrl && !meta;
  if (!mod || alt) return null;
  if (digit || code === "Tab") return "browser";
  if (shift) return has(EDITING_SHIFT_LETTERS, letter) ? "editing" : has(BROWSER_SHIFT_LETTERS, letter) ? "browser" : null;
  return has(EDITING_LETTERS, letter) ? "editing" : has(BROWSER_LETTERS, letter) ? "browser" : null;
}

/** What keeps `combo` from being a shortcut combination, or null. */
export function comboProblem(combo: Combo, mac: boolean): Problem | null {
  const reserved = reservedProblem(combo, mac);
  if (reserved) return reserved;
  if (!combo.ctrl && !combo.alt && !combo.meta) return "needsModifier";
  return BINDABLE.test(combo.code) ? null : "unsupported";
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "FnLock", "OS", "Hyper", "Super"]);

export type Capture =
  | { kind: "ignore" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "move" }
  | { kind: "problem"; problem: Problem; pressed: Combo }
  | { kind: "ok"; value: string; pressed: Combo };

/**
 * Reads a key press while the person records new keys for `slot`. Esc cancels, Backspace or Delete clears, Tab keeps
 * moving the focus, and a lone modifier waits for the key that completes the combination.
 */
export function capture(event: KeyInfo & { isComposing?: boolean }, slot: Slot, mac: boolean): Capture {
  if (event.isComposing || event.key === "Process" || MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  const pressed = comboOf(event);
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (plain && !event.shiftKey && event.key === "Escape") return { kind: "cancel" };
  if (plain && !event.shiftKey && (event.key === "Backspace" || event.key === "Delete")) return { kind: "clear" };
  if (plain && event.code === "Tab") return { kind: "move" };
  if (slot === "combo") {
    const problem = comboProblem(pressed, mac);
    return problem ? { kind: "problem", problem, pressed } : { kind: "ok", value: comboString(pressed), pressed };
  }
  if (!plain) return { kind: "problem", problem: "singleOnly", pressed };
  if (PAGE_KEYS.has(event.code)) return { kind: "problem", problem: "page", pressed };
  if (event.key.length !== 1 || !event.key.trim()) return { kind: "problem", problem: "unsupported", pressed };
  return { kind: "ok", value: event.key.toLowerCase(), pressed };
}

export type Bindings = Record<Slot, Record<ShortcutId, string | null>>;
export type Overrides = Record<Slot, Partial<Record<ShortcutId, string | null>>>;

const STORAGE_VERSION = 1;

function validValue(slot: Slot, value: string, mac: boolean): boolean {
  if (slot === "single") return value.length === 1 && value.trim() !== "" && value === value.toLowerCase();
  const combo = parseCombo(value);
  return combo !== null && comboString(combo) === value && comboProblem(combo, mac) === null;
}

export function defaultBindings(mac: boolean): Bindings {
  const combo = {} as Record<ShortcutId, string | null>;
  const single = {} as Record<ShortcutId, string | null>;
  for (const s of SHORTCUTS) {
    const parsed = s.combo ? parseCombo(s.combo, mac) : null;
    combo[s.id] = parsed && comboString(parsed);
    single[s.id] = s.single;
  }
  return { combo, single };
}

/**
 * The bindings in effect: the person's changes over the defaults. A stored value that no longer fits (a key that is
 * now reserved, a duplicate) falls back to the default, and a default another action took over stays empty, so no
 * two actions ever share keys.
 */
export function resolveBindings(overrides: Overrides, mac: boolean): Bindings {
  const defaults = defaultBindings(mac);
  const result = defaultBindings(mac);
  for (const slot of SLOTS) {
    const used = new Set<string>();
    const settled = new Set<ShortcutId>();
    for (const { id } of SHORTCUTS) {
      if (!Object.hasOwn(overrides[slot], id)) continue;
      const value = overrides[slot][id];
      if (value === null) {
        result[slot][id] = null;
        settled.add(id);
      } else if (typeof value === "string" && validValue(slot, value, mac) && !used.has(value)) {
        result[slot][id] = value;
        used.add(value);
        settled.add(id);
      }
    }
    for (const { id } of SHORTCUTS) {
      if (settled.has(id)) continue;
      const value = defaults[slot][id];
      result[slot][id] = value && !used.has(value) ? value : null;
      if (value) used.add(value);
    }
  }
  return result;
}

/** Reads the stored changes; whatever it does not understand is dropped, so an old or broken entry means the defaults. */
export function parseOverrides(raw: string | null): Overrides {
  const result: Overrides = { combo: {}, single: {} };
  if (!raw) return result;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== STORAGE_VERSION) return result;
  for (const slot of SLOTS) {
    const entries = (data as Record<string, unknown>)[slot];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [id, value] of Object.entries(entries)) {
      if (IDS.has(id) && (value === null || typeof value === "string")) result[slot][id as ShortcutId] = value;
    }
  }
  return result;
}

export function serializeOverrides(overrides: Overrides): string | null {
  if (Object.keys(overrides.combo).length === 0 && Object.keys(overrides.single).length === 0) return null;
  return JSON.stringify({ v: STORAGE_VERSION, combo: overrides.combo, single: overrides.single });
}

/** The other action that already has `value` in `slot`, or null. */
export function findConflict(bindings: Bindings, slot: Slot, value: string, id: ShortcutId): ShortcutId | null {
  return SHORTCUTS.find((s) => s.id !== id && bindings[slot][s.id] === value)?.id ?? null;
}

/**
 * The changes after giving `id` the keys `value` in `slot`; with `swapWith`, that action takes over the keys `id`
 * had. Keys equal to the default are not stored.
 */
export function assign(
  overrides: Overrides,
  mac: boolean,
  slot: Slot,
  id: ShortcutId,
  value: string | null,
  swapWith?: ShortcutId,
): Overrides {
  const current = resolveBindings(overrides, mac);
  const defaults = defaultBindings(mac);
  const next: Overrides = { combo: { ...overrides.combo }, single: { ...overrides.single } };
  const put = (target: ShortcutId, keys: string | null) => {
    if (keys === defaults[slot][target]) delete next[slot][target];
    else next[slot][target] = keys;
  };
  if (swapWith) put(swapWith, current[slot][id]);
  put(id, value);
  return next;
}

export function matchShortcut(event: KeyInfo, bindings: Bindings, singleKeys: boolean): ShortcutId | null {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    const combo = comboString(comboOf(event));
    return SHORTCUTS.find((s) => bindings.combo[s.id] === combo)?.id ?? null;
  }
  if (!singleKeys) return null;
  const key = event.key.toLowerCase();
  return SHORTCUTS.find((s) => bindings.single[s.id] === key)?.id ?? null;
}

/** Ctrl or ⌘ without Alt also works in a text field, except with arrows; Alt there types characters. */
export function worksWhileTyping(event: KeyInfo): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.code.startsWith("Arrow");
}

const TEXT_ENTRY =
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), select, textarea, [contenteditable]:not([contenteditable="false"])';

/** Keys pressed while typing belong to the field. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY) !== null;
}

export type ModifierNames = Record<Modifier, string>;
export type KeyLayout = ReadonlyMap<string, string>;

const MAC_SYMBOLS: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const ARROWS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** The key as printed on the keyboard: KeyQ is "A" on AZERTY when the browser tells the layout. */
export function keyName(code: string, layout?: KeyLayout | null): string {
  if (ARROWS[code]) return ARROWS[code];
  const printed = layout?.get(code);
  if (printed?.length === 1 && /^(Key|Digit)/.test(code)) return printed.toUpperCase();
  return code.replace(/^(Key|Digit)/, "");
}

/** "⌥⇧R" on macOS, "Alt+Umschalt+R" elsewhere. */
export function formatCombo(combo: Combo, mac: boolean, names: ModifierNames, layout?: KeyLayout | null): string {
  const modifiers = MODIFIERS.filter(([m]) => combo[m]).map(([m]) => (mac ? MAC_SYMBOLS[m] : names[m]));
  return [...modifiers, keyName(combo.code, layout)].join(mac ? "" : "+");
}

export function formatSingle(key: string): string {
  const upper = key.toUpperCase();
  return upper.length === 1 ? upper : key;
}

/** Value for `aria-keyshortcuts`: the combination and, while single keys are on, the single key. */
export function ariaKeyshortcuts(bindings: Bindings, id: ShortcutId, singleKeys: boolean, layout?: KeyLayout | null): string | undefined {
  const combo = bindings.combo[id] ? parseCombo(bindings.combo[id]) : null;
  const key = combo && (combo.code.startsWith("Arrow") ? combo.code : keyName(combo.code, layout));
  const single = singleKeys ? bindings.single[id] : null;
  const keys = [combo && [...MODIFIERS.filter(([m]) => combo[m]).map(([, name]) => name), key].join("+"), single && formatSingle(single)];
  return keys.filter(Boolean).join(" ") || undefined;
}

export const SINGLE_KEYS_KEY = "fw-einzeltasten";
export const BINDINGS_KEY = "fw-tastenkuerzel";

export function detectMac(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectMac(nav.userAgentData?.platform || nav.platform || "");
}

const listeners = new Set<() => void>();
// Private mode has no storage: choices then last until the next reload.
const memory = new Map<string, string | null>();

function notify() {
  for (const listener of listeners) listener();
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null): void {
  memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // See `memory`.
  }
  notify();
}

export function setSingleKeysEnabled(enabled: boolean): void {
  write(SINGLE_KEYS_KEY, enabled ? "on" : "off");
}

export function setBinding(slot: Slot, id: ShortcutId, value: string | null, swapWith?: ShortcutId): void {
  write(BINDINGS_KEY, serializeOverrides(assign(parseOverrides(read(BINDINGS_KEY)), isMac(), slot, id, value, swapWith)));
}

export function resetAllBindings(): void {
  write(BINDINGS_KEY, null);
}

let layout: KeyLayout | null = null;
let layoutRequested = false;

/** Asks Chromium once for the printed keys of the keyboard layout; other browsers keep the US names. */
function requestLayout() {
  if (layoutRequested || typeof navigator === "undefined") return;
  layoutRequested = true;
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<KeyLayout> } }).keyboard;
  keyboard?.getLayoutMap?.().then(
    (map) => {
      layout = map;
      notify();
    },
    () => undefined,
  );
}

export type KeyboardState = { mac: boolean; singleKeys: boolean; bindings: Bindings; defaults: Bindings; layout: KeyLayout | null };

const SERVER_STATE: KeyboardState = {
  mac: false,
  singleKeys: false,
  bindings: defaultBindings(false),
  defaults: defaultBindings(false),
  layout: null,
};

let cached: { raw: string | null; singleKeys: boolean; mac: boolean; layout: KeyLayout | null; state: KeyboardState } | null = null;

function clientState(): KeyboardState {
  const raw = read(BINDINGS_KEY);
  const singleKeys = read(SINGLE_KEYS_KEY) === "on";
  const mac = isMac();
  if (cached?.raw !== raw || cached.singleKeys !== singleKeys || cached.mac !== mac || cached.layout !== layout) {
    const state = { mac, singleKeys, bindings: resolveBindings(parseOverrides(raw), mac), defaults: defaultBindings(mac), layout };
    cached = { raw, singleKeys, mac, layout, state };
  }
  return cached.state;
}

function subscribe(listener: () => void): () => void {
  requestLayout();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The platform, the bindings and the single-key switch of this browser; the server renders the defaults. */
export function useKeyboard(): KeyboardState {
  return useSyncExternalStore(subscribe, clientState, () => SERVER_STATE);
}
