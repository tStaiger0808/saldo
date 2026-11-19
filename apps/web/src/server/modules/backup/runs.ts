/** Making archives: one dump sealed with the backup passphrase, copied to each target, then retention per target. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { desc, eq, sql } from "drizzle-orm";
import packageJson from "../../../../package.json" with { type: "json" };
import { DEFAULT_LOCALE, hasMessage, msg, render, type Translatable } from "../../../i18n/index.ts";
import { archiveName, type BackupRunResult, type BackupRunStatus, type BackupTrigger, RETAINED_ARCHIVE_NAME } from "../../../lib/backup.ts";
import type { Db } from "../../db/index.ts";
import { backupRuns, settings } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { UserError } from "../../errors.ts";
import { record } from "../audit/index.ts";
import { notifySuperusers } from "../notifications/index.ts";
import { ARCHIVE_VERSION, type Manifest, sealArchive } from "./archive.ts";
import { decryptStream, encryptStream, FAST_KDF, newHeader, unlock } from "./container.ts";
import { dumpDatabase, EXCLUDED_DATA, migrationsHash } from "./database.ts";
import { deleteArchive, listArchives, type Target, uploadFile } from "./rclone.ts";
import { deps, spoolDir } from "./state.ts";
import { ToolError, toolVersion } from "./tools.ts";

export const SETTINGS_LINK = "/einstellungen/sicherung";

export type ArchiveFile = { path: string; name: string; bytes: number; manifest: Manifest };

/**
 * Dumps the database and seals it into an archive file in the spool folder. The dump is spooled first (its size goes
 * into the tar header), encrypted under a throwaway key, so plaintext never reaches the disk.
 */
export async function createArchiveFile(databaseUrl: string, passphrase: string, name: string): Promise<ArchiveFile> {
  const dir = await spoolDir();
  const token = randomBytes(8).toString("hex");
  const spool = join(dir, `${token}.dump.spool`);
  const path = join(dir, `${token}.archive.spool`);
  const spoolKey = randomBytes(32).toString("base64");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const facts = await dumpDatabase(databaseUrl, async (out) => {
      async function* counted(): AsyncGenerator<Buffer> {
        for await (const piece of out) {
          hash.update(piece);
          bytes += piece.length;
          yield piece;
        }
      }
      const { header, keys } = await newHeader(spoolKey, { kdf: FAST_KDF });
      await pipeline(Readable.from(encryptStream(counted(), header, keys)), createWriteStream(spool, { mode: 0o600 }));
    });
    const manifest: Manifest = {
      format: "saldo-backup",
      formatVersion: ARCHIVE_VERSION,
      createdAt: deps.now().toISOString(),
      app: { version: packageJson.version ?? null, gitSha: env().SALDO_GIT_SHA || null },
      postgres: { server: facts.serverVersion, dump: await toolVersion("pg_dump") },
      migrations: { count: facts.migrations.length, hash: migrationsHash(facts.migrations), applied: facts.migrations },
      counts: facts.counts,
      excludedData: [...EXCLUDED_DATA],
      encryptionKey: env().ENCRYPTION_KEY,
      database: { file: "database.dump", bytes, sha256: hash.digest("hex") },
    };
    const dump = decryptStream(createReadStream(spool), (header) => unlock(header, spoolKey));
    await pipeline(
      Readable.from(await sealArchive(manifest, dump, passphrase, { kdf: deps.kdf })),
      createWriteStream(path, { mode: 0o600 }),
    );
    return { path, name, bytes: (await stat(path)).size, manifest };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await rm(spool, { force: true });
  }
}

/** The stored reason of a failure: a message key, or plain text (a tool's own error line, shown to superusers only). */
export function failureText(error: unknown): string {
  if (error instanceof UserError) {
    const text = error.text;
    return typeof text === "string" || text.vars ? render(DEFAULT_LOCALE, text) : text.key;
  }
  if (error instanceof ToolError) return error.missing ? "backup.errors.toolMissing" : error.detail || "backup.errors.toolFailed";
  return "common.genericError";
}

/** Deletes archives beyond `keep` on one target; only names Saldo writes for runs, never pre-restore copies. */
async function prune(target: Target, keep: number): Promise<number> {
  const old = (await listArchives(target, env().BACKUP_DIR)).filter((a) => RETAINED_ARCHIVE_NAME.test(a.name)).slice(keep);
  for (const archive of old) await deleteArchive(target, env().BACKUP_DIR, archive.name);
  return old.length;
}

export type RunTarget = { id: number | null; name: string; keep: number | null; target: Target };

export type RunOutcome = {
  status: Exclude<BackupRunStatus, "running">;
  fileName: string | null;
  sizeBytes: number | null;
  results: BackupRunResult[];
  error: string | null;
  manifest: Manifest | null;
};

/**
 * One run: archive, upload to every target (a failing target does not stop the others), retention. Never throws; the
 * outcome says what happened. `onStep` reports progress (dump, then one step per target).
 */
