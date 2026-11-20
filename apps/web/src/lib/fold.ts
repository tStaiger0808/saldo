import { useSyncExternalStore } from "react";

/**
 * Sections people can fold away, remembered per browser (localStorage). `<html data-folded>` carries the folded ids:
 * the head script sets it before the first paint and the CSS hides those sections from it until React has hydrated,
 * so a reload shows them closed from the start. The ids are stored in browsers, so they stay German.
 */
export const FOLDS = ["konten-verlauf", "konto-verlauf", "konten-angefangen"] as const;
export type FoldId = (typeof FOLDS)[number];

export const FOLDED_KEY = "fw-eingeklappt";

/** The known ids in a stored value, separated by spaces like the `data-folded` attribute. */
export function foldedIds(value: string | null | undefined): FoldId[] {
  return (value ?? "").split(" ").filter((id): id is FoldId => (FOLDS as readonly string[]).includes(id));
}

const listeners = new Set<() => void>();

export function isFolded(id: FoldId | undefined): boolean {
  return id !== undefined && typeof document !== "undefined" && foldedIds(document.documentElement.dataset.folded).includes(id);
}

export function setFolded(id: FoldId, folded: boolean): void {
  const root = document.documentElement;
  const ids = foldedIds(root.dataset.folded).filter((other) => other !== id);
  if (folded) ids.push(id);
  const value = ids.join(" ");
  if (value) root.dataset.folded = value;
  else delete root.dataset.folded;
  try {
    localStorage.setItem(FOLDED_KEY, value);
  } catch {
    // Private mode: the choice lasts until the next reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the section is folded; the server renders every section open. */
export function useFolded(id: FoldId | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isFolded(id),
    () => false,
  );
}
