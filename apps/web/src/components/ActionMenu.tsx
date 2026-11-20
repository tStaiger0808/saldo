import { Fragment, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { useExitWhenHidden } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  /** Destructive actions are listed last, below a separator and in red. */
  danger?: boolean;
  disabled?: boolean;
  /** Makes the item a checkbox (`menuitemcheckbox`) with a check mark while on; in a group, a radio item. */
  checked?: boolean;
};

/** A labelled set of radio items (`menuitemradio`); `checked` marks the chosen one. */
export type ActionMenuGroup = { group: string; items: ActionMenuItem[] };

export type ActionMenuEntry = ActionMenuItem | ActionMenuGroup;

const isGroup = (entry: ActionMenuEntry): entry is ActionMenuGroup => "group" in entry;

const GAP = 4;
const EDGE = 8;

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]') ?? []),
];

/**
 * "⋯" button with the secondary actions of a row, following the WAI-ARIA menu button pattern. Choosing an item gives
 * focus back to the button before the action runs, so a dialog opened by it returns focus there when it closes.
 * `label` replaces the button's name "Aktionen für {name}".
 */
export function ActionMenu({
  name,
  label,
  items,
}: {
  name?: string;
  label?: string;
  items: (ActionMenuEntry | false | null | undefined)[];
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const visible = items.flatMap((entry) => (entry && (!isGroup(entry) || entry.items.length > 0) ? [entry] : []));
  const regular = visible.filter((entry) => isGroup(entry) || !entry.danger);
  const danger = visible.filter((entry): entry is ActionMenuItem => !isGroup(entry) && Boolean(entry.danger));

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
      // A menu taller than the room on either side scrolls within the larger one.
      const height = node.scrollHeight + node.offsetHeight - node.clientHeight;
      const below = window.innerHeight - EDGE - anchor.bottom - GAP;
      const above = anchor.top - GAP - EDGE;
      const downwards = height <= below || (height > above && below >= above);
      const room = downwards ? below : above;
      node.style.maxHeight = height > room ? `${room}px` : "";
      node.style.top = `${downwards ? anchor.bottom + GAP : anchor.top - GAP - Math.min(height, room)}px`;
      node.style.left = `${Math.max(EDGE, Math.min(anchor.right - node.offsetWidth, window.innerWidth - node.offsetWidth - EDGE))}px`;
    };
    place();
    const list = menuItems(menu.current);
    (open === "first" ? list[0] : list.at(-1))?.focus();
    const follow = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", follow, true);
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

  const checkable = visible.some((entry) => isGroup(entry) || entry.checked !== undefined);
  const renderItem = (item: ActionMenuItem, radio = false) => {
    const props = {
      type: "button" as const,
      tabIndex: -1,
      className: item.danger ? "action-menu-item danger" : "action-menu-item",
      "aria-disabled": item.disabled || undefined,
      onClick: () => choose(item),
    };
    const content = (
      <>
        {checkable && (
          <span className="action-menu-check" aria-hidden="true">
            {item.checked && <Icon name="check" size={16} />}
          </span>
        )}
        {item.label}
      </>
    );
    if (radio) {
      return (
        <button key={item.label} {...props} role="menuitemradio" aria-checked={Boolean(item.checked)}>
          {content}
        </button>
      );
    }
    if (item.checked !== undefined) {
      return (
        <button key={item.label} {...props} role="menuitemcheckbox" aria-checked={item.checked}>
          {content}
        </button>
      );
    }
    return (
      <button key={item.label} {...props} role="menuitem">
        {content}
      </button>
    );
  };
  // Groups stand apart from their neighbours by a separator on each side.
  const renderEntry = (entry: ActionMenuEntry, index: number) => {
    if (!isGroup(entry)) return renderItem(entry);
    return (
      <Fragment key={`group:${entry.group}`}>
        {index > 0 && <hr className="action-menu-separator" />}
        {/* biome-ignore lint/a11y/useSemanticElements: a group of menu items, not a form fieldset */}
        <div role="group" aria-label={entry.group} className="action-menu-group">
          <div className="action-menu-label" aria-hidden="true">
            {entry.group}
          </div>
          {entry.items.map((item) => renderItem(item, true))}
        </div>
        {index < regular.length - 1 && !isGroup(regular[index + 1] as ActionMenuEntry) && <hr className="action-menu-separator" />}
      </Fragment>
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
        <span className="visually-hidden">{label ?? t("common.actionsFor", { name: name ?? "" })}</span>
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
          {regular.map(renderEntry)}
          {regular.length > 0 && danger.length > 0 && <hr className="action-menu-separator" />}
          {danger.map((item) => renderItem(item))}
        </div>
      )}
    </div>
  );
}
