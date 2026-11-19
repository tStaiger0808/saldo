import { inArray } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { accountGroupMembers, accountGroups, accountShares, user, type Visibility } from "../../db/schema.ts";
import { canManage, canShare, type Owned, type Viewer } from "../access/index.ts";

/** How an account is shared, as far as the viewer may know: recipients only for those who decide about them. */
export type Sharing = {
  visibility: Visibility;
  /** The owner's name when it is someone else. */
  owner: string | null;
  /** People and groups a private account is shared with; null when the viewer does not decide about it. */
  sharedWith: string[] | null;
};

export const nameOf = (u: Pick<typeof user.$inferSelect, "displayUsername" | "username" | "name">) =>
  u.displayUsername ?? u.username ?? u.name;

/** Grouping a household account is the household's business, grouping a private one is sharing it. */
export function canGroup(viewer: Viewer, account: Owned): boolean {
  return account.visibility === "household" ? canManage(viewer, account) : canShare(viewer, account);
}

/** Sharing of the given (visible) accounts as the viewer may see it. */
export async function sharingOf(db: Db, viewer: Viewer, rows: (Owned & { id: number })[]): Promise<Map<number, Sharing>> {
  const result = new Map<number, Sharing>();
  if (rows.length === 0) return result;
  const ids = rows.map((r) => r.id);
  const people = new Map((await db.select().from(user)).map((u) => [u.id, nameOf(u)]));
  const shares = await db.select().from(accountShares).where(inArray(accountShares.accountId, ids));
  const groupNames = new Map((await db.select().from(accountGroups)).map((g) => [g.id, g.name]));
  const memberships = await db.select().from(accountGroupMembers).where(inArray(accountGroupMembers.accountId, ids));
  for (const row of rows) {
    const decides = row.visibility === "private" && canShare(viewer, row);
    const sharedWith = decides
      ? [
          ...shares.filter((s) => s.accountId === row.id).map((s) => people.get(s.userId) ?? ""),
          ...memberships.filter((m) => m.accountId === row.id).map((m) => groupNames.get(m.groupId) ?? ""),
        ]
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
      : null;
    result.set(row.id, {
      visibility: row.visibility,
      owner: row.ownerUserId === viewer.id ? null : (people.get(row.ownerUserId) ?? null),
      sharedWith,
    });
  }
  return result;
}
