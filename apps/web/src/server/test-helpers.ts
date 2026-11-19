import { sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import type { Role } from "./db/schema.ts";
import type { Viewer } from "./modules/access/index.ts";
import { seedDefaults } from "./modules/seed/index.ts";
import { insertUser } from "./modules/users/index.ts";

/** Empties every application table and seeds the default categories and rules. */
export async function resetDb(): Promise<void> {
  const rows = await db().execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db().execute(sql.raw(`truncate ${names} restart identity cascade`));
  await seedDefaults(db());
}

export async function makeUser(
  username: string,
  role: Role,
  groupIds: number[] = [],
  options: { aiAllowed?: boolean } = {},
): Promise<Viewer> {
  const id = await insertUser(db(), { username, password: "test-password-123", role, groupIds, aiAllowed: options.aiAllowed });
  return { id, role };
}
