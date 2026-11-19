/**
 * Restore: stage an archive (upload or a target), check it in full with the passphrase, show what it holds, and only
 * after an explicit confirmation make a safety copy of the current state and swap the database (database.ts).
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Locale, msg, render, t } from "../../../i18n/index.ts";
import { ARCHIVE_NAME, MAX_PASSPHRASE, MAX_UPLOAD_BYTES } from "../../../lib/backup.ts";
import type { Db } from "../../db/index.ts";
import { user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import type { Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import { ArchiveError, type ArchiveFailure, openArchive } from "./archive.ts";
import { MAGIC } from "./container.ts";
import { compatibility, dumpContents, knownMigrations, restoreDatabase } from "./database.ts";
import { restorableList } from "./guard.ts";
import { downloadFile, type Target } from "./rclone.ts";
import { failureText, insertRun, performBackup, type RunOutcome, reasonOf } from "./runs.ts";
import { claimBusy, deps, type Prepared, pruneStaged, type Staged, spoolDir, state } from "./state.ts";
import { ToolError } from "./tools.ts";

const ARCHIVE_ERRORS: Record<
  ArchiveFailure,
  "backup.errors.wrongPassphrase" | "backup.errors.damaged" | "backup.errors.notAnArchive" | "backup.errors.newerFormat"
> = {
  passphrase: "backup.errors.wrongPassphrase",
  damaged: "backup.errors.damaged",
  manifest: "backup.errors.damaged",
  kdf: "backup.errors.damaged",
  format: "backup.errors.notAnArchive",
  version: "backup.errors.newerFormat",
};

export function archiveUserError(error: unknown): unknown {
  return error instanceof ArchiveError ? new UserError(msg(ARCHIVE_ERRORS[error.reason])) : error;
}

/**
 * Decrypts and checks a whole archive: passphrase, integrity, a schema this version can take, and a dump holding only
 * what Saldo's own pg_dump writes (guard.ts).
 */
async function verifyArchive(file: string, passphrase: string) {
  let list = "";
  const opened = await openArchive(
    createReadStream(file),
    { passphrase },
    {
      onManifest: (manifest) => {
        const check = compatibility(manifest.migrations.applied);
        if (!check.ok) throw new UserError(msg(check.reason === "newer" ? "backup.errors.newerSchema" : "backup.errors.unknownSchema"));
      },
      onDump: async (dump) => {
        list = await dumpContents(dump).catch((error: unknown) => {
          if (error instanceof ToolError && !error.missing) throw new UserError(msg("backup.errors.damaged"));
          throw error;
        });
      },
    },
  ).catch((error: unknown) => {
    throw archiveUserError(error);
  });
  restorableList(list);
  return opened;
}

const LOCAL_ROOT: Target = { config: { type: "local", path: "" }, secrets: {} };

/** Streams an upload into the spool folder; refuses anything that does not start like an archive, and oversized bodies. */
export async function receiveUpload(viewer: Viewer, body: ReadableStream<Uint8Array>, fileName: string): Promise<{ uploadId: string }> {
  await pruneStaged();
  const id = randomBytes(12).toString("base64url");
  const file = join(await spoolDir(), `${id}.upload.spool`);
  let size = 0;
  async function* checked(): AsyncGenerator<Uint8Array> {
    let head = Buffer.alloc(0);
    for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
      size += piece.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new UserError(msg("backup.errors.uploadTooLarge"), 413);
      if (head.length < MAGIC.length) {
        head = Buffer.concat([head, piece]);
        if (head.length >= MAGIC.length && !head.subarray(0, MAGIC.length).equals(MAGIC)) {
          throw new UserError(msg("backup.errors.notAnArchive"));
        }
      }
      yield piece;
    }
    if (head.length < MAGIC.length) throw new UserError(msg("backup.errors.notAnArchive"));
  }
  try {
    await pipeline(Readable.from(checked()), createWriteStream(file, { mode: 0o600 }));
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
  const name = fileName.replace(/[\p{Cc}/\\]/gu, "").slice(0, 200) || "upload.saldo-backup";
  state().uploads.set(id, { id, userId: viewer.id, file, name, createdAt: Date.now() });
  return { uploadId: id };
}

export const prepareRestoreInput = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("target"),
      targetId: z.number().int().positive(),
      name: z.string().regex(ARCHIVE_NAME, "backup.errors.archiveName"),
    }),
    z.object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(64) }),
  ]),
  passphrase: z.string().min(1, "backup.errors.passphraseRequired").max(MAX_PASSPHRASE),
});

