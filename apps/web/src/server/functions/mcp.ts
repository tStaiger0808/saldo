import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware } from "../middleware.ts";
import { createToken, listTokens, mcpInfo, revokeToken, tokenInput } from "../modules/mcp/index.ts";

export const getMcpInfo = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => mcpInfo());

export const getMcpTokens = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listTokens(db(), context.user));

export const createMcpTokenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(tokenInput)
  .handler(({ data, context }) => createToken(db(), context.user, data));

export const revokeMcpTokenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int() }))
  .handler(({ data, context }) => revokeToken(db(), context.user, data.id));
