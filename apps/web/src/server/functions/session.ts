import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { LOCALES } from "../../i18n/locales.ts";
import { sessionUser } from "../auth.ts";
import { db } from "../db/index.ts";
import { browserLocale } from "../locale.ts";
import { authMiddleware } from "../middleware.ts";
import { listGroups } from "../modules/accounts/index.ts";
import { avatarUrlOf } from "../modules/avatars/index.ts";
import { ownNameInput, setOwnLocale, setOwnName } from "../modules/users/index.ts";

/**
 * Loaded by the root route on every navigation: the language to render in, what "automatic" resolves to in this
 * browser, and the signed-in user with their picture and groups (`auth` is null when nobody is signed in).
 */
export const getSessionState = createServerFn({ method: "GET" }).handler(async () => {
  const headers = getRequest().headers;
  const user = await sessionUser(headers);
  const automaticLocale = browserLocale(headers);
  if (!user) return { locale: automaticLocale, automaticLocale, auth: null };
  const [groups, avatar] = await Promise.all([listGroups(db(), user), avatarUrlOf(db(), user.id)]);
  return {
    locale: user.locale,
    automaticLocale,
    auth: { user: { ...user, avatar }, groups: groups.map((g) => ({ id: g.id, name: g.name })) },
  };
});

export const setOwnLocaleFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ locale: z.enum(LOCALES).nullable() }))
  .handler(({ data, context }) => setOwnLocale(db(), context.user, data.locale));

export const setOwnNameFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(ownNameInput)
  .handler(({ data, context }) => setOwnName(db(), context.user, data));
