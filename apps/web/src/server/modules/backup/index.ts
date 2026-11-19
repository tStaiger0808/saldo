/**
 * Backups and restore (superusers only, never while viewing as someone else). pg_dump and rclone run in the app
 * container; archives are sealed with the backup passphrase (archive.ts), which is stored encrypted with ENCRYPTION_KEY
 * so scheduled runs can use it. One backup or restore runs at a time, as a task.
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, msg, render, t } from "../../../i18n/index.ts";
import {
  ARCHIVE_NAME,
  archiveTime,
  BACKUP_FREQUENCIES,
  type BackupRunResult,
  type BackupRunStatus,
  type BackupSchedule,
  type BackupTrigger,
  DEFAULT_SCHEDULE,
  MAX_PASSPHRASE,
  MIN_PASSPHRASE,
  RETAINED_ARCHIVE_NAME,
} from "../../../lib/backup.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import type { Db, Tx } from "../../db/index.ts";
import { backupTargets, settings, user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import { requireSuperuser, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import { startTask } from "../tasks/index.ts";
import { archiveStream, listArchives, testTarget } from "./rclone.ts";
import {
  confirmRestoreInput,
  discardRestore,
  prepareRestore,
  prepareRestoreInput,
  type RestorePreview,
  receiveUpload,
  restoreIdInput,
  runRestore,
  takePrepared,
} from "./restore.ts";
import { claimSlot, closeAbandonedRuns, failureText, type RunTarget, reasonOf, recentRuns, recordedBackup } from "./runs.ts";
import { latestSlot, nextSlot } from "./schedule.ts";
import { type BusyKind, busyKind, claimBusy } from "./state.ts";
import {
  hostOf,
  listTargetRows,
  mergeSecrets,
  storedSecrets,
  type TargetView,
  targetIdInput,
  targetInput,
  targetOf,
  targetRow,
  viewOf,
} from "./targets.ts";
import { toolVersion } from "./tools.ts";

export { MAX_UPLOAD_BYTES } from "../../../lib/backup.ts";
export { openArchive } from "./archive.ts";
export { checkArchiveFile, runRestore } from "./restore.ts";
export { claimBusy, resetBackupStateForTests, setBackupDepsForTests } from "./state.ts";
export type { RestorePreview, TargetView };
export { closeAbandonedRuns, confirmRestoreInput, prepareRestoreInput, restoreIdInput, targetIdInput, targetInput };

const SCHEDULE_KEY = "backup_schedule";
const PASSPHRASE_KEY = "backup_passphrase";
const SLOT_KEY = "backup_slot";

/** Superusers in their own session only; a view as someone else is never a superuser anyway. */
export function requireBackupAdmin(viewer: Viewer): void {
  requireSuperuser(viewer);
  if (viewer.impersonation) throw new Forbidden(msg("errors.superuserOnly"));
}

async function readSetting(db: Db | Tx, key: string): Promise<{ value: unknown; ciphertext: string | null } | null> {
  const [row] = await db.select({ value: settings.value, ciphertext: settings.ciphertext }).from(settings).where(eq(settings.key, key));
  return row ?? null;
}

async function writeSetting(db: Db | Tx, key: string, value: unknown, ciphertext: string | null = null): Promise<void> {
  await db.insert(settings).values({ key, value, ciphertext }).onConflictDoUpdate({ target: settings.key, set: { value, ciphertext } });
}

type StoredSchedule = BackupSchedule & { updatedAt: string | null };

export async function readSchedule(db: Db | Tx): Promise<StoredSchedule> {
  const value = (await readSetting(db, SCHEDULE_KEY))?.value as Partial<StoredSchedule> | null | undefined;
  return { ...DEFAULT_SCHEDULE, updatedAt: null, ...value };
}

/** The backup passphrase, for scheduled runs and the safety copy before a restore; null when none is set. */
export async function storedPassphrase(db: Db): Promise<{ passphrase: string; changedAt: string | null } | null> {
  const row = await readSetting(db, PASSPHRASE_KEY);
  if (!row?.ciphertext) return null;
  return { passphrase: decrypt(row.ciphertext), changedAt: (row.value as { changedAt?: string } | null)?.changedAt ?? null };
}

// ---- overview

export type RunView = {
  id: number;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  fileName: string | null;
  sizeBytes: number | null;
  startedBy: string | null;
  error: string | null;
  results: (Omit<BackupRunResult, "error"> & { error: string | null })[];
};

export type BackupTools = { pgDump: string | null; pgRestore: string | null; rclone: string | null };

export type BackupOverview = {
  timeZone: string;
  backupDir: string;
  passphrase: { set: boolean; changedAt: string | null };
  schedule: BackupSchedule & { nextRun: string | null };
  targets: TargetView[];
  runs: RunView[];
  busy: BusyKind | null;
  tools: BackupTools;
};

