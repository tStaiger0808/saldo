import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useExitWhenHidden } from "../lib/motion.ts";

const GAP = 4;
const EDGE = 8;

/**
 * A button that opens a small non-modal panel (disclosure pattern): focus moves into the panel, Escape, a click outside
 * or focus leaving closes it, and closing from inside returns focus to the button.
 */
export function Popover({
  label,
  trigger,
  className = "btn btn-sm",
  active,
  children,
}: {
  /** Accessible name of the panel. */
  label: string;
  trigger: ReactNode;
  className?: string;
  /** Styles the button as the current choice, e.g. within a segmented group. */
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  useExitWhenHidden(open, panel, root);

  // Fixed positioning keeps the panel clear of scrolling and clipping card containers.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      const node = panel.current;
      if (!anchor || !node) return;
      const fitsBelow = anchor.bottom + GAP + node.offsetHeight <= window.innerHeight - EDGE;
      const top = fitsBelow || anchor.top - GAP - node.offsetHeight < EDGE ? anchor.bottom + GAP : anchor.top - GAP - node.offsetHeight;
      node.style.top = `${top}px`;
      node.style.left = `${Math.max(EDGE, Math.min(anchor.left, window.innerWidth - node.offsetWidth - EDGE))}px`;
    };
    place();
    (panel.current?.querySelector<HTMLElement>("input, select, textarea") ?? panel.current)?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  return (
    <div ref={root} className="popover">
      <button
        ref={button}
        type="button"
        className={className}
        data-active={active || undefined}
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={`${id}-panel`}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className="popover-panel"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