export async function performBackup(input: {
  passphrase: string | null;
  targets: RunTarget[];
  suffix?: "" | "-pre-restore";
  onStep?: (done: number, total: number) => void;
}): Promise<RunOutcome> {
  const total = input.targets.length + 1;
  const empty = { fileName: null, sizeBytes: null, results: [], manifest: null };
  if (!input.passphrase) return { status: "failed", error: "backup.errors.noPassphrase", ...empty };
  if (input.targets.length === 0) return { status: "failed", error: "backup.errors.noTargets", ...empty };
  input.onStep?.(0, total);
  let archive: ArchiveFile;
  try {
    archive = await createArchiveFile(deps.databaseUrl(), input.passphrase, archiveName(deps.now(), input.suffix ?? ""));
  } catch (error) {
    console.error(`Backup failed: ${error instanceof Error ? error.name : typeof error}`);
    return { status: "failed", error: failureText(error), ...empty };
  }
  try {
    const results: BackupRunResult[] = [];
    for (const [index, entry] of input.targets.entries()) {
      input.onStep?.(index + 1, total);
      try {
        await uploadFile(entry.target, env().BACKUP_DIR, archive.path, archive.name);
      } catch (error) {
        results.push({ targetId: entry.id, name: entry.name, ok: false, error: failureText(error), deleted: 0 });
        continue;
      }
      let deleted = 0;
      let warning: string | null = null;
      if (entry.keep !== null) {
        try {
          deleted = await prune(entry.target, entry.keep);
        } catch (error) {
          warning = failureText(error);
        }
      }
      results.push({ targetId: entry.id, name: entry.name, ok: true, error: warning, deleted });
    }
    const ok = results.filter((r) => r.ok).length;
    const status = ok === results.length ? "ok" : ok === 0 ? "failed" : "partial";
    return { status, fileName: archive.name, sizeBytes: archive.bytes, results, error: null, manifest: archive.manifest };
  } finally {
    await rm(archive.path, { force: true });
  }
}

export async function insertRun(
  db: Db,
  trigger: BackupTrigger,
  startedBy: string | null,
  outcome: RunOutcome | null,
  startedAt = deps.now(),
): Promise<number> {
  const [row] = await db
    .insert(backupRuns)
    .values({
      trigger,
      startedBy,
      startedAt,
      status: outcome?.status ?? "running",
      finishedAt: outcome ? deps.now() : null,
      fileName: outcome?.fileName ?? null,
      sizeBytes: outcome?.sizeBytes ?? null,
      results: outcome?.results ?? [],
      error: outcome?.error ?? null,
    })
    .returning({ id: backupRuns.id });
  return row?.id ?? 0;
}

async function finishRun(db: Db, id: number, outcome: RunOutcome): Promise<void> {
  await db
    .update(backupRuns)
    .set({
      status: outcome.status,
      finishedAt: deps.now(),
      fileName: outcome.fileName,
      sizeBytes: outcome.sizeBytes,
      results: outcome.results,
      error: outcome.error,
    })
    .where(eq(backupRuns.id, id));
}

/** Runs still marked running were cut off by a restart; they count as failed. */
export async function closeAbandonedRuns(db: Db): Promise<void> {
  await db
    .update(backupRuns)
    .set({ status: "failed", finishedAt: deps.now(), error: "backup.errors.interrupted" })
    .where(eq(backupRuns.status, "running"));
}

export async function recentRuns(db: Db, limit = 20) {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt), desc(backupRuns.id)).limit(limit);
}

/** A stored reason, translatable again when it is a message key. */
export const reasonOf = (text: string): Translatable | string => (hasMessage(text) ? { key: text } : text);

/** A run for the schedule or "back up now": run row, archive, notifications and audit entry. */
export async function recordedBackup(
  db: Db,
  input: { trigger: Exclude<BackupTrigger, "safety">; startedBy: string | null; passphrase: string | null; targets: RunTarget[] },
  onStep?: (done: number, total: number) => void,
): Promise<RunOutcome> {
  const runId = await insertRun(db, input.trigger, input.startedBy, null);
  const outcome = await performBackup({ passphrase: input.passphrase, targets: input.targets, onStep });
  await finishRun(db, runId, outcome);
  const failed = outcome.results.filter((r) => !r.ok).map((r) => r.name);
  await record(db, {
    action: "backup.run",
    actor: input.startedBy ? { id: input.startedBy } : null,
    outcome: outcome.status === "ok" ? "ok" : "failed",
    target: { type: "backupRun", id: runId },
    details: {
      trigger: input.trigger,
      fileName: outcome.fileName ?? undefined,
      sizeBytes: outcome.sizeBytes ?? undefined,
      failedTargets: failed.length > 0 ? failed : undefined,
      reason: outcome.error ?? undefined,
    },
  });
  if (outcome.status === "ok") {
    await notifySuperusers(
      db,
      "backup_succeeded",
      `backup_succeeded:${runId}`,
      msg("backup.notify.succeededTitle"),
      msg("backup.notify.succeededBody", { file: outcome.fileName ?? "", count: outcome.results.length }),
      SETTINGS_LINK,
    );
  } else {
    const reason = outcome.error
      ? reasonOf(outcome.error)
      : msg("backup.notify.failedTargets", {
          names: outcome.results
            .filter((r) => !r.ok)
            .map((r) => r.name)
            .join(", "),
        });
    await notifySuperusers(db, "backup_failed", `backup_failed:${runId}`, msg("backup.notify.failedTitle"), reason, SETTINGS_LINK);
  }
  return outcome;
}

/** Claims a schedule slot (an ISO time) once; a later tick for the same or an older slot gets false. */
export async function claimSlot(db: Db, key: string, slot: string): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key, value: slot })
    .onConflictDoUpdate({ target: settings.key, set: { value: slot }, setWhere: sql`(${settings.value} #>> '{}') < ${slot}` })
    .returning({ key: settings.key });
  return rows.length > 0;
}
