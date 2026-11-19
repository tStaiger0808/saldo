import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n/index.ts";
import { useT } from "../i18n/react.tsx";
import {
  ariaKeyshortcuts,
  type Combo,
  formatCombo,
  formatSingle,
  isTyping,
  type ModifierNames,
  matchShortcut,
  parseCombo,
  SHORTCUTS,
  type ShortcutGroup,
  type ShortcutId,
  useKeyboard,
  worksWhileTyping,
} from "../lib/shortcuts.ts";
import { FormDialog, isDialogOpen } from "./Dialog.tsx";

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type Action = { current: () => void };
const registered = new Map<ShortcutId, Action[]>();
const available = store<ReadonlySet<ShortcutId>>(new Set());
const overview = store(false);
const NONE: ReadonlySet<ShortcutId> = new Set();

function register(id: ShortcutId, action: Action): () => void {
  registered.set(id, [...(registered.get(id) ?? []), action]);
  available.set(new Set(registered.keys()));
  return () => {
    const rest = (registered.get(id) ?? []).filter((a) => a !== action);
    if (rest.length > 0) registered.set(id, rest);
    else registered.delete(id);
    available.set(new Set(registered.keys()));
  };
}

/** The shortcuts that work right now: those of the page and those the person may use. */
export function useAvailableShortcuts(): ReadonlySet<ShortcutId> {
  return useSyncExternalStore(available.subscribe, available.get, () => NONE);
}

/** Runs what the shortcut `id` would run, e.g. from the search palette. */
export function runShortcut(id: ShortcutId): void {
  registered.get(id)?.at(-1)?.current();
}

/**
 * Runs `action` on the keys bound to `id` while `enabled`; never while a modal dialog is open, and while typing in a
 * field only for Ctrl or ⌘ combinations. The overview and the search palette list the shortcuts registered here.
 */
export function useShortcut(id: ShortcutId, action: () => void, enabled = true) {
  const { bindings, singleKeys } = useKeyboard();
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!enabled) return;
    const release = register(id, latest);
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (matchShortcut(event, bindings, singleKeys) !== id || isDialogOpen()) return;
      if (isTyping(event.target) && !worksWhileTyping(event)) return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      release();
    };
  }, [id, enabled, bindings, singleKeys]);
}

/** Formats keys for this platform and language: "⌥⇧R" on macOS, "Alt+Umschalt+R" elsewhere. */
export function useKeyText() {
  const t = useT();
  const keyboard = useKeyboard();
  return useMemo(() => {
    const names: ModifierNames = {
      ctrl: t("shortcuts.modifiers.ctrl"),
      alt: t("shortcuts.modifiers.alt"),
      shift: t("shortcuts.modifiers.shift"),
      meta: t("shortcuts.modifiers.meta"),
    };
    const pressed = (combo: Combo) => formatCombo(combo, keyboard.mac, names, keyboard.layout);
    const combo = (value: string | null) => {
      const parsed = value ? parseCombo(value) : null;
      return parsed ? pressed(parsed) : null;
    };
    const single = (value: string | null) => (value ? formatSingle(value) : null);
    return {
      keyboard,
      pressed,
      combo,
      single,
      comboOf: (id: ShortcutId) => combo(keyboard.bindings.combo[id]),
      singleOf: (id: ShortcutId) => single(keyboard.bindings.single[id]),
    };
  }, [t, keyboard]);
}

/** The keys of a shortcut for tooltips (`title(label)`) and `aria-keyshortcuts` (`aria`). */
export function useShortcutHint(id: ShortcutId) {
  const t = useT();
  const { keyboard, comboOf, singleOf } = useKeyText();
  const keys = [comboOf(id), keyboard.singleKeys ? singleOf(id) : null]
    .filter((k): k is string => Boolean(k))
    .reduce<string | null>((a, b) => (a ? t("shortcuts.or", { a, b }) : b), null);
  return {
    aria: ariaKeyshortcuts(keyboard.bindings, id, keyboard.singleKeys, keyboard.layout),
    title: (label: string) => (keys ? t("shortcuts.withKeys", { label, keys }) : label),
  };
}

export function openShortcuts(): void {
  overview.set(true);
}

/** The overview of all shortcuts, opened from the user menu; "?" opens it, too, when single keys are on. */
export function ShortcutsOverview() {
  const open = useSyncExternalStore(overview.subscribe, overview.get, () => false);
  useShortcut("help", openShortcuts);
  return open ? <ShortcutsDialog onClose={() => overview.set(false)} /> : null;
}

export const SHORTCUT_LABELS = {
  palette: "palette.title",
  help: "shortcuts.help",
  sync: "shell.syncAccounts",
  chat: "shell.askAi",
  tasks: "tasks.title",
  notifications: "shell.notifications",
  amounts: "shell.hideAmounts",
  "go-overview": "shell.overview",
  "go-accounts": "accounts.title",
  "go-transactions": "shell.transactions",
  "go-analysis": "shell.analysis",
  "go-contracts": "shell.contracts",
  "go-settings": "shell.settings",
  "next-tab": "shortcuts.nextTab",
  "prev-tab": "shortcuts.prevTab",
  search: "shortcuts.search",
  filter: "shortcuts.filter",
} as const satisfies Record<ShortcutId, MessageKey>;

export const GROUPS: readonly ShortcutGroup[] = ["general", "pages", "bookings"];

export function Keys({ children }: { children: string | null }) {
  const t = useT();
  return children ? <kbd>{children}</kbd> : <span className="muted">{t("shortcuts.none")}</span>;
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { keyboard, comboOf, singleOf } = useKeyText();
  const active = useAvailableShortcuts();
  // The bookings shortcuts are listed everywhere, their group says where they work.
  const shown = (group: ShortcutGroup) => SHORTCUTS.filter((s) => s.group === group && (group === "bookings" || active.has(s.id)));
  return (
    <FormDialog title={t("shortcuts.title")} onClose={onClose} dismissible className="shortcuts-dialog">
      <div className="stack">
        <p className="muted">{t("shortcuts.intro")}</p>
        <p className="small">
          {keyboard.singleKeys ? t("shortcuts.singleOn") : t("shortcuts.singleOff")}{" "}
          <Link to="/persoenlich/tastenkuerzel" onClick={onClose}>
            {t("shortcuts.toSettings")}
          </Link>
        </p>
        {GROUPS.map((group) => (
          <table key={group} className="data-table shortcut-table">
            <caption>{t(`shortcuts.groups.${group}`)}</caption>
            <colgroup>
              <col className="shortcut-action" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("shortcuts.action")}</th>
                <th scope="col">{t("shortcuts.keys")}</th>
                <th scope="col">{t("shortcuts.single")}</th>
              </tr>
            </thead>
            <tbody>
              {shown(group).map((s) => (
                <tr key={s.id}>
                  <td>{t(SHORTCUT_LABELS[s.id])}</td>
                  <td>
                    <Keys>{comboOf(s.id)}</Keys>
                  </td>
                  <td>
                    <Keys>{singleOf(s.id)}</Keys>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </FormDialog>
  );
}
