/**
 * In-memory registry of long-running work (bank fetches, AI categorization), so the shell can show what runs and how
 * it ended. Like the bank jobs it lives in the single app process; a restart forgets it, which is fine for a status list.
 */
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale, msg, render, type Translatable } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { isSuperuser, manageableConnectionIds, type Viewer } from "../access/index.ts";

export type TaskKind =
  | "bankSync"
  | "bankDiscover"
  | "aiCategorize"
  | "aiRecategorize"
  | "aiAutoCategorize"
  | "aiAnalysis"
  | "backup"
  | "restore";
export type TaskStatus = "running" | "done" | "failed" | "cancelled";
export type TaskProgress = { done: number; total: number; unit: "batch" | "account" | "step" };
type Text = Translatable | string;

/** The bank job behind a bank task; its dialog takes the TAN. */
export type TaskJob = { id: string; connectionId: number; kind: "sync" | "discover"; status: string };

export type TaskState = {
  status: TaskStatus;
  progress: TaskProgress | null;
  /** The current step while running, the result or the failure once finished. */
  message: Text | null;
  /** Waits for the person, e.g. for a TAN or an app approval. */
  waiting: boolean;
  cancellable: boolean;
  finishedAt: number | null;
  /** AI tokens (input and output) the work used so far; null when it called no model. */
  tokens: number | null;
};

/** Anything listed as a task: work run by `startTask`, or an adapter over another registry such as the bank jobs. */
export interface TaskEntry {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: Translatable;
  /** User id; null for automatic work (schedule, after a sync). */
  readonly startedBy: string | null;
  readonly startedAt: number;
  readonly job: (() => TaskJob) | null;
  state(): TaskState;
  cancel(): void;
}

export type TaskView = {
  id: string;
  kind: TaskKind;
  title: string;
  /** Null when the task started automatically. */
  startedBy: { name: string | null } | null;
  startedAt: string;
  finishedAt: string | null;
  status: TaskStatus;
  progress: TaskProgress | null;
  message: string | null;
  waiting: boolean;
  cancellable: boolean;
  job: TaskJob | null;
  tokens: number | null;
};

/** What running work sees of its task: report progress and AI usage, and look for a cancel between steps. */
export type TaskControl = Pick<Task, "step" | "shouldStop" | "meter">;

export const taskLimits = { retentionMs: 60 * 60_000, maxFinished: 50 };

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Work started with `startTask`. A cancel is a request: the work asks `shouldStop()` between its steps, finishes the
 * step in flight and keeps what earlier steps did. Only work that actually stopped ends as cancelled.
 */
export class Task<T = unknown> implements TaskEntry {
  readonly id = randomBytes(12).toString("base64url");
  readonly startedAt = Date.now();
  readonly job = null;
  status: TaskStatus = "running";
  progress: TaskProgress | null = null;
  message: Text | null = null;
  finishedAt: number | null = null;
  tokens: number | null = null;
  /** Resolves when the task ended, never rejects. */
  readonly settled: Promise<Settled<T>>;
  private cancelRequested = false;
  private stopped = false;
  private settle: (outcome: Settled<T>) => void = () => undefined;

