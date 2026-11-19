import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, handleAuthRequest } from "../../auth.ts";
import { type Db, db } from "../../db/index.ts";
import { auditEvents } from "../../db/schema.ts";
import { Forbidden } from "../../errors.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import { createGroup } from "../accounts/index.ts";
import { chat, createProvider, updateProvider } from "../ai/index.ts";
import { createToken, handleMcpRequest, revokeToken } from "../mcp/index.ts";
import { tick } from "../scheduler/index.ts";
import { exportCsv } from "../transactions/index.ts";
import { createUser, deleteUser, resetPassword, updateUser } from "../users/index.ts";
import { auditCsv, listAuditEvents, pruneAuditEvents, record, requestMeta, withRequestMeta } from "./index.ts";

const ORIGIN = "https://saldo.test";

function authRequest(path: string, body: object, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": "vitest", ...headers },
    body: JSON.stringify(body),
  });
}

/** Through the auth route as start.ts runs it; the peer is the client, its X-Forwarded-For claim is ignored. */
async function signIn(username: string, password: string, ip = "203.0.113.7") {
  const request = authRequest("/sign-in/username", { username, password }, { "x-forwarded-for": "198.51.100.66" });
  Object.defineProperty(request, "ip", { value: ip });
  return withRequestMeta(requestMeta(request), () => handleAuthRequest(request));
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const events = async () => (await db().select().from(auditEvents)).sort((a, b) => a.id - b.id);

describe("audit log", () => {
  beforeEach(resetDb);

  it("records sign-in success and failure with the user name, IP and agent but never the password", async () => {
    const admin = await makeUser("admin", "superuser");
    expect((await signIn("admin", "wrong-password-123")).status).toBe(401);
    expect((await signIn("nobody", "secret-password-1")).status).toBe(401);
    expect((await signIn("admin", "test-password-123")).status).toBe(200);

    const rows = await events();
    expect(rows.map((r) => [r.action, r.outcome, r.userId, r.username])).toEqual([
      ["auth.signIn", "failed", admin.id, "admin"],
      ["auth.signIn", "failed", null, null],
      ["auth.signIn", "ok", admin.id, "admin"],
    ]);
    expect(rows[0]?.details).toEqual({ attemptedUsername: "admin" });
    expect(rows[1]?.details).toEqual({ attemptedUsername: "nobody" });
    expect(rows.every((r) => r.ip === "203.0.113.7" && r.userAgent === "vitest")).toBe(true);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("wrong-password-123");
    expect(stored).not.toContain("secret-password-1");
    expect(stored).not.toContain("test-password-123");
  });

  it("records sign-out, password change and session revocation of the signed-in user", async () => {
    const admin = await makeUser("admin", "superuser");
    const cookie = cookieOf(await signIn("admin", "test-password-123"));
    const as = (path: string, body: object) => auth().handler(authRequest(path, body, { cookie }));
    expect(
      (
        await as("/change-password", {
          currentPassword: "test-password-123",
          newPassword: "another-password-1",
          revokeOtherSessions: false,
        })
      ).status,
    ).toBe(200);
    expect((await as("/change-password", { currentPassword: "wrong-wrong-wrong", newPassword: "another-password-2" })).status).toBe(400);
    expect((await as("/revoke-other-sessions", {})).status).toBe(200);
    expect((await as("/sign-out", {})).status).toBe(200);

    const rows = (await events()).filter((r) => r.action !== "auth.signIn");
    expect(rows.map((r) => [r.action, r.outcome, r.userId])).toEqual([
      ["auth.passwordChanged", "ok", admin.id],
      ["auth.passwordChanged", "failed", admin.id],
      ["auth.sessionRevoked", "ok", admin.id],
      ["auth.signOut", "ok", admin.id],
    ]);
    expect(JSON.stringify(rows)).not.toContain("another-password");
  });

  it("never throws when the log cannot be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      insert: () => ({ values: () => ({ returning: () => Promise.reject(new Error("database down")) }) }),
    } as unknown as Db;
    const throwing = {
      insert: () => {
        throw new Error("database down");
      },
    } as unknown as Db;
    await expect(record(broken, { action: "auth.signOut", username: "admin" })).resolves.toBeUndefined();
    await expect(record(throwing, { action: "auth.signOut", username: "admin" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).not.toContain("database down");
    error.mockRestore();
  });

  it("takes the origin from the request and the name from the actor", async () => {
    const admin = await makeUser("admin", "superuser");
    await withRequestMeta({ ip: "198.51.100.4", userAgent: "Firefox" }, () =>
      record(db(), { action: "users.deleted", actor: admin, target: { type: "user", id: "x" }, details: { name: "lena" } }),
    );
    const [row] = await events();
    expect(row).toMatchObject({
      username: "admin",
      ip: "198.51.100.4",
      userAgent: "Firefox",
      targetType: "user",
      targetId: "x",
      details: { name: "lena" },
    });
  });

  it("is for admins only", async () => {
    const member = await makeUser("lena", "member");
    await expect(listAuditEvents(db(), member, {})).rejects.toBeInstanceOf(Forbidden);
    await expect(auditCsv(db(), member, {})).rejects.toBeInstanceOf(Forbidden);
  });

  it("filters by user, category, outcome, period and search and pages newest first", async () => {
    const admin = await makeUser("admin", "superuser");
    const member = await makeUser("lena", "member");
    await record(db(), { action: "auth.signIn", actor: admin });
    await record(db(), { action: "auth.signIn", actor: member, outcome: "failed", details: { attemptedUsername: "lena" } });
    await record(db(), { action: "ai.analysis", actor: admin, details: { model: "gpt-5-nano", inputTokens: 1000, outputTokens: 234 } });
    await record(db(), { action: "bank.syncStarted", actor: null, details: { trigger: "scheduled" } });
    await record(db(), { action: "export.transactionsCsv", actor: member, details: { rows: 12 } });
    await record(db(), { action: "auth.signOut", actor: admin });
    await db()
      .update(auditEvents)
      .set({ at: new Date("2025-01-10T12:00:00") })
      .where(eq(auditEvents.action, "auth.signOut"));

    const actions = async (input: Parameters<typeof listAuditEvents>[2]) =>
      (await listAuditEvents(db(), admin, input)).items.map((i) => i.action);
    expect(await actions({ userId: member.id })).toEqual(["export.transactionsCsv", "auth.signIn"]);
    expect(await actions({ category: "auth" })).toEqual(["auth.signOut", "auth.signIn", "auth.signIn"]);
    expect(await actions({ outcome: "failed" })).toEqual(["auth.signIn"]);
    expect(await actions({ dateFrom: "2025-01-01", dateTo: "2025-01-31" })).toEqual(["auth.signOut"]);
    expect(await actions({ q: "nano" })).toEqual(["ai.analysis"]);
    expect(await actions({ q: "lena" })).toEqual(["export.transactionsCsv", "auth.signIn"]);
    // The reader's wording of an action is searchable, too.
    expect(await actions({ q: "Abmeldung" })).toEqual(["auth.signOut"]);
    expect(await actions({ q: "100%" })).toEqual([]);

    const first = await listAuditEvents(db(), admin, { limit: 4 });
    expect(first.items.map((i) => i.action)).toEqual(["auth.signOut", "export.transactionsCsv", "bank.syncStarted", "ai.analysis"]);
    expect(first.items[2]).toMatchObject({ category: "bank", userId: null, details: { trigger: "scheduled" } });
    const second = await listAuditEvents(db(), admin, { limit: 4, before: first.nextBefore });
    expect(second.items.map((i) => i.action)).toEqual(["auth.signIn", "auth.signIn"]);
    expect(second.nextBefore).toBeNull();
  });

  it("exports the filtered log as CSV through the formula guard and records the export", async () => {
    const admin = await makeUser("admin", "superuser");
    await record(db(), {
      action: "auth.signIn",
      username: "=HYPERLINK()",
      outcome: "failed",
      details: { attemptedUsername: "=HYPERLINK()" },
    });
    await record(db(), { action: "ai.chat", actor: admin });
    const csv = await auditCsv(db(), admin, { category: "auth" });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("Zeit;Benutzer;Aktion;Ergebnis;Ziel;Details;IP;User-Agent");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(";'=HYPERLINK();auth.signIn;failed;");
    expect((await events()).at(-1)).toMatchObject({ action: "export.auditCsv", userId: admin.id, details: { rows: 1 } });
  });

  it("deletes events older than the retention period", async () => {
    await record(db(), { action: "auth.signIn", username: "old" });
    await record(db(), { action: "auth.signIn", username: "recent" });
    const now = new Date("2026-11-16T09:00:00Z");
    await db()
      .update(auditEvents)
      .set({ at: new Date("2025-11-15T09:00:00Z") })
      .where(eq(auditEvents.username, "old"));
    await db()
      .update(auditEvents)
      .set({ at: new Date("2025-11-17T09:00:00Z") })
      .where(eq(auditEvents.username, "recent"));
    expect(await pruneAuditEvents(db(), now, 365)).toBe(1);
    expect((await events()).map((r) => r.username)).toEqual(["recent"]);
  });
});

describe("what the audit log records", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  const replyWith = (content: string) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
      return body.messages
        ? Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1200, completion_tokens: 34 } })
        : Response.json({ data: [{ id: "gpt-5-nano" }] });
    });

  it("records every AI request with provider, model, tokens and cost but no prompt or answer", async () => {
    const admin = await makeUser("admin", "superuser");
    replyWith("Die Antwort bleibt privat.");
    const created = await createProvider(db(), admin, { name: "OpenAI", kind: "openai", apiKey: "sk-secret-key" });
    await updateProvider(db(), admin, created.provider.id, {
      name: "OpenAI",
      kind: "openai",
      model: "gpt-5-nano",
      priceInputPerMtok: 0.05,
      priceOutputPerMtok: 0.4,
    });
    await chat(db(), admin, { question: "Wie hoch ist meine geheime Miete?" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    await expect(chat(db(), admin, { question: "Noch eine Frage" })).rejects.toMatchObject({ status: 502 });

    const rows = await events();
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([
      ["settings.aiProviderCreated", "ok"],
      ["settings.aiProviderUpdated", "ok"],
      ["ai.chat", "ok"],
      ["ai.chat", "failed"],
    ]);
    expect(rows[2]).toMatchObject({
      userId: admin.id,
      details: { provider: "OpenAI", model: "gpt-5-nano", inputTokens: 1200, outputTokens: 34, costMicro: 74, currency: "USD" },
    });
    expect(rows[3]?.details).toEqual({ provider: "OpenAI", model: "gpt-5-nano", reason: "ai.errors.timeout" });
    const logged = JSON.stringify(rows);
    for (const text of ["geheime Miete", "Noch eine Frage", "bleibt privat", "sk-secret-key"]) expect(logged).not.toContain(text);
  });

  it("records user management with names, roles and groups but never passwords", async () => {
    const admin = await makeUser("admin", "superuser");
    const kids = await createGroup(db(), admin, { name: "Kinder" });
    const id = await createUser(db(), admin, { username: "Lena", password: "lenas-password-1", role: "member", groupIds: [kids] });
    await updateUser(db(), admin, { id, role: "superuser", groupIds: [kids] });
    await updateUser(db(), admin, { id, groupIds: [] });
    await resetPassword(db(), admin, id, "lenas-password-2");
    await deleteUser(db(), admin, id);

    const rows = (await events()).filter((r) => r.action !== "users.created" || r.targetId === id);
    expect(rows.map((r) => [r.action, r.targetId, r.details])).toEqual([
      ["users.created", id, { name: "Lena", role: "member", groups: ["Kinder"] }],
      ["users.updated", id, { name: "Lena", role: "superuser" }],
      ["users.updated", id, { name: "Lena", groups: [] }],
      ["auth.passwordReset", id, { name: "Lena" }],
      ["users.deleted", id, { name: "Lena" }],
    ]);
    expect(rows.every((r) => r.userId === admin.id && r.username === "admin")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("lenas-password");
    // Deleting the user keeps its events and only clears the link.
    expect((await events()).some((r) => r.userId === id)).toBe(false);
  });

  it("records MCP tokens by name and tool calls by tool name only, plus CSV exports", async () => {
    const admin = await makeUser("admin", "superuser");
    const created = await createToken(db(), admin, { name: "Claude" });
    const call = new Request("https://saldo.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_transactions", arguments: { q: "Apotheke Geheim" } },
      }),
    });
    expect((await handleMcpRequest(db(), call, "198.51.100.9")).status).toBe(200);
    await revokeToken(db(), admin, created.id);
    await exportCsv(db(), admin, {});

    const rows = await events();
    expect(rows.map((r) => [r.action, r.details])).toEqual([
      ["settings.mcpTokenCreated", { name: "Claude" }],
      ["export.mcpTool", { tool: "search_transactions" }],
      ["settings.mcpTokenRevoked", { name: "Claude" }],
      ["export.transactionsCsv", { rows: 0 }],
    ]);
    expect(rows[1]).toMatchObject({ userId: admin.id, ip: "198.51.100.9" });
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain(created.token);
    expect(logged).not.toContain("Apotheke");
  });

  it("prunes old events in the daily scheduler run", async () => {
    await record(db(), { action: "auth.signIn", username: "old" });
    await db()
      .update(auditEvents)
      .set({ at: new Date(2025, 0, 1) });
    await record(db(), { action: "auth.signIn", username: "new" });
    await tick(db(), new Date(2026, 10, 16, 7, 0));
    expect(await events()).toHaveLength(2);
    await tick(db(), new Date(2026, 10, 16, 8, 0));
    expect((await events()).map((r) => r.username)).toEqual(["new"]);
  });
});