export type RestorePreview = {
  restoreId: string;
  fileName: string;
  createdAt: string;
  appVersion: string | null;
  gitSha: string | null;
  postgres: string;
  counts: { users: number; accounts: number; transactions: number; contracts: number; bankConnections: number; documents: number };
  migrations: { archive: number; app: number; pending: number };
  sameEncryptionKey: boolean;
  /** Whether the safety copy before the restore is sealed with the backup passphrase or, without one, with this archive's. */
  safetyPassphrase: "backup" | "archive";
};

/** Stages the archive, checks passphrase and content in full, refuses newer schemas, and keeps it ready for the confirmation. */
export async function prepareRestore(
  input: z.input<typeof prepareRestoreInput>,
  viewer: Viewer,
  resolveTarget: (id: number) => Promise<Target>,
  backupPassphraseSet: boolean,
): Promise<RestorePreview> {
  const { source, passphrase } = prepareRestoreInput.parse(input);
  await pruneStaged();
  if (state().busy)
    throw new UserError(msg(state().busy === "restore" ? "backup.errors.restoreRunning" : "backup.errors.backupRunning"), 409);
  let staged: Staged;
  if (source.kind === "upload") {
    const upload = state().uploads.get(source.uploadId);
    if (!upload || upload.userId !== viewer.id) throw new NotFound(msg("backup.errors.uploadNotFound"));
    staged = upload;
  } else {
    const target = await resolveTarget(source.targetId);
    const id = randomBytes(12).toString("base64url");
    const file = join(await spoolDir(), `${id}.download.spool`);
    try {
      await downloadFile(target, env().BACKUP_DIR, source.name, file);
    } catch (error) {
      await rm(file, { force: true });
      throw new UserError(msg("backup.errors.downloadFailed", { reason: failureText(error) }));
    }
    staged = { id, userId: viewer.id, file, name: source.name, createdAt: Date.now() };
  }
  try {
    const opened = await verifyArchive(staged.file, passphrase);
    const { manifest } = opened;
    state().uploads.delete(staged.id);
    for (const old of state().prepared.values()) if (old.userId === viewer.id) await discard(old.id);
    const prepared: Prepared = { ...staged, id: randomBytes(12).toString("base64url"), keys: opened.keys, manifest, passphrase };
    state().prepared.set(prepared.id, prepared);
    const check = compatibility(manifest.migrations.applied);
    const counts = manifest.counts;
    return {
      restoreId: prepared.id,
      fileName: staged.name,
      createdAt: manifest.createdAt,
      appVersion: manifest.app.version,
      gitSha: manifest.app.gitSha,
      postgres: manifest.postgres.server,
      counts: {
        users: counts.user ?? 0,
        accounts: counts.accounts ?? 0,
        transactions: counts.transactions ?? 0,
        contracts: counts.contracts ?? 0,
        bankConnections: counts.bank_connections ?? 0,
        documents: counts.contract_documents ?? 0,
      },
      migrations: { archive: manifest.migrations.count, app: knownMigrations().length, pending: check.ok ? check.pending : 0 },
      sameEncryptionKey: manifest.encryptionKey === env().ENCRYPTION_KEY,
      safetyPassphrase: backupPassphraseSet ? "backup" : "archive",
    };
  } catch (error) {
    // An upload stays for another try with the right passphrase; anything else about the file will not get better.
    const retry =
      source.kind === "upload" && error instanceof UserError && (error.text as { key?: string }).key === "backup.errors.wrongPassphrase";
    if (!retry) {
      state().uploads.delete(staged.id);
      await rm(staged.file, { force: true });
    }
    throw error;
  }
}

async function discard(id: string): Promise<void> {
  const prepared = state().prepared.get(id);
  if (!prepared) return;
  state().prepared.delete(id);
  await rm(prepared.file, { force: true });
}

export const restoreIdInput = z.object({ restoreId: z.string().min(1).max(64) });

export async function discardRestore(viewer: Viewer, input: z.input<typeof restoreIdInput>): Promise<void> {
  const { restoreId } = restoreIdInput.parse(input);
  const prepared = state().prepared.get(restoreId);
  if (prepared && prepared.userId === viewer.id) await discard(restoreId);
}

export const confirmRestoreInput = restoreIdInput.extend({ confirmation: z.string().max(100) });

/** The word to type: the reader's own, and the German one everywhere. */
export function confirmationAccepted(typed: string, locale: Locale): boolean {
  const value = typed.trim().toLocaleUpperCase(locale);
  return [t(locale, "backup.restore.confirmWord"), t("de", "backup.restore.confirmWord")].some(
    (word) => word.toLocaleUpperCase(locale) === value,
  );
}

