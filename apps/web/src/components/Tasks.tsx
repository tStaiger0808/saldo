import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useI18n } from "../i18n/react.tsx";
import { errorMessage } from "../lib/action.ts";
import { useAiDetails } from "../lib/ai-details.ts";
import { cancelTaskFn, getTasksFn } from "../server/functions/tasks.ts";
import { useBankJobs } from "./BankJobs.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Banner, Status, type StatusTone } from "./Status.tsx";

export type TaskView = Awaited<ReturnType<typeof getTasksFn>>[number];

const appRoute = getRouteApi("/_app");

const BUSY_MS = 3_000;
const IDLE_MS = 15_000;

type Context = {
  /** Running tasks first, then the ones finished within the last hour. */
  tasks: TaskView[];
  running: TaskView[];
  /** Fetches the list now, e.g. right after a task was started here. */
  refresh: () => Promise<void>;
};

const TasksContext = createContext<Context | null>(null);

export function useTasks(): Context {
  const context = useContext(TasksContext);
  if (!context) throw new Error("useTasks outside TasksProvider");
  return context;
}

export function statusLabel(t: Translate, task: TaskView): string {
  return task.waiting ? t("tasks.status.waiting") : t(`tasks.status.${task.status}`);
}

const TONES: Record<TaskView["status"], StatusTone> = { running: "info", done: "ok", failed: "danger", cancelled: "neutral" };

/**
 * The one polling loop for background work: often while a task runs, rarely otherwise, and only while the tab is
 * visible. When a task ends the page data is reloaded and the end is announced politely.
 */
export function TasksProvider({ initial, children }: { initial: TaskView[]; children: ReactNode }) {
  const router = useRouter();
  const fetchTasks = useServerFn(getTasksFn);
  const { t } = useI18n();
  const [tasks, setTasks] = useState(initial);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(initial);
  useEffect(() => setTasks(initial), [initial]);

  const refresh = useCallback(async () => {
    const next = await fetchTasks().catch(() => null);
    if (next) setTasks(next);
  }, [fetchTasks]);

  const busy = tasks.some((task) => task.status === "running");
  useEffect(() => {
    let stopped = false;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      const next = await fetchTasks().catch(() => null);
      if (!stopped && next) setTasks(next);
    }
    const timer = setInterval(poll, busy ? BUSY_MS : IDLE_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [busy, fetchTasks]);

  useEffect(() => {
    const before = previous.current;
    previous.current = tasks;
    if (before === tasks) return;
    const wasRunning = (id: string) => before.some((task) => task.id === id && task.status === "running");
    const vanished = before.some((task) => task.status === "running" && !tasks.some((next) => next.id === task.id));
    // A task may start and end between two polls; it is new and already finished then.
    const finished = tasks.filter((task) => task.status !== "running" && (wasRunning(task.id) || !before.some((b) => b.id === task.id)));
    if (finished.length === 0 && !vanished) return;
    // The end of a bank sync is announced with its result by BankJobsProvider.
    const told = finished.filter((task) => task.job?.kind !== "sync");
    if (told.length > 0) {
      setAnnouncement(told.map((task) => t("tasks.announce", { title: task.title, status: statusLabel(t, task) })).join(" · "));
    }
    void router.invalidate();
  }, [tasks, router, t]);

  const value = useMemo(() => ({ tasks, running: tasks.filter((task) => task.status === "running"), refresh }), [tasks, refresh]);

  return (
    <TasksContext.Provider value={value}>
      {children}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </TasksContext.Provider>
  );
}

/** Running and recently finished tasks in a drawer, like the notifications. */
export function TasksDialog({ onClose }: { onClose: () => void }) {
  const { tasks, running, refresh } = useTasks();
  const { t } = useI18n();
  const runningId = useId();
  const finishedId = useId();
  const finished = tasks.filter((task) => task.status !== "running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <FormDialog
      title={t("tasks.title")}
      variant="drawer"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}
      <p className="muted small">{t("tasks.intro")}</p>
      {tasks.length === 0 && <p className="empty">{t("tasks.empty")}</p>}
      {running.length > 0 && (
        <section className="stack-sm" aria-labelledby={runningId}>
          <h3 id={runningId}>{t("tasks.running")}</h3>
          <ul className="list task-list">
            {running.map((task) => (
              <TaskRow key={task.id} task={task} onClose={onClose} onError={setError} />
            ))}
          </ul>
        </section>
      )}
      {finished.length > 0 && (
        <section className="stack-sm" aria-labelledby={finishedId}>
          <h3 id={finishedId}>{t("tasks.finished")}</h3>
          <ul className="list task-list">
            {finished.map((task) => (
              <TaskRow key={task.id} task={task} onClose={onClose} onError={setError} />
            ))}
          </ul>
        </section>
      )}
    </FormDialog>
  );
}

