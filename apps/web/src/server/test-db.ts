import postgres from "postgres";
import { runMigrations } from "./db/migrate.ts";

// Vitest globalSetup: recreate the test database once and migrate it.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/finanzen_test";
  const admin = postgres(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
  const name = new URL(url).pathname.slice(1);
  if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await client.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await client.end();
  await runMigrations(url);
}