let toolsCache: BackupTools | null = null;

async function tools(): Promise<BackupTools> {
  if (toolsCache?.pgDump && toolsCache.pgRestore && toolsCache.rclone) return toolsCache;
  const [pgDump, pgRestore, rclone] = await Promise.all([toolVersion("pg_dump"), toolVersion("pg_restore"), toolVersion("rclone")]);
  toolsCache = { pgDump, pgRestore, rclone };
  return toolsCache;
}

export const serverTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export async function getBackupOverview(db: Db, viewer: Viewer): Promise<BackupOverview> {
  requireBackupAdmin(viewer);
  const locale = viewer.locale ?? DEFAULT_LOCALE;
  const [rows, runs, schedule, passphrase] = await Promise.all([
    listTargetRows(db),
    recentRuns(db),
    readSchedule(db),
    storedPassphrase(db),
  ]);
  const starters = [...new Set(runs.flatMap((run) => (run.startedBy ? [run.startedBy] : [])))];
  const names = new Map(
    (starters.length
      ? await db.select({ id: user.id, username: user.username, name: user.name }).from(user).where(inArray(user.id, starters))
      : []
    ).map((row) => [row.id, row.name || row.username || ""]),
  );
  const text = (value: string | null) => (value ? render(locale, reasonOf(value)) : null);
  const { updatedAt: _, ...plan } = schedule;
  return {
    timeZone: serverTimeZone(),
    backupDir: env().BACKUP_DIR,
    passphrase: { set: passphrase !== null, changedAt: passphrase?.changedAt ?? null },
    schedule: { ...plan, nextRun: nextSlot(schedule, new Date())?.toISOString() ?? null },
    targets: rows.map(viewOf),
    runs: runs.map((run) => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
      fileName: run.fileName,
      sizeBytes: run.sizeBytes,
      startedBy: run.startedBy ? (names.get(run.startedBy) ?? null) : null,
      error: text(run.error),
      results: run.results.map((result) => ({ ...result, error: text(result.error) })),
    })),
    busy: busyKind(),
    tools: await tools(),
  };
}

// ---- targets

export type TestResult = { ok: boolean; message: string };

async function runTest(db: Db, viewer: Viewer, id: number): Promise<TestResult> {
  const row = await targetRow(db, id);
  const locale = viewer.locale ?? DEFAULT_LOCALE;
  try {
    await testTarget(targetOf(row), env().BACKUP_DIR);
    await record(db, { action: "backup.targetTested", actor: viewer, target: { type: "backupTarget", id }, details: { name: row.name } });
    return { ok: true, message: t(locale, "backup.targets.testOk", { name: row.name }) };
  } catch (error) {
    await record(db, {
      action: "backup.targetTested",
      actor: viewer,
      outcome: "failed",
      target: { type: "backupTarget", id },
      details: { name: row.name },
    });
    return {
      ok: false,
      message: t(locale, "backup.targets.testFailed", { name: row.name, reason: render(locale, reasonOf(failureText(error))) }),
    };
  }
}

/** Creates or updates a target, then tests it. */
export async function saveTarget(db: Db, viewer: Viewer, input: z.input<typeof targetInput>): Promise<{ id: number; test: TestResult }> {
  requireBackupAdmin(viewer);
  const data = targetInput.parse(input);
  const previous = data.id ? await targetRow(db, data.id) : null;
  const secrets = mergeSecrets(data.config, data.secrets, previous ? targetOf(previous) : null);
  const values = { name: data.name, type: data.config.type, config: data.config, ciphertext: storedSecrets(secrets), keep: data.keep };
  let id: number;
  if (previous) {
    await db
      .update(backupTargets)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(backupTargets.id, previous.id));
    id = previous.id;
  } else {
    const [row] = await db.insert(backupTargets).values(values).returning({ id: backupTargets.id });
    id = row?.id ?? 0;
  }
  await record(db, {
    action: previous ? "backup.targetUpdated" : "backup.targetCreated",
    actor: viewer,
    target: { type: "backupTarget", id },
    details: {
      name: data.name,
      targetType: data.config.type,
      host: hostOf(data.config),
      passwordChanged: Object.values(data.secrets).some(Boolean),
    },
  });
  return { id, test: await runTest(db, viewer, id) };
}

export async function testBackupTarget(db: Db, viewer: Viewer, input: z.input<typeof targetIdInput>): Promise<TestResult> {
  requireBackupAdmin(viewer);
  return runTest(db, viewer, targetIdInput.parse(input).id);
}

