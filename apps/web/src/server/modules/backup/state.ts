/**
 * Process-wide backup state: the one backup or restore that may run, files staged for a restore, and the settings
 * tests replace. Like the task registry it lives in the single app process.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { msg } from "../../../i18n/index.ts";
import { env } from "../../env.ts";
import { UserError } from "../../errors.ts";
import type { Manifest } from "./archive.ts";
import { DEFAULT_KDF, type KdfParams, type Keys } from "./container.ts";

export type BusyKind = "backup" | "restore";

/** A staged archive: uploaded, or fetched from a target for a restore. */
export type Staged = { id: string; userId: string; file: string; name: string; createdAt: number };

/** An archive whose passphrase was right and whose content checked out, waiting for the confirmation. */
export type Prepared = Staged & {
  keys: Keys;
  manifest: Manifest;
  passphrase: string /** A file the person gave, not a staged copy. */;
  keepFile?: boolean;
};

type State = { busy: BusyKind | null; uploads: Map<string, Staged>; prepared: Map<string, Prepared> };

const KEY = Symbol.for("saldo.backup");
const store = globalThis as unknown as Record<symbol, State | undefined>;

export function state(): State {
  let current = store[KEY];
  if (!current) {
    current = { busy: null, uploads: new Map(), prepared: new Map() };
    store[KEY] = current;
  }
  return current;
}

export type BackupDeps = {
  kdf: KdfParams;
  databaseUrl: () => string;
  now: () => Date;
  /** Runs right before the databases are swapped; tests make it fail. */
  beforeSwap: () => Promise<void>;
};

export const deps: BackupDeps = {
  kdf: DEFAULT_KDF,
  databaseUrl: () => env().DATABASE_URL,
  now: () => new Date(),
  beforeSwap: async () => undefined,
};

/** Replaces dependencies for a test; returns the undo. */
export function setBackupDepsForTests(next: Partial<BackupDeps>): () => void {
  const previous = { ...deps };
  Object.assign(deps, next);
  return () => {
    Object.assign(deps, previous);
  };
}

/** Claims the single slot for a backup or restore, synchronously, so two starts cannot both pass. */
export function claimBusy(kind: BusyKind): () => void {
  const current = state();
  if (current.busy)
    throw new UserError(msg(current.busy === "restore" ? "backup.errors.restoreRunning" : "backup.errors.backupRunning"), 409);
  current.busy = kind;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.busy = null;
  };
}

export const busyKind = () => state().busy;

/** Staged and temporary files a run or restore works with; below the backup folder, so large files never land in RAM. */
export async function spoolDir(): Promise<string> {
  const dir = join(env().BACKUP_DIR, ".saldo-tmp");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new UserError(msg("backup.errors.folderNotWritable", { folder: env().BACKUP_DIR }));
  }
  return dir;
}

export const STAGED_TTL_MS = 60 * 60_000;

/** Forgets staged files after an hour and deletes leftovers of crashed runs. */
export async function pruneStaged(now = Date.now()): Promise<void> {
  const current = state();
  for (const map of [current.uploads, current.prepared] as Map<string, Staged>[]) {
    for (const [id, staged] of map) {
      if (now - staged.createdAt < STAGED_TTL_MS) continue;
      map.delete(id);
      await rm(staged.file, { force: true });
    }
  }
  const dir = join(env().BACKUP_DIR, ".saldo-tmp");
  const inUse = new Set([...current.uploads.values(), ...current.prepared.values()].map((s) => s.file));
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const file = join(dir, name);
    if (inUse.has(file) || current.busy) continue;
    const info = await stat(file).catch(() => null);
    // rclone gives a downloaded copy the archive's own (old) mtime; ctime says when the copy was made.
    if (info && now - Math.max(info.mtimeMs, info.ctimeMs) > 24 * 60 * 60_000) await rm(file, { recursive: true, force: true });
  }
}

export function resetBackupStateForTests(): void {
  store[KEY] = undefined;
}
