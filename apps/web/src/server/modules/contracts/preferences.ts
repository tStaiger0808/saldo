/**
 * A person's own choices on the contracts page: list layout, sorting, how far ahead a due date counts as soon and their
 * name for the "all" tab.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  CONTRACT_LIST_MODES,
  CONTRACT_SORTS,
  type ContractPreferences,
  DEFAULT_CONTRACT_PREFERENCES,
  DUE_SOON_WINDOWS,
  type DueSoonWindow,
} from "../../../lib/contract-preferences.ts";
import type { Db } from "../../db/index.ts";
import { contractPreferences } from "../../db/schema.ts";
import type { Viewer } from "../access/index.ts";

/** Only the given choices change; the others keep their stored value. */
export const contractPreferencesInput = z.object({
  listMode: z.enum(CONTRACT_LIST_MODES).optional(),
  sort: z.enum(CONTRACT_SORTS).optional(),
  dueSoonDays: z.literal(DUE_SOON_WINDOWS).optional(),
  /** Empty brings back the default label. */
  allViewName: z
    .string()
    .trim()
    .max(64)
    .transform((name) => name || null)
    .nullish(),
});

const isWindow = (days: number): days is DueSoonWindow => (DUE_SOON_WINDOWS as readonly number[]).includes(days);

export async function getContractPreferences(db: Db, viewer: Viewer): Promise<ContractPreferences> {
  const [row] = await db.select().from(contractPreferences).where(eq(contractPreferences.userId, viewer.id));
  if (!row) return DEFAULT_CONTRACT_PREFERENCES;
  return {
    listMode: row.listMode,
    sort: row.sort,
    dueSoonDays: isWindow(row.dueSoonDays) ? row.dueSoonDays : DEFAULT_CONTRACT_PREFERENCES.dueSoonDays,
    allViewName: row.allViewName,
  };
}

export async function saveContractPreferences(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof contractPreferencesInput>,
): Promise<ContractPreferences> {
  const changes = contractPreferencesInput.parse(input);
  const next = { ...(await getContractPreferences(db, viewer)), ...changes };
  await db
    .insert(contractPreferences)
    .values({ userId: viewer.id, ...next })
    .onConflictDoUpdate({ target: contractPreferences.userId, set: { ...changes, updatedAt: new Date() } });
  return next;
}
