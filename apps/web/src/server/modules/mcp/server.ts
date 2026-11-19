import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Db } from "../../db/index.ts";
import { env } from "../../env.ts";
import { UserError } from "../../errors.ts";
import type { Viewer } from "../access/index.ts";
import { record, requestMeta } from "../audit/index.ts";
import { INSTRUCTIONS, toolsFor } from "../tools/index.ts";
import { tokenOwner } from "./tokens.ts";

const MCP_TOOLS = toolsFor("mcp");
// Tool texts are English for every user: MCP clients and their models work best with one language.
export const TOOLS: Record<string, string> = Object.fromEntries(MCP_TOOLS.map((tool) => [tool.name, tool.description]));

const groupId = z.number().int().optional().describe("Group ID from list_groups; without it all visible accounts");

async function result(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run()) }] };
  } catch (error) {
    if (error instanceof UserError) return { isError: true, content: [{ type: "text", text: error.localized("en") }] };
    console.error("MCP tool failed", error);
    return { isError: true, content: [{ type: "text", text: "Internal error" }] };
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function buildServer(db: Db, viewer: Viewer): McpServer {
  const server = new McpServer({ name: "saldo", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const tool of MCP_TOOLS) {
    const scoped = tool.name !== "list_groups";
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        annotations: readOnly,
        inputSchema: scoped ? { groupId, ...tool.input } : tool.input,
      },
      (args: Record<string, unknown>) =>
        result(async () => {
          const chosen = typeof args.groupId === "number" ? args.groupId : undefined;
          return (await tool.run({ db, viewer, audience: "mcp", groupId: chosen }, args)).data;
        }),
    );
  }
  return server;
}

export function mcpInfo(): { url: string; tools: { name: string; description: string }[] } {
  return { url: `${env().APP_URL}/api/mcp`, tools: Object.entries(TOOLS).map(([name, description]) => ({ name, description })) };
}

// ---- HTTP endpoint

const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const MAX_TRACKED_ADDRESSES = 10_000;
const MAX_BATCH = 20;
// Keyed on the trusted client address; insertion order is the age, so the oldest entry goes first when full.
const failures = new Map<string, { count: number; resetAt: number }>();

function throttled(ip: string, now: number): number | null {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) return null;
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : null;
}

function recordFailure(ip: string, now: number): void {
  const entry = failures.get(ip);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
    return;
  }
  failures.delete(ip);
  while (failures.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
  failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
}

export const trackedFailureAddressesForTests = (): number => failures.size;

const jsonError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status, headers });

/** The JSON-RPC messages of a request; null when the body is no JSON (the SDK then answers with its own error). */
async function readMessages(request: Request): Promise<unknown[] | null> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  if (body === undefined) return null;
  return Array.isArray(body) ? body : [body];
}

/** One audit event per request naming the tools called; arguments can carry search texts and stay out. */
async function recordToolCalls(db: Db, viewer: Viewer, request: Request, ip: string | null, messages: unknown[]): Promise<void> {
  const tools = messages.flatMap((message) => {
    const { method, params } = (message ?? {}) as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call") return [];
    return [typeof params?.name === "string" ? params.name.slice(0, 64) : "?"];
  });
  if (tools.length === 0) return;
  await record(db, {
    action: "export.mcpTool",
    actor: viewer,
    outcome: tools.every((tool) => tool in TOOLS) ? "ok" : "failed",
    details: tools.length === 1 ? { tool: tools[0] } : { tools },
    request: { ip, userAgent: requestMeta(request).userAgent },
  });
}

/** Stateless MCP endpoint: bearer token only (cookies are ignored), POST only, a fresh server per request. */
export async function handleMcpRequest(db: Db, request: Request, ip: string | null): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "POST only", { Allow: "POST" });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(env().APP_URL).origin) return jsonError(403, "Origin not allowed");
  const now = Date.now();
  const key = ip ?? "unknown";
  const retryAfter = throttled(key, now);
  if (retryAfter !== null) return jsonError(429, "Too many failed sign-ins", { "Retry-After": String(retryAfter) });
  const viewer = await tokenOwner(db, request.headers.get("authorization"));
  if (!viewer) {
    recordFailure(key, now);
    return jsonError(401, "Valid bearer token required", { "WWW-Authenticate": 'Bearer realm="saldo"' });
  }
  const messages = await readMessages(request);
  if (messages && messages.length > MAX_BATCH) return jsonError(400, `At most ${MAX_BATCH} messages per request`);
  await recordToolCalls(db, viewer, request, ip, messages ?? []);
  const server = buildServer(db, viewer);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
