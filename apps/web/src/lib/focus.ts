import { type RefObject, useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled], [type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A removed part that still plays its exit animation (`lib/motion.ts`) is inert and counts as gone. */
const present = (node: Element) => node.isConnected && node.closest("[inert]") === null;

/**
 * Keeps keyboard and screen reader users in place when the focused control goes away: a removed control hands focus to
 * the nearest part of the page that is still there (else `fallback`), a disabled one gets it back once it is enabled
 * again. A pointer press elsewhere means the person moved on, so nothing is restored then.
 */
export function useFocusRescue(fallback: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let last: HTMLElement | null = null;
    let ancestors: HTMLElement[] = [];
    let disabled = false;

    function remember(event: FocusEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      last = event.target;
      disabled = false;
      ancestors = [];
      for (let node = last.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
    }

    function forget() {
      last = null;
    }

    function rescue() {
      const active = document.activeElement;
      if (!last || (active && active !== document.body)) return;
      if (present(last)) {
        // Only a disabled control gets focus back; an enabled one was left on purpose, e.g. by tabbing out of the page.
        if (last.matches(":disabled")) disabled = true;
        else if (disabled) last.focus();
        else last = null;
        return;
      }
      const main = fallback.current;
      const home = ancestors.find(
        (node) => present(node) && node !== main && (main?.contains(node) || node.closest("dialog[open], [data-focus-home]")),
      );
      last = null;
      (home?.querySelector<HTMLElement>(FOCUSABLE) ?? main)?.focus();
    }

    const observer = new MutationObserver(rescue);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("focusin", remember);
    document.addEventListener("pointerdown", forget, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", remember);
      document.removeEventListener("pointerdown", forget, true);
    };
  }, [fallback]);
}
