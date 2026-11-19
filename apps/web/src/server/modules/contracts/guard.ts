import { asc, eq, type SQL } from "drizzle-orm";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { accounts, contracts, type Visibility } from "../../db/schema.ts";
import { Forbidden, NotFound } from "../../errors.ts";
import { canManage, isSuperuser, type Viewer, visibleAccountIds } from "../access/index.ts";

export type Row = typeof contracts.$inferSelect;
export type AccountInfo = { name: string; visibility: Visibility } | null;

export const effectiveVisibility = (c: Pick<Row, "visibility">, account: AccountInfo): Visibility => account?.visibility ?? c.visibility;

export function sees(viewer: Viewer, c: Row, visible: ReadonlySet<number>): boolean {
  if (isSuperuser(viewer) || c.ownerUserId === viewer.id) return true;
  return c.accountId !== null ? visible.has(c.accountId) : c.visibility === "household";
}

export async function rowsWithAccounts(db: Db, where?: SQL) {
  return db
    .select({ contract: contracts, account: { name: accounts.name, visibility: accounts.visibility } })
    .from(contracts)
    .leftJoin(accounts, eq(accounts.id, contracts.accountId))
    .where(where)
    .orderBy(asc(contracts.name), asc(contracts.id));
}

/** A hidden contract is a 404. */
export async function requireVisibleContract(db: Db, viewer: Viewer, id: number): Promise<{ contract: Row; account: AccountInfo }> {
  const [row] = await rowsWithAccounts(db, eq(contracts.id, id));
  if (!row || !sees(viewer, row.contract, new Set(await visibleAccountIds(db, viewer))))
    throw new NotFound(msg("contracts.errors.notFound"));
  return row;
}

/** A hidden contract is a 404, a visible one the viewer may not change a 403. */
export async function requireManageableContract(db: Db, viewer: Viewer, id: number): Promise<Row> {
  const { contract, account } = await requireVisibleContract(db, viewer, id);
  if (!canManage(viewer, { ownerUserId: contract.ownerUserId, visibility: effectiveVisibility(contract, account) }))
    throw new Forbidden(msg("contracts.errors.notYours"));
  return contract;
}
