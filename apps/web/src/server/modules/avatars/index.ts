/**
 * Profile pictures. Everyone signed in sees everyone's names (users.listPeople), so they may see the pictures, too.
 * Only the person changes their own; a superuser may remove anyone's. The type comes from the first bytes, and the URL
 * carries the time of the last change, so browsers may keep a picture for good.
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { userAvatars } from "../../db/schema.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import { sniffFileType } from "../../file-types.ts";
import { isSuperuser, type Viewer } from "../access/index.ts";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const avatarUserInput = z.object({ userId: z.string().min(1).max(100) });

export const avatarUrl = (userId: string, updatedAt: Date) => `/api/avatars/${encodeURIComponent(userId)}?v=${updatedAt.getTime()}`;

/** The picture URLs of the given users; those without a picture are missing from the map. */
export async function avatarUrls(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userAvatars.userId, updatedAt: userAvatars.updatedAt })
    .from(userAvatars)
    .where(inArray(userAvatars.userId, [...new Set(userIds)]));
  return new Map(rows.map((r) => [r.userId, avatarUrl(r.userId, r.updatedAt)]));
}

export async function avatarUrlOf(db: Db, userId: string): Promise<string | null> {
  return (await avatarUrls(db, [userId])).get(userId) ?? null;
}

/** Stores or replaces the viewer's own picture: PNG, JPEG or WebP up to 2 MB. Returns its new URL. */
export async function setAvatar(db: Db, viewer: Viewer, userId: string, bytes: Uint8Array): Promise<string> {
  if (userId !== viewer.id) throw new Forbidden(msg("personal.avatar.errors.ownOnly"));
  if (bytes.byteLength === 0) throw new UserError(msg("personal.avatar.errors.empty"));
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new UserError(msg("personal.avatar.errors.tooLarge"), 413);
  const type = sniffFileType(bytes);
  if (!type || !AVATAR_TYPES.has(type.contentType)) throw new UserError(msg("personal.avatar.errors.type"), 415);
  const values = {
    contentType: type.contentType,
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(userAvatars)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userAvatars.userId, set: values })
    .returning({ updatedAt: userAvatars.updatedAt });
  if (!row) throw new UserError(msg("personal.avatar.errors.saveFailed"));
  return avatarUrl(userId, row.updatedAt);
}

/** Removes a picture: one's own, or anyone's for a superuser. Removing a missing picture is fine. */
export async function removeAvatar(db: Db, viewer: Viewer, input: z.input<typeof avatarUserInput>): Promise<void> {
  const { userId } = avatarUserInput.parse(input);
  if (userId !== viewer.id && !isSuperuser(viewer)) throw new Forbidden(msg("personal.avatar.errors.ownOnly"));
  await db.delete(userAvatars).where(eq(userAvatars.userId, userId));
}

/** Anyone's picture for anyone signed in; a missing picture is a 404. */
export async function readAvatar(db: Db, _viewer: Viewer, userId: string): Promise<{ contentType: string; data: Buffer }> {
  const [row] = await db
    .select({ contentType: userAvatars.contentType, data: userAvatars.data })
    .from(userAvatars)
    .where(eq(userAvatars.userId, userId));
  if (!row) throw new NotFound(msg("personal.avatar.errors.notFound"));
  return row;
}