  constructor(
    readonly kind: TaskKind,
    readonly title: Translatable,
    readonly startedBy: string | null,
    private readonly cancellable: boolean,
  ) {
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  state(): TaskState {
    return {
      status: this.status,
      progress: this.progress,
      message: this.message,
      waiting: false,
      cancellable: this.cancellable && this.status === "running" && !this.cancelRequested,
      finishedAt: this.finishedAt,
      tokens: this.tokens,
    };
  }

  step(done: number, total: number, unit: TaskProgress["unit"]): void {
    this.progress = { done, total, unit };
  }

  /** Adds the tokens of one model call; a call without reported usage adds nothing. */
  meter(usage: { inputTokens: number; outputTokens: number; reported: boolean }): void {
    if (usage.reported) this.tokens = (this.tokens ?? 0) + usage.inputTokens + usage.outputTokens;
  }

  cancel(): void {
    if (!this.cancellable || this.status !== "running") return;
    this.cancelRequested = true;
    this.message = msg("tasks.stopping");
  }

  /** True once a cancel was requested; the caller then stops before its next step. */
  shouldStop(): boolean {
    if (this.cancelRequested) this.stopped = true;
    return this.cancelRequested;
  }

  finish(outcome: Settled<T>, summary: (value: T) => Text): void {
    if (outcome.ok) {
      this.status = this.stopped ? "cancelled" : "done";
      this.message = summary(outcome.value);
    } else {
      this.status = "failed";
      this.message = outcome.error instanceof UserError ? outcome.error.text : msg("common.genericError");
    }
    this.finishedAt = Date.now();
    this.settle(outcome);
  }
}

type Registry = Map<string, TaskEntry>;
// Nitro plugins and the SSR bundle may load separate module copies; the registry must be process-wide.
const KEY = Symbol.for("saldo.tasks");
const store = globalThis as unknown as Record<symbol, Registry | undefined>;

function registry(): Registry {
  let tasks = store[KEY];
  if (!tasks) {
    tasks = new Map();
    store[KEY] = tasks;
  }
  return tasks;
}

/** Drops finished tasks after an hour and keeps at most `maxFinished` of them; running ones always stay. */
function prune(): void {
  const tasks = registry();
  const cutoff = Date.now() - taskLimits.retentionMs;
  const finished: [string, number][] = [];
  for (const [id, entry] of tasks) {
    const { finishedAt } = entry.state();
    if (finishedAt === null) continue;
    if (finishedAt < cutoff) tasks.delete(id);
    else finished.push([id, finishedAt]);
  }
  finished.sort((a, b) => b[1] - a[1]);
  for (const [id] of finished.slice(taskLimits.maxFinished)) tasks.delete(id);
}

export function registerTask(entry: TaskEntry): void {
  prune();
  registry().set(entry.id, entry);
}

export type TaskMeta = { kind: TaskKind; title: Translatable; startedBy: string | null; cancellable: boolean };

/** Runs `work` detached and returns at once; the outcome lands in the task and in `settled`. */
export function startTask<T>(meta: TaskMeta, work: (task: TaskControl) => Promise<T>, summary: (value: T) => Text): Task<T> {
  const task = new Task<T>(meta.kind, meta.title, meta.startedBy, meta.cancellable);
  registerTask(task);
  void run(task, work, summary);
  return task;
}

async function run<T>(task: Task<T>, work: (task: TaskControl) => Promise<T>, summary: (value: T) => Text): Promise<void> {
  try {
    task.finish({ ok: true, value: await work(task) }, summary);
  } catch (error) {
    // Only the type: provider and driver messages can carry booking data.
    if (!(error instanceof UserError)) console.error(`Task ${task.kind} failed: ${error instanceof Error ? error.name : typeof error}`);
    task.finish({ ok: false, error }, summary);
  }
}

/** A running task of one of these kinds, e.g. to refuse a second categorization while one runs. */
export function runningTask(kinds: readonly TaskKind[]): TaskEntry | undefined {
  for (const entry of registry().values()) if (kinds.includes(entry.kind) && entry.state().status === "running") return entry;
  return undefined;
}

/** Superusers see every task; everyone else those they started and the bank jobs of connections they manage. */
async function visibilityFor(db: Db, viewer: Viewer): Promise<(entry: TaskEntry) => boolean> {
  if (isSuperuser(viewer)) return () => true;
  const connections = new Set(await manageableConnectionIds(db, viewer));
  return (entry) =>
    (entry.startedBy !== null && entry.startedBy === viewer.id) || (entry.job !== null && connections.has(entry.job().connectionId));
}

function view(entry: TaskEntry, names: Map<string, string>, locale: Locale): TaskView {
  const state = entry.state();
  return {
    id: entry.id,
    kind: entry.kind,
    title: render(locale, entry.title),
    startedBy: entry.startedBy === null ? null : { name: names.get(entry.startedBy) ?? null },
    startedAt: new Date(entry.startedAt).toISOString(),
    finishedAt: state.finishedAt === null ? null : new Date(state.finishedAt).toISOString(),
    status: state.status,
    progress: state.progress,
    message: state.message === null ? null : render(locale, state.message),
    waiting: state.waiting,
    cancellable: state.cancellable,
    job: entry.job?.() ?? null,
    tokens: state.tokens,
  };
}

/** Running tasks first (newest first), then the finished ones by end time. */
export async function listTasks(db: Db, viewer: Viewer): Promise<TaskView[]> {
  prune();
  const visible = await visibilityFor(db, viewer);
  const entries = [...registry().values()].filter(visible);
  const ids = [...new Set(entries.flatMap((entry) => (entry.startedBy === null ? [] : [entry.startedBy])))];
  const rows =
    ids.length === 0
      ? []
      : await db.select({ id: user.id, name: user.name, username: user.username }).from(user).where(inArray(user.id, ids));
  const names = new Map(rows.map((r) => [r.id, r.name || r.username || ""]));
  const views = entries.map((entry) => view(entry, names, viewer.locale ?? DEFAULT_LOCALE));
  const running = views.filter((v) => v.status === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const finished = views.filter((v) => v.status !== "running").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  return [...running, ...finished];
}

export const taskInput = z.object({ taskId: z.string().min(1).max(64) });

/** Asks a visible task to stop; a hidden task is a 404, one that cannot stop a 409. */
export async function cancelTask(db: Db, viewer: Viewer, input: z.input<typeof taskInput>): Promise<void> {
  const entry = registry().get(taskInput.parse(input).taskId);
  if (!entry || !(await visibilityFor(db, viewer))(entry)) throw new NotFound(msg("tasks.errors.notFound"));
  const state = entry.state();
  if (state.status !== "running") return;
  if (!state.cancellable) throw new UserError(msg("tasks.errors.notCancellable"), 409);
  entry.cancel();
}

export function resetTasksForTests(): void {
  for (const entry of registry().values()) entry.cancel();
  registry().clear();
}
