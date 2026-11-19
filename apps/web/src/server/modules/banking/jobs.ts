/**
 * In-memory registry of bank jobs. A FinTS job may wait minutes for a TAN, so jobs run detached from the request
 * and the UI polls their state. The app runs as a single process, so memory is the right place.
 */
import { randomBytes } from "node:crypto";
import { BankError, type TanChallenge } from "@saldo/banking";
import { DEFAULT_LOCALE, type Locale, msg, render } from "../../../i18n/index.ts";
import { UserError } from "../../errors.ts";
import { registerTask, type TaskEntry, type TaskState } from "../tasks/index.ts";
import { failureText, SaldoBankError, type Text } from "./texts.ts";

export type JobStatus = "running" | "tan_required" | "done" | "error" | "cancelled";
export type JobKind = "discover" | "sync";

/** New bookings of one account in a sync; on its first import they are the fetched history, not news. */
export type AccountResult = { accountId: number; name: string; newBookings: number; firstImport: boolean };

export type JobView = {
  id: string;
  connectionId: number;
  kind: JobKind;
  status: JobStatus;
  message: string;
  tan: TanChallenge | null;
  newBookings: number;
  accountsSynced: number;
  accounts: AccountResult[];
  error: string | null;
  /** The job started right after this one finished, e.g. the first sync of a just discovered connection. */
  next: string | null;
};

export const jobTiming = { tanTimeoutMs: 5 * 60_000, decoupledPollMs: 3_000, retentionMs: 60 * 60_000 };

export const APPROVAL_NEEDED = msg("banking.job.approvalNeeded");

class JobCancelled extends Error {}

/** Who started a job and the connection name for the task list; `startedBy` is null for scheduled runs. */
export type JobOrigin = { name: string; startedBy: string | null };

export class Job {
  readonly id = randomBytes(12).toString("base64url");
  status: JobStatus = "running";
  message: Text = msg("banking.job.connecting");
  /** The account the message names, so it can be left unnamed for someone who cannot see that account. */
  messageAccountId: number | null = null;
  tan: TanChallenge | null = null;
  newBookings = 0;
  accountsSynced = 0;
  error: Text | null = null;
  finishedAt: number | null = null;
  transactionIds: number[] = [];
  /** The new bookings left unread (all but the older history of a first import); only these are notified. */
  unreadTransactionIds: number[] = [];
  accounts: AccountResult[] = [];
  /** Accounts fetched so far of all linked ones, for the progress in the task list. */
  steps: { done: number; total: number } | null = null;
  /** Set when an unattended run was cancelled because the bank asked for a TAN or app approval. */
  approvalNeeded = false;
  next: string | null = null;
  private followUp: FollowUp | null = null;
  private cancelled = false;
  private wake: (() => void) | null = null;
  private typedTan: string | null = null;
  private decoupledSince: number | null = null;

  constructor(
    readonly connectionId: number,
    readonly kind: JobKind,
    readonly origin: JobOrigin,
    readonly unattended = false,
  ) {}

  /**
   * Messages stay translatable while the job runs; each poll renders them for whoever asks. With `visible` (the
   * viewer's visible accounts) accounts outside it are neither listed nor named.
   */
  view(locale: Locale = DEFAULT_LOCALE, visible: ReadonlySet<number> | null = null): JobView {
    const hidden = (accountId: number) => visible !== null && !visible.has(accountId);
    return {
      id: this.id,
      connectionId: this.connectionId,
      kind: this.kind,
      status: this.status,
      message: render(locale, this.namedMessage(hidden)),
      tan: this.status === "tan_required" ? this.tan : null,
      newBookings: this.newBookings,
      accountsSynced: this.accountsSynced,
      accounts: this.accounts.filter((a) => !hidden(a.accountId)),
      error: this.error === null ? null : render(locale, this.error),
      next: this.next,
    };
  }

  /** The message, or a neutral one when it names an account `hidden` says the reader cannot see. */
  namedMessage(hidden: (accountId: number) => boolean): Text {
    return this.messageAccountId !== null && hidden(this.messageAccountId) ? msg("banking.job.fetchingHidden") : this.message;
  }

  progress(message: Text, accountId: number | null = null): void {
    this.throwIfCancelled();
    this.status = "running";
    this.message = message;
    this.messageAccountId = accountId;
    this.tan = null;
    this.decoupledSince = null;
  }

  /** Resolves after `ms`, or early when a TAN arrives or the job is cancelled. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  async askTan(challenge: TanChallenge): Promise<string> {
    this.throwIfCancelled();
    // Nobody is there to type a TAN or approve in the app; waiting would only block the connection.
    if (this.unattended) {
      this.approvalNeeded = true;
      throw new JobCancelled();
    }
    this.status = "tan_required";
    this.message = challenge.decoupled ? msg("banking.job.approvalInApp") : msg("banking.job.tanRequired");
    this.messageAccountId = null;
    this.tan = challenge;
    if (challenge.decoupled) {
      this.decoupledSince ??= Date.now();
      if (Date.now() - this.decoupledSince > jobTiming.tanTimeoutMs) {
        throw new SaldoBankError(msg("banking.errors.approvalTimeout"));
      }
      await this.pause(jobTiming.decoupledPollMs);
      this.throwIfCancelled();
      return "";
    }
    this.typedTan = null;
    await this.pause(jobTiming.tanTimeoutMs);
    this.throwIfCancelled();
    const tan = this.typedTan;
    this.typedTan = null;
    if (tan === null) throw new SaldoBankError(msg("banking.errors.tanTimeout"));
    this.status = "running";
    this.message = msg("banking.job.checkingTan");
    this.messageAccountId = null;
    this.tan = null;
    return tan;
  }

  submitTan(tan: string): void {
    if (this.status !== "tan_required" || this.tan?.decoupled) throw new UserError(msg("banking.errors.noTanExpected"), 409);
    this.typedTan = tan.trim();
    this.wake?.();
  }

  /** Starts `next` in the same tick this job finishes successfully, so whoever sees it done also sees `next`. */
  afterwards(next: FollowUp): void {
    this.followUp = next;
  }

