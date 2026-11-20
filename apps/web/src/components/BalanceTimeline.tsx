import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n/react.tsx";
import { linear, linePath, useChartWidth } from "../lib/chart.ts";
import type { FoldId } from "../lib/fold.ts";
import {
  bounds,
  clampViewport,
  dateViewport,
  dayIso,
  downsample,
  expandBalance,
  extent,
  type FlowPrefix,
  flowPrefix,
  keySelection,
  keyViewport,
  MIN_SPAN,
  matchesPreset,
  type PeriodLabel,
  PRESETS,
  panBy,
  periodOf,
  popHistory,
  presetViewport,
  pushHistory,
  resizeViewport,
  type Selection,
  selectionDays,
  selectionViewport,
  sumFlows,
  type Viewport,
  valueTicks,
  visibleDays,
  xTicks,
  zoomAround,
  zoomBy,
  zoomStep,
} from "../lib/timeline.ts";
import type { Timeline } from "../server/modules/accounts/index.ts";
import { Amount, useMaskAmounts } from "./Bits.tsx";
import { FoldBody } from "./Fold.tsx";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };
/** Pixels a press moves before it pans; less is a tap that places the crosshair. */
const DRAG_START = 6;
const SETTLE_MS = 400;
/** A touch held this long without moving starts a range selection instead of a pan. */
const LONG_PRESS_MS = 400;
const DOUBLE_TAP_MS = 350;
const ZOOM_KEYS = new Set(["+", "=", "-", "_"]);

