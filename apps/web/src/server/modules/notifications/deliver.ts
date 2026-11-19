import { and, eq, lt, not, sql } from "drizzle-orm";
import { t } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE, type Locale } from "../../../i18n/locales.ts";
import type { Db } from "../../db/index.ts";
import { type NotificationKind, notificationDeliveries, notificationPreferences, notifications, settings, user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import type { Viewer } from "../access/index.ts";
import { deps, logFailure } from "./deps.ts";
import { sendNotificationMail } from "./mail.ts";
import { type PushResult, pushToUser } from "./push.ts";

/** Title and body are already in the recipient's language; the list stores them as text. */
export type Outgoing = { kind: NotificationKind | "test"; title: string; body: string; link: string | null };
export type Channels = { push: boolean; email: boolean };
export type ChannelResult = { push: PushResult | null; email: boolean | null };

/** `locale` is the recipient's language; without a choice of their own German, since no browser is known at send time. */
export type Subscriber = { viewer: Viewer; locale: Locale; channels: Channels; threshold: number | null };

/** Users who enabled `kind`; callers narrow them to those who may see what the notification is about. */
export async function subscribers(db: Db, kind: NotificationKind): Promise<Subscriber[]> {
  const rows = await db
    .select({
      id: user.id,
      role: user.role,
      locale: user.locale,
      push: notificationPreferences.push,
      email: notificationPreferences.email,
      threshold: notificationPreferences.threshold,
    })
    .from(notificationPreferences)
    .innerJoin(user, eq(user.id, notificationPreferences.userId))
    .where(and(eq(notificationPreferences.kind, kind), eq(notificationPreferences.enabled, true)));
  return rows.map((r) => {
    const locale = r.locale ?? DEFAULT_LOCALE;
    return { viewer: { id: r.id, role: r.role, locale }, locale, channels: { push: r.push, email: r.email }, threshold: r.threshold };
  });
}

async function senderAddress(db: Db): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "smtp"));
  const from = (row?.value as { fromAddress?: unknown } | null)?.fromAddress;
  return typeof from === "string" ? from : null;
}

/** Push and mail for a notification that is already stored; never throws. */
export async function sendChannels(db: Db, userId: string, locale: Locale, item: Outgoing, channels: Channels): Promise<ChannelResult> {
  const result: ChannelResult = { push: null, email: null };
  try {
    const from = await senderAddress(db);
    if (channels.push) result.push = await pushToUser(db, userId, { title: item.title, body: item.body, link: item.link }, from);
    if (channels.email && from) {
      const [row] = await db.select({ to: user.notifyEmail }).from(user).where(eq(user.id, userId));
      if (row?.to) {
        const link = item.link ? `\n\n${env().APP_URL}${item.link}` : "";
        const subject = t(locale, "notifications.mail.subject", { title: item.title });
        result.email = await sendNotificationMail(db, row.to, subject, `${item.body}${link}`);
      }
    }
  } catch (error) {
    logFailure("Notification channels", error);
  }
  return result;
}

export async function storeNotification(db: Db, userId: string, item: Outgoing): Promise<void> {
  await db
    .insert(notifications)
    .values({ userId, kind: item.kind, title: item.title, body: item.body, link: item.link, createdAt: deps.now() });
}

/**
 * Claims `dedupKey` for the user in the delivery log and, only if it was new, stores the notification and sends it.
 * Returns whether it went out.
 */
export async function deliver(db: Db, subscriber: Subscriber, dedupKey: string, item: Outgoing): Promise<boolean> {
  const userId = subscriber.viewer.id;
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(notificationDeliveries)
      .values({ userId, dedupKey, createdAt: deps.now() })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id });
    if (row) await storeNotification(tx, userId, item);
    return Boolean(row);
  });
  if (claimed) await sendChannels(db, userId, subscriber.locale, item, subscriber.channels);
  return claimed;
}

/** Re-arms a state notification (e.g. low balance) once its condition no longer holds. */
export async function release(db: Db, userId: string, dedupKey: string): Promise<void> {
  await db
    .delete(notificationDeliveries)
    .where(and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.dedupKey, dedupKey)));
}

const DAY_MS = 24 * 3600_000;

/** Old notifications go; delivery records stay longer so a repeated check cannot resend. Low-balance records stay while armed. */
export async function pruneNotifications(db: Db): Promise<void> {
  const now = deps.now().getTime();
  await db.delete(notifications).where(lt(notifications.createdAt, new Date(now - 180 * DAY_MS)));
  await db
    .delete(notificationDeliveries)
    .where(
      and(
        lt(notificationDeliveries.createdAt, new Date(now - 400 * DAY_MS)),
        not(sql`${notificationDeliveries.dedupKey} like 'low_balance:%'`),
      ),
    );
}
