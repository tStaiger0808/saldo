import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { errorMessage } from "./action.ts";
import { CHUNK_SIZE } from "./booking-filter.ts";
import type { BookingRun } from "./booking-window.ts";

/**
 * Beyond this many loaded rows the list stops loading on its own and waits for "load more", so an endless scroll
 * session does not keep growing the page; below it the table needs no virtualisation.
 */
export const AUTO_LOAD_LIMIT = 1000;

type Row = { id: number };
type Range = { offset: number; limit: number };
export type RowPage<T> = { items: T[]; total: number };
export type LoadedRun<T> = BookingRun<T> & { total: number };
/** How a load was asked for: by reaching the end of the list, or with the button from the keyboard or a pointer. */
export type LoadTrigger = "auto" | "keyboard" | "pointer";

/** The rows of `more` not in `rows` yet; a booking can move between two loads when the list changes in between. */
export function unseenRows<T extends Row>(rows: readonly T[], more: readonly T[]): T[] {
  const known = new Set(rows.map((row) => row.id));
  return more.filter((row) => !known.has(row.id));
}

/** The requests that fetch `length` rows from `offset` when one request may ask for at most `max`. */
export function chunkRanges(offset: number, length: number, max: number): Range[] {
  const ranges: Range[] = [];
  for (let at = offset; at < offset + length; at += max) ranges.push({ offset: at, limit: Math.min(max, offset + length - at) });
  return ranges;
}

/** Where the list continues after `end` rows, or null once they reach the total. */
export function offsetAfter(end: number, total: number): number | null {
  return end < total ? end : null;
}

const runOf = <T>(first: RowPage<T>): LoadedRun<T> => ({
  items: first.items,
  total: first.total,
  start: 0,
  nextOffset: offsetAfter(first.items.length, first.total),
});

/**
 * A booking list that grows in chunks: `first` is the route's first chunk, `fetchRows` gets more of the same list.
 * Each change of the run takes a ticket, so only the latest load lands. When the route reloads (`first` changes, e.g.
 * after a booking was saved), the whole loaded range is fetched again and replaces the rows in one step, so the list
 * keeps its length and scroll position. A load from the keyboard puts focus on its first new row.
 */
export function useBookingRun<T extends Row>(
  first: RowPage<T>,
  fetchRows: (range: Range) => Promise<RowPage<T>>,
  maxLimit: number,
  list: RefObject<HTMLElement | null>,
) {
  const t = useT();
  const [run, setRun] = useState<LoadedRun<T>>(() => runOf(first));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ count: number; serial: number } | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const loaded = useRef(run);
  loaded.current = run;
  const fetchLatest = useRef(fetchRows);
  fetchLatest.current = fetchRows;
  const generation = useRef(0);
  const loading = useRef(false);
  const shownFirst = useRef(first);

  const claim = useCallback(() => ++generation.current, []);
  const isLatest = useCallback((ticket: number) => ticket === generation.current, []);

  useEffect(() => {
    if (shownFirst.current === first) return;
    shownFirst.current = first;
    const ticket = claim();
    const { start, items } = loaded.current;
    const kept = start === 0 ? first.items : [];
    const from = start + kept.length;
    const ranges = chunkRanges(from, start + items.length - from, maxLimit);
    if (ranges.length === 0) {
      setRun(runOf(first));
      return;
    }
    Promise.all(ranges.map((range) => fetchLatest.current(range))).then(
      (pages) => {
        if (!isLatest(ticket)) return;
        const rows = [...kept];
        for (const page of pages) rows.push(...unseenRows(rows, page.items));
        const total = pages.at(-1)?.total ?? first.total;
        const end = from + pages.reduce((sum, page) => sum + page.items.length, 0);
        setRun({ items: rows, total, start, nextOffset: offsetAfter(end, total) });
      },
      () => undefined,
    );
  }, [first, maxLimit, claim, isLatest]);

  useEffect(() => {
    if (focusRow === null) return;
    list.current?.querySelectorAll<HTMLElement>("tr.booking-row .booking-open")[focusRow]?.focus();
    setFocusRow(null);
  }, [focusRow, list]);

  const load = useCallback(
    async (direction: "older" | "newer", trigger: LoadTrigger) => {
      const base = loaded.current;
      const offset = direction === "older" ? base.nextOffset : base.start > 0 ? Math.max(0, base.start - CHUNK_SIZE) : null;
      if (offset === null || loading.current) return;
      const ticket = claim();
      loading.current = true;
      setBusy(true);
      setError(null);
      try {
        const more = await fetchLatest.current({ offset, limit: direction === "older" ? CHUNK_SIZE : base.start - offset });
        if (!isLatest(ticket)) return;
        const fresh = unseenRows(base.items, more.items);
        if (direction === "older") {
          const nextOffset = more.items.length > 0 ? offsetAfter(offset + more.items.length, more.total) : null;
          setRun({ ...base, items: [...base.items, ...fresh], total: more.total, nextOffset });
          if (trigger === "keyboard" && fresh.length > 0) setFocusRow(base.items.length);
        } else {
          setRun({ ...base, items: [...fresh, ...base.items], total: more.total, start: offset });
          // The button goes away with the newest rows loaded; focus moves to the row next to where it was.
          if (offset === 0) setFocusRow(fresh.length - 1);
        }
        setAdded((last) => ({ count: fresh.length, serial: (last?.serial ?? 0) + 1 }));
      } catch (e) {
        if (isLatest(ticket)) setError(errorMessage(e, t));
      } finally {
        loading.current = false;
        setBusy(false);
      }
    },
    [claim, isLatest, t],
  );

  const loadOlder = useCallback((trigger: LoadTrigger) => load("older", trigger), [load]);
  const loadNewer = useCallback(() => load("newer", "pointer"), [load]);

  return {
    run,
    /** The run as of the latest render, for async work that must not act on a stale one. */
    loaded,
    setRun,
    claim,
    isLatest,
    busy,
    error,
    setError,
    added,
    autoLoad: error === null && run.items.length < AUTO_LOAD_LIMIT,
    loadOlder,
    loadNewer,
  };
}
