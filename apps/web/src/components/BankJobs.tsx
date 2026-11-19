import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useT } from "../i18n/react.tsx";
import { errorMessage } from "../lib/action.ts";
import {
  type ActiveJob,
  adoptActive,
  escalate,
  isFinished,
  settleQuiet,
  syncingConnections,
  syncNotice,
  type Tracked as TrackedJob,
} from "../lib/sync-state.ts";
import {
  cancelBankJobFn,
  getBankJobFn,
  submitBankTanFn,
  syncAllBankConnectionsFn,
  syncBankConnectionFn,
} from "../server/functions/banking.ts";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Banner, Status } from "./Status.tsx";
import { ToastStack, useToasts } from "./Toasts.tsx";

export type JobView = Awaited<ReturnType<typeof getBankJobFn>>;
export type { ActiveJob };

type Tracked = TrackedJob<JobView>;
type Started = { job: JobView; label: string };

const POLL_MS = 1500;

type Context = {
  /** Shows the job dialog for these jobs (checking access, a bank login) and follows them until they finish. */
  track: (jobs: Started[]) => void;
  /** Opens the job dialog for a job that is already running, e.g. one waiting for a TAN. */
  follow: (jobId: string, label: string) => Promise<void>;
  /** Fetches one connection without a dialog; the dialog opens only when the bank asks for input or it fails. */
  syncConnection: (connectionId: number, label: string) => Promise<string | null>;
  /** "Konten abrufen": every connection not marked "only manually", without a dialog. */
  syncAll: () => Promise<void>;
  /** The "fetch all" request is being sent. */
  syncing: boolean;
  /** Any bank job runs on the server, started here, elsewhere or by the schedule. */
  running: boolean;
  active: ActiveJob[];
  /** Connections being fetched right now; their accounts show the progress ring. */
  fetching: ReadonlySet<number>;
};

const BankJobsContext = createContext<Context | null>(null);

export function useBankJobs(): Context {
  const context = useContext(BankJobsContext);
  if (!context) throw new Error("useBankJobs outside BankJobsProvider");
  return context;
}

/** For components also shown outside the signed-in layout. */
export function useBankJobsOptional(): Context | null {
  return useContext(BankJobsContext);
}

/**
 * Bank fetches run as server jobs that may stop for a TAN or an app approval. This provider polls the jobs it follows
 * and reloads the page data once they finish. Fetches run quietly (progress ring, a notice at the end); the job dialog
 * opens only when the bank needs input or a fetch failed, and for checking a connection. `active` holds every running
 * job, also those started elsewhere or by the schedule; the task list keeps it current.
 */
