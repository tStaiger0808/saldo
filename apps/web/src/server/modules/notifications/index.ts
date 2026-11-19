/**
 * Notifications: per-user event preferences and contact address, the in-app list, and delivery by Web Push and
 * mail. Events are evaluated in events.ts after syncs and by the scheduler's daily run.
 */
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { msg, t, translate } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/locales.ts";
import type { Db } from "../../db/index.ts";
import { NOTIFICATION_KINDS, type NotificationKind, notificationPreferences, notifications, user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { isSuperuser, type Viewer } from "../access/index.ts";
import { sendChannels, storeNotification } from "./deliver.ts";
import { deps } from "./deps.ts";
import { DEFAULT_PREFERENCES, DEFAULT_THRESHOLDS, SUPERUSER_KINDS, THRESHOLD_RANGES } from "./kinds.ts";
import { mailConfigured } from "./mail.ts";
import { pushDeviceCount, vapidPublicKey } from "./push.ts";

export { pruneNotifications } from "./deliver.ts";
export { setNotificationDepsForTests } from "./deps.ts";
export {
  checkBalances,
  checkContracts,
  checkUpcomingContracts,
  localDay,
  notifyAfterSync,
  notifyBankProblem,
  notifySuperusers,
  runDailyChecks,
} from "./events.ts";
export {
  getMailSettings,
  type MailSettings,
  mailSettingsInput,
  mailTimeouts,
  saveMailSettings,
  sendTestMail,
  type TestMailResult,
  testMailInput,
} from "./mail.ts";
export {
  deletePushSubscription,
  ensureVapidKeys,
  pushEndpointInput,
  pushSubscriptionInput,
  savePushSubscription,
} from "./push.ts";

const kindsFor = (viewer: Viewer) => NOTIFICATION_KINDS.filter((kind) => isSuperuser(viewer) || !SUPERUSER_KINDS.includes(kind));

export type PreferenceView = { kind: NotificationKind; enabled: boolean; push: boolean; email: boolean; threshold: number | null };

export type NotificationSettings = {
  notifyEmail: string | null;
  mailReady: boolean;
  pushPublicKey: string | null;
  pushDevices: number;
  preferences: PreferenceView[];
};

export async function getNotificationSettings(db: Db, viewer: Viewer): Promise<NotificationSettings> {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, viewer.id));
  const [me] = await db.select({ notifyEmail: user.notifyEmail }).from(user).where(eq(user.id, viewer.id));
  return {
    notifyEmail: me?.notifyEmail ?? null,
    mailReady: await mailConfigured(db),
    pushPublicKey: await vapidPublicKey(db),
    pushDevices: await pushDeviceCount(db, viewer),
    preferences: kindsFor(viewer).map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      const fallback = DEFAULT_PREFERENCES[kind];
      return {
        kind,
        enabled: row?.enabled ?? fallback?.enabled ?? false,
        push: row?.push ?? fallback?.push ?? false,
        email: row?.email ?? fallback?.email ?? false,
        threshold: row?.threshold ?? DEFAULT_THRESHOLDS[kind] ?? null,
      };
    }),
  };
}

export const preferencesInput = z.object({
  preferences: z
    .array(
      z.object({
        kind: z.enum(NOTIFICATION_KINDS),
        enabled: z.boolean(),
        push: z.boolean(),
        email: z.boolean(),
        threshold: z.number().int("notifications.errors.wholeNumber").nullable(),
      }),
    )
    .max(NOTIFICATION_KINDS.length),
});

