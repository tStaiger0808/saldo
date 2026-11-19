import type { Translate } from "../i18n/index.ts";
import type { Notice } from "./action.ts";

export type JobStatus = "running" | "tan_required" | "done" | "error" | "cancelled";

/** A bank job as the job poll returns it (modules/banking `JobView`), reduced to what the screen needs. */
export type SyncJob = {
  id: string;
  connectionId: number;
  kind: "sync" | "discover";
  status: JobStatus;
  accounts: { accountId: number; name: string; newBookings: number; firstImport: boolean }[];
  error: string | null;
  next: string | null;
};

/** A running job as the task list reports it, also those started elsewhere or by the schedule. */
export type ActiveJob = { id: string; connectionId: number; kind: string; status: string };

/**
 * A job this tab follows. `dialog` jobs show in the job dialog; `quiet` ones only as progress ring and notice.
 * `observed` jobs were started elsewhere (another tab, the schedule): they never open the dialog by themselves.
 */
export type Tracked<J extends SyncJob = SyncJob> = { job: J; label: string; mode: "dialog" | "quiet"; observed: boolean };

const FINISHED: ReadonlySet<JobStatus> = new Set(["done", "error", "cancelled"]);

export const isFinished = (status: JobStatus): boolean => FINISHED.has(status);

/** A quiet job started here moves to the dialog once the bank asks for input or the job failed, and stays there. */
export function escalate<J extends SyncJob>(tracked: Tracked<J>[]): Tracked<J>[] {
  return tracked.map((t) =>
    t.mode === "quiet" && !t.observed && (t.job.status === "tan_required" || t.job.status === "error") ? { ...t, mode: "dialog" } : t,
  );
}

/** Connections whose accounts show the progress ring: a sync requested here, followed here or reported running. */
export function syncingConnections(tracked: readonly Tracked[], active: readonly ActiveJob[], pending: Iterable<number>): Set<number> {
  const ids = new Set(pending);
  const finishedHere = new Set(tracked.filter((t) => isFinished(t.job.status)).map((t) => t.job.id));
  for (const t of tracked) if (t.job.kind === "sync" && !isFinished(t.job.status)) ids.add(t.job.connectionId);
  for (const job of active) if (job.kind === "sync" && !finishedHere.has(job.id)) ids.add(job.connectionId);
  return ids;
}

/**
 * Running syncs from the task list that nobody here follows yet join as observed quiet jobs, so their end is noticed.
 * `settled` holds jobs already reported; the task list may still show them as running until its next refresh.
 */
export function adoptActive(
  tracked: readonly Tracked[],
  active: readonly ActiveJob[],
  settled: ReadonlySet<string>,
  labelOf: (connectionId: number) => string,
): Tracked[] {
  const known = new Set(tracked.map((t) => t.job.id));
  const fresh = active.filter((job) => job.kind === "sync" && !known.has(job.id) && !settled.has(job.id));
  return fresh.map((job) => ({
    job: { id: job.id, connectionId: job.connectionId, kind: "sync", status: "running", accounts: [], error: null, next: null },
    label: labelOf(job.connectionId),
    mode: "quiet",
    observed: true,
  }));
}

/** Once no quiet job runs anymore, the finished quiet jobs are reported together and leave the list. */
export function settleQuiet<J extends SyncJob>(tracked: Tracked<J>[]): { finished: Tracked<J>[]; remaining: Tracked<J>[] } | null {
  const quiet = tracked.filter((t) => t.mode === "quiet");
  if (quiet.length === 0 || quiet.some((t) => !isFinished(t.job.status))) return null;
  return { finished: quiet, remaining: tracked.filter((t) => t.mode !== "quiet") };
}

/** "PayPal: 1 neue Buchung", one line per account; failures by connection. */
export function syncNotice(finished: readonly Tracked[], t: Translate): Notice {
  const lines: string[] = [];
  const failures: string[] = [];
  for (const { job, label } of finished) {
    if (job.status === "done") {
      for (const account of job.accounts) {
        if (account.newBookings === 0) continue;
        const vars = { account: account.name, count: account.newBookings };
        lines.push(account.firstImport ? t("banking.jobs.accountFirst", vars) : t("banking.jobs.accountNew", vars));
      }
    } else {
      failures.push(t("banking.named", { name: label, text: job.error ?? t(`banking.jobs.status.${job.status}`) }));
    }
  }
  const text = [...failures, ...(lines.length > 0 ? lines : failures.length === 0 ? [t("banking.jobs.noNew")] : [])].join(" · ");
  return { tone: failures.length > 0 ? "warn" : "ok", text };
}
