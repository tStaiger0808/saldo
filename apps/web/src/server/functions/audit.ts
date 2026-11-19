import { createServerFn } from "@tanstack/react-start";
import { db } from "../db/index.ts";
import { superuserMiddleware } from "../middleware.ts";
import { auditListInput, listAuditEvents } from "../modules/audit/index.ts";

export const getAuditEventsFn = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .validator(auditListInput)
  .handler(({ data, context }) => listAuditEvents(db(), context.user, data));
