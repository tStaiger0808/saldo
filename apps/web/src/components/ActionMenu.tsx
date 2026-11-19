import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { useExitWhenHidden } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  /** Destructive actions are listed last, below a separator and in red. */
  danger?: boolean;
  disabled?: boolean;
  /** Makes the item a checkbox (`menuitemcheckbox`) with a check mark while on. */
  checked?: boolean;
};

const GAP = 4;
const EDGE = 8;

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? []),
];

/**
 * "⋯" button with the secondary actions of a row, following the WAI-ARIA menu button pattern. Choosing an item gives
 * focus back to the button before the action runs, so a dialog opened by it returns focus there when it closes.
 */
export function ActionMenu({ name, items }: { name: string; items: (ActionMenuItem | false | null | undefined)[] }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const visible = items.filter((item): item is ActionMenuItem => Boolean(item));
  const regular = visible.filter((item) => !item.danger);
  const danger = visible.filter((item) => item.danger);

  function close(restoreFocus: boolean) {
    setOpen(null);
    if (restoreFocus) button.current?.focus();
  }
  useExitWhenHidden(open !== null, menu, root);

  // Fixed positioning keeps the menu clear of scrolling table and card containers.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      const node = menu.current;
      if (!anchor || !node) return;
      const fitsBelow = anchor.bottom + GAP + node.offsetHeight <= window.innerHeight - EDGE;
      const top = fitsBelow || anchor.top - GAP - node.offsetHeight < EDGE ? anchor.bottom + GAP : anchor.top - GAP - node.offsetHeight;
      node.style.top = `${top}px`;
      node.style.left = `${Math.max(EDGE, Math.min(anchor.right - node.offsetWidth, window.innerWidth - node.offsetWidth - EDGE))}px`;
    };
    place();
    const list = menuItems(menu.current);
    (open === "first" ? list[0] : list.at(-1))?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(null);
      // A click on another control keeps its focus; on plain content (or the main area, tabindex -1) it returns here.
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement) || focused === document.body || focused.tabIndex < 0) button.current?.focus();
      });
    }
    function onFocusIn(event: FocusEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(event.key === "ArrowDown" ? "first" : "last");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = menuItems(menu.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return close(true);
      case "Tab":
        // From the button, the browser's own Tab step lands on the control after (or before) the menu.
        return close(true);
    }
  }

  function choose(item: ActionMenuItem) {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  }

  const checkable = visible.some((item) => item.checked !== undefined);
  const renderItem = (item: ActionMenuItem) => {
    const className = item.danger ? "action-menu-item danger" : "action-menu-item";
    const mark = checkable && (
      <span className="action-menu-check" aria-hidden="true">
        {item.checked && <Icon name="check" size={16} />}
      </span>
    );
    return item.checked === undefined ? (
      <button
        key={item.label}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={className}
        aria-disabled={item.disabled || undefined}
        onClick={() => choose(item)}
      >
        {mark}
        {item.label}
      </button>
    ) : (
      <button
        key={item.label}
        type="button"
        role="menuitemcheckbox"
        aria-checked={item.checked}
        tabIndex={-1}
        className={className}
        aria-disabled={item.disabled || undefined}
        onClick={() => choose(item)}
      >
        {mark}
        {item.label}
      </button>
    );
  };

  if (visible.length === 0) return null;
  return (
    <div ref={root} className="action-menu">
      <button
        ref={button}
        type="button"
        id={`${id}-button`}
        className="btn btn-sm btn-icon"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(true) : setOpen("first"))}
        onKeyDown={onButtonKeyDown}
      >
        <Icon name="more" size={18} />
        <span className="visually-hidden">{t("common.actionsFor", { name })}</span>
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          role="menu"
          tabIndex={-1}
          aria-labelledby={`${id}-button`}
          className="action-menu-list"
          onKeyDown={onMenuKeyDown}
        >
          {regular.map(renderItem)}
          {regular.length > 0 && danger.length > 0 && <hr className="action-menu-separator" />}
          {danger.map(renderItem)}
        </div>
      )}
    </div>
  );
}
