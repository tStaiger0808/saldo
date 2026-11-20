import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/react.tsx";
import { type Notice, useAction } from "../lib/action.ts";
import { useFormErrors } from "../lib/forms.ts";
import { resolveDashboardPeriod, resolvePeriod } from "../lib/periods.ts";
import { recategorizePreviewFn, startRecategorizeFn } from "../server/functions/ai.ts";
import { ConfirmDialog, FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Banner } from "./Status.tsx";
import { statusLabel, type TaskView, useTasks } from "./Tasks.tsx";

type Target = "uncategorized" | "includeAi";
type Scope = { dateFrom: string | null; dateTo: string | null; target: Target };
export const RECATEGORIZE_SCOPES = ["last_30_days", "last_3_months", "all", "custom"] as const;
export type ScopeChoice = (typeof RECATEGORIZE_SCOPES)[number];
/** What the dialog starts with: a choice, and for "custom" its dates. */
export type ScopeStart = { choice: ScopeChoice; dateFrom?: string | null; dateTo?: string | null };

const CATEGORIZING = new Set<TaskView["kind"]>(["aiCategorize", "aiRecategorize", "aiAutoCategorize"]);
const OUTCOME_TONE = { done: "ok", failed: "danger", cancelled: "info" } as const;

function rangeOf(choice: ScopeChoice, from: string, to: string): { dateFrom: string | null; dateTo: string | null } {
  if (choice === "all") return { dateFrom: null, dateTo: null };
  if (choice === "custom") return { dateFrom: from, dateTo: to };
  if (choice === "last_30_days") {
    const { dateFrom, dateTo } = resolveDashboardPeriod("last_30_days", null);
    return { dateFrom, dateTo };
  }
  return resolvePeriod(choice);
}

/**
 * "Mit KI neu kategorisieren": pick a period, see how many counterparties that sends, confirm, and the run continues as a
 * background task. `onNotice` reports the start and how the task ended; the page data reloads when it is done. The page
 * shows `dialogs` and calls `open` from its action.
 */
export function useRecategorize({
  groupId,
  start,
  onNotice,
}: {
  groupId: number | null;
  start?: ScopeStart;
  onNotice: (notice: Notice | null) => void;
}): { open: () => void; busy: boolean; running: boolean; dialogs: ReactNode } {
  const { t } = useI18n();
  const router = useRouter();
  const { tasks, refresh } = useTasks();
  const recategorize = useAction(startRecategorizeFn, { invalidate: false });
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState<{ scope: Scope; payees: number; bookings: number } | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const running = tasks.some((task) => task.status === "running" && CATEGORIZING.has(task.kind));

  useEffect(() => {
    const ended = tasks.find((task) => task.id === started && task.status !== "running");
    if (!ended || ended.status === "running") return;
    setStarted(null);
    onNotice({
      tone: OUTCOME_TONE[ended.status],
      text: t("tasks.outcome", { status: statusLabel(t, ended), message: ended.message ?? "" }),
    });
    if (ended.status === "done") void router.invalidate();
  }, [tasks, started, onNotice, t, router]);

  async function run(scope: Scope) {
    onNotice(null);
    const r = await recategorize.run({ data: { groupId, ...scope } });
    if (!r.ok) return onNotice({ tone: "danger", text: r.error });
    setStarted(r.value.taskId);
    onNotice({ tone: "info", text: t("tasks.started") });
    await refresh();
  }

  const dialogs = (
    <>
      {choosing && (
        <RecategorizeDialog
          groupId={groupId}
          start={start}
          onClose={() => setChoosing(false)}
          onChecked={(scope, preview) => {
            setChoosing(false);
            if (preview.payees === 0) onNotice({ tone: "ok", text: t("analysis.ai.recategorizeNothing") });
            else setPending({ scope, ...preview });
          }}
        />
      )}
      <ConfirmDialog
        open={pending !== null}
        title={t("analysis.ai.recategorizeConfirmTitle", { count: pending?.payees ?? 0 })}
        confirmLabel={t("analysis.ai.recategorizeConfirm")}
        onConfirm={() => pending && void run(pending.scope)}
        onClose={() => setPending(null)}
      >
        <p>{t("analysis.ai.recategorizeConfirmText", { bookings: t("analysis.ai.bookings", { count: pending?.bookings ?? 0 }) })}</p>
      </ConfirmDialog>
    </>
  );
  return {
    open: () => {
      onNotice(null);
      setChoosing(true);
    },
    busy: recategorize.busy,
    running,
    dialogs,
  };
}

const COUNT_DELAY_MS = 300;

