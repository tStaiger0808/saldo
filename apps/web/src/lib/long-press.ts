import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

/** About as long as the platforms' own long press. */
const DELAY_MS = 500;
/** A finger that moves further is scrolling or swiping. */
const SLOP_PX = 10;

/**
 * After a long press the finger is still down, and whatever opened rests under it. Its release must not click that,
 * nor a link under it, and Android's own menu must stay shut. A keyboard click (`detail` 0) is never swallowed, and
 * the next press lifts the guard in case the release sent no click.
 */
function guardRelease() {
  const swallow = (event: MouseEvent) => {
    if (event.type === "click" && event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "click") lift();
  };
  const lift = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("contextmenu", swallow, true);
    window.removeEventListener("pointerdown", lift, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("contextmenu", swallow, true);
  window.addEventListener("pointerdown", lift, true);
}

/**
 * A long press by touch or pen on an element: after `DELAY_MS` without moving, `onLongPress` runs. While the finger
 * rests the element carries `data-pressing`. Mouse presses are left alone; keyboard users reach the same actions
 * through a button.
 */
export function useLongPress<T extends HTMLElement>(onLongPress: (element: T) => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const press = useRef<{ x: number; y: number; element: T } | null>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function cancel() {
    clearTimeout(timer.current);
    press.current?.element.removeAttribute("data-pressing");
    press.current = null;
  }

  function fire() {
    const element = press.current?.element;
    cancel();
    if (!element) return;
    guardRelease();
    navigator.vibrate?.(10);
    onLongPress(element);
  }

  return {
    onPointerDown(event: ReactPointerEvent<T>) {
      cancel();
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      press.current = { x: event.clientX, y: event.clientY, element: event.currentTarget };
      event.currentTarget.setAttribute("data-pressing", "");
      timer.current = setTimeout(fire, DELAY_MS);
    },
    onPointerMove(event: ReactPointerEvent<T>) {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Android answers a long press with its own menu, sometimes before the timer is due.
    onContextMenu(event: ReactMouseEvent<T>) {
      if (!press.current) return;
      event.preventDefault();
      fire();
    },
  };
}