  /** Called once the job no longer blocks its connection. */
  startFollowUp(): void {
    if (this.status !== "done" || !this.followUp) return;
    try {
      this.next = this.followUp().id;
    } catch (error) {
      console.error(`Follow-up of bank job ${this.id} failed: ${error instanceof Error ? error.name : typeof error}`);
    }
  }

  cancel(): void {
    if (this.finishedAt !== null) return;
    this.cancelled = true;
    this.wake?.();
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new JobCancelled();
  }
}

type Registry = Map<string, Job>;
// Nitro plugins and the SSR bundle may load separate module copies; the registry must be process-wide.
const KEY = Symbol.for("saldo.bankJobs");
const store = globalThis as unknown as Record<symbol, Registry | undefined>;

function registry(): Registry {
  let jobs = store[KEY];
  if (!jobs) {
    jobs = new Map();
    store[KEY] = jobs;
  }
  return jobs;
}

export function getJob(id: string): Job | undefined {
  return registry().get(id);
}

export function activeJobs(): Job[] {
  return [...registry().values()].filter((job) => job.finishedAt === null);
}

export function activeJobFor(connectionId: number): Job | undefined {
  for (const job of registry().values()) if (job.connectionId === connectionId && job.finishedAt === null) return job;
  return undefined;
}

const TASK_STATUS: Record<JobStatus, TaskState["status"]> = {
  running: "running",
  tan_required: "running",
  done: "done",
  error: "failed",
  cancelled: "cancelled",
};

/** The task list is shared by everyone who manages the connection, so it never names an account. */
function jobResult(job: Job): Text {
  if (job.status !== "done") return job.namedMessage(() => true);
  return job.kind === "discover" ? msg("banking.jobs.discovered") : msg("tasks.bankResult", { count: job.newBookings });
}

/** The job as an entry of the task list; it reads the job live, so the list never lags behind the job dialog. */
function jobTask(job: Job): TaskEntry {
  return {
    id: job.id,
    kind: job.kind === "sync" ? "bankSync" : "bankDiscover",
    title: msg(job.kind === "sync" ? "tasks.kinds.bankSync" : "tasks.kinds.bankDiscover", { name: job.origin.name }),
    startedBy: job.origin.startedBy,
    startedAt: Date.now(),
    job: () => ({ id: job.id, connectionId: job.connectionId, kind: job.kind, status: job.status }),
    state: () => ({
      status: TASK_STATUS[job.status],
      progress: job.steps && { ...job.steps, unit: "account" },
      message: jobResult(job),
      waiting: job.status === "tan_required",
      // Only while it waits for the person: a cancel later could land between storing the bookings and assigning them.
      cancellable: job.status === "tan_required",
      finishedAt: job.finishedAt,
      tokens: null,
    }),
    cancel: () => job.cancel(),
  };
}

/** The job that follows a successful one, e.g. the first sync after a discovery. */
export type FollowUp = () => Job;

/** Starts `work` detached unless the connection already has a running job, which is returned instead. */
export function startJob(
  connectionId: number,
  kind: JobKind,
  origin: JobOrigin,
  work: (job: Job) => Promise<void>,
  unattended = false,
): Job {
  const jobs = registry();
  const cutoff = Date.now() - jobTiming.retentionMs;
  for (const [id, job] of jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
  const running = activeJobFor(connectionId);
  if (running) return running;
  const job = new Job(connectionId, kind, origin, unattended);
  jobs.set(job.id, job);
  registerTask(jobTask(job));
  void run(job, work);
  return job;
}

async function run(job: Job, work: (job: Job) => Promise<void>): Promise<void> {
  try {
    await work(job);
    job.status = "done";
    job.message = msg("banking.job.done");
  } catch (error) {
    if (error instanceof JobCancelled) {
      job.status = "cancelled";
      job.message = job.approvalNeeded ? APPROVAL_NEEDED : msg("banking.job.cancelled");
    } else {
      // Only the type: messages of driver errors can carry booking data.
      if (!(error instanceof BankError) && !(error instanceof UserError)) {
        console.error(`Bank job ${job.id} failed: ${error instanceof Error ? error.name : typeof error}`);
      }
      job.status = "error";
      job.error = failureText(error);
      job.message = job.error;
    }
  } finally {
    job.tan = null;
    job.messageAccountId = null;
    job.finishedAt = Date.now();
  }
  job.startFollowUp();
}

export function isCancellation(error: unknown): boolean {
  return error instanceof JobCancelled;
}

export function resetJobsForTests(): void {
  for (const job of registry().values()) job.cancel();
  registry().clear();
}