/** Deletes the target and takes it out of the schedule; archives on it stay where they are. */
export async function deleteTarget(db: Db, viewer: Viewer, input: z.input<typeof targetIdInput>): Promise<void> {
  requireBackupAdmin(viewer);
  const row = await targetRow(db, targetIdInput.parse(input).id);
  await db.transaction(async (tx) => {
    await tx.delete(backupTargets).where(eq(backupTargets.id, row.id));
    const schedule = await readSchedule(tx);
    if (schedule.targetIds.includes(row.id)) {
      const value = { ...schedule, targetIds: schedule.targetIds.filter((id) => id !== row.id) };
      await writeSetting(tx, SCHEDULE_KEY, value);
    }
  });
  await record(db, {
    action: "backup.targetDeleted",
    actor: viewer,
    target: { type: "backupTarget", id: row.id },
    details: { name: row.name, targetType: row.type },
  });
}

// ---- schedule and passphrase

export const scheduleInput = z.object({
  frequency: z.enum(BACKUP_FREQUENCIES),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "backup.errors.timeFormat"),
  weekday: z.number().int().min(1).max(7),
  monthDay: z.union([z.literal("last"), z.number().int().min(1, "backup.errors.monthDayRange").max(28, "backup.errors.monthDayRange")]),
  targetIds: z.array(z.number().int().positive()).max(50),
});

export async function saveSchedule(db: Db, viewer: Viewer, input: z.input<typeof scheduleInput>): Promise<void> {
  requireBackupAdmin(viewer);
  const data = scheduleInput.parse(input);
  const known = new Set((await listTargetRows(db)).map((row) => row.id));
  const targetIds = [...new Set(data.targetIds)].filter((id) => known.has(id));
  if (targetIds.length !== new Set(data.targetIds).size) throw new NotFound(msg("backup.errors.targetNotFound"));
  if (data.frequency !== "off") {
    if (targetIds.length === 0) throw new UserError(msg("backup.errors.noTargets"));
    if (!(await storedPassphrase(db))) throw new UserError(msg("backup.errors.noPassphrase"));
  }
  await writeSetting(db, SCHEDULE_KEY, { ...data, targetIds, updatedAt: new Date().toISOString() });
  await record(db, {
    action: "backup.scheduleChanged",
    actor: viewer,
    details: { frequency: data.frequency, time: data.frequency === "off" ? undefined : data.time },
  });
}

export const passphraseInput = z.object({
  passphrase: z
    .string()
    .max(MAX_PASSPHRASE)
    .refine((value) => [...value].length >= MIN_PASSPHRASE, "backup.errors.passphraseShort"),
  confirmation: z.string().max(MAX_PASSPHRASE),
});

/** Sets or replaces the passphrase; it only applies to archives made from now on. */
export async function setPassphrase(db: Db, viewer: Viewer, input: z.input<typeof passphraseInput>): Promise<void> {
  requireBackupAdmin(viewer);
  const { passphrase, confirmation } = passphraseInput.parse(input);
  if (passphrase !== confirmation) throw new UserError(msg("backup.errors.passphraseMismatch"));
  const first = (await storedPassphrase(db)) === null;
  await writeSetting(db, PASSPHRASE_KEY, { changedAt: new Date().toISOString() }, encrypt(passphrase));
  await record(db, { action: "backup.passphraseChanged", actor: viewer, details: { enabled: first ? true : undefined } });
}

// ---- runs

async function scheduledTargets(db: Db, ids: number[]): Promise<RunTarget[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(backupTargets).where(inArray(backupTargets.id, ids));
  return rows.map((row) => ({ id: row.id, name: row.name, keep: row.keep, target: targetOf(row) }));
}

function startRun(db: Db, trigger: "manual" | "scheduled", startedBy: string | null, release: () => void) {
  return startTask(
    { kind: "backup", title: msg("tasks.kinds.backup"), startedBy, cancellable: false },
    async (task) => {
      try {
        const schedule = await readSchedule(db);
        const outcome = await recordedBackup(
          db,
          {
            trigger,
            startedBy,
            passphrase: (await storedPassphrase(db))?.passphrase ?? null,
            targets: await scheduledTargets(db, schedule.targetIds),
          },
          (done, total) => task.step(done, total, "step"),
        );
        if (outcome.status === "failed") {
          throw new UserError(outcome.error ? reasonOf(outcome.error) : msg("backup.run.allFailed"));
        }
        if (outcome.status === "partial") {
          const names = outcome.results.filter((r) => !r.ok).map((r) => r.name);
          throw new UserError(msg("backup.run.partial", { names: names.join(", ") }));
        }
        return outcome;
      } finally {
        release();
      }
    },
    (outcome) => msg("backup.run.done", { file: outcome.fileName ?? "", count: outcome.results.length }),
  );
}