export function BankJobsProvider({
  connectionNames,
  active,
  children,
}: {
  connectionNames?: Map<number, string>;
  active: ActiveJob[];
  children: ReactNode;
}) {
  const router = useRouter();
  const poll = useServerFn(getBankJobFn);
  const runAll = useServerFn(syncAllBankConnectionsFn);
  const runOne = useServerFn(syncBankConnectionFn);
  const t = useT();
  const [jobs, setJobs] = useState<Tracked[]>([]);
  const { toasts, push, dismiss } = useToasts();
  const [announcement, setAnnouncement] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<number[]>([]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const settled = useRef(new Set<string>());
  const nameOf = useCallback((id: number) => connectionNames?.get(id) ?? t("banking.connectionFallback"), [connectionNames, t]);

  const add = useCallback((next: Tracked[]) => {
    setJobs((current) => escalate([...current.filter((c) => !next.some((n) => n.job.id === c.job.id)), ...next]));
  }, []);

  const track = useCallback(
    (next: Started[]) => {
      add(next.map((item) => ({ ...item, mode: "dialog", observed: false })));
    },
    [add],
  );

  const watch = useCallback(
    (next: Started[]) => {
      if (next.length === 0) return;
      setAnnouncement(t("banking.sync.started", { names: next.map((item) => item.label).join(", ") }));
      add(next.map((item) => ({ ...item, mode: "quiet", observed: false })));
    },
    [add, t],
  );

  // Syncs started elsewhere or by the schedule are followed like those started here, only without a dialog.
  useEffect(() => {
    const adopted = adoptActive(jobsRef.current, active, settled.current, nameOf) as Tracked[];
    if (adopted.length > 0) add(adopted);
  }, [active, nameOf, add]);

  const open = jobs.some((tracked) => !isFinished(tracked.job.status));
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(async () => {
      const running = jobsRef.current.filter((tracked) => !isFinished(tracked.job.status));
      const views = await Promise.all(running.map((tracked) => poll({ data: { jobId: tracked.job.id } }).catch(() => null)));
      // A finished discovery hands over to the first sync of the connection; it joins the dialog under the same name.
      const known = new Set(jobsRef.current.map((tracked) => tracked.job.id));
      const chained = await Promise.all(
        running.flatMap((tracked, i) => {
          const next = views[i]?.next;
          if (!next || known.has(next)) return [];
          return [
            poll({ data: { jobId: next } })
              .then((job): Tracked => ({ ...tracked, job }))
              .catch(() => null),
          ];
        }),
      );
      setJobs((current) =>
        escalate([
          ...current.map((tracked) => {
            const view = views.find((v) => v?.id === tracked.job.id);
            return view ? { ...tracked, job: view } : tracked;
          }),
          ...chained.filter((item): item is Tracked => item !== null && !current.some((c) => c.job.id === item.job.id)),
        ]),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, poll]);

  // The quiet fetches are over: one notice for all of them, and fresh page data for the "new" badges.
  useEffect(() => {
    const done = settleQuiet(jobs);
    if (!done) return;
    for (const tracked of done.finished) settled.current.add(tracked.job.id);
    setJobs(done.remaining);
    push(syncNotice(done.finished, t));
    void router.invalidate();
  }, [jobs, t, router, push]);

  const syncConnection = useCallback(
    async (connectionId: number, label: string) => {
      setPending((list) => [...list, connectionId]);
      try {
        watch([{ job: await runOne({ data: { id: connectionId } }), label }]);
        return null;
      } catch (error) {
        return errorMessage(error, t);
      } finally {
        setPending((list) => list.filter((id) => id !== connectionId));
      }
    },
    [runOne, watch, t],
  );

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      const items = await runAll();
      // Connections marked "only manually" are left out without a word: that is what the mark asks for.
      const started = items.flatMap((item) => (item.job ? [{ job: item.job, label: nameOf(item.connectionId) }] : []));
      const failures = items
        .filter((item) => item.error)
        .map((item) => t("banking.named", { name: nameOf(item.connectionId), text: item.error ?? "" }));
      watch(started);
      if (failures.length > 0) push({ tone: "danger", text: failures.join(" · ") });
      else if (items.length === 0) push({ tone: "info", text: t("banking.jobs.noConnections") });
    } catch (error) {
      push({ tone: "danger", text: errorMessage(error, t) });
    } finally {
      setSyncing(false);
    }
  }, [runAll, watch, nameOf, t, push]);

  const follow = useCallback(
    async (jobId: string, label: string) => {
      try {
        track([{ job: await poll({ data: { jobId } }), label }]);
      } catch (error) {
        push({ tone: "danger", text: errorMessage(error, t) });
      }
    },
    [poll, track, t, push],
  );

  const dialogJobs = jobs.filter((tracked) => tracked.mode === "dialog");

  async function close() {
    setJobs((current) => current.filter((tracked) => tracked.mode !== "dialog"));
    await router.invalidate();
  }

  const fetching = useMemo(() => syncingConnections(jobs, active, pending), [jobs, active, pending]);
  // A followed job that just finished may still be listed as active until the next refresh of the task list.
  const running =
    syncing ||
    pending.length > 0 ||
    open ||
    active.some(
      (job) => !settled.current.has(job.id) && !jobs.some((tracked) => tracked.job.id === job.id && isFinished(tracked.job.status)),
    );

  const value = useMemo(
    () => ({ track, follow, syncConnection, syncAll, syncing, running, active, fetching }),
    [track, follow, syncConnection, syncAll, syncing, running, active, fetching],
  );

  return (
    <BankJobsContext.Provider value={value}>
      {children}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {dialogJobs.length > 0 && <JobDialog jobs={dialogJobs} onClose={close} />}
    </BankJobsContext.Provider>
  );
}