/** Takes a prepared restore out of the waiting list after the checks a confirmation needs; claims the busy slot. */
export function takePrepared(viewer: Viewer, input: z.input<typeof confirmRestoreInput>): { prepared: Prepared; release: () => void } {
  const { restoreId, confirmation } = confirmRestoreInput.parse(input);
  const prepared = state().prepared.get(restoreId);
  if (!prepared) throw new NotFound(msg("backup.errors.restoreExpired"));
  if (prepared.userId !== viewer.id) throw new Forbidden(msg("errors.superuserOnly"));
  if (!confirmationAccepted(confirmation, viewer.locale ?? "de")) throw new UserError(msg("backup.errors.confirmationMismatch"));
  const release = claimBusy("restore");
  state().prepared.delete(restoreId);
  return { prepared, release };
}

export type RestoreResult = { safetyFile: string; rekeyed: boolean; migrated: number };

/** Who restores: a superuser in the browser, or the command line inside the container (scripts/restore.ts). */
export type RestoreActor = { viewer: Viewer } | { commandLine: true };

/**
 * The confirmed restore: a safety copy of the current state into the local folder, then the swap. A failure anywhere
 * leaves the live database untouched; the safety copy stays either way.
 */
export async function runRestore(
  db: Db,
  actor: RestoreActor,
  prepared: Prepared,
  backupPassphrase: string | null,
  onStep: (done: number, total: number) => void,
): Promise<RestoreResult> {
  const viewer = "viewer" in actor ? actor.viewer : null;
  const locale = viewer?.locale ?? "de";
  const actorName = viewer ? await nameOf(db, viewer.id) : "scripts/restore.ts";
  const rekeyed = prepared.manifest.encryptionKey !== env().ENCRYPTION_KEY;
  const check = compatibility(prepared.manifest.migrations.applied);
  const details = { fileName: prepared.name, createdAt: prepared.manifest.createdAt, rekeyed };
  let safety: RunOutcome | null = null;
  const startedAt = deps.now();
  const audit = async (outcome: "ok" | "failed", reason?: string) => {
    const known = viewer ? await userExists(db, viewer.id) : false;
    if (safety?.status === "ok")
      await insertRun(db, "safety", known ? (viewer?.id ?? null) : null, safety, startedAt).catch(() => undefined);
    await record(db, {
      action: "backup.restored",
      actor: known ? viewer : null,
      username: known ? undefined : actorName,
      outcome,
      details: { ...details, reason },
    });
  };
  try {
    onStep(0, 4);
    safety = await performBackup({
      passphrase: backupPassphrase ?? prepared.passphrase,
      targets: [{ id: null, name: t(locale, "backup.restore.localFolder"), keep: null, target: LOCAL_ROOT }],
      suffix: "-pre-restore",
    });
    if (safety.status !== "ok") {
      const reason = safety.error ?? safety.results[0]?.error ?? "common.genericError";
      throw new UserError(msg("backup.errors.safetyFailed", { reason: render(locale, reasonOf(reason)) }));
    }
    await restoreDatabase({
      liveUrl: deps.databaseUrl(),
      file: prepared.file,
      keys: prepared.keys,
      manifest: prepared.manifest,
      currentKey: Buffer.from(env().ENCRYPTION_KEY, "base64"),
      beforeSwap: deps.beforeSwap,
      onStep: (step) => onStep(step === "restore" ? 1 : step === "migrate" ? 2 : 3, 4),
    }).catch((error: unknown) => {
      throw archiveUserError(error);
    });
  } catch (error) {
    await audit("failed", failureText(error));
    throw error;
  } finally {
    if (!prepared.keepFile) await rm(prepared.file, { force: true });
  }
  onStep(4, 4);
  // From here on `db` reaches the restored database: the run and the audit entry land in the history people now see.
  await audit("ok");
  return { safetyFile: safety?.fileName ?? "", rekeyed, migrated: check.ok ? check.pending : 0 };
}

/** Checks an archive file in full for the command line: passphrase, content and schema, as in the browser. */
export async function checkArchiveFile(file: string, passphrase: string): Promise<Prepared> {
  const opened = await verifyArchive(file, passphrase);
  return {
    id: "cli",
    userId: "",
    file,
    name: file.split("/").at(-1) ?? file,
    createdAt: Date.now(),
    ...opened,
    passphrase,
    keepFile: true,
  };
}

async function nameOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ username: user.username, name: user.name }).from(user).where(eq(user.id, id));
  return row ? (row.username ?? row.name) : null;
}

async function userExists(db: Db, id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (await db.select({ id: user.id }).from(user).where(eq(user.id, id))).length > 0;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}
