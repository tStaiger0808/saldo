import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };

// Nitro plugins and the SSR bundle load separate module copies; one process-wide client avoids two pools.
const KEY = Symbol.for("saldo.db");
type Holder = { client: postgres.Sql; db: Db };
const store = globalThis as unknown as Record<symbol, Holder | undefined>;

export function db(): Db {
  let holder = store[KEY];
  if (!holder) {
    const client = postgres(env().DATABASE_URL, { max: 10, onnotice: () => {} });
    holder = { client, db: drizzle(client, { schema }) };
    store[KEY] = holder;
  }
  return holder.db;
}

export async function closeDatabase(): Promise<void> {
  const holder = store[KEY];
  store[KEY] = undefined;
  await holder?.client.end({ timeout: 5 });
}