/** How many bookings and counterparties the current choice would send, asked again shortly after each change. */
function useAffected(groupId: number | null, choice: ScopeChoice, from: string, to: string, target: Target) {
  const count = useAction(recategorizePreviewFn, { invalidate: false });
  // The count only follows the choice; a new `run` identity alone must not ask again.
  const run = useRef(count.run);
  run.current = count.run;
  const [affected, setAffected] = useState<{ payees: number; bookings: number } | "loading" | null>(null);
  useEffect(() => {
    if (choice === "custom" && (!from || !to || from > to)) {
      setAffected(null);
      return;
    }
    let current = true;
    setAffected("loading");
    const timer = setTimeout(async () => {
      const r = await run.current({ data: { groupId, ...rangeOf(choice, from, to), target } });
      if (current) setAffected(r.ok ? r.value : null);
    }, COUNT_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [groupId, choice, from, to, target]);
  return affected;
}

/** Picks the period to re-categorize and asks the server how many counterparties that would send. */
function RecategorizeDialog({
  groupId,
  start,
  onClose,
  onChecked,
}: {
  groupId: number | null;
  start?: ScopeStart;
  onClose: () => void;
  onChecked: (scope: Scope, preview: { payees: number; bookings: number }) => void;
}) {
  const { t } = useI18n();
  const name = useId();
  const [choice, setChoice] = useState<ScopeChoice>(start?.choice ?? "last_3_months");
  const [from, setFrom] = useState(start?.dateFrom ?? "");
  const [to, setTo] = useState(start?.dateTo ?? "");
  const [target, setTarget] = useState<Target>("uncategorized");
  const targetName = useId();
  const { form, errors, check, clear } = useFormErrors<{ from: string; to: string }>();
  const preview = useAction(recategorizePreviewFn, { invalidate: false });
  const affected = useAffected(groupId, choice, from, to, target);
  const label = (value: ScopeChoice) =>
    value === "all" ? t("analysis.ai.periodAll") : value === "custom" ? t("analysis.ai.periodCustom") : t(`periods.${value}`);

  async function submit() {
    if (choice === "custom") {
      const ok = check({
        from: from ? undefined : t("analysis.ai.datesRequired"),
        to: !to ? t("analysis.ai.datesRequired") : from && from > to ? t("analysis.ai.datesOrder") : undefined,
      });
      if (!ok) return;
    }
    const scope: Scope = { ...rangeOf(choice, from, to), target };
    const r = await preview.run({ data: { groupId, ...scope } });
    if (r.ok) onChecked(scope, r.value);
  }

  return (
    <FormDialog
      title={t("analysis.ai.recategorizeTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={preview.busy} aria-busy={preview.busy}>
            {t("analysis.ai.recategorizeNext")}
          </button>
        </>
      }
    >
      {preview.error && <Banner tone="danger">{preview.error}</Banner>}
      <p className="muted">{t("analysis.ai.recategorizeIntro")}</p>
      <fieldset className="field">
        <legend>{t("analysis.ai.targetLegend")}</legend>
        {(["uncategorized", "includeAi"] as const).map((value) => (
          <label key={value} className="checkbox">
            <input type="radio" name={targetName} value={value} checked={target === value} onChange={() => setTarget(value)} />
            {t(`analysis.ai.target.${value}`)}
          </label>
        ))}
      </fieldset>
      <fieldset className="field">
        <legend>{t("common.fields.period")}</legend>
        {RECATEGORIZE_SCOPES.map((value) => (
          <label key={value} className="checkbox">
            <input type="radio" name={name} value={value} checked={choice === value} onChange={() => setChoice(value)} />
            {label(value)}
          </label>
        ))}
      </fieldset>
      {choice === "custom" && (
        <div className="form-grid">
          <Field label={t("transactions.filter.from")} error={errors.from}>
            {(control) => (
              <input
                {...control}
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  clear("from");
                }}
              />
            )}
          </Field>
          <Field label={t("transactions.filter.to")} error={errors.to}>
            {(control) => (
              <input
                {...control}
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  clear("to");
                }}
              />
            )}
          </Field>
        </div>
      )}
      <p className="recategorize-count" role="status">
        {affected === "loading"
          ? t("analysis.ai.countLoading")
          : affected === null
            ? ""
            : affected.bookings === 0
              ? t("analysis.ai.countNone")
              : t("analysis.ai.countAffects", {
                  bookings: t("analysis.ai.bookings", { count: affected.bookings }),
                  payees: affected.payees,
                })}
      </p>
    </FormDialog>
  );
}
