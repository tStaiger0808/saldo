import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveName, MAX_UPLOAD_BYTES } from "../../../lib/backup.ts";
import { bodyLimit } from "../../body-limit.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import { type Db, db, schema } from "../../db/index.ts";
import { runMigrations } from "../../db/migrate.ts";
import { auditEvents, backupRuns, bankConnections, notifications, settings } from "../../db/schema.ts";
import { env, resetEnvForTests } from "../../env.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createAccount } from "../accounts/index.ts";
import { resetTasksForTests } from "../tasks/index.ts";
import { type Manifest, openArchive, sealArchive } from "./archive.ts";
import { FAST_KDF } from "./container.ts";
import { compatibility, dumpContents, knownMigrations, migrateTo, restoreDatabase, SECRET_COLUMNS, withDatabase } from "./database.ts";
import { auditRestored, matchReference, restorableList } from "./guard.ts";
import {
  confirmBackupRestore,
  deleteTarget,
  getBackupOverview,
  listTargetArchives,
  openDownload,
  prepareBackupRestore,
  runScheduledBackup,
  saveSchedule,
  saveTarget,
  setBackupDepsForTests,
  setPassphrase,
  startBackup,
  testBackupTarget,
  uploadRestoreArchive,
} from "./index.ts";
import { createArchiveFile } from "./runs.ts";
import { busyKind, claimBusy, resetBackupStateForTests } from "./state.ts";

const PASSPHRASE = "eine lange passphrase für tests";
const tools = ["pg_dump", "pg_restore", "rclone"].every((tool) => spawnSync(tool, ["--version"]).status === 0);
const BASE = process.env.TEST_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/finanzen_test";
const LIVE_NAME = "finanzen_test_backup_live";
const LIVE = withDatabase(BASE, LIVE_NAME);

