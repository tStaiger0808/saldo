import { createServerFn } from "@tanstack/react-start";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import { cancelTask, listTasks, taskInput } from "../modules/tasks/index.ts";

export const getTasksFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listTasks(db(), context.user));

export const cancelTaskFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(taskInput)
  .handler(({ data, context }) => cancelTask(db(), context.user, data));
