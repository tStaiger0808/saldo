import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mayUseAi, visibleAccountIds } from "../modules/access/index.ts";
import { listAccounts } from "../modules/accounts/index.ts";
import type { Db } from "./index.ts";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
/** The last migration before roles and ownership: the shape the running installations have. */
const OLD_SHAPE = "0004_audit_events";
const BASE = process.env.TEST_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/finanzen_test";
const URL_ = BASE.replace(/\/[^/]+$/, "/finanzen_test_migration");

/** A copy of the migrations folder that ends with the given migration. */
function oldMigrations(last = OLD_SHAPE): string {
  const dir = mkdtempSync(join(tmpdir(), "saldo-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((e) => e.tag === last);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }));
  return dir;
}

describe("migration to roles and ownership", () => {
  let sql: postgres.Sql;
  let db: Db;
  let folder: string;

  beforeAll(async () => {
    const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
    await admin.unsafe("drop database if exists finanzen_test_migration");
    await admin.unsafe("create database finanzen_test_migration");
    await admin.end();
    folder = oldMigrations();
    sql = postgres(URL_, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: folder });

    // The household as it is stored before the change: one member older than the admins, an admin, a second admin.
    await sql`insert into "user" (id, name, email, username, role, created_at) values
      ('u-oldmember', 'Oma', 'oma@x.invalid', 'oma', 'member', '2025-01-01'),
      ('u-admin', 'Admin', 'admin@x.invalid', 'admin', 'admin', '2025-02-01'),
      ('u-admin2', 'Zweit', 'zweit@x.invalid', 'zweit', 'admin', '2025-03-01'),
      ('u-chatter', 'Lena', 'lena@x.invalid', 'lena', 'member', '2025-04-01'),
      ('u-quiet', 'Max', 'max@x.invalid', 'max', 'member', '2025-05-01')`;
    await sql`insert into account_groups (name, position) values ('Familie', 0), ('Kinder', 1)`;
    await sql`insert into bank_connections (name, provider, bank, ciphertext, status) values ('DKB', 'enable_banking', 'dkb', 'x', 'active')`;
    await sql`insert into accounts (name, bank, kind, connection_id, balance_cents) values
      ('Giro', 'dkb', 'checking', 1, 120000), ('Tagesgeld', 'dkb', 'savings', 1, 500000), ('Bargeld', 'bar', 'checking', null, 5000)`;
    await sql`insert into account_group_members (account_id, group_id) values (1, 1), (2, 1), (3, 2)`;
    await sql`insert into user_group_access (user_id, group_id) values ('u-chatter', 1), ('u-quiet', 2)`;
    for (let i = 0; i < 40; i++) {
      await sql`insert into transactions (account_id, external_id, source, booking_date, amount_cents, counterparty)
        values (${(i % 3) + 1}, ${`e-${i}`}, 'eb', '2026-10-01', ${-100 * (i + 1)}, ${`Laden ${i}`})`;
    }
    await sql`insert into ai_usage (user_id, provider_name, kind, model, purpose) values ('u-chatter', 'OpenAI', 'openai', 'm', 'chat')`;
    await sql`insert into audit_events (user_id, username, action, details) values ('u-admin', 'admin', 'users.updated', '{"role":"admin"}')`;

    await runMigrations(URL_);
    db = drizzle(sql, { schema });
  });

  afterAll(async () => {
    await sql.end();
    rmSync(folder, { recursive: true, force: true });
  });

  it("makes admins superusers, keeps members and allows AI to superusers and to those who already used it", async () => {
    const users = await sql<{ id: string; role: string; ai_allowed: boolean }[]>`select id, role, ai_allowed from "user" order by id`;
    expect(users.map((u) => [u.id, u.role, u.ai_allowed])).toEqual([
      ["u-admin", "superuser", true],
      ["u-admin2", "superuser", true],
      ["u-chatter", "member", true],
      ["u-oldmember", "member", false],
      ["u-quiet", "member", false],
    ]);
    expect(await mayUseAi(db, { id: "u-quiet", role: "member" })).toBe(false);
  });

  it("gives every account and connection to the first superuser as household data", async () => {
    const accounts = await sql<{ owner_user_id: string; visibility: string }[]>`select owner_user_id, visibility from accounts`;
    const connections = await sql<{ owner_user_id: string; visibility: string }[]>`select owner_user_id, visibility from bank_connections`;
    for (const row of [...accounts, ...connections]) expect(row).toEqual({ owner_user_id: "u-admin", visibility: "household" });
    const nullable = await sql<{ is_nullable: string }[]>`select is_nullable from information_schema.columns
      where table_name in ('accounts', 'bank_connections') and column_name = 'owner_user_id'`;
    expect(nullable.map((c) => c.is_nullable)).toEqual(["NO", "NO"]);
  });

  it("keeps all data and what everyone sees", async () => {
    const [counts] = await sql<{ txns: number; total: string; groups: number; access: number; members: number; audit: number }[]>`
      select (select count(*)::int from transactions) as txns, (select sum(amount_cents) from transactions) as total,
        (select count(*)::int from account_groups) as groups, (select count(*)::int from user_group_access) as access,
        (select count(*)::int from account_group_members) as members, (select count(*)::int from audit_events) as audit`;
    expect(counts).toEqual({ txns: 40, total: String(-100 * ((40 * 41) / 2)), groups: 2, access: 2, members: 3, audit: 1 });
    expect(await visibleAccountIds(db, { id: "u-admin2", role: "superuser" })).toEqual([1, 2, 3]);
    expect(await visibleAccountIds(db, { id: "u-chatter", role: "member" })).toEqual([1, 2]);
    expect(await visibleAccountIds(db, { id: "u-quiet", role: "member" })).toEqual([3]);
    expect(await visibleAccountIds(db, { id: "u-oldmember", role: "member" })).toEqual([]);
    const seen = await listAccounts(db, { id: "u-chatter", role: "member" });
    expect(seen.map((a) => [a.name, a.sharing.visibility, a.canManage])).toEqual([
      ["Giro", "household", false],
      ["Tagesgeld", "household", false],
    ]);
  });
});

describe("migration to one schedule for all connections", () => {
  const url = BASE.replace(/\/[^/]+$/, "/finanzen_test_migration_schedule");
  let sql: postgres.Sql;
  let folder: string;

  beforeAll(async () => {
    const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
    await admin.unsafe("drop database if exists finanzen_test_migration_schedule");
    await admin.unsafe("create database finanzen_test_migration_schedule");
    await admin.end();
    folder = oldMigrations("0011_depot_holdings");
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: folder });

    // The connections as the running installation has them.
    await sql`insert into "user" (id, name, email, username, role) values ('u-admin', 'Admin', 'admin@x.invalid', 'admin', 'superuser')`;
    await sql`insert into bank_connections (name, provider, bank, ciphertext, status, owner_user_id, schedule_enabled, schedule_times, skip_sync_all) values
      ('DKB', 'enable_banking', 'dkb', 'x', 'active', 'u-admin', true, '["07:00"]', false),
      ('Gemeinschaftskonto', 'enable_banking', 'dkb', 'x', 'active', 'u-admin', true, '["07:00"]', false),
      ('Trade Republic', 'enable_banking', 'trade-republic', 'x', 'active', 'u-admin', true, '["07:00"]', false),
      ('PayPal', 'enable_banking', 'paypal', 'x', 'active', 'u-admin', false, '[]', false),
      ('Bank Norwegian', 'enable_banking', 'bank-norwegian', 'x', 'active', 'u-admin', false, '[]', false),
      ('Trade Republic', 'trade_republic', 'trade_republic', 'x', 'active', 'u-admin', false, '[]', true)`;

    await runMigrations(url);
  });

  afterAll(async () => {
    await sql.end();
    rmSync(folder, { recursive: true, force: true });
  });

  it("switches the one schedule on at the times the connections had and drops the per-connection schedule", async () => {
    const [row] = await sql<{ value: unknown }[]>`select value from settings where key = 'bank_sync_schedule'`;
    expect(row?.value).toEqual({ enabled: true, times: ["07:00"] });
    const columns = await sql<{ column_name: string }[]>`select column_name from information_schema.columns
      where table_name = 'bank_connections' and column_name like 'schedule%'`;
    expect(columns).toEqual([]);
    const connections = await sql<{ name: string; provider: string; skip_sync_all: boolean }[]>`
      select name, provider, skip_sync_all from bank_connections order by id`;
    expect(connections.filter((c) => c.skip_sync_all).map((c) => [c.name, c.provider])).toEqual([["Trade Republic", "trade_republic"]]);
  });
});

