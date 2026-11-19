import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { db } from "../db/index.ts";
import { authMiddleware, superuserMiddleware } from "../middleware.ts";
import {
  contactEmailInput,
  deletePushSubscription,
  getMailSettings,
  getNotificationSettings,
  listNotifications,
  listNotificationsInput,
  mailSettingsInput,
  markAllNotificationsRead,
  markNotificationRead,
  notificationIdInput,
  preferencesInput,
  pushEndpointInput,
  pushSubscriptionInput,
  saveContactEmail,
  saveMailSettings,
  savePreferences,
  savePushSubscription,
  sendTestMail,
  sendTestNotification,
  testMailInput,
  unreadNotificationCount,
} from "../modules/notifications/index.ts";

export const getNotificationSettingsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => getNotificationSettings(db(), context.user));

export const saveNotificationPreferencesFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(preferencesInput)
  .handler(({ data, context }) => savePreferences(db(), context.user, data));

export const saveContactEmailFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(contactEmailInput)
  .handler(({ data, context }) => saveContactEmail(db(), context.user, data));

export const savePushSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(pushSubscriptionInput)
  .handler(({ data, context }) => savePushSubscription(db(), context.user, data, getRequest().headers.get("user-agent") ?? ""));

export const deletePushSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(pushEndpointInput)
  .handler(({ data, context }) => deletePushSubscription(db(), context.user, data));

export const sendTestNotificationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => sendTestNotification(db(), context.user));

export const getNotificationsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(listNotificationsInput)
  .handler(({ data, context }) => listNotifications(db(), context.user, data));

export const getUnreadNotificationCountFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => unreadNotificationCount(db(), context.user));

export const markNotificationReadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(notificationIdInput)
  .handler(({ data, context }) => markNotificationRead(db(), context.user, data));

export const markAllNotificationsReadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => markAllNotificationsRead(db(), context.user));

export const getMailSettingsFn = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => getMailSettings(db(), context.user));

export const saveMailSettingsFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(mailSettingsInput)
  .handler(({ data, context }) => saveMailSettings(db(), context.user, data));

export const sendTestMailFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(testMailInput)
  .handler(({ data, context }) => sendTestMail(db(), context.user, data));
