import { eq } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { settings } from "../../db/schema.ts";

export async function readSetting(db: Db, key: string): Promise<{ value: unknown; ciphertext: string | null } | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row;
}

export async function writeSetting(db: Db, key: string, value: unknown, ciphertext: string | null = null): Promise<void> {
  await db.insert(settings).values({ key, value, ciphertext }).onConflictDoUpdate({ target: settings.key, set: { value, ciphertext } });
}
