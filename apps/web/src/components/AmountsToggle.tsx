import type { ReactNode } from "react";
import { useT } from "../i18n/react.tsx";
import { amountsHidden, setAmountsHidden, useAmountsHidden } from "../lib/amounts.ts";
import { Icon } from "./Icon.tsx";
import { useShortcut, useShortcutHint } from "./Shortcuts.tsx";

/** The "amounts" shortcut (Alt+Shift+H by default) hides or shows every amount; registered once, the toggle appears twice. */
export function useAmountsShortcut() {
  useShortcut("amounts", () => setAmountsHidden(!amountsHidden()));
}

/** Hides every money amount until pressed again. The name stays fixed and `aria-pressed` carries the state. */
export function AmountsToggle({ className, tip }: { className: string; tip?: (label: string) => ReactNode }) {
  const t = useT();
  const hidden = useAmountsHidden();
  const hint = useShortcutHint("amounts");
  const title = hint.title(t("shell.hideAmounts"));
  return (
    <button
      type="button"
      className={`${className} amounts-toggle`}
      aria-pressed={hidden}
      aria-keyshortcuts={hint.aria}
      title={title}
      onClick={() => setAmountsHidden(!hidden)}
    >
      <Icon name={hidden ? "eye-off" : "eye"} />
      <span className="nav-label">{t("shell.hideAmounts")}</span>
      {tip?.(title)}
    </button>
  );
}
