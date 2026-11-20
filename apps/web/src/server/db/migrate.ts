import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * The migrations folder next to this file; inside the server bundle that relative path no longer holds, so the app
 * folder (the working directory of the container and of `bun run`) and the repository root are tried as well.
 */
export function migrationsFolder(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "drizzle"),
    join(process.cwd(), "drizzle"),
    join(process.cwd(), "apps", "web", "drizzle"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "meta", "_journal.json")));
  if (!found) throw new Error("Migrations folder not found");
  return found;
}

// Any fixed number; keeps two starting containers from migrating at the same time.
const LOCK_ID = 727_001;

export async function runMigrations(url: string, folder: string = migrationsFolder()): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(${LOCK_ID})`;
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL fehlt");
  await runMigrations(url);
  console.log("Migrations applied");
}
