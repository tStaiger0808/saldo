import { type RefObject, useLayoutEffect } from "react";

/** Removes a leaving node even if its animation never reports its end, e.g. in a background tab. */
const EXIT_FALLBACK_MS = 400;

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Gives a node that React is removing a short exit. Call it while the node is still known (an effect cleanup); once
 * React has taken it out, `restore` puts it back (returning what to remove afterwards, or null to skip), and it stays
 * inert, hidden from assistive technology, without ids and marked `data-exiting` until its CSS animations have played.
 * Nothing happens with reduced motion, or when the node itself was not removed (a StrictMode re-run, a removed ancestor).
 */
export function playExit(node: Element | null | undefined, restore: (node: Element) => Element | null): void {
  if (!node || prefersReducedMotion()) return;
  queueMicrotask(() => {
    if (node.parentNode) return;
    const leaving = restore(node);
    if (!leaving) return;
    leaving.setAttribute("inert", "");
    leaving.setAttribute("aria-hidden", "true");
    for (const element of [node, ...node.querySelectorAll("[id]")]) element.removeAttribute("id");
    node.setAttribute("data-exiting", "");
    const animations = leaving
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    if (animations.length === 0) {
      leaving.remove();
      return;
    }
    const timer = setTimeout(() => leaving.remove(), EXIT_FALLBACK_MS);
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      clearTimeout(timer);
      leaving.remove();
    });
  });
}

/** For a fixed-position popup rendered only while `shown`: once hidden, it plays its exit animation inside `host`. */
export function useExitWhenHidden(shown: boolean, ref: RefObject<HTMLElement | null>, host: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (!shown) return;
    const node = ref.current;
    const parent = host.current;
    return () => playExit(node, (leaving) => (parent?.isConnected ? parent.appendChild(leaving) : null));
  }, [shown, ref, host]);
}

/**
 * Keeps the element in `ref` where it was for its exit animation after its component unmounts. Its height is fixed
 * inline, so the animation can collapse it and the content below moves up instead of jumping.
 */
export function useExitInPlace(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      const parent = node?.parentNode;
      const next = node?.nextSibling ?? null;
      playExit(node, (leaving) => {
        if (!parent?.isConnected || !(leaving instanceof HTMLElement)) return null;
        parent.insertBefore(leaving, next?.parentNode === parent ? next : null);
        leaving.style.height = `${leaving.offsetHeight}px`;
        return leaving;
      });
    };
  }, [ref]);
}