export async function savePreferences(db: Db, viewer: Viewer, input: z.input<typeof preferencesInput>): Promise<void> {
  const { preferences } = preferencesInput.parse(input);
  if (new Set(preferences.map((p) => p.kind)).size !== preferences.length) throw new UserError(msg("notifications.errors.eachEventOnce"));
  const allowed = new Set(kindsFor(viewer));
  const values = preferences
    .filter((p) => allowed.has(p.kind))
    .map((p) => {
      const range = THRESHOLD_RANGES[p.kind];
      let threshold: number | null = null;
      if (range) {
        threshold = p.threshold ?? DEFAULT_THRESHOLDS[p.kind] ?? null;
        if (threshold === null || threshold < range[0] || threshold > range[1]) throw new UserError({ key: range[2] });
      }
      return { userId: viewer.id, kind: p.kind, enabled: p.enabled, push: p.push, email: p.email, threshold };
    });
  if (values.length === 0) return;
  await db.transaction(async (tx) => {
    for (const v of values) {
      await tx
        .insert(notificationPreferences)
        .values(v)
        .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.kind], set: v });
    }
  });
}

export const contactEmailInput = z.object({
  notifyEmail: z.union([z.literal(""), z.email("notifications.errors.validEmail").max(255)]),
});

export async function saveContactEmail(db: Db, viewer: Viewer, input: z.input<typeof contactEmailInput>): Promise<void> {
  const { notifyEmail } = contactEmailInput.parse(input);
  await db
    .update(user)
    .set({ notifyEmail: notifyEmail || null })
    .where(eq(user.id, viewer.id));
}

// ---- in-app list

export type NotificationView = {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  read: boolean;
};

export const listNotificationsInput = z.object({ limit: z.number().int().min(1).max(100).default(30) });

export async function unreadNotificationCount(db: Db, viewer: Viewer): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

export async function listNotifications(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof listNotificationsInput> = {},
): Promise<{ items: NotificationView[]; unread: number }> {
  const { limit } = listNotificationsInput.parse(input);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, viewer.id))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
    })),
    unread: await unreadNotificationCount(db, viewer),
  };
}

export const notificationIdInput = z.object({ id: z.number().int() });

export async function markNotificationRead(db: Db, viewer: Viewer, input: z.input<typeof notificationIdInput>): Promise<void> {
  const { id } = notificationIdInput.parse(input);
  const updated = await db
    .update(notifications)
    .set({ readAt: deps.now() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, viewer.id)))
    .returning({ id: notifications.id });
  if (updated.length === 0) throw new NotFound(msg("notifications.errors.notFound"));
}

export async function markAllNotificationsRead(db: Db, viewer: Viewer): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: deps.now() })
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
}

export type TestNotificationResult = { push: string; email: string };

/**
 * Puts a test notification into the list and sends it on every channel the user has, with a result per channel.
 * The user is reading along, so everything is in the language of the current request.
 */
export async function sendTestNotification(db: Db, viewer: Viewer): Promise<TestNotificationResult> {
  const locale = viewer.locale ?? DEFAULT_LOCALE;
  const item = {
    kind: "test" as const,
    title: t(locale, "notifications.test.title"),
    body: t(locale, "notifications.test.body"),
    link: "/persoenlich/benachrichtigungen",
  };
  await storeNotification(db, viewer.id, item);
  const [me] = await db.select({ notifyEmail: user.notifyEmail }).from(user).where(eq(user.id, viewer.id));
  const ready = await mailConfigured(db);
  const result = await sendChannels(db, viewer.id, locale, item, { push: true, email: ready && Boolean(me?.notifyEmail) });
  const push = result.push;
  const total = push ? push.sent + push.failed + push.removed : 0;
  return {
    push:
      !push || total === 0
        ? t(locale, "notifications.test.noDevice")
        : t(locale, "notifications.test.pushSent", {
            sent: push.sent,
            count: total,
            removed: push.removed ? translate(locale, "notifications.test.removed", { count: push.removed }) : "",
          }),
    email: !ready
      ? t(locale, "notifications.test.emailNotSetUp")
      : !me?.notifyEmail
        ? t(locale, "notifications.test.noEmail")
        : result.email
          ? t(locale, "notifications.test.emailSent", { to: me.notifyEmail })
          : t(locale, "notifications.test.emailFailed"),
  };
}