type Series = { start: string; days: number; values: Float64Array; flows: FlowPrefix };
type Mover = (next: Viewport, how?: "now" | "animate") => void;
type Motion = {
  move: Mover;
  glide: (velocity: number) => void;
  halt: () => void;
  /** A zoom that "back" undoes. */
  zoomTo: Mover;
  /** Records a zoom that already happened live (pinch, wheel, handle drag) as one step back to `origin`. */
  commit: (origin: Viewport) => void;
  back: () => void;
};
type Picker = {
  selection: Selection | null;
  ref: RefObject<Selection | null>;
  set: (next: Selection | null) => void;
  /** Zooms to the selection and ends it; a single day just ends it. */
  apply: () => void;
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Keeps a drag going outside the element; a pointer that is already gone (lifted, cancelled) cannot be captured. */
function capture(node: Element | null, pointerId: number) {
  try {
    node?.setPointerCapture(pointerId);
  } catch {
    // The drag still works while the pointer stays over the element.
  }
}

/** State that many events may set per frame (pointer moves), rendered at most once per animation frame. */
function useFrameState<T>(initial: () => T): [T, RefObject<T>, (next: T) => void] {
  const [state, setState] = useState(initial);
  const ref = useRef(state);
  const frame = useRef(0);
  const set = useCallback((next: T) => {
    ref.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setState(ref.current);
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  return [state, ref, set];
}

function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Balance over time that pans and zooms through the whole history without loading more: drag or swipe, pinch,
 * Ctrl/⌘ + wheel, a selected range (Shift + drag, long press + drag, the overview or Shift + arrows), the buttons and
 * presets, or the keyboard. Zoom steps can be undone. The header sums the visible window's bookings (or the selection's
 * while picking one), the table lists it, and changes are announced once they settle. `onWindowChange` hears of each
 * window the user moves to, once it has settled, as ISO days (both included); the window it opens with is not reported.
 * With `fold`, everything below the header sums folds away (element `bodyId`) while the sums stay.
 */
export function BalanceTimeline({
  title,
  timeline,
  transfers,
  fold,
  bodyId,
  onWindowChange,
}: {
  title: string;
  timeline: Timeline;
  transfers: "included" | "excluded";
  fold?: FoldId;
  bodyId?: string;
  onWindowChange?: (shown: { from: string; to: string }) => void;
}) {
  const { t, f } = useI18n();
  const mask = useMaskAmounts();
  const id = useId();
  const series = useMemo<Series>(
    () => ({
      start: timeline.start,
      days: timeline.days,
      values: expandBalance(timeline.balance, timeline.days),
      flows: flowPrefix(timeline.flows, timeline.days),
    }),
    [timeline],
  );
  const { start, days, values } = series;
  const [vp, vpRef, setVp] = useFrameState<Viewport>(() => presetViewport("3m", timeline.start, timeline.days));
  const [touched, setTouched] = useState(false);
  const animation = useRef(0);
  const settled = useSettled(vp, SETTLE_MS);
  const [settledFrom, settledTo] = visibleDays(settled, timeline.days);
  const onWindowRef = useRef(onWindowChange);
  onWindowRef.current = onWindowChange;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const shown = { from: dayIso(timeline.start, settledFrom), to: dayIso(timeline.start, settledTo) };
    const key = `${shown.from}:${shown.to}`;
    if (reported.current !== null && reported.current !== key) onWindowRef.current?.(shown);
    reported.current = key;
  }, [timeline.start, settledFrom, settledTo]);
  // Where the window is heading: the chart's value names it at once, without the frames of an animation in between.
  const [goal, setGoalState] = useState(vp);
  const goalRef = useRef(goal);
  const setGoal = useCallback((next: Viewport) => {
    goalRef.current = next;
    setGoalState(next);
  }, []);
  const [history, setHistoryState] = useState<readonly Viewport[]>([]);
  const historyRef = useRef(history);
  const setHistory = useCallback((next: readonly Viewport[]) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);
  const [selection, selectionRef, setSelection] = useFrameState<Selection | null>(() => null);

  useEffect(() => {
    const clamped = clampViewport(vpRef.current, days);
    setVp(clamped);
    setGoal(clamped);
    setHistory([]);
    setSelection(null);
  }, [days, setVp, vpRef, setGoal, setHistory, setSelection]);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  const move = useCallback<Mover>(
    (next, how = "now") => {
      setTouched(true);
      cancelAnimationFrame(animation.current);
      const target = clampViewport(next, days);
      setGoal(target);
      if (how === "now" || reducedMotion()) {
        setVp(target);
        return;
      }
      const origin = vpRef.current;
      const began = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - began) / 220);
        const e = 1 - (1 - p) ** 3;
        setVp({ from: origin.from + (target.from - origin.from) * e, to: origin.to + (target.to - origin.to) * e });
        if (p < 1) animation.current = requestAnimationFrame(step);
      };
      animation.current = requestAnimationFrame(step);
    },
    [days, setVp, vpRef, setGoal],
  );

  const halt = useCallback(() => cancelAnimationFrame(animation.current), []);

  /** Keeps panning after a flick, slowing down; `velocity` in days per millisecond. */
  const glide = useCallback(
    (velocity: number) => {
      if (reducedMotion()) return;
      cancelAnimationFrame(animation.current);
      let v = velocity;
      let last = performance.now();
      const step = (now: number) => {
        const before = vpRef.current;
        const next = panBy(before, v * (now - last), days);
        v *= 0.995 ** (now - last);
        last = now;
        setVp(next);
        setGoal(next);
        if (Math.abs(v) > 0.0005 && next.from !== before.from) animation.current = requestAnimationFrame(step);
      };
      animation.current = requestAnimationFrame(step);
    },
    [days, setVp, vpRef, setGoal],
  );

  const zoomTo = useCallback<Mover>(
    (next, how = "animate") => {
      setHistory(pushHistory(historyRef.current, goalRef.current, clampViewport(next, days)));
      move(next, how);
    },
    [days, move, setHistory],
  );
  const commit = useCallback((origin: Viewport) => setHistory(pushHistory(historyRef.current, origin, goalRef.current)), [setHistory]);
  const back = useCallback(() => {
    const previous = popHistory(historyRef.current, goalRef.current);
    setHistory(previous.history);
    if (previous.viewport) move(previous.viewport, "animate");
  }, [move, setHistory]);
  const apply = useCallback(() => {
    const picked = selectionRef.current;
    setSelection(null);
    const target = picked && selectionViewport(picked, days);
    if (target) zoomTo(target);
  }, [days, selectionRef, setSelection, zoomTo]);

  const selecting = selection !== null;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, setSelection]);

  const motion = useMemo<Motion>(() => ({ move, glide, halt, zoomTo, commit, back }), [move, glide, halt, zoomTo, commit, back]);
  const picker = useMemo<Picker>(
    () => ({ selection, ref: selectionRef, set: setSelection, apply }),
    [selection, selectionRef, setSelection, apply],
  );
  const { lo, hi } = bounds(days);
  const span = vp.to - vp.from;
  const atStart = vp.from <= lo + 1e-3;
  const atEnd = vp.to >= hi - 1e-3;
  const pan = (fraction: number) => {
    const c = vpRef.current;
    move(panBy(c, (c.to - c.from) * fraction, days), "animate");
  };
  const zoom = (direction: "in" | "out") => zoomTo(zoomStep(vpRef.current, direction, days));

  const periodText = (label: PeriodLabel) => (label.kind === "month" ? f.monthLong(label.month) : f.dateRange(label.from, label.to));
  const balanceText = (cents: number) => (cents < 0 ? f.signed(cents) : f.euro(cents));
  const [d0, d1] = selection ? selectionDays(selection) : visibleDays(vp, days);
  const period = periodText(periodOf(start, d0, d1, days));
  const sums = sumFlows(series.flows, d0, d1);

  const windowText = (shown: Viewport) => {
    const [a, b] = visibleDays(shown, days);
    const flows = sumFlows(series.flows, a, b);
    const vars = { period: periodText(periodOf(start, a, b, days)), in: f.euro(flows.inCents), out: f.euro(flows.outCents) };
    const first = values[a] ?? Number.NaN;
    const last = values[b] ?? Number.NaN;
    return Number.isNaN(last)
      ? t("timeline.announceUnknown", vars)
      : t("timeline.announce", { ...vars, from: balanceText(Number.isNaN(first) ? last : first), to: balanceText(last) });
  };
  const selectionText = (picked: Selection) => {
    const [a, b] = selectionDays(picked);
    const flows = sumFlows(series.flows, a, b);
    return t("timeline.announceSelection", {
      period: periodText(periodOf(start, a, b, days)),
      in: f.euro(flows.inCents),
      out: f.euro(flows.outCents),
    });
  };
  const [plotFocused, setPlotFocused] = useState(false);
  const settledSelection = useSettled(selection, SETTLE_MS);
  // A selection is announced even while the chart has focus: picking one does not change the chart's value.
  const announcement = selection
    ? settledSelection
      ? selectionText(settledSelection)
      : ""
    : touched && !plotFocused
      ? windowText(settled)
      : "";

  return (
    <div className="timeline">
      <div className="timeline-head" data-selecting={selecting || undefined}>
        <p className="timeline-period">
          {selecting && <span className="timeline-badge">{t("timeline.selection")}</span>}
          {period}
        </p>
        <dl className="timeline-sums">
          <div>
            <dt>{t("accounts.detail.in")}</dt>
            <dd>
              <Amount cents={sums.inCents} />
            </dd>
          </div>
          <div>
            <dt>{t("accounts.detail.out")}</dt>
            <dd>
              <Amount cents={-sums.outCents} />
            </dd>
          </div>
          <div>
            <dt className="visually-hidden">{t("accounts.detail.count")}</dt>
            <dd className="timeline-count">{t("transactions.count", { count: sums.count })}</dd>
          </div>
        </dl>
      </div>
      <FoldBody fold={fold} id={bodyId} className="timeline-body">
        <Plot
          series={series}
          vp={vp}
          vpRef={vpRef}
          motion={motion}
          picker={picker}
          title={title}
          valueText={mask(windowText(goal))}
          hintId={`${id}-hint`}
          onFocusChange={setPlotFocused}
        />
        <Scrubber series={series} vp={vp} vpRef={vpRef} motion={motion} picker={picker} />
        <div className="timeline-controls">
          {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset */}
          <div className="segmented" role="group" aria-label={t("timeline.range")}>
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={matchesPreset(vp, preset, start, days)}
                onClick={() => {
                  setSelection(null);
                  setHistory([]);
                  move(presetViewport(preset, start, days), "animate");
                }}
              >
                <span aria-hidden="true">{t(`timeline.preset.${preset}`)}</span>
                <span className="visually-hidden">{t(`timeline.presetLong.${preset}`)}</span>
              </button>
            ))}
            <Popover
              label={t("timeline.customTitle")}
              className="segmented-popover"
              active={!PRESETS.some((preset) => matchesPreset(vp, preset, start, days))}
              trigger={t("timeline.custom")}
            >
              {(close) => (
                <CustomRange
                  start={start}
                  days={days}
                  shown={visibleDays(goal, days)}
                  onApply={(next) => {
                    close();
                    setSelection(null);
                    motion.zoomTo(next);
                  }}
                />
              )}
            </Popover>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of buttons, not a form fieldset */}
          <div className="timeline-nav" role="group" aria-label={t("timeline.move")}>
            <NavButton icon disabled={atStart} title={t("timeline.earlierHint")} onClick={() => pan(-0.5)}>
              <Icon name="chevron-left" size={18} />
              <span className="visually-hidden">{t("timeline.earlier")}</span>
            </NavButton>
            <NavButton icon disabled={atEnd} title={t("timeline.laterHint")} onClick={() => pan(0.5)}>
              <Icon name="chevron-right" size={18} />
              <span className="visually-hidden">{t("timeline.later")}</span>
            </NavButton>
            <NavButton icon disabled={span >= hi - lo - 1e-3} title={t("timeline.zoomOut")} onClick={() => zoom("out")}>
              <span aria-hidden="true">−</span>
              <span className="visually-hidden">{t("timeline.zoomOut")}</span>
            </NavButton>
            <NavButton icon disabled={span <= MIN_SPAN + 1e-3} title={t("timeline.zoomIn")} onClick={() => zoom("in")}>
              <span aria-hidden="true">+</span>
              <span className="visually-hidden">{t("timeline.zoomIn")}</span>
            </NavButton>
            <NavButton disabled={history.length === 0} title={t("timeline.backHint")} onClick={back}>
              <Icon name="undo" size={16} />
              {t("timeline.back")}
            </NavButton>
          </div>
          <Popover
            label={t("timeline.help")}
            className="btn btn-sm btn-icon btn-ghost"
            trigger={
              <>
                <Icon name="info" size={18} />
                <span className="visually-hidden">{t("timeline.help")}</span>
              </>
            }
          >
            {() => <TimelineHelp />}
          </Popover>
        </div>
        <p className="muted small">{t(transfers === "included" ? "timeline.withTransfers" : "timeline.withoutTransfers")}</p>
      </FoldBody>
      <p id={`${id}-hint`} className="visually-hidden">
        {t("timeline.hint")}
      </p>
      {/* The chart focused from the keyboard reads the same window text as its value, so the status leaves that out then. */}
      <p className="visually-hidden" role="status">
        {mask(announcement)}
      </p>
    </div>
  );
}

