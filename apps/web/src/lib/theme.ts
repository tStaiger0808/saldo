import { FOLDED_KEY, FOLDS } from "./fold.ts";

/**
 * Colour theme, light/dark mode, hidden amounts and folded sections live only in the browser (localStorage). `<html>`
 * carries them as data-theme, data-mode, data-amounts and data-folded; the inline script applies them before the first paint.
 */
// The ids are stored in browsers, so they stay German; labels live under `themes.*` in the messages.
export const THEMES = [
  { id: "leinen" },
  { id: "leinen-nacht" },
  { id: "tanne" },
  { id: "fjord" },
  { id: "holunder" },
  { id: "schiefer" },
] as const;

export const MODES = [{ id: "hell" }, { id: "dunkel" }, { id: "system" }] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ModeId = (typeof MODES)[number]["id"];

export const THEME_KEY = "fw-theme";
export const MODE_KEY = "fw-modus";
export const AMOUNTS_KEY = "fw-privat";
export const DEFAULT_THEME: ThemeId = "leinen";
export const DEFAULT_MODE: ModeId = "system";

/** Earlier theme ids that browsers may still have stored, with the theme each became. */
export const RENAMED_THEMES: Readonly<Record<string, ThemeId>> = {
  quest: "leinen",
  wald: "tanne",
  ozean: "fjord",
  pflaume: "holunder",
  graphit: "schiefer",
};

/** The theme a stored value stands for: a current id, the new id of a renamed one, otherwise the default. */
export function themeFor(value: string | null): ThemeId {
  const current = THEMES.find((t) => t.id === value)?.id;
  if (current) return current;
  return value !== null && Object.hasOwn(RENAMED_THEMES, value) ? (RENAMED_THEMES[value] as ThemeId) : DEFAULT_THEME;
}

export const HEAD_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");
function get(k){try{return localStorage.getItem(k)}catch(e){return null}}
function apply(){var t=get(${JSON.stringify(THEME_KEY)}),mo=get(${JSON.stringify(MODE_KEY)}),r=${JSON.stringify(RENAMED_THEMES)};
if(t&&Object.prototype.hasOwnProperty.call(r,t)){t=r[t];try{localStorage.setItem(${JSON.stringify(THEME_KEY)},t)}catch(e){}}
d.dataset.theme=${JSON.stringify(THEMES.map((t) => t.id))}.indexOf(t)>=0?t:${JSON.stringify(DEFAULT_THEME)};
if(${JSON.stringify(MODES.map((x) => x.id))}.indexOf(mo)<0)mo=${JSON.stringify(DEFAULT_MODE)};
d.dataset.mode=mo==="dunkel"||(mo==="system"&&m&&m.matches)?"dark":"light";}
apply();if(get(${JSON.stringify(AMOUNTS_KEY)})==="hidden")d.dataset.amounts="hidden";
var f=(get(${JSON.stringify(FOLDED_KEY)})||"").split(" ").filter(function(x){return ${JSON.stringify(FOLDS)}.indexOf(x)>=0}).join(" ");if(f)d.dataset.folded=f;if(m&&m.addEventListener)m.addEventListener("change",apply);window.__fwApply=apply})();`;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts until the next reload.
  }
}

export function readTheme(): ThemeId {
  return themeFor(stored(THEME_KEY));
}

export function readMode(): ModeId {
  const value = stored(MODE_KEY);
  return MODES.find((m) => m.id === value)?.id ?? DEFAULT_MODE;
}

const listeners = new Set<() => void>();

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyAll(): void {
  const apply = (window as { __fwApply?: () => void }).__fwApply;
  apply?.();
  for (const listener of listeners) listener();
}

export function saveTheme(theme: ThemeId): void {
  store(THEME_KEY, theme);
  applyAll();
}

export function saveMode(mode: ModeId): void {
  store(MODE_KEY, mode);
  applyAll();
}
