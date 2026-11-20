/**
 * The database side of backups. A dump runs inside one exported snapshot, so its row counts and migrations describe
 * exactly the dumped state. A restore only ever writes to a fresh database; the live one is replaced at the very end by
 * renaming both in one transaction, and kept as `<name>_previous` until the next restore. The dump itself is untrusted
 * (guard.ts): only allowed entries are restored, by a throwaway role without superuser rights, and the result is audited
 * and compared with a second throwaway database built from this build's migrations at the archive's level.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { msg } from "../../../i18n/index.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import { migrationsFolder, runMigrations } from "../../db/migrate.ts";
import { UserError } from "../../errors.ts";
import { type Manifest, openArchive } from "./archive.ts";
import type { Keys } from "./container.ts";
import { auditRestored, matchReference, restorableList } from "./guard.ts";
import { pgEnv, runTool } from "./tools.ts";

/** Sessions and sign-in tokens stay behind, so everyone signs in again after a restore; impersonations belong to sessions. */
export const EXCLUDED_DATA = ["session", "verification", "impersonations"] as const;

/** Every column holding ENCRYPTION_KEY ciphertext; re-keyed when an archive comes from an instance with another key. */
export const SECRET_COLUMNS = [
  { table: "bank_connections", column: "ciphertext", key: "id" },
  { table: "ai_providers", column: "api_key_ciphertext", key: "id" },
  { table: "settings", column: "ciphertext", key: "key" },
  { table: "backup_targets", column: "ciphertext", key: "id" },
] as const;

export type MigrationEntry = { hash: string; createdAt: number };

type Sql = postgres.Sql | postgres.TransactionSql;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const connect = (url: string) => postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

export const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

export async function tableCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname = 'public' order by tablename`;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from public.${ident(name)}`);
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