describe("migration to cards that follow the dashboard period", () => {
  const url = BASE.replace(/\/[^/]+$/, "/finanzen_test_migration_periods");
  let sql: postgres.Sql;
  let folder: string;

  beforeAll(async () => {
    const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
    await admin.unsafe("drop database if exists finanzen_test_migration_periods");
    await admin.unsafe("create database finanzen_test_migration_periods");
    await admin.end();
    folder = oldMigrations("0014_contracts_and_dashboard_period");
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: folder });

    await sql`insert into "user" (id, name, email, username, role) values ('u-admin', 'Admin', 'admin@x.invalid', 'admin', 'superuser')`;
    const cards = [
      { id: "a", type: "summary", title: "Diesen Monat", width: "full", options: { period: "this_month" } },
      { id: "b", type: "monthly_trend", title: "Verlauf", width: "full", options: { period: "last_12_months" } },
      { id: "c", type: "category_breakdown", title: "Kategorien", width: "half", options: { kind: "expense" } },
      { id: "d", type: "top_counterparties", title: "Empfänger", width: "half", options: { limit: 8 } },
      { id: "e", type: "recent_transactions", title: "Neu", width: "half", options: { limit: 8 } },
      { id: "f", type: "period_comparison", title: "Vergleich", width: "half", options: { period: "last_year", limit: 6 } },
    ];
    await sql`insert into dashboards (owner_id, name, cards) values ('u-admin', 'Alle Konten', ${JSON.stringify(cards)}::jsonb), ('u-admin', 'Leer', '[]')`;

    await runMigrations(url);
  });

  afterAll(async () => {
    await sql.end();
    rmSync(folder, { recursive: true, force: true });
  });

  it("lets cards of this month follow the dashboard and keeps every other period, in order", async () => {
    const rows = await sql<{ name: string; period: string; cards: { id: string; options: Record<string, unknown> }[] }[]>`
      select name, period, cards from dashboards order by id`;
    expect(rows.map((r) => [r.name, r.period])).toEqual([
      ["Alle Konten", "this_month"],
      ["Leer", "this_month"],
    ]);
    expect(rows[0]?.cards.map((c) => [c.id, c.options])).toEqual([
      ["a", { period: "dashboard" }],
      ["b", { period: "last_12_months" }],
      ["c", { kind: "expense", period: "dashboard" }],
      ["d", { limit: 8, period: "last_3_months" }],
      ["e", { limit: 8 }],
      ["f", { period: "last_year", limit: 6 }],
    ]);
    expect(rows[1]?.cards).toEqual([]);
  });
});
