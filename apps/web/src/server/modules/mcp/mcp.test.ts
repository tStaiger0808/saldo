import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAuthRequest } from "../../auth.ts";
import { db } from "../../db/index.ts";
import { accountGroups, accounts, auditEvents, mcpTokens } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createDemoData } from "../seed/demo.ts";
import { resetPassword } from "../users/index.ts";
import { createToken, handleMcpRequest, listTokens, mcpInfo, revokeToken, trackedFailureAddressesForTests } from "./index.ts";

let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter}`;

function rpc(body: object, headers: Record<string, string> = {}, method = "POST") {
  return new Request("https://saldo.test/api/mcp", {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function authPost(path: string, body: object, cookie?: string) {
  const request = new Request(`https://saldo.test/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://saldo.test", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "ip", { value: "192.0.2.90" });
  return request;
}
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};
const callTool = (name: string, args: object = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

async function toolJson(token: string, name: string, args: object = {}) {
  const response = await handleMcpRequest(db(), rpc(callTool(name, args), bearer(token)), freshIp());
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  if (body.result.isError) throw new Error(body.result.content[0]?.text);
  return JSON.parse(body.result.content[0]?.text ?? "null");
}

describe("MCP endpoint", () => {
  let admin: Viewer;
  let member: Viewer;
  let shared: number;
  let memberToken: string;
  let adminToken: string;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    await createDemoData(db(), new Date("2026-11-15T12:00:00Z"));
    shared = (await db().select().from(accountGroups).where(eq(accountGroups.name, "Gemeinschaftskonto")))[0]?.id ?? -1;
    member = await makeUser("partnerin", "member", [shared]);
    memberToken = (await createToken(db(), member, { name: "Claude" })).token;
    adminToken = (await createToken(db(), admin, { name: "Admin" })).token;
  });

  it("answers the initialize handshake and lists read-only tools", async () => {
    const init = await handleMcpRequest(db(), rpc(initialize, bearer(memberToken)), freshIp());
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const body = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe("saldo");

    const list = await handleMcpRequest(db(), rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer(memberToken)), freshIp());
    const tools = ((await list.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "category_totals",
        "list_accounts",
        "list_categories",
        "list_contracts",
        "list_groups",
        "list_holdings",
        "recurring_payments",
        "search_transactions",
        "summary",
        "top_counterparties",
      ].sort(),
    );
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(mcpInfo()).toMatchObject({ url: "https://saldo.test/api/mcp" });
    expect(mcpInfo().tools).toHaveLength(10);
  });

  it("limits a member's token to the member's groups", async () => {
    const groups = await toolJson(memberToken, "list_groups");
    expect(groups.map((g: { name: string }) => g.name)).toEqual(["Gemeinschaftskonto"]);
    const balances = await toolJson(memberToken, "list_accounts");
    expect(balances.accounts.map((a: { name: string }) => a.name)).toEqual(["Comdirect Gemeinschaftskonto"]);
    const found = await toolJson(memberToken, "search_transactions", { limit: 200 });
    const [joint] = await db().select().from(accounts).where(eq(accounts.bank, "comdirect"));
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((t: { accountId: number }) => t.accountId === joint?.id)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/DE02|Muster GmbH/);
    expect((await toolJson(memberToken, "search_transactions", { query: "Muster" })).total).toBe(0);
    const tops = await toolJson(memberToken, "top_counterparties", { dateFrom: "2026-01-01", dateTo: "2026-11-30" });
    expect(tops[0].counterparty).toBe("Hausverwaltung Sonnenhalde");
    await expect(toolJson(memberToken, "summary", { groupId: shared + 1000 })).rejects.toThrow("Group not found");

    const adminGroups = await toolJson(adminToken, "list_groups");
    expect(adminGroups).toHaveLength(2);
  });

  it("filters bookings by amount and category name", async () => {
    const rent = await toolJson(memberToken, "search_transactions", { category: "Wohnen", maxAmount: -1000, limit: 200 });
    const all = await toolJson(memberToken, "search_transactions", { maxAmount: -1000, limit: 200 });
    expect(all.items.every((t: { amountCents: number }) => t.amountCents <= -100_000)).toBe(true);
    expect(rent.items.every((t: { category: string }) => t.category === "Wohnen")).toBe(true);
    await expect(toolJson(memberToken, "search_transactions", { category: "Gibt es nicht" })).rejects.toThrow("Unknown category");
    const incoming = await toolJson(memberToken, "search_transactions", { direction: "in", limit: 200 });
    expect(incoming.items.length).toBeGreaterThan(0);
    expect(incoming.items.every((t: { amountCents: number }) => t.amountCents > 0)).toBe(true);
    const largest = await toolJson(memberToken, "search_transactions", { sort: "largest_expense", limit: 5 });
    const amounts = largest.items.map((t: { amountCents: number }) => t.amountCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    const [dkb] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    await expect(toolJson(memberToken, "list_holdings", { accountId: dkb?.id })).rejects.toThrow("Account not found");
    await expect(toolJson(memberToken, "search_transactions", { accountId: dkb?.id })).rejects.toThrow("Account not found");
    const catalog = await toolJson(memberToken, "list_categories");
    expect(catalog.categories.length).toBeGreaterThan(10);
  });

  it("rejects missing, invalid, cookie-only and revoked credentials and foreign origins", async () => {
    const ip = freshIp();
    expect((await handleMcpRequest(db(), rpc(initialize), ip)).status).toBe(401);
    expect((await handleMcpRequest(db(), rpc(initialize, bearer(`fwm_${"x".repeat(43)}`)), ip)).status).toBe(401);
    const cookieOnly = await handleMcpRequest(db(), rpc(initialize, { cookie: `better-auth.session_token=${memberToken}` }), ip);
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("www-authenticate")).toContain("Bearer");
    const foreign = await handleMcpRequest(db(), rpc(initialize, { ...bearer(memberToken), origin: "https://evil.example" }), ip);
    expect(foreign.status).toBe(403);
    expect((await handleMcpRequest(db(), rpc(initialize, { ...bearer(memberToken), origin: "https://saldo.test" }), ip)).status).toBe(200);
    expect((await handleMcpRequest(db(), rpc(initialize, bearer(memberToken)), ip)).status).toBe(200);
    expect((await handleMcpRequest(db(), rpc({}, bearer(memberToken), "GET"), ip)).status).toBe(405);
    expect((await handleMcpRequest(db(), rpc({}, bearer(memberToken), "DELETE"), ip)).status).toBe(405);

    const [row] = await db().select().from(mcpTokens).where(eq(mcpTokens.userId, member.id));
    expect(row?.lastUsedAt).not.toBeNull();
    await revokeToken(db(), member, row?.id ?? -1);
    expect((await handleMcpRequest(db(), rpc(initialize, bearer(memberToken)), ip)).status).toBe(401);
  });

  it("throttles repeated failures per address", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await handleMcpRequest(db(), rpc(initialize, bearer("fwm_wrong")), ip)).status).toBe(401);
    const blocked = await handleMcpRequest(db(), rpc(initialize, bearer(memberToken)), ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await handleMcpRequest(db(), rpc(initialize, bearer(memberToken)), freshIp())).status).toBe(200);
  });

  it("keeps a bounded number of failing addresses, dropping the oldest", async () => {
    for (let i = 0; i < 10_050; i++) {
      await handleMcpRequest(db(), rpc(initialize), `172.16.${Math.floor(i / 250)}.${i % 250}`);
    }
    expect(trackedFailureAddressesForTests()).toBeLessThanOrEqual(10_000);
  });

  it("refuses large JSON-RPC batches before any work and audits one event per request", async () => {
    await db().delete(auditEvents);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...callTool("list_groups"), id: i + 1 }));
    expect((await handleMcpRequest(db(), rpc(many, bearer(memberToken)), freshIp())).status).toBe(400);
    expect(await db().select().from(auditEvents)).toHaveLength(0);
    const few = [callTool("list_groups"), { ...callTool("list_accounts"), id: 3 }];
    expect((await handleMcpRequest(db(), rpc(few, bearer(memberToken)), freshIp())).status).toBe(200);
    const rows = await db().select().from(auditEvents);
    expect(rows.map((r) => [r.action, r.details])).toEqual([["export.mcpTool", { tools: ["list_groups", "list_accounts"] }]]);
  });

  it("ends a person's tokens when their password is reset or changed, and lets new tokens expire after a year", async () => {
    const ok = async (token: string) => (await handleMcpRequest(db(), rpc(initialize, bearer(token)), freshIp())).status;
    expect(await ok(memberToken)).toBe(200);
    await resetPassword(db(), admin, member.id, "new-password-1234");
    expect(await ok(memberToken)).toBe(401);

    const own = await createToken(db(), admin, { name: "Eigener" });
    expect(Date.parse(own.expiresAt ?? "") - Date.now()).toBeGreaterThan(364 * 86_400_000);
    const signIn = await handleAuthRequest(authPost("/sign-in/username", { username: "admin", password: "test-password-123" }));
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const changed = await handleAuthRequest(
      authPost("/change-password", { currentPassword: "test-password-123", newPassword: "admin-password-new-1" }, cookie),
    );
    expect(changed.status).toBe(200);
    expect(await ok(own.token)).toBe(401);

    const later = await createToken(db(), admin, { name: "Abgelaufen" });
    await db()
      .update(mcpTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpTokens.id, later.id));
    expect(await ok(later.token)).toBe(401);
  });

  it("stores only a hash, shows members their own tokens and lets an admin see and revoke all", async () => {
    const created = await createToken(db(), member, { name: "Zweiter" });
    expect(created.token).toMatch(/^fwm_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const stored = await db().select().from(mcpTokens);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const own = await listTokens(db(), member);
    expect(own.map((t) => t.name).sort()).toEqual(["Claude", "Zweiter"]);
    expect(JSON.stringify(own)).not.toContain("token_hash");
    expect(own.every((t) => !("token" in t) && !("tokenHash" in t))).toBe(true);
    const all = await listTokens(db(), admin);
    expect(all.map((t) => t.username).sort()).toEqual(["admin", "partnerin", "partnerin"]);

    const adminTokenId = all.find((t) => t.username === "admin")?.id ?? -1;
    await expect(revokeToken(db(), member, adminTokenId)).rejects.toMatchObject({ status: 404 });
    await revokeToken(db(), admin, created.id);
    expect(await listTokens(db(), member)).toHaveLength(1);
  });
});
