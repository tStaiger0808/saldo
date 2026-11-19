/**
 * Maps the balance timeline's visible window onto a booking list sorted newest first, loaded in runs: which loaded
 * row starts the window, and how rows fetched for a window far from the loaded ones join the list.
 */

/** ISO days, both included. */
export type DateWindow = { from: string; to: string };

/** Contiguous bookings of the list, newest first, starting at offset `start` of the whole list. */
export type BookingRun<T> = { items: T[]; start: number; nextOffset: number | null };

export function inWindow(date: string, window: DateWindow): boolean {
  return date >= window.from && date <= window.to;
}

/**
 * The index of the window's newest booking among the loaded dates (newest first), "none" when the list holds no
 * booking in the window, or "fetch" when that booking may lie outside the loaded run.
 */
export function windowTarget(dates: readonly string[], start: number, complete: boolean, window: DateWindow): number | "none" | "fetch" {
  const index = dates.findIndex((date) => date <= window.to);
  if (index === -1) return complete ? "none" : "fetch";
  // Rows before the run are as new or newer, so one of them may be the window's newest.
  if (index === 0 && start > 0) return "fetch";
  return (dates[index] ?? "") >= window.from ? index : "none";
}

/**
 * The rows still missing between the loaded run and the window's newest booking at offset `target`, when they are few
 * enough to append; null when the list should jump to the target instead.
 */
export function gapBefore(
  run: { start: number; length: number },
  target: number,
  maxGap: number,
): { offset: number; limit: number } | null {
  const end = run.start + run.length;
  if (target < run.start || target - end > maxGap) return null;
  return { offset: end, limit: Math.max(0, target - end) };
}

/**
 * The run with the rows fetched from offset `target` in place: after the loaded rows and the `gap` between them, or,
 * without a gap, on their own.
 */
export function placeRows<T>(run: BookingRun<T>, rows: T[], target: number, nextOffset: number | null, gap: T[] | null): BookingRun<T> {
  if (gap === null) return { items: rows, start: target, nextOffset };
  return { items: [...run.items.slice(0, Math.max(0, target - run.start)), ...gap, ...rows], start: run.start, nextOffset };
}
