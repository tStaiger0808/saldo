import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware, householdAdminMiddleware } from "../middleware.ts";
import { avatarUserInput, removeAvatar } from "../modules/avatars/index.ts";
import {
  createUser,
  createUserInput,
  deleteUser,
  listPeople,
  listUsers,
  passwordSchema,
  resetPassword,
  updateUser,
  updateUserInput,
} from "../modules/users/index.ts";

export const getUsers = createServerFn({ method: "GET" })
  .middleware([householdAdminMiddleware])
  .handler(({ context }) => listUsers(db(), context.user));

export const createUserFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(createUserInput)
  .handler(({ data, context }) => createUser(db(), context.user, data));

export const updateUserFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(updateUserInput)
  .handler(({ data, context }) => updateUser(db(), context.user, data));

export const resetPasswordFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(z.object({ id: z.string(), password: passwordSchema }))
  .handler(({ data, context }) => resetPassword(db(), context.user, data.id, data.password));

export const deleteUserFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) => deleteUser(db(), context.user, data.id));

export const getPeopleFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listPeople(db(), context.user));

export const removeAvatarFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(avatarUserInput)
  .handler(({ data, context }) => removeAvatar(db(), context.user, data));