async function appliedMigrations(sql: Sql): Promise<MigrationEntry[]> {
  const rows = await sql<{ hash: string; created_at: string }[]>`
    select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at, id`;
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

/** The migrations of this build, oldest first. */
export function knownMigrations(): MigrationEntry[] {
  return readMigrationFiles({ migrationsFolder: migrationsFolder() }).map((m) => ({ hash: m.hash, createdAt: m.folderMillis }));
}

export const migrationsHash = (entries: MigrationEntry[]) =>
  createHash("sha256")
    .update(entries.map((entry) => `${entry.createdAt}:${entry.hash}`).join("\n"))
    .digest("hex");

export type Compatibility = { ok: true; pending: number } | { ok: false; reason: "newer" | "unknown" };

/**
 * Whether this build can take a database with these migrations applied: they must be the first of this build's
 * migrations, in order, with the same timestamps and hashes. Older archives are migrated after the restore; archives
 * that go on past this build's last migration are newer and refused, as is anything else.
 */
export function compatibility(applied: MigrationEntry[], known: MigrationEntry[] = knownMigrations()): Compatibility {
  const latestKnown = Math.max(0, ...known.map((entry) => entry.createdAt));
  for (const [index, entry] of applied.entries()) {
    const ours = known[index];
    if (ours?.createdAt === entry.createdAt && ours.hash === entry.hash) continue;
    return { ok: false, reason: !ours && entry.createdAt > latestKnown ? "newer" : "unknown" };
  }
  return { ok: true, pending: known.length - applied.length };
}

/** Applies this build's first `count` migrations, from a copy of the migrations folder that ends there. */
export async function migrateTo(url: string, count: number, scratch: string): Promise<void> {
  const folder = migrationsFolder();
  const journal = JSON.parse(await readFile(join(folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  if (count === journal.entries.length) return runMigrations(url, folder);
  const partial = join(scratch, "migrations");
  await mkdir(join(partial, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, count);
  await writeFile(join(partial, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) await copyFile(join(folder, `${tag}.sql`), join(partial, `${tag}.sql`));
  await runMigrations(url, partial);
}

export type DumpFacts = { counts: Record<string, number>; migrations: MigrationEntry[]; serverVersion: string };

/** pg_dump (custom format) of the database at one snapshot, streamed to `sink`, with the facts of that snapshot. */
export async function dumpDatabase(url: string, sink: (out: AsyncIterable<Buffer>) => Promise<void>): Promise<DumpFacts> {
  const sql = connect(url);
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      const [exported] = await tx<{ snapshot: string }[]>`select pg_export_snapshot() as snapshot`;
      const [version] = await tx<{ server_version: string }[]>`show server_version`;
      const facts = {
        counts: await tableCounts(tx),
        migrations: await appliedMigrations(tx),
        serverVersion: version?.server_version ?? "",
      };
      const args = [
        "--format=custom",
        `--snapshot=${exported?.snapshot ?? ""}`,
        ...EXCLUDED_DATA.map((t) => `--exclude-table-data=public.${t}`),
      ];
      await runTool("pg_dump", args, { env: pgEnv(url), stdout: sink });
      return facts;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function rekey(url: string, from: Buffer, to: Buffer): Promise<void> {
  const sql = connect(url);
  try {
    await sql.begin(async (tx) => {
      for (const { table, column, key } of SECRET_COLUMNS) {
        const rows = await tx.unsafe<{ k: string; v: string }[]>(
          `select ${ident(key)}::text as k, ${ident(column)} as v from public.${ident(table)} where ${ident(column)} is not null and ${ident(column)} <> ''`,
        );
        for (const row of rows) {
          let plain: string;
          try {
            plain = decrypt(row.v, from);
          } catch {
            throw new UserError(msg("backup.errors.rekeyFailed"));
          }
          await tx.unsafe(`update public.${ident(table)} set ${ident(column)} = $1 where ${ident(key)}::text = $2`, [
            encrypt(plain, to),
            row.k,
          ]);
        }
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function swap(admin: postgres.Sql, live: string, temp: string, previous: string): Promise<void> {
  await admin.unsafe(`drop database if exists ${ident(previous)} with (force)`);
  for (let attempt = 1; ; attempt++) {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname in (${live}, ${temp}) and pid <> pg_backend_pid()`;
    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(`alter database ${ident(live)} rename to ${ident(previous)}`);
        await tx.unsafe(`alter database ${ident(temp)} rename to ${ident(live)}`);
      });
      return;
    } catch (error) {
      // 55006: a client reconnected in between; it is terminated again on the next attempt.
      if (attempt >= 10 || (error as { code?: unknown }).code !== "55006") throw error;
      await sleep(200 * attempt);
    }
  }
}

/**
 * The table of contents of a custom-format dump (`pg_restore --list`), while the whole dump is still read: pg_restore
 * may stop after the TOC, and the archive's checksum covers every byte.
 */
export async function dumpContents(dump: AsyncIterable<Buffer>): Promise<string> {
  const feed = new PassThrough();
  feed.on("error", () => undefined);
  let open = true;
  const listed = runTool("pg_restore", ["--list"], { stdin: feed }).finally(() => {
    open = false;
    feed.destroy();
  });
  listed.catch(() => undefined);
  for await (const piece of dump) {
    if (open && !feed.write(piece)) await Promise.race([once(feed, "drain"), once(feed, "close"), listed.catch(() => undefined)]);
  }
  if (open) feed.end();
  return (await listed).toString("utf8");
}

export type RestoreInput = {
  liveUrl: string;
  /** The staged archive, already checked once in full. */
  file: string;
  keys: Keys;
  manifest: Manifest;
  /** ENCRYPTION_KEY of this instance. */
  currentKey: Buffer;
  beforeSwap?: () => Promise<void>;
  onStep?: (step: "restore" | "migrate" | "swap") => void;
};

/**
 * Restores the archive into a fresh database, audits it, compares its schema with a reference database migrated to
 * the archive's level, checks its row counts against the manifest, migrates and re-keys it, and only then swaps it in.
 * Any failure before the swap leaves the live database as it was; the new and the reference database are dropped.
 */
export async function restoreDatabase(input: RestoreInput): Promise<{ database: string; previous: string }> {
  const live = databaseName(input.liveUrl);
  const base = live.slice(0, 40);
  const suffix = randomBytes(4).toString("hex");
  const temp = `${base}_restore_${suffix}`;
  const previous = `${base}_previous`;
  const tempUrl = withDatabase(input.liveUrl, temp);
  const reference = `${base}_reference_${suffix}`;
  const referenceUrl = withDatabase(input.liveUrl, reference);
  const admin = connect(withDatabase(input.liveUrl, "postgres"));
  const scratch = await mkdtemp(join(tmpdir(), "saldo-restore-"));
  let created = false;
  let role: string | null = null;
  let referenceBuilt: Promise<void> | null = null;
  try {
    const level = compatibility(input.manifest.migrations.applied);
    if (!level.ok) throw new UserError(msg(level.reason === "newer" ? "backup.errors.newerSchema" : "backup.errors.unknownSchema"));
    let list = "";
    await openArchive(
      createReadStream(input.file),
      { keys: input.keys },
      {
        onDump: async (dump) => {
          list = await dumpContents(dump);
        },
      },
    );
    const listFile = join(scratch, "restore.list");
    await writeFile(listFile, restorableList(list), { mode: 0o600 });

    const [info] = await admin<{ encoding: string; collate: string; ctype: string; provider: string; superuser: boolean }[]>`
      select pg_encoding_to_char(encoding) as encoding, datcollate as collate, datctype as ctype, datlocprovider::text as provider,
        (select rolsuper from pg_roles where rolname = current_user) as superuser
      from pg_database where datname = ${live}`;
    if (!info) throw new UserError(msg("backup.errors.restoreFailed", { reason: live }));
    // As a superuser Saldo would restore with every right there is; a role of its own owns only the new database.
    const password = randomBytes(24).toString("hex");
    if (info.superuser) {
      role = `${base}_restore_${suffix}`;
      await admin.unsafe(
        `create role ${ident(role)} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 4 ` +
          `password ${literal(password)} valid until ${literal(new Date(Date.now() + 24 * 3600_000).toISOString())}`,
      );
    }
    const locale =
      info.provider === "c"
        ? ` encoding ${literal(info.encoding)} lc_collate ${literal(info.collate)} lc_ctype ${literal(info.ctype)}`
        : "";
    await admin.unsafe(`create database ${ident(temp)} template template0${locale}${role ? ` owner ${ident(role)}` : ""}`);
    created = true;
    referenceBuilt = admin
      .unsafe(`create database ${ident(reference)} template template0${locale}`)
      .then(() => migrateTo(referenceUrl, input.manifest.migrations.applied.length, scratch));
    referenceBuilt.catch(() => undefined);

    input.onStep?.("restore");
    const restoreEnv = role ? { ...pgEnv(input.liveUrl, temp), PGUSER: role, PGPASSWORD: password } : pgEnv(input.liveUrl, temp);
    await openArchive(
      createReadStream(input.file),
      { keys: input.keys },
      {
        onDump: (dump) =>
          runTool(
            "pg_restore",
            [
              "--no-owner",
              "--no-privileges",
              "--no-comments",
              "--exit-on-error",
              "--single-transaction",
              `--use-list=${listFile}`,
              `--dbname=${temp}`,
            ],
            { env: restoreEnv, stdin: dump },
          ).then(() => undefined),
      },
    );

    const restored = connect(tempUrl);
    try {
      await auditRestored(restored);
      await referenceBuilt;
      const expected = connect(referenceUrl);
      try {
        await matchReference(restored, expected);
      } finally {
        await expected.end({ timeout: 5 });
      }
      if (migrationsHash(await appliedMigrations(restored)) !== migrationsHash(input.manifest.migrations.applied)) {
        throw new UserError(msg("backup.errors.unsafeDump", { entry: "TABLE DATA drizzle __drizzle_migrations" }));
      }
      const counts = await tableCounts(restored);
      const excluded = new Set<string>(EXCLUDED_DATA);
      for (const [table, expected] of Object.entries(input.manifest.counts)) {
        if (!excluded.has(table) && counts[table] !== expected) throw new UserError(msg("backup.errors.countMismatch", { table }));
      }
      if (role) {
        await restored.unsafe(`reassign owned by ${ident(role)} to current_user`);
        await restored.unsafe(`drop owned by ${ident(role)}`);
      }
      await restored`create extension if not exists unaccent`;
    } finally {
      await restored.end({ timeout: 5 });
    }
    if (role) {
      await admin.unsafe(`drop role ${ident(role)}`);
      role = null;
    }

    input.onStep?.("migrate");
    await runMigrations(tempUrl);
    const archiveKey = Buffer.from(input.manifest.encryptionKey, "base64");
    if (!archiveKey.equals(input.currentKey)) await rekey(tempUrl, archiveKey, input.currentKey);
    await input.beforeSwap?.();

    input.onStep?.("swap");
    await swap(admin, live, temp, previous);
    created = false;
    return { database: live, previous };
  } finally {
    if (referenceBuilt) {
      await referenceBuilt.catch(() => undefined);
      await admin.unsafe(`drop database if exists ${ident(reference)} with (force)`).catch(() => undefined);
    }
    if (created) await admin.unsafe(`drop database if exists ${ident(temp)} with (force)`).catch(() => undefined);
    if (role) await admin.unsafe(`drop role if exists ${ident(role)}`).catch(() => undefined);
    await admin.end({ timeout: 5 });
    await rm(scratch, { recursive: true, force: true });
  }
}
