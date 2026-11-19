import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice } from "../lib/action.ts";
import { useExitInPlace } from "../lib/motion.ts";
import { Banner } from "./Status.tsx";

type Toast = Notice & { id: number };

/** At most this many stay on screen; a new one pushes the oldest out. */
const MAX_TOASTS = 4;
/** Errors stay longer, so there is time to read what went wrong. */
const DURATION_MS = { ok: 6_000, info: 6_000, warn: 8_000, danger: 10_000 } as const;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const push = useCallback((notice: Notice) => {
    next.current += 1;
    const id = next.current;
    setToasts((list) => [...list, { ...notice, id }].slice(-MAX_TOASTS));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  return { toasts, push, dismiss };
}

/**
 * Short results in the bottom right corner, newest at the bottom. Each hides itself after a few seconds; the timer
 * waits while the pointer or keyboard focus is on it (WCAG 2.2.1), and the close button removes it at once.
 */
export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  // The stack stays while empty, so the last toast still has a place to play its exit.
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const node = useRef<HTMLDivElement>(null);
  useExitInPlace(node);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), DURATION_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [paused, toast.id, toast.tone, onDismiss]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only pause the timer; the close button is the control
    <div
      ref={node}
      className="toast"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <Banner tone={toast.tone} onClose={() => onDismiss(toast.id)}>
        {toast.text}
      </Banner>
    </div>
  );
}
