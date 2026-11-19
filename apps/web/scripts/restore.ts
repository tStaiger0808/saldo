/**
 * Emergency restore of a .saldo-backup file from inside the app container, without the web interface:
 *
 *   docker compose exec -w /app/apps/web app bun scripts/restore.ts /backups/saldo-….saldo-backup
 *   docker compose exec -w /app/apps/web app bun scripts/restore.ts --check <file>
 *   docker compose exec -w /app/apps/web app bun scripts/restore.ts --extract <file> <empty folder>
 *
 * The passphrase is asked for (hidden) or read from SALDO_BACKUP_PASSPHRASE. A restore runs exactly as in the browser:
 * full check, safety copy into BACKUP_DIR, restore into a fresh database, migrations, re-keying, swap.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { render } from "../src/i18n/index.ts";
import { closeDatabase, db } from "../src/server/db/index.ts";
import { UserError } from "../src/server/errors.ts";
import { checkArchiveFile, claimBusy, openArchive, runRestore, storedPassphrase } from "../src/server/modules/backup/index.ts";

const CONFIRM_WORD = "RESTORE";

function ask(question: string, hidden: boolean): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const raw = hidden && stdin.isTTY;
  if (raw) stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let answer = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(answer);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") answer = answer.slice(0, -1);
        else answer += char;
      }
    };
    stdin.on("data", onData);
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const mode = args[0] === "--check" || args[0] === "--extract" ? args.shift() : "--restore";
const file = args[0];
if (!file || (mode === "--extract" && !args[1])) {
  fail("Usage: bun scripts/restore.ts [--check | --extract <folder>] <file.saldo-backup>");
}
if (!existsSync(file)) fail(`File not found: ${file}`);

const passphrase = process.env.SALDO_BACKUP_PASSPHRASE || (await ask("Passphrase of the archive: ", true));

try {
  if (mode === "--extract") {
    const folder = args[1] as string;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if ((await readdir(folder)).length > 0) fail(`Folder is not empty: ${folder}`);
    const { manifest } = await openArchive(
      createReadStream(file),
      { passphrase },
      {
        onDump: (dump) => pipeline(Readable.from(dump), createWriteStream(join(folder, "database.dump"), { mode: 0o600 })),
      },
    );
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(`Wrote ${join(folder, "database.dump")} (pg_restore custom format) and manifest.json.`);
    console.log("The archive's ENCRYPTION_KEY is in manifest.json: keep that folder as secret as the archive.");
    process.exit(0);
  }

  const prepared = await checkArchiveFile(file, passphrase);
  const { manifest } = prepared;
  console.log(
    `Archive is intact. Created ${manifest.createdAt} by Saldo ${manifest.app.version ?? "?"} on PostgreSQL ${manifest.postgres.server}.`,
  );
  console.log(
    `Contains ${manifest.counts.user ?? 0} people, ${manifest.counts.accounts ?? 0} accounts, ${manifest.counts.transactions ?? 0} bookings, ${manifest.counts.contracts ?? 0} contracts.`,
  );
  if (mode === "--check") process.exit(0);

  console.log("This replaces ALL data of this Saldo instance. A safety copy of the current state goes to BACKUP_DIR first.");
  const typed = (await ask(`Type ${CONFIRM_WORD} to continue: `, false)).trim();
  if (typed.toUpperCase() !== CONFIRM_WORD) fail("Not confirmed; nothing was changed.");

  const release = claimBusy("restore");
  try {
    const result = await runRestore(
      db(),
      { commandLine: true },
      prepared,
      (await storedPassphrase(db()))?.passphrase ?? null,
      (done, total) => console.log(`Step ${done} of ${total}`),
    );
    console.log(`Restored. Safety copy of the previous state: ${result.safetyFile}`);
    if (result.migrated > 0) console.log(`Applied ${result.migrated} database updates.`);
    if (result.rekeyed) console.log("Secrets were re-encrypted with this server's ENCRYPTION_KEY.");
    console.log("Everyone signs in again.");
  } finally {
    release();
  }
} catch (error) {
  fail(
    error instanceof UserError
      ? `Failed: ${render("en", error.text)}`
      : `Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await closeDatabase();
}