async function waitIdle(): Promise<void> {
  for (let i = 0; i < 600 && busyKind() !== null; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(busyKind()).toBeNull();
}

/** One checksum per table: identical data gives identical checksums. */
async function checksums(url: string, skip: string[] = []): Promise<Record<string, string>> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await client<{ name: string }[]>`select tablename as name from pg_tables where schemaname = 'public' order by 1`;
    const out: Record<string, string> = {};
    for (const { name } of tables) {
      if (skip.includes(name)) continue;
      const [row] = await client.unsafe<{ sum: string | null }[]>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as sum from public."${name}" t`,
      );
      out[name] = row?.sum ?? "";
    }
    return out;
  } finally {
    await client.end();
  }
}

async function admin<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const client = postgres(withDatabase(BASE, "postgres"), { max: 1, onnotice: () => {} });
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function databases(prefix: string): Promise<string[]> {
  return admin(async (client) =>
    (await client<{ datname: string }[]>`select datname from pg_database where datname like ${`${prefix}%`} order by 1`).map(
      (r) => r.datname,
    ),
  );
}

async function freeLive(): Promise<void> {
  await admin(async (client) => {
    for (const name of await databases(LIVE_NAME)) await client.unsafe(`drop database if exists "${name}" with (force)`);
  });
}

/** A second "live" database the restore replaces, so the test database itself stays in place. */
async function freshLive(): Promise<{ db: Db; client: postgres.Sql }> {
  await freeLive();
  await admin((client) => client.unsafe(`create database "${LIVE_NAME}"`));
  await runMigrations(LIVE);
  const client = postgres(LIVE, { max: 2, onnotice: () => {} });
  const live = drizzle(client, { schema });
  await live.insert(settings).values({ key: "only_in_live", value: "before" });
  return { db: live, client };
}

async function uploadFile(viewer: Viewer, file: string): Promise<string> {
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return (await uploadRestoreArchive(viewer, body, "upload.saldo-backup")).uploadId;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

it("lets only the restore upload send up to 2 GB", () => {
  expect(bodyLimit("/api/backup/upload")).toBeGreaterThan(MAX_UPLOAD_BYTES);
  expect(bodyLimit("/api/backup/upload/x")).toBe(1024 * 1024);
  expect(bodyLimit("/api/backup/download")).toBe(1024 * 1024);
});

describe("migration levels", () => {
  const known = [1, 2, 3].map((n) => ({ hash: String(n).repeat(64), createdAt: n * 1000 }));

  it("takes the same or an older level when its migrations are a prefix of this build's", () => {
    expect(compatibility(known, known)).toEqual({ ok: true, pending: 0 });
    expect(compatibility(known.slice(0, 1), known)).toEqual({ ok: true, pending: 2 });
    expect(compatibility([], known)).toEqual({ ok: true, pending: 3 });
  });

  it("refuses migrations that are not a prefix, and calls only a longer list newer", () => {
    expect(compatibility([...known, { hash: "f".repeat(64), createdAt: 9000 }], known)).toEqual({ ok: false, reason: "newer" });
    for (const applied of [
      known.filter((_, index) => index !== 1),
      known.toReversed(),
      [{ hash: "e".repeat(64), createdAt: 1000 }],
      [{ hash: "1".repeat(64), createdAt: 1001 }],
    ]) {
      expect(compatibility(applied, known)).toEqual({ ok: false, reason: "unknown" });
    }
  });
});

describe.skipIf(!tools)("backups", { timeout: 120_000 }, () => {
  let dir: string;
  let superuser: Viewer;
  let member: Viewer;
  let familyAdmin: Viewer;
  let localTarget: number;
  let undoDeps: () => void;
  const previousDir = process.env.BACKUP_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "saldo-backups-"));
    process.env.BACKUP_DIR = dir;
    resetEnvForTests();
    undoDeps = setBackupDepsForTests({ kdf: FAST_KDF });
    await resetDb();
    superuser = { ...(await makeUser("chef", "superuser")), locale: "de" };
    member = { ...(await makeUser("kind", "member")), locale: "de" };
    familyAdmin = { ...(await makeUser("mama", "familyAdmin")), locale: "de" };
    await createAccount(db(), superuser, { name: "Giro", bank: "dkb", kind: "checking", color: "#1f6f5c" });
    await db()
      .insert(bankConnections)
      .values({
        name: "DKB",
        ownerUserId: superuser.id,
        provider: "fints",
        bank: "dkb",
        ciphertext: encrypt(JSON.stringify({ login: "kunde", pin: "13579" })),
      });
    localTarget = (await saveTarget(db(), superuser, { name: "Lokal", keep: 5, config: { type: "local", path: "saldo" } })).id;
  });

  afterAll(async () => {
    undoDeps();
    resetBackupStateForTests();
    resetTasksForTests();
    if (previousDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = previousDir;
    resetEnvForTests();
    await freeLive();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetBackupStateForTests();
  });

  async function backupNow(): Promise<string> {
    await saveSchedule(db(), superuser, { frequency: "off", time: "03:00", weekday: 1, monthDay: 1, targetIds: [localTarget] });
    await startBackup(db(), superuser);
    await waitIdle();
    const [run] = await db().select().from(backupRuns).orderBy(sql`${backupRuns.id} desc`).limit(1);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "ok", trigger: "manual" });
    return join(dir, "saldo", run?.fileName ?? "");
  }

  it("is for superusers only, and never while viewing as someone else", async () => {
    const viewing: Viewer = {
      ...superuser,
      impersonation: { actorId: superuser.id, actorName: "chef", expiresAt: "2099-01-01T00:00:00Z" },
    };
    for (const viewer of [member, familyAdmin, viewing]) {
      await expect(getBackupOverview(db(), viewer)).rejects.toMatchObject({ status: 403 });
      await expect(saveTarget(db(), viewer, { name: "x", keep: 1, config: { type: "local", path: "" } })).rejects.toMatchObject({
        status: 403,
      });
      await expect(setPassphrase(db(), viewer, { passphrase: PASSPHRASE, confirmation: PASSPHRASE })).rejects.toMatchObject({
        status: 403,
      });
      await expect(startBackup(db(), viewer)).rejects.toMatchObject({ status: 403 });
      await expect(listTargetArchives(db(), viewer, { targetId: localTarget })).rejects.toMatchObject({ status: 403 });
      await expect(openDownload(db(), viewer, { targetId: localTarget, name: archiveName(new Date()) })).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        prepareBackupRestore(db(), viewer, { source: { kind: "upload", uploadId: "x" }, passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(confirmBackupRestore(db(), viewer, { restoreId: "x", confirmation: "WIEDERHERSTELLEN" })).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  it("checks the passphrase and keeps it only encrypted", async () => {
    await expect(setPassphrase(db(), superuser, { passphrase: "zu kurz", confirmation: "zu kurz" })).rejects.toThrow();
    await expect(setPassphrase(db(), superuser, { passphrase: PASSPHRASE, confirmation: `${PASSPHRASE}!` })).rejects.toMatchObject({
      text: { key: "backup.errors.passphraseMismatch" },
    });
    await setPassphrase(db(), superuser, { passphrase: PASSPHRASE, confirmation: PASSPHRASE });
    const [row] = await db().select().from(settings).where(eq(settings.key, "backup_passphrase"));
    expect(JSON.stringify(row)).not.toContain(PASSPHRASE);
    expect(decrypt(row?.ciphertext ?? "")).toBe(PASSPHRASE);
    expect((await getBackupOverview(db(), superuser)).passphrase.set).toBe(true);
  });

  it("stores target secrets encrypted, never shows them and asks again for a new server", async () => {
    const saved = await saveTarget(db(), superuser, {
      name: "NAS",
      keep: 3,
      config: { type: "sftp", host: "127.0.0.1", port: 9, username: "saldo", auth: "password", path: "/backups", knownHosts: "" },
      secrets: { password: "sftp-geheim" },
    });
    expect(saved.test.ok).toBe(false);
    const overview = await getBackupOverview(db(), superuser);
    expect(JSON.stringify(overview)).not.toContain("sftp-geheim");
    expect(overview.targets.find((target) => target.id === saved.id)).toMatchObject({ secretsSet: ["password"], type: "sftp" });
    const update = {
      name: "NAS",
      keep: 3,
      config: {
        type: "sftp" as const,
        host: "127.0.0.1",
        port: 9,
        username: "saldo",
        auth: "password" as const,
        path: "/x",
        knownHosts: "",
      },
    };
    await expect(saveTarget(db(), superuser, { id: saved.id, ...update })).resolves.toMatchObject({ id: saved.id });
    await expect(
      saveTarget(db(), superuser, { id: saved.id, ...update, config: { ...update.config, host: "nas.example" } }),
    ).rejects.toMatchObject({
      text: { key: "backup.errors.reenterSecret" },
    });
    for (const change of [{ knownHosts: "nas.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample" }, { auth: "key" as const }]) {
      await expect(saveTarget(db(), superuser, { id: saved.id, ...update, config: { ...update.config, ...change } })).rejects.toMatchObject(
        {
          text: { key: change.auth ? "backup.errors.keyRequired" : "backup.errors.reenterSecret" },
        },
      );
    }

    const ftp = {
      type: "ftp" as const,
      host: "127.0.0.1",
      port: 9,
      username: "saldo",
      tls: "explicit" as const,
      skipVerify: false,
      path: "",
    };
    const stored = await saveTarget(db(), superuser, { name: "FTP", keep: 3, config: ftp, secrets: { password: "ftp-geheim" } });
    for (const weaker of [{ skipVerify: true }, { tls: "none" as const }, { tls: "implicit" as const }]) {
      await expect(
        saveTarget(db(), superuser, { id: stored.id, name: "FTP", keep: 3, config: { ...ftp, ...weaker } }),
      ).rejects.toMatchObject({
        text: { key: "backup.errors.reenterSecret" },
      });
    }
    await saveTarget(db(), superuser, { id: stored.id, name: "FTP", keep: 3, config: { ...ftp, path: "anderswo" } });
    expect((await getBackupOverview(db(), superuser)).targets.find((t) => t.id === stored.id)?.secretsSet).toEqual(["password"]);
    await saveTarget(db(), superuser, {
      id: stored.id,
      name: "FTP",
      keep: 3,
      config: { ...ftp, skipVerify: true },
      secrets: { password: "neu" },
    });
    await deleteTarget(db(), superuser, { id: stored.id });
    await expect(saveTarget(db(), superuser, { name: "x", keep: 1, config: { type: "local", path: "../etc" } })).rejects.toThrow();
    await expect(
      saveTarget(db(), superuser, {
        name: "x",
        keep: 1,
        config: { type: "ftp", host: "ftp://host", port: 21, username: "u", tls: "explicit" },
      }),
    ).rejects.toThrow();
    await deleteTarget(db(), superuser, { id: saved.id });
  });

  it("covers every encrypted column when re-keying", () => {
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => value instanceof PgTable);
    const found = tables.flatMap((table) =>
      Object.values(getTableColumns(table))
        .filter((column) => column.name.includes("ciphertext"))
        .map((column) => `${getTableName(table)}.${column.name}`),
    );
    expect(found.sort()).toEqual(SECRET_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
  });

  it("backs up to the local folder, lists, downloads and keeps only the newest per target", async () => {
    const times = ["2026-11-01T03:00:00Z", "2026-11-02T03:00:00Z", "2026-11-03T03:00:00Z"].map((iso) => new Date(iso));
    await saveTarget(db(), superuser, { id: localTarget, name: "Lokal", keep: 2, config: { type: "local", path: "saldo" } });
    for (const now of times) {
      const undo = setBackupDepsForTests({ now: () => now });
      await backupNow();
      undo();
    }
    await writeFile(join(dir, "saldo", "notizen.txt"), "nicht von Saldo");
    await writeFile(join(dir, "saldo", archiveName(new Date("2026-10-01T00:00:00Z"), "-pre-restore")), "x");
    const undo = setBackupDepsForTests({ now: () => new Date("2026-11-04T03:00:00Z") });
    const file = await backupNow();
    undo();
    const names = (await readdir(join(dir, "saldo"))).sort();
    expect(names).toEqual([
      "notizen.txt",
      "saldo-2026-10-01T00-00-00Z-pre-restore.saldo-backup",
      "saldo-2026-11-03T03-00-00Z.saldo-backup",
      "saldo-2026-11-04T03-00-00Z.saldo-backup",
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const archives = await listTargetArchives(db(), superuser, { targetId: localTarget });
    expect(archives.map((a) => [a.name, a.kind])).toEqual([
      ["saldo-2026-11-04T03-00-00Z.saldo-backup", "run"],
      ["saldo-2026-11-03T03-00-00Z.saldo-backup", "run"],
      ["saldo-2026-10-01T00-00-00Z-pre-restore.saldo-backup", "safety"],
    ]);

    const download = await openDownload(db(), superuser, { targetId: localTarget, name: "saldo-2026-11-04T03-00-00Z.saldo-backup" });
    const bytes = Buffer.from(await new Response(download.stream).arrayBuffer());
    expect(bytes.equals(await readFile(file))).toBe(true);
    expect(download.size).toBe(bytes.length);
    const audit = await db().select().from(auditEvents).where(eq(auditEvents.action, "backup.downloaded"));
    expect(audit).toHaveLength(1);
    await expect(openDownload(db(), superuser, { targetId: localTarget, name: "../etc/passwd" })).rejects.toThrow();
    await expect(openDownload(db(), superuser, { targetId: localTarget, name: archiveName(new Date("2020-01-01")) })).rejects.toMatchObject(
      {
        status: 404,
      },
    );

    const [opened] = await Promise.all([openArchive(createReadStream(file), { passphrase: PASSPHRASE })]);
    expect(opened.manifest.counts).toMatchObject({ accounts: 1, bank_connections: 1, user: 3 });
    expect(opened.manifest.encryptionKey).toBe(env().ENCRYPTION_KEY);
    expect(opened.manifest.migrations.count).toBe(knownMigrations().length);
    expect((await db().select().from(auditEvents).where(eq(auditEvents.action, "backup.run"))).every((e) => e.outcome === "ok")).toBe(true);
  });

  it("refuses a second backup while one runs", async () => {
    const release = claimBusy("restore");
    await expect(startBackup(db(), superuser)).rejects.toMatchObject({ status: 409 });
    release();
  });

  it("runs the schedule once per slot, not for slots before it was saved", async () => {
    await saveSchedule(db(), superuser, { frequency: "daily", time: "03:00", weekday: 1, monthDay: 1, targetIds: [localTarget] });
    const before = (await db().select().from(backupRuns)).length;
    await runScheduledBackup(db(), new Date());
    expect(busyKind()).toBeNull();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(4, 0, 0, 0);
    await runScheduledBackup(db(), tomorrow);
    await runScheduledBackup(db(), tomorrow);
    await waitIdle();
    const runs = await db().select().from(backupRuns);
    expect(runs.length - before).toBe(1);
    expect(runs.at(-1)).toMatchObject({ trigger: "scheduled", status: "ok", startedBy: null });
    await saveSchedule(db(), superuser, { frequency: "off", time: "03:00", weekday: 1, monthDay: 1, targetIds: [localTarget] });
  });

  it("restores into a fresh database, reproduces every table and keeps the old one aside", async () => {
    const file = await backupNow();
    const expected = await checksums(BASE, ["session", "verification", "impersonations", "audit_events", "backup_runs", "notifications"]);
    const live = await freshLive();
    try {
      const undo = setBackupDepsForTests({ databaseUrl: () => LIVE });
      const preview = await prepareBackupRestore(live.db, superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, file) },
        passphrase: PASSPHRASE,
      });
      expect(preview).toMatchObject({
        counts: { users: 3, accounts: 1, bankConnections: 1 },
        sameEncryptionKey: true,
        safetyPassphrase: "archive",
      });
      await expect(confirmBackupRestore(live.db, superuser, { restoreId: preview.restoreId, confirmation: "nein" })).rejects.toMatchObject({
        text: { key: "backup.errors.confirmationMismatch" },
      });
      await confirmBackupRestore(live.db, superuser, { restoreId: preview.restoreId, confirmation: "wiederherstellen" });
      await waitIdle();
      undo();
      const actual = await checksums(LIVE, ["session", "verification", "impersonations", "audit_events", "backup_runs", "notifications"]);
      expect(actual).toEqual(expected);
      expect(await databases(LIVE_NAME)).toEqual([LIVE_NAME, `${LIVE_NAME}_previous`]);
      const previous = postgres(withDatabase(BASE, `${LIVE_NAME}_previous`), { max: 1, onnotice: () => {} });
      expect(await previous`select value from settings where key = 'only_in_live'`).toHaveLength(1);
      await previous.end();
      expect(await live.db.select().from(settings).where(eq(settings.key, "only_in_live"))).toHaveLength(0);
      const restored = await live.db.select().from(auditEvents).where(eq(auditEvents.action, "backup.restored"));
      expect(restored).toMatchObject([{ outcome: "ok", userId: superuser.id }]);
      expect(await live.db.select().from(backupRuns).where(eq(backupRuns.trigger, "safety"))).toMatchObject([{ status: "ok" }]);
      const safety = (await readdir(dir)).filter((name) => name.endsWith("-pre-restore.saldo-backup"));
      expect(safety).toHaveLength(1);
      await admin(async (client) => {
        expect(await client`select rolname from pg_roles where rolname like ${`${LIVE_NAME}_restore_%`}`).toEqual([]);
        const [owner] = await client<
          { owner: string }[]
        >`select pg_get_userbyid(datdba) as owner from pg_database where datname = ${LIVE_NAME}`;
        expect(owner?.owner).toBe(new URL(BASE).username);
      });
      const owners = await live.client<
        { owner: string }[]
      >`select distinct tableowner as owner from pg_tables where schemaname in ('public', 'drizzle')`;
      expect(owners.map((o) => o.owner)).toEqual([new URL(BASE).username]);
    } finally {
      await live.client.end();
    }
  });

  it("re-keys secrets when the archive comes from an instance with another ENCRYPTION_KEY", async () => {
    const file = await backupNow();
    const previousKey = process.env.ENCRYPTION_KEY;
    const live = await freshLive();
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetEnvForTests();
    try {
      const undo = setBackupDepsForTests({ databaseUrl: () => LIVE });
      const preview = await prepareBackupRestore(live.db, superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, file) },
        passphrase: PASSPHRASE,
      });
      expect(preview.sameEncryptionKey).toBe(false);
      await confirmBackupRestore(live.db, superuser, { restoreId: preview.restoreId, confirmation: "WIEDERHERSTELLEN" });
      await waitIdle();
      undo();
      const [connection] = await live.db.select().from(bankConnections);
      expect(JSON.parse(decrypt(connection?.ciphertext ?? ""))).toEqual({ login: "kunde", pin: "13579" });
      const [passphrase] = await live.db.select().from(settings).where(eq(settings.key, "backup_passphrase"));
      expect(decrypt(passphrase?.ciphertext ?? "")).toBe(PASSPHRASE);
      expect(await live.db.select().from(auditEvents).where(eq(auditEvents.action, "backup.restored"))).toMatchObject([{ outcome: "ok" }]);
    } finally {
      process.env.ENCRYPTION_KEY = previousKey;
      resetEnvForTests();
      await live.client.end();
    }
  });

  it("refuses a wrong passphrase, a changed byte and an archive from a newer schema", async () => {
    const file = await backupNow();
    await expect(
      prepareBackupRestore(db(), superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, file) },
        passphrase: "falsche passphrase",
      }),
    ).rejects.toMatchObject({ text: { key: "backup.errors.wrongPassphrase" } });

    const tampered = join(dir, "tampered.saldo-backup");
    const bytes = await readFile(file);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 1;
    await writeFile(tampered, bytes);
    await expect(
      prepareBackupRestore(db(), superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, tampered) },
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ text: { key: "backup.errors.damaged" } });

    let manifest: Manifest | null = null;
    let dump = Buffer.alloc(0);
    await openArchive(
      createReadStream(file),
      { passphrase: PASSPHRASE },
      {
        onDump: async (body, m) => {
          manifest = m;
          const parts: Buffer[] = [];
          for await (const piece of body) parts.push(piece);
          dump = Buffer.concat(parts);
        },
      },
    );
    const current = manifest as unknown as Manifest;
    const future = [...current.migrations.applied, { hash: "f".repeat(64), createdAt: Date.now() + 86_400_000 }];
    expect(compatibility(future)).toEqual({ ok: false, reason: "newer" });
    const newer = join(dir, "saldo", archiveName(new Date("2030-01-01T00:00:00Z")));
    const sealed = await sealArchive(
      { ...current, migrations: { ...current.migrations, applied: future, count: future.length } },
      Readable.from([dump]),
      PASSPHRASE,
      {
        kdf: FAST_KDF,
      },
    );
    await pipeline(Readable.from(sealed), createWriteStream(newer));
    await expect(
      prepareBackupRestore(db(), superuser, {
        source: { kind: "target", targetId: localTarget, name: "saldo-2030-01-01T00-00-00Z.saldo-backup" },
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ text: { key: "backup.errors.newerSchema" } });
    await rm(newer);

    const gap = current.migrations.applied.filter((_, index) => index !== 1);
    const foreign = join(dir, "foreign.saldo-backup");
    const foreignManifest = { ...current, migrations: { ...current.migrations, applied: gap, count: gap.length } };
    await pipeline(
      Readable.from(await sealArchive(foreignManifest, Readable.from([dump]), PASSPHRASE, { kdf: FAST_KDF })),
      createWriteStream(foreign),
    );
    await expect(
      prepareBackupRestore(db(), superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, foreign) },
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ text: { key: "backup.errors.unknownSchema" } });
    const { keys } = await openArchive(createReadStream(foreign), { passphrase: PASSPHRASE });
    await expect(
      restoreDatabase({
        liveUrl: LIVE,
        file: foreign,
        keys,
        manifest: foreignManifest,
        currentKey: Buffer.from(env().ENCRYPTION_KEY, "base64"),
      }),
    ).rejects.toMatchObject({ text: { key: "backup.errors.unknownSchema" } });
    expect(await databases(`${LIVE_NAME}_re`)).toEqual([]);
    await rm(foreign);
    await expect(uploadFile(superuser, join(dir, "saldo", "notizen.txt"))).rejects.toMatchObject({
      text: { key: "backup.errors.notAnArchive" },
    });
  });

  it("leaves the live database untouched when the restore fails", async () => {
    const file = await backupNow();
    const live = await freshLive();
    try {
      const before = await checksums(LIVE);
      const undo = setBackupDepsForTests({
        databaseUrl: () => LIVE,
        beforeSwap: async () => {
          throw new Error("disk full");
        },
      });
      const preview = await prepareBackupRestore(live.db, superuser, {
        source: { kind: "upload", uploadId: await uploadFile(superuser, file) },
        passphrase: PASSPHRASE,
      });
      await confirmBackupRestore(live.db, superuser, { restoreId: preview.restoreId, confirmation: "WIEDERHERSTELLEN" });
      await waitIdle();

      const { manifest } = await openArchive(createReadStream(file), { passphrase: PASSPHRASE });
      const garbage = Buffer.from("PGDMP but not really a dump");
      const broken = join(dir, "broken.saldo-backup");
      const brokenManifest = {
        ...(manifest as unknown as Manifest),
        database: { file: "database.dump" as const, bytes: garbage.length, sha256: createHash("sha256").update(garbage).digest("hex") },
      };
      await pipeline(
        Readable.from(await sealArchive(brokenManifest, Readable.from([garbage]), PASSPHRASE, { kdf: FAST_KDF })),
        createWriteStream(broken),
      );
      await expect(
        prepareBackupRestore(live.db, superuser, {
          source: { kind: "upload", uploadId: await uploadFile(superuser, broken) },
          passphrase: PASSPHRASE,
        }),
      ).rejects.toMatchObject({ text: { key: "backup.errors.damaged" } });
      undo();

      const after = await checksums(LIVE, ["audit_events", "backup_runs"]);
      const { audit_events: _a, backup_runs: _b, ...unchanged } = before;
      expect(after).toEqual(unchanged);
      expect(await databases(LIVE_NAME)).toEqual([LIVE_NAME]);
      const failures = await live.db.select().from(auditEvents).where(eq(auditEvents.action, "backup.restored"));
      expect(failures.map((f) => f.outcome)).toEqual(["failed"]);
      expect(await live.db.select().from(settings).where(eq(settings.key, "only_in_live"))).toHaveLength(1);
    } finally {
      await live.client.end();
    }
  });

  it("restores only what Saldo's own pg_dump writes", async () => {
    const file = await backupNow();
    let list = "";
    await openArchive(
      createReadStream(file),
      { passphrase: PASSPHRASE },
      {
        onDump: async (dump) => {
          list = await dumpContents(dump);
        },
      },
    );
    const kept = restorableList(list);
    expect(kept).toMatch(/TABLE DATA public transactions /);
    expect(kept).toMatch(/TABLE drizzle __drizzle_migrations /);
    expect(kept).not.toMatch(/EXTENSION|COMMENT|ACL/);

    const evil = withDatabase(BASE, "finanzen_test_backup_evil");
    const live = await freshLive();
    const plant = [
      "create function public.stolen() returns trigger language plpgsql as $$ begin return new; end $$; " +
        "create trigger stolen before insert on public.settings for each row execute function public.stolen();",
      "create schema elsewhere; create table elsewhere.notes (id int);",
    ];
    try {
      for (const sql of plant) {
        await admin(async (client) => {
          await client.unsafe('drop database if exists "finanzen_test_backup_evil" with (force)');
          await client.unsafe('create database "finanzen_test_backup_evil"');
        });
        await runMigrations(evil);
        const client = postgres(evil, { max: 1, onnotice: () => {} });
        await client.unsafe(sql);
        await expect(auditRestored(client)).rejects.toMatchObject({ text: { key: "backup.errors.unsafeDump" } });
        await client.end();

        const archive = await createArchiveFile(evil, PASSPHRASE, archiveName(new Date()));
        await expect(
          prepareBackupRestore(db(), superuser, {
            source: { kind: "upload", uploadId: await uploadFile(superuser, archive.path) },
            passphrase: PASSPHRASE,
          }),
        ).rejects.toMatchObject({ text: { key: "backup.errors.unsafeDump" } });
        const { keys, manifest } = await openArchive(createReadStream(archive.path), { passphrase: PASSPHRASE });
        await expect(
          restoreDatabase({ liveUrl: LIVE, file: archive.path, keys, manifest, currentKey: Buffer.from(env().ENCRYPTION_KEY, "base64") }),
        ).rejects.toMatchObject({ text: { key: "backup.errors.unsafeDump" } });
        await rm(archive.path, { force: true });
      }
      expect(await databases(LIVE_NAME)).toEqual([LIVE_NAME]);
      expect(await live.db.select().from(settings).where(eq(settings.key, "only_in_live"))).toHaveLength(1);
    } finally {
      await live.client.end();
      await admin((client) => client.unsafe('drop database if exists "finanzen_test_backup_evil" with (force)'));
    }
  });

  describe("compared with a database built from the migrations", () => {
    const EVIL = "finanzen_test_backup_evil";
    const evil = withDatabase(BASE, EVIL);
    const currentKey = () => Buffer.from(env().ENCRYPTION_KEY, "base64");
    let live: { db: Db; client: postgres.Sql };

    /** An archive of a database migrated to `level`, then changed by `plant`; the earlier checks all let it through. */
    async function craftedArchive(plant: string, level = knownMigrations().length) {
      const scratch = await mkdtemp(join(tmpdir(), "saldo-level-"));
      try {
        await admin(async (client) => {
          await client.unsafe(`drop database if exists "${EVIL}" with (force)`);
          await client.unsafe(`create database "${EVIL}"`);
        });
        await migrateTo(evil, level, scratch);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      const client = postgres(evil, { max: 1, onnotice: () => {} });
      try {
        if (plant) await client.unsafe(plant);
        await auditRestored(client);
      } finally {
        await client.end();
      }
      const archive = await createArchiveFile(evil, PASSPHRASE, archiveName(new Date()));
      let list = "";
      const { keys } = await openArchive(
        createReadStream(archive.path),
        { passphrase: PASSPHRASE },
        {
          onDump: async (dump) => {
            list = await dumpContents(dump);
          },
        },
      );
      restorableList(list);
      return { file: archive.path, keys, manifest: archive.manifest };
    }

    async function expectNothingLeft(): Promise<void> {
      expect(await databases(LIVE_NAME)).toEqual([LIVE_NAME]);
      expect(await live.db.select().from(settings).where(eq(settings.key, "only_in_live"))).toHaveLength(1);
      await admin(async (client) => {
        expect(await client`select rolname from pg_roles where rolname like ${`${LIVE_NAME}_restore_%`}`).toEqual([]);
      });
    }

    beforeAll(async () => {
      live = await freshLive();
    });

    afterAll(async () => {
      await live.client.end();
      await admin((client) => client.unsafe(`drop database if exists "${EVIL}" with (force)`));
    });

    it.each([
      {
        name: "a column default calling a function",
        plant: "alter table public.settings alter column ciphertext set default current_setting('is_superuser')",
        object: /^"COLUMN public\.settings\.ciphertext"$/,
      },
      {
        name: "a planted call in an existing default",
        plant: "alter table public.accounts alter column color set default pg_sleep(30)::text || '#1f6f5c'",
        object: /^"COLUMN public\.accounts\.color"$/,
      },
      {
        name: "a check constraint calling a function",
        plant: "alter table public.settings add constraint settings_peek check (current_setting('is_superuser') <> '')",
        object: /^"CONSTRAINT public\.settings\.settings_peek"$/,
      },
      {
        name: "an expression index",
        plant: "create index settings_peek on public.settings (md5(key))",
        object: /^"(RELATION|INDEX) public\.settings_peek"$/,
      },
      {
        name: "an index changed to a partial one",
        plant:
          "drop index public.pending_transactions_account_idx; " +
          "create index pending_transactions_account_idx on public.pending_transactions (account_id) where md5(id::text) <> ''",
        object: /^"INDEX public\.pending_transactions_account_idx"$/,
      },
      {
        name: "a generated column",
        plant: "alter table public.settings add column peek text generated always as (md5(key)) stored",
        object: /^"COLUMN public\.settings\.peek"$/,
      },
      {
        name: "an extra column",
        plant: "alter table public.settings add column extra text",
        object: /^"COLUMN public\.settings\.extra"$/,
      },
      { name: "an extra table", plant: "create table public.notes (id int)", object: /^"(RELATION|COLUMN) public\.notes(\.id)?"$/ },
      {
        name: "a changed type",
        plant: "alter table public.settings alter column ciphertext type varchar(10000)",
        object: /^"COLUMN public\.settings\.ciphertext"$/,
      },
      {
        name: "a missing constraint",
        plant: "alter table public.settings drop constraint settings_pkey",
        object: /^"(RELATION|INDEX|CONSTRAINT) public\.(settings\.)?settings_pkey"$/,
      },
    ])("refuses $name, and leaves the live database alone", async ({ plant, object }) => {
      const crafted = await craftedArchive(plant);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
      try {
        await expect(restoreDatabase({ liveUrl: LIVE, ...crafted, currentKey: currentKey() })).rejects.toMatchObject({
          text: { key: "backup.errors.unsafeDump" },
        });
        const [line] = debug.mock.calls.map((call) => String(call[0]));
        expect(line?.slice(line.indexOf(": ") + 2)).toMatch(object);
      } finally {
        debug.mockRestore();
        await rm(crafted.file, { force: true });
      }
      await expectNothingLeft();
    });

    it("refuses a dump whose own migrations are not the ones the manifest names", async () => {
      // 0006_roles_data changes no schema, so only the migrations table tells the two levels apart.
      const crafted = await craftedArchive("", 7);
      try {
        const applied = crafted.manifest.migrations.applied.slice(0, -1);
        const manifest = { ...crafted.manifest, migrations: { ...crafted.manifest.migrations, applied, count: applied.length } };
        await expect(restoreDatabase({ liveUrl: LIVE, ...crafted, manifest, currentKey: currentKey() })).rejects.toMatchObject({
          text: { key: "backup.errors.unsafeDump", vars: { entry: "TABLE DATA drizzle __drizzle_migrations" } },
        });
      } finally {
        await rm(crafted.file, { force: true });
      }
      await expectNothingLeft();
    });

    it("compares an older archive at its own level, then migrates it", async () => {
      const level = knownMigrations().length - 2;
      const older = await craftedArchive("", level);
      try {
        expect(older.manifest.migrations.count).toBe(level);
        await restoreDatabase({ liveUrl: LIVE, ...older, currentKey: currentKey() });
      } finally {
        await rm(older.file, { force: true });
      }
      const restored = postgres(LIVE, { max: 1, onnotice: () => {} });
      const reference = postgres(BASE, { max: 1, onnotice: () => {} });
      try {
        const applied = await restored<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations order by created_at`;
        expect(applied.map((row) => row.hash)).toEqual(knownMigrations().map((entry) => entry.hash));
        await matchReference(restored, reference);
      } finally {
        await restored.end();
        await reference.end();
      }
      expect(await databases(LIVE_NAME)).toEqual([LIVE_NAME, `${LIVE_NAME}_previous`]);
    });
  });

  describe("over the network, against rclone's own servers on loopback", () => {
    const servers: ReturnType<typeof spawn>[] = [];
    let served: string;

    async function serve(protocol: "webdav" | "sftp"): Promise<number> {
      const port = await freePort();
      const child = spawn("rclone", ["serve", protocol, served, "--addr", `127.0.0.1:${port}`, "--user", "saldo", "--pass", "dav-geheim"], {
        env: { PATH: process.env.PATH ?? "", HOME: served, RCLONE_CONFIG: "", RCLONE_CACHE_DIR: join(served, ".cache") },
        stdio: "ignore",
      });
      servers.push(child);
      for (let i = 0; i < 100; i++) {
        const open = await new Promise<boolean>((resolve) => {
          const socket = createServer().listen(port, "127.0.0.1");
          socket.once("listening", () => socket.close(() => resolve(false)));
          socket.once("error", () => resolve(true));
        });
        if (open) return port;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`rclone serve ${protocol} did not start`);
    }

    beforeAll(async () => {
      served = await mkdtemp(join(tmpdir(), "saldo-served-"));
    });

    afterAll(async () => {
      for (const child of servers) child.kill();
      await rm(served, { recursive: true, force: true });
    });

    it.each(["webdav", "sftp"] as const)("tests, backs up to and lists a %s target", async (protocol) => {
      const port = await serve(protocol);
      const config =
        protocol === "webdav"
          ? { type: "webdav" as const, url: `http://127.0.0.1:${port}`, vendor: "other" as const, username: "saldo", path: "saldo" }
          : { type: "sftp" as const, host: "127.0.0.1", port, username: "saldo", auth: "password" as const, path: "saldo", knownHosts: "" };
      const wrong = await saveTarget(db(), superuser, { name: `${protocol} falsch`, keep: 1, config, secrets: { password: "falsch" } });
      expect(wrong.test.ok).toBe(false);
      await deleteTarget(db(), superuser, { id: wrong.id });
      const saved = await saveTarget(db(), superuser, { name: protocol, keep: 1, config, secrets: { password: "dav-geheim" } });
      expect(saved.test).toMatchObject({ ok: true });
      await expect(testBackupTarget(db(), superuser, { id: saved.id })).resolves.toMatchObject({ ok: true });
      await saveSchedule(db(), superuser, { frequency: "off", time: "03:00", weekday: 1, monthDay: 1, targetIds: [saved.id] });
      for (const now of ["2026-12-01T03:00:00Z", "2026-12-02T03:00:00Z"]) {
        const undo = setBackupDepsForTests({ now: () => new Date(now) });
        await startBackup(db(), superuser);
        await waitIdle();
        undo();
      }
      expect((await readdir(join(served, "saldo"))).filter((name) => name.endsWith(".saldo-backup"))).toEqual([
        "saldo-2026-12-02T03-00-00Z.saldo-backup",
      ]);
      expect(await listTargetArchives(db(), superuser, { targetId: saved.id })).toMatchObject([
        { name: "saldo-2026-12-02T03-00-00Z.saldo-backup" },
      ]);
      expect(existsSync(join(served, "saldo", "saldo-2026-12-02T03-00-00Z.saldo-backup"))).toBe(true);
      await deleteTarget(db(), superuser, { id: saved.id });
    });

    it("reports a failing target in the run, the task and a notification", async () => {
      const unreachable = await saveTarget(db(), superuser, {
        name: "Weg",
        keep: 1,
        config: { type: "webdav", url: `http://127.0.0.1:${await freePort()}`, vendor: "other", username: "", path: "" },
      });
      await saveSchedule(db(), superuser, {
        frequency: "off",
        time: "03:00",
        weekday: 1,
        monthDay: 1,
        targetIds: [localTarget, unreachable.id],
      });
      await startBackup(db(), superuser);
      await waitIdle();
      const [run] = await db().select().from(backupRuns).orderBy(sql`${backupRuns.id} desc`).limit(1);
      expect(run).toMatchObject({ status: "partial" });
      expect(run?.results.map((r) => [r.name, r.ok])).toEqual([
        ["Lokal", true],
        ["Weg", false],
      ]);
      const sent = await db().select().from(notifications).where(eq(notifications.kind, "backup_failed"));
      expect(sent.map((n) => n.userId)).toEqual([superuser.id]);
      await deleteTarget(db(), superuser, { id: unreachable.id });
    });
  });
});