const TONES: Record<JobView["status"], "info" | "warn" | "ok" | "danger" | "neutral"> = {
  running: "info",
  tan_required: "warn",
  done: "ok",
  error: "danger",
  cancelled: "neutral",
};

function accountLine(t: Translate, result: JobView["accounts"][number]): string {
  const vars = { account: result.name, count: result.newBookings };
  return result.firstImport && result.newBookings > 0 ? t("banking.jobs.accountFirst", vars) : t("banking.jobs.accountNew", vars);
}

function JobDialog({ jobs, onClose }: { jobs: Tracked[]; onClose: () => void }) {
  const t = useT();
  const allDone = jobs.every((tracked) => isFinished(tracked.job.status));
  const synced = jobs.filter((tracked) => tracked.job.kind === "sync" && tracked.job.status === "done");
  const results = synced.flatMap((tracked) => tracked.job.accounts);
  return (
    <FormDialog
      title={allDone ? t("banking.jobs.titleDone") : t("banking.jobs.titleRunning")}
      onClose={onClose}
      footer={
        <button type="button" className={allDone ? "btn btn-primary" : "btn"} onClick={onClose}>
          {allDone ? t("common.close") : t("banking.jobs.runInBackground")}
        </button>
      }
    >
      <p className="visually-hidden" role="status">
        {jobs.map((tracked) => `${tracked.label}: ${t(`banking.jobs.status.${tracked.job.status}`)}`).join(". ")}
      </p>
      <div className="stack">
        {jobs.map((tracked) => (
          <JobRow key={tracked.job.id} tracked={tracked} />
        ))}
        {allDone && synced.length > 0 && (
          <Banner tone="ok">{results.length > 0 ? results.map((r) => accountLine(t, r)).join(" · ") : t("banking.jobs.noNew")}</Banner>
        )}
      </div>
    </FormDialog>
  );
}

function JobRow({ tracked }: { tracked: Tracked }) {
  const { job, label } = tracked;
  const submit = useServerFn(submitBankTanFn);
  const cancel = useServerFn(cancelBankJobFn);
  const [tan, setTan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tanInput = useRef<HTMLInputElement>(null);
  const t = useT();
  const asksTan = job.status === "tan_required" && Boolean(job.tan) && !job.tan?.decoupled;
  useEffect(() => {
    if (asksTan) tanInput.current?.focus();
  }, [asksTan]);
  // The new bookings of a finished sync are listed per account below all jobs.
  const detail = job.status === "done" ? (job.kind === "discover" ? t("banking.jobs.discovered") : null) : (job.error ?? job.message);

  async function sendTan() {
    if (!tan.trim()) {
      setError(t("banking.jobs.enterTan"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submit({ data: { jobId: job.id, tan: tan.trim() } });
      setTan("");
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack-sm" aria-label={label}>
      <div className="row-between">
        <strong>{label}</strong>
        <Status tone={TONES[job.status]} emphasis={job.status === "tan_required" || job.status === "error" ? "urgent" : undefined} inline>
          {t(`banking.jobs.status.${job.status}`)}
        </Status>
      </div>
      {detail && <p className="muted small">{detail}</p>}
      {job.status === "tan_required" && job.tan && (
        <div className="stack-sm">
          <p>{job.tan.text}</p>
          {job.tan.imageDataUrl && <img className="tan-image" src={job.tan.imageDataUrl} alt={t("banking.jobs.photoTanAlt")} width={220} />}
          {job.tan.decoupled ? (
            <p className="muted">{t("banking.jobs.approveInApp")}</p>
          ) : (
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Field label={t("banking.jobs.tan")} error={error}>
                {(control) => (
                  <input
                    {...control}
                    ref={tanInput}
                    className="mono"
                    value={tan}
                    autoComplete="one-time-code"
                    inputMode="text"
                    onChange={(event) => {
                      setTan(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void sendTan();
                      }
                    }}
                  />
                )}
              </Field>
              <button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={sendTan}>
                {t("banking.jobs.sendTan")}
              </button>
            </div>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => cancel({ data: { jobId: job.id } }).catch(() => undefined)}
            >
              {t("banking.jobs.cancelSync")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