/** "Back up now": the scheduled targets, at once, as a task. */
export async function startBackup(db: Db, viewer: Viewer): Promise<{ taskId: string }> {
  requireBackupAdmin(viewer);
  const schedule = await readSchedule(db);
  if (schedule.targetIds.length === 0) throw new UserError(msg("backup.errors.noTargets"));
  if (!(await storedPassphrase(db))) throw new UserError(msg("backup.errors.noPassphrase"));
  const release = claimBusy("backup");
  return { taskId: startRun(db, "manual", viewer.id, release).id };
}

/**
 * Scheduler tick: starts the due run once per slot. A schedule saved after a slot waits for the next one; a slot missed
 * while the server was down runs on the next tick.
 */
export async function runScheduledBackup(db: Db, now: Date): Promise<void> {
  const schedule = await readSchedule(db);
  if (schedule.frequency === "off") return;
  const slot = latestSlot(schedule, now);
  if (!slot || (schedule.updatedAt && slot.getTime() < Date.parse(schedule.updatedAt))) return;
  if (!(await claimSlot(db, SLOT_KEY, slot.toISOString()))) return;
  let release: () => void;
  try {
    release = claimBusy("backup");
  } catch {
    console.warn("Scheduled backup skipped: another backup or restore is running");
    return;
  }
  startRun(db, "scheduled", null, release);
}

// ---- archives

export const archivesInput = z.object({ targetId: z.number().int().positive() });

export type ArchiveView = { name: string; sizeBytes: number; createdAt: string | null; kind: "run" | "safety" };

export async function listTargetArchives(db: Db, viewer: Viewer, input: z.input<typeof archivesInput>): Promise<ArchiveView[]> {
  requireBackupAdmin(viewer);
  const row = await targetRow(db, archivesInput.parse(input).targetId);
  try {
    const archives = await listArchives(targetOf(row), env().BACKUP_DIR);
    return archives.map((archive) => ({
      name: archive.name,
      sizeBytes: archive.size,
      createdAt: archiveTime(archive.name),
      kind: RETAINED_ARCHIVE_NAME.test(archive.name) ? "run" : "safety",
    }));
  } catch (error) {
    throw new UserError(
      msg("backup.errors.listFailed", { reason: render(viewer.locale ?? DEFAULT_LOCALE, reasonOf(failureText(error))) }),
      502,
    );
  }
}

export const downloadInput = z.object({
  targetId: z.coerce.number().int().positive(),
  name: z.string().regex(ARCHIVE_NAME, "backup.errors.archiveName"),
});

/** Streams an archive from its target to the browser; audited. */
export async function openDownload(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof downloadInput>,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; name: string }> {
  requireBackupAdmin(viewer);
  const { targetId, name } = downloadInput.parse(input);
  const row = await targetRow(db, targetId);
  const target = targetOf(row);
  const found = (await listArchives(target, env().BACKUP_DIR).catch(() => [])).find((archive) => archive.name === name);
  if (!found) throw new NotFound(msg("backup.errors.archiveNotFound"));
  await record(db, {
    action: "backup.downloaded",
    actor: viewer,
    target: { type: "backupTarget", id: row.id },
    details: { name: row.name, fileName: name, sizeBytes: found.size },
  });
  return { stream: archiveStream(target, env().BACKUP_DIR, name), size: found.size, name };
}

// ---- restore

export async function uploadRestoreArchive(
  viewer: Viewer,
  body: ReadableStream<Uint8Array>,
  fileName: string,
): Promise<{ uploadId: string }> {
  requireBackupAdmin(viewer);
  return receiveUpload(viewer, body, fileName);
}

export async function prepareBackupRestore(db: Db, viewer: Viewer, input: z.input<typeof prepareRestoreInput>): Promise<RestorePreview> {
  requireBackupAdmin(viewer);
  const passphrase = await storedPassphrase(db);
  return prepareRestore(input, viewer, async (id) => targetOf(await targetRow(db, id)), passphrase !== null);
}

export async function cancelBackupRestore(viewer: Viewer, input: z.input<typeof restoreIdInput>): Promise<void> {
  requireBackupAdmin(viewer);
  await discardRestore(viewer, input);
}

/** Starts the confirmed restore as a task; everyone (the person restoring, too) signs in again afterwards. */
export async function confirmBackupRestore(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof confirmRestoreInput>,
): Promise<{ taskId: string }> {
  requireBackupAdmin(viewer);
  const backupPassphrase = (await storedPassphrase(db))?.passphrase ?? null;
  const { prepared, release } = takePrepared(viewer, input);
  const task = startTask(
    { kind: "restore", title: msg("tasks.kinds.restore", { file: prepared.name }), startedBy: viewer.id, cancellable: false },
    async (control) => {
      try {
        return await runRestore(db, { viewer }, prepared, backupPassphrase, (done, total) => control.step(done, total, "step"));
      } finally {
        release();
      }
    },
    (result) => msg("backup.restore.done", { file: result.safetyFile }),
  );
  return { taskId: task.id };
}