function TaskRow({ task, onClose, onError }: { task: TaskView; onClose: () => void; onError: (message: string | null) => void }) {
  const { t, f } = useI18n();
  const { refresh } = useTasks();
  const { follow } = useBankJobs();
  const cancel = useServerFn(cancelTaskFn);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const { user } = appRoute.useRouteContext();
  const { aiAllowed } = appRoute.useLoaderData();
  const details = useAiDetails(user, aiAllowed);
  const running = task.status === "running";
  const who = task.startedBy === null ? t("tasks.automatic") : task.startedBy.name || t("tasks.unknownUser");
  const tokens = details && !running && task.tokens !== null ? ` · ${t("tasks.tokens", { count: task.tokens })}` : "";

  async function stop() {
    setBusy(true);
    onError(null);
    try {
      await cancel({ data: { taskId: task.id } });
      await refresh();
    } catch (e) {
      onError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function openJob(jobId: string) {
    onClose();
    await follow(jobId, task.title);
  }

  return (
    <li className="list-row">
      <span className="list-main task-main">
        <span className="list-title" id={titleId}>
          {task.title}
        </span>
        <span className="list-sub">
          {t("tasks.startedBy", { who, at: f.dateTime(task.startedAt) })}
          {task.finishedAt && ` · ${t("tasks.finishedAt", { at: f.dateTime(task.finishedAt) })}`}
        </span>
        {running && task.progress && <TaskProgress progress={task.progress} labelledBy={titleId} />}
        <Status
          tone={task.waiting ? "warn" : TONES[task.status]}
          emphasis={task.waiting || task.status === "failed" ? "urgent" : undefined}
        >
          {statusLabel(t, task)}
        </Status>
        {task.message && (
          <span className="task-message">
            {task.message}
            {tokens}
          </span>
        )}
      </span>
      {running && (task.job || task.cancellable) && (
        <span className="actions list-actions">
          {task.job && (
            <button type="button" className="btn btn-sm" onClick={() => task.job && openJob(task.job.id)}>
              {task.waiting ? t("tasks.enterTan") : t("tasks.openJob")}
              <span className="visually-hidden">: {task.title}</span>
            </button>
          )}
          {task.cancellable && (
            <button type="button" className="btn btn-sm" disabled={busy} aria-busy={busy} onClick={stop}>
              {t("tasks.cancel")}
              <span className="visually-hidden">: {task.title}</span>
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function TaskProgress({ progress, labelledBy }: { progress: NonNullable<TaskView["progress"]>; labelledBy: string }) {
  const { t } = useI18n();
  const text = t(`tasks.progress.${progress.unit}`, { done: progress.done, total: progress.total });
  const share = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <span className="task-progress">
      <span
        className="task-progress-track"
        role="progressbar"
        aria-labelledby={labelledBy}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-valuetext={text}
      >
        <span style={{ width: `${share * 100}%` }} />
      </span>
      <span className="list-sub" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
