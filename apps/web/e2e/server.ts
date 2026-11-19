/** Fresh database with demo data, then the production build on port 3100 (started by playwright.config.ts). */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import postgres from "postgres";
import { startFakeEnableBanking } from "./fake-enable-banking.ts";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("e2e")) throw new Error("DATABASE_URL must point at an e2e database, it is wiped");

const backupDir = process.env.BACKUP_DIR ?? "";
if (!backupDir.includes("saldo-e2e-backups")) throw new Error("BACKUP_DIR must point at an e2e folder, it is wiped");
rmSync(backupDir, { recursive: true, force: true });
mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const admin = postgres(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
const name = new URL(url).pathname.slice(1);
if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) await admin.unsafe(`create database "${name}"`);
await admin.end();

const client = postgres(url, { max: 1, onnotice: () => {} });
await client.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
await client.end();

const { runMigrations } = await import("../src/server/db/migrate.ts");
await runMigrations(url);
const { db, closeDatabase } = await import("../src/server/db/index.ts");
const { seedDefaults } = await import("../src/server/modules/seed/index.ts");
const { createDemoData } = await import("../src/server/modules/seed/demo.ts");
const { bootstrapAdmin } = await import("../src/server/modules/users/index.ts");
await seedDefaults(db());
// The demo accounts belong to the first superuser, so it exists before them.
await bootstrapAdmin(db(), process.env.ADMIN_USERNAME ?? "admin", process.env.ADMIN_PASSWORD);
await createDemoData(db());
await closeDatabase();

await startFakeEnableBanking(Number(new URL(process.env.ENABLE_BANKING_API_URL ?? "").port), process.env.APP_URL ?? "");

const server = spawn("bun", [".output/server/index.mjs"], { stdio: "inherit", env: process.env });
process.on("SIGTERM", () => server.kill("SIGTERM"));
process.on("SIGINT", () => server.kill("SIGINT"));
server.on("exit", (code) => process.exit(code ?? 0));