const HELP_ITEMS = ["pan", "zoom", "select", "overview", "back"] as const;

function TimelineHelp() {
  const { t } = useI18n();
  return (
    <div className="timeline-help">
      <p className="timeline-help-title">{t("timeline.help")}</p>
      <dl>
        {HELP_ITEMS.map((item) => (
          <div key={item}>
            <dt>{t(`timeline.helpItems.${item}.label`)}</dt>
            <dd>{t(`timeline.helpItems.${item}.text`)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Two dates within the history; both days are included. */
function CustomRange({
  start,
  days,
  shown,
  onApply,
}: {
  start: string;
  days: number;
  shown: [number, number];
  onApply: (next: Viewport) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const first = dayIso(start, 0);
  const last = dayIso(start, days - 1);
  const [from, setFrom] = useState(() => dayIso(start, shown[0]));
  const [to, setTo] = useState(() => dayIso(start, shown[1]));
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="timeline-custom"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const next = dateViewport(from, to, start, days);
        setInvalid(next === null);
        if (next) onApply(next);
      }}
    >
      <p className="timeline-help-title">{t("timeline.customTitle")}</p>
      <div className="timeline-custom-fields">
        <label htmlFor={`${id}-from`}>{t("timeline.customFrom")}</label>
        <input
          id={`${id}-from`}
          type="date"
          min={first}
          max={last}
          value={from}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
          onChange={(event) => setFrom(event.target.value)}
        />
        <label htmlFor={`${id}-to`}>{t("timeline.customTo")}</label>
        <input
          id={`${id}-to`}
          type="date"
          min={first}
          max={last}
          value={to}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      {invalid ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {t("timeline.customInvalid")}
        </p>
      ) : (
        <p id={`${id}-hint`} className="muted small">
          {t("timeline.customHint")}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-sm btn-primary">
          {t("timeline.customApply")}
        </button>
      </div>
    </form>
  );
}

/** Stays focusable at the end of the range (aria-disabled), so keyboard focus is not lost while paging. */
function NavButton({
  disabled,
  onClick,
  title,
  icon = false,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  title: string;
  icon?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={icon ? "btn btn-sm btn-icon" : "btn btn-sm"}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </button>
  );
}

type Gesture =
  | { kind: "press"; id: number; x: number; y: number }
  | { kind: "pan"; id: number; x: number; origin: Viewport; lastX: number; lastT: number; velocity: number }
  | { kind: "pinch"; origin: Viewport; distance: number; pivot: number }
  | { kind: "select"; id: number };

function Plot({
  series,
  vp,
  vpRef,
  motion,
  picker,
  title,
  valueText,
  hintId,
  onFocusChange,
}: {
  series: Series;
  vp: Viewport;
  vpRef: RefObject<Viewport>;
  motion: Motion;
  picker: Picker;
  title: string;
  valueText: string;
  hintId: string;
  onFocusChange: (focused: boolean) => void;
}) {
  const { t, f } = useI18n();
  const { move, glide, halt, zoomTo, commit, back } = motion;
  const [measure, width] = useChartWidth();
  const el = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      el.current = node;
      measure(node);
    },
    [measure],
  );
  const [hover, hoverRef, setHover] = useFrameState<number | null>(() => null);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const longPress = useRef(0);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  // Where a long press started a selection, shown as a ring instead of a vibration.
  const [cue, setCue] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => () => clearTimeout(longPress.current), []);
  const clipId = `${useId().replace(/[^\w-]/g, "")}-clip`;
  const { start, days, values } = series;
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const bottom = HEIGHT - PAD.bottom;

  // Pointer math reads the element's live size, so it stays right between a resize and the next render.
  const geometry = useCallback(() => {
    const rect = el.current?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? rect.width / width : 1;
    return { left: (rect?.left ?? 0) + PAD.left * scale, plot: plotW * scale };
  }, [width, plotW]);
  const anchorAt = useCallback(
    (clientX: number) => {
      const g = geometry();
      return clamp((clientX - g.left) / g.plot, 0, 1);
    },
    [geometry],
  );
  const dayAt = (clientX: number) => {
    const c = vpRef.current;
    const day = Math.round(c.from + anchorAt(clientX) * (c.to - c.from));
    return clamp(day, 0, days - 1);
  };

  const latest = useRef({ anchorAt, geometry, move, commit, days });
  latest.current = { anchorAt, geometry, move, commit, days };
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    // A run of wheel zooms is one step back.
    let wheelOrigin: Viewport | null = null;
    let wheelTimer = 0;
    const onWheel = (e: WheelEvent) => {
      const { anchorAt, geometry, move, days } = latest.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? geometry().plot : 1;
      const c = vpRef.current;
      // Trackpad pinches arrive as wheel events with ctrlKey set.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        wheelOrigin ??= c;
        clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => {
          if (wheelOrigin) latest.current.commit(wheelOrigin);
          wheelOrigin = null;
        }, SETTLE_MS);
        move(zoomBy(c, Math.exp(e.deltaY * unit * 0.01), anchorAt(e.clientX), days));
        return;
      }
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!horizontal && !e.shiftKey) return;
      e.preventDefault();
      const delta = horizontal ? e.deltaX : e.deltaY;
      move(panBy(c, (delta * unit * (c.to - c.from)) / geometry().plot, days));
    };
    // Safari reports trackpad pinches as gesture events instead.
    let pinchOrigin: Viewport | null = null;
    const onGesture = (e: Event) => {
      const g = e as Event & { scale: number; clientX: number };
      e.preventDefault();
      const { anchorAt, move, days } = latest.current;
      if (e.type === "gesturestart") pinchOrigin = vpRef.current;
      else if (e.type === "gestureend") {
        if (pinchOrigin) latest.current.commit(pinchOrigin);
        pinchOrigin = null;
      } else if (pinchOrigin) move(zoomBy(pinchOrigin, 1 / g.scale, anchorAt(g.clientX), days));
    };
    // Once a long press has started a selection, vertical moves extend it instead of scrolling the page.
    const onTouchMove = (e: TouchEvent) => {
      if (gesture.current?.kind === "select") e.preventDefault();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("gesturestart", onGesture);
    node.addEventListener("gesturechange", onGesture);
    node.addEventListener("gestureend", onGesture);
    return () => {
      clearTimeout(wheelTimer);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("gesturestart", onGesture);
      node.removeEventListener("gesturechange", onGesture);
      node.removeEventListener("gestureend", onGesture);
    };
  }, [vpRef]);

  function startSelection(pointerId: number, clientX: number) {
    capture(el.current, pointerId);
    gesture.current = { kind: "select", id: pointerId };
    const day = dayAt(clientX);
    picker.set({ anchor: day, head: day });
    setHover(null);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    halt();
    clearTimeout(longPress.current);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      if (gesture.current?.kind === "select") picker.set(null);
      setCue(null);
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const c = vpRef.current;
      const mid = (a.x + b.x) / 2;
      gesture.current = {
        kind: "pinch",
        origin: c,
        distance: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)),
        pivot: c.from + anchorAt(mid) * (c.to - c.from),
      };
      for (const id of pointers.current.keys()) capture(el.current, id);
      setHover(null);
    } else if (pointers.current.size === 1) {
      if (e.shiftKey) {
        startSelection(e.pointerId, e.clientX);
        return;
      }
      gesture.current = { kind: "press", id: e.pointerId, x: e.clientX, y: e.clientY };
      if (e.pointerType === "mouse") return;
      const pointerId = e.pointerId;
      longPress.current = window.setTimeout(() => {
        const g = gesture.current;
        if (g?.kind !== "press" || g.id !== pointerId) return;
        startSelection(pointerId, g.x);
        const rect = el.current?.getBoundingClientRect();
        setCue({ x: g.x - (rect?.left ?? 0), y: g.y - (rect?.top ?? 0) });
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const p = pointers.current.get(e.pointerId);
    if (!p) {
      if (e.pointerType === "mouse") setHover(dayAt(e.clientX));
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    let g = gesture.current;
    if (g?.kind === "select") {
      const picked = picker.ref.current;
      if (g.id === e.pointerId && picked) picker.set({ anchor: picked.anchor, head: dayAt(e.clientX) });
      return;
    }
    if (g?.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.max(24, Math.hypot(a.x - b.x, a.y - b.y));
      move(zoomAround(((g.origin.to - g.origin.from) * g.distance) / distance, g.pivot, anchorAt((a.x + b.x) / 2), days));
      return;
    }
    if (g?.kind === "press" && g.id === e.pointerId) {
      const dx = e.clientX - g.x;
      if (Math.hypot(dx, e.clientY - g.y) >= DRAG_START) clearTimeout(longPress.current);
      // Mostly vertical touch moves stay with the browser (touch-action: pan-y), which scrolls the page.
      if (Math.abs(dx) < DRAG_START || Math.abs(dx) <= Math.abs(e.clientY - g.y)) {
        if (e.pointerType === "mouse") setHover(dayAt(e.clientX));
        return;
      }
      capture(el.current, e.pointerId);
      g = { kind: "pan", id: e.pointerId, x: g.x, origin: vpRef.current, lastX: e.clientX, lastT: e.timeStamp, velocity: 0 };
      gesture.current = g;
      setDragging(true);
      setHover(null);
    }
    if (g?.kind === "pan" && g.id === e.pointerId) {
      const perPx = (g.origin.to - g.origin.from) / geometry().plot;
      move(panBy(g.origin, -(e.clientX - g.x) * perPx, days));
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.velocity = 0.7 * ((-(e.clientX - g.lastX) * perPx) / dt) + 0.3 * g.velocity;
      g.lastX = e.clientX;
      g.lastT = e.timeStamp;
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    clearTimeout(longPress.current);
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === "select" && g.id === e.pointerId) {
      setCue(null);
      picker.apply();
    } else if (g?.kind === "press" && g.id === e.pointerId) {
      const previous = lastTap.current;
      if (previous && e.timeStamp - previous.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 24) {
        lastTap.current = null;
        setHover(null);
        back();
      } else {
        lastTap.current = { time: e.timeStamp, x: e.clientX, y: e.clientY };
        const day = dayAt(e.clientX);
        setHover(e.pointerType !== "mouse" && hoverRef.current === day ? null : day);
      }
    } else if (g?.kind === "pan" && g.id === e.pointerId && e.timeStamp - g.lastT < 80 && Math.abs(g.velocity) > 0.002) {
      glide(g.velocity);
    }
    if (g?.kind === "pinch" && pointers.current.size === 0) commit(g.origin);
    if (g?.kind !== "pinch" || pointers.current.size === 0) gesture.current = null;
    if (pointers.current.size === 0) setDragging(false);
  }

  function onPointerCancel(e: PointerEvent<HTMLDivElement>) {
    clearTimeout(longPress.current);
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === "select") picker.set(null);
    if (g?.kind === "pinch") commit(g.origin);
    setCue(null);
    gesture.current = null;
    setDragging(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const picked = picker.ref.current;
    if (e.key === "Escape") {
      picker.set(null);
      setHover(null);
      return;
    }
    if (e.key === "Enter" && picked) {
      e.preventDefault();
      picker.apply();
      return;
    }
    const range = e.shiftKey ? keySelection(e.key, picked, vpRef.current, days) : null;
    if (range) {
      e.preventDefault();
      setHover(null);
      picker.set(range);
      return;
    }
    const next = keyViewport(e.key, vpRef.current, days);
    if (!next) return;
    e.preventDefault();
    if (picked) picker.set(null);
    (ZOOM_KEYS.has(e.key) ? zoomTo : move)(next, e.repeat ? "now" : "animate");
  }

  const [d0, d1] = visibleDays(vp, days);
  const e0 = Math.max(0, d0 - 1);
  const e1 = Math.min(days - 1, d1 + 1);
  const range = extent(values, d0, d1);
  const ticks = range ? valueTicks(range.min, range.max) : [];
  const y = linear([ticks[0] ?? 0, ticks.at(-1) ?? 1], [bottom, PAD.top]);
  const x = (day: number) => PAD.left + ((day - vp.from) / (vp.to - vp.from)) * plotW;
  const points = downsample(values, e0, e1, Math.round(plotW)).map(([d, v]): [number, number] => [x(d), y(v)]);
  const line = linePath(points);
  const [firstX] = points[0] ?? [0];
  const [lastX] = points.at(-1) ?? [0];
  const labels = xTicks(start, vp, plotW).filter((tick) => x(tick.day) >= PAD.left - 4 && x(tick.day) <= width - 22);
  const label = (day: number, kind: "day" | "month" | "year") => {
    const iso = dayIso(start, day);
    return kind === "day" ? f.dayShort(iso) : kind === "month" ? f.monthShort(iso) : f.year(iso);
  };
  const money = (cents: number) => (cents < 0 ? f.signed(cents) : f.euro(cents));
  const active = hover !== null && hover >= d0 && hover <= d1 && !Number.isNaN(values[hover] ?? Number.NaN) ? hover : null;
  const activeFlows = active === null ? null : sumFlows(series.flows, active, active);
  const picked = picker.selection ? selectionDays(picker.selection) : null;

  return (
    <div
      ref={setRef}
      className="chart timeline-plot"
      role="slider"
      tabIndex={0}
      aria-label={title}
      aria-describedby={hintId}
      aria-valuemin={Math.round(bounds(days).lo)}
      aria-valuemax={Math.round(bounds(days).hi)}
      aria-valuenow={Math.round(vp.to)}
      aria-valuetext={valueText}
      data-dragging={dragging || undefined}
      data-selecting={picked ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse" && !gesture.current) setHover(null);
      }}
      onContextMenu={(e) => {
        // A long press on touch screens opens the context menu, which would end the selection.
        if (gesture.current) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onFocus={(e) => onFocusChange(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => {
        setHover(null);
        onFocusChange(false);
      }}
    >
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={0} width={plotW} height={HEIGHT} />
          </clipPath>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "axis-line" : "grid-line"} x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="money" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
              {f.axis(tick)}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {points.length > 1 && <path className="timeline-area" d={`${line}L${lastX},${bottom}L${firstX},${bottom}Z`} />}
          {picked && (
            <g className="timeline-selection">
              <rect x={x(picked[0])} y={PAD.top} width={Math.max(0, x(picked[1]) - x(picked[0]))} height={bottom - PAD.top} />
              <line x1={x(picked[0])} x2={x(picked[0])} y1={PAD.top} y2={bottom} />
              <line x1={x(picked[1])} x2={x(picked[1])} y1={PAD.top} y2={bottom} />
            </g>
          )}
          <path className="timeline-line" d={line} />
          {active !== null && (
            <g className="timeline-cross">
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={bottom} />
              <circle cx={x(active)} cy={y(values[active] ?? 0)} r={4} />
            </g>
          )}
        </g>
        {labels.map((tick) => (
          <text key={tick.day} x={x(tick.day)} y={HEIGHT - 8} textAnchor="middle">
            {label(tick.day, tick.kind)}
          </text>
        ))}
        {!range && (
          <text x={PAD.left + plotW / 2} y={HEIGHT / 2} textAnchor="middle">
            {t("timeline.unknown")}
          </text>
        )}
      </svg>
      {cue && <span className="timeline-press-cue" aria-hidden="true" style={{ left: cue.x, top: cue.y }} />}
      {active !== null && (
        <div className="chart-tooltip" aria-hidden="true" style={{ left: clamp(x(active), 84, width - 84), top: PAD.top }}>
          <strong>{f.date(dayIso(start, active))}</strong>
          <dl>
            <dt>
              <span className="swatch" style={{ background: "var(--s1)" }} />
              {t("common.fields.balance")}
            </dt>
            <dd className="money">{money(values[active] ?? 0)}</dd>
            {activeFlows && activeFlows.inCents > 0 && (
              <>
                <dt>{t("accounts.detail.in")}</dt>
                <dd className="money">{f.signed(activeFlows.inCents)}</dd>
              </>
            )}
            {activeFlows && activeFlows.outCents > 0 && (
              <>
                <dt>{t("accounts.detail.out")}</dt>
                <dd className="money">{f.signed(-activeFlows.outCents)}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

type Zone = "thumb" | "from" | "to" | "outside";

/**
 * The whole history in miniature with the visible window on it: drag the window to pan, drag its handles to resize
 * it, drag elsewhere to draw a new one, or tap a spot to go there.
 */
function Scrubber({
  series,
  vp,
  vpRef,
  motion,
  picker,
}: {
  series: Series;
  vp: Viewport;
  vpRef: RefObject<Viewport>;
  motion: Motion;
  picker: Picker;
}) {
  const { move, halt, commit } = motion;
  const [measure, width] = useChartWidth();
  const el = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      el.current = node;
      measure(node);
    },
    [measure],
  );
  const press = useRef<{ id: number; x: number; y: number; origin: Viewport; zone: Zone; dragging: boolean } | null>(null);
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);
  const { days, values } = series;
  const { lo, hi } = bounds(days);
  const full = hi - lo;
  const area = useMemo(() => {
    const range = extent(values, 0, days - 1);
    if (!range) return "";
    const x = linear([lo, hi], [0, width]);
    const y = linear([range.min, range.max === range.min ? range.min + 1 : range.max], [30, 4]);
    const points = downsample(values, 0, days - 1, Math.round(width / 2)).map(([d, v]): [number, number] => [x(d), y(v)]);
    const [firstX] = points[0] ?? [0];
    const [lastX] = points.at(-1) ?? [0];
    return points.length > 1 ? `${linePath(points)}L${lastX},32L${firstX},32Z` : "";
  }, [values, days, lo, hi, width]);

  const box = () => {
    const rect = el.current?.getBoundingClientRect();
    return { left: rect?.left ?? 0, width: rect?.width || 1 };
  };
  const dayAt = (clientX: number) => {
    const b = box();
    return lo + clamp((clientX - b.left) / b.width, 0, 1) * full;
  };
  const wholeDay = (clientX: number) => clamp(Math.round(dayAt(clientX)), 0, days - 1);
  // Handles reach 22 px to each side on touch (a 44 px target), 8 px for a mouse; a narrow window keeps its middle for panning.
  const zoneAt = (clientX: number, touch: boolean): Zone => {
    const b = box();
    const c = vpRef.current;
    const px = clientX - b.left;
    const left = ((c.from - lo) / full) * b.width;
    const right = ((c.to - lo) / full) * b.width;
    const reach = touch ? 22 : 8;
    const inner = Math.min(reach, (right - left) / 4);
    if (px > left + inner && px < right - inner) return "thumb";
    const toLeft = Math.abs(px - left);
    const toRight = Math.abs(px - right);
    if (Math.min(toLeft, toRight) <= reach) return toLeft <= toRight ? "from" : "to";
    return "outside";
  };

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    halt();
    const zone = zoneAt(e.clientX, e.pointerType !== "mouse");
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: vpRef.current, zone, dragging: false };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    if (!p) {
      if (e.pointerType === "mouse") setHoverZone(zoneAt(e.clientX, false));
      return;
    }
    if (p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    if (!p.dragging) {
      if (Math.abs(dx) < DRAG_START || Math.abs(dx) <= Math.abs(e.clientY - p.y)) return;
      p.dragging = true;
      capture(el.current, e.pointerId);
      if (p.zone === "outside") {
        const day = wholeDay(p.x);
        picker.set({ anchor: day, head: day });
      }
    }
    const shift = (dx / box().width) * full;
    if (p.zone === "thumb") move(panBy(p.origin, shift, days));
    else if (p.zone === "from" || p.zone === "to") move(resizeViewport(p.origin, p.zone, p.origin[p.zone] + shift, days));
    else {
      const picked = picker.ref.current;
      if (picked) picker.set({ anchor: picked.anchor, head: wholeDay(e.clientX) });
    }
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== e.pointerId) return;
    if (p.dragging) {
      if (p.zone === "from" || p.zone === "to") commit(p.origin);
      else if (p.zone === "outside") picker.apply();
      return;
    }
    const c = vpRef.current;
    const half = (c.to - c.from) / 2;
    const center = dayAt(e.clientX);
    move({ from: center - half, to: center + half }, "animate");
  }
  function onPointerCancel() {
    const p = press.current;
    press.current = null;
    if (!p?.dragging) return;
    if (p.zone === "from" || p.zone === "to") commit(p.origin);
    else if (p.zone === "outside") picker.set(null);
  }

  const percent = (day: number) => `${((day - lo) / full) * 100}%`;
  const picked = picker.selection ? selectionDays(picker.selection) : null;
  return (
    <div
      ref={setRef}
      className="timeline-scrubber"
      aria-hidden="true"
      data-zone={press.current?.dragging ? press.current.zone : (hoverZone ?? undefined)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setHoverZone(null)}
    >
      <svg viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path className="timeline-scrubber-area" d={area} />
      </svg>
      <span className="timeline-thumb" style={{ left: percent(vp.from), width: `${((vp.to - vp.from) / full) * 100}%` }}>
        <span className="timeline-handle timeline-handle-from" />
        <span className="timeline-handle timeline-handle-to" />
      </span>
      {picked && (
        <span className="timeline-draft" style={{ left: percent(picked[0]), width: `${((picked[1] - picked[0]) / full) * 100}%` }} />
      )}
    </div>
  );
}
