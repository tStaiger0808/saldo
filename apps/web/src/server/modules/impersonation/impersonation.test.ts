import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ current: new Request("https://saldo.test/") }));
vi.mock("@tanstack/react-start/server", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start/server")>()),
  getRequest: () => request.current,
}));

import { startInstance } from "../../../start.ts";
import { auth, sessionUser, signedInSession } from "../../auth.ts";
import { db } from "../../db/index.ts";
import { accounts, auditEvents, impersonations, notifications, session } from "../../db/schema.ts";
import { readOnlyRequests, readOnlyWhileImpersonating } from "../../middleware.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import { type Viewer, visibleAccountIds } from "../access/index.ts";
import { withRequestMeta } from "../audit/index.ts";
import { exportCsv } from "../transactions/index.ts";
import { deleteUser, updateUser } from "../users/index.ts";
import {
  activeImpersonation,
  endImpersonation,
  IMPERSONATION_EXIT_FN,
  refusedWhileImpersonating,
  serverFnAllowedWhileImpersonating,
  startImpersonation,
} from "./index.ts";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const LOCKED = "Beim Ansehen als lena sind Änderungen gesperrt";

async function signIn(username: string): Promise<Headers> {
  const { headers } = await auth().api.signInUsername({ body: { username, password: "test-password-123" }, returnHeaders: true });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}

async function signedIn(headers: Headers) {
  const found = await signedInSession(headers);
  if (!found) throw new Error("not signed in");
  return found;
}

/** A bare session row, for module tests that need no cookie. */
async function fakeSession(userId: string): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(session)
    .values({ id, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) });
  return id;
}

async function account(name: string, ownerUserId: string) {
  const [row] = await db()
    .insert(accounts)
    .values({ name, bank: "Testbank", kind: "checking", ownerUserId, visibility: "private" })
    .returning({ id: accounts.id });
  return row?.id ?? -1;
}

const events = (action: string) => db().select().from(auditEvents).where(eq(auditEvents.action, action));

/** Every source file below src, tests left out. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function serverFunctions() {
  return sources().flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/export const (\w+) = createServerFn\(\{ method: "(\w+)" \}\)/g)].map((m) => ({
      name: m[1] ?? "",
      method: m[2] ?? "",
      filename: relative(join(SRC, ".."), file),
    })),
  );
}

function serverRoutes() {
  return sources(join(SRC, "routes")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const path = text.match(/createFileRoute\("([^"]+)"\)/)?.[1];
    const handlers = text.indexOf("handlers:");
    if (!path || handlers < 0) return [];
    const methods = [...new Set([...text.slice(handlers).matchAll(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\b\s*:/g)].map((m) => m[1] ?? ""))];
    return methods.map((method) => ({ method, path: path.replaceAll(/\$\w+/g, "1") }));
  });
}

describe("impersonation", () => {
  let chef: Viewer;
  let lena: Viewer;
  let tom: Viewer;
  let zweitchef: Viewer;
  let ids: { chef: number; lena: number; tom: number };

  beforeEach(async () => {
    await resetDb();
    chef = await makeUser("chef", "superuser");
    zweitchef = await makeUser("zweitchef", "superuser");
    lena = await makeUser("lena", "member");
    tom = await makeUser("tom", "member");
    ids = {
      chef: await account("Chef privat", chef.id),
      lena: await account("Lena privat", lena.id),
      tom: await account("Tom privat", tom.id),
    };
  });

  it("shows Saldo with the member's own visibility, records start and end, and ends on request", async () => {
    const headers = await signIn("chef");
    const { sessionId, user } = await signedIn(headers);
    await startImpersonation(db(), user, sessionId, { userId: lena.id });

    const viewer = await sessionUser(headers);
    expect(viewer).toMatchObject({ id: lena.id, role: "member", impersonation: { actorId: chef.id, actorName: "chef" } });
    expect(await visibleAccountIds(db(), viewer as Viewer)).toEqual([ids.lena]);
    expect((await signedIn(headers)).user.id).toBe(chef.id);

    expect(await endImpersonation(db(), sessionId, "stopped")).toBe(true);
    const own = await sessionUser(headers);
    expect(own).toMatchObject({ id: chef.id, role: "superuser" });
    expect(own?.impersonation).toBeUndefined();
    expect(await visibleAccountIds(db(), own as Viewer)).toEqual([ids.chef, ids.lena, ids.tom]);

    const [started] = await events("users.impersonationStarted");
    expect(started).toMatchObject({ userId: chef.id, username: "chef", targetType: "user", targetId: lena.id, details: { name: "lena" } });
    const [ended] = await events("users.impersonationEnded");
    expect(ended).toMatchObject({ userId: chef.id, targetId: lena.id, details: { name: "lena", reason: "impersonation.reasons.stopped" } });
  });

  it("only lets superusers start, never as themselves or as another superuser", async () => {
    const mama = await makeUser("mama", "familyAdmin");
    for (const viewer of [mama, tom]) {
      await expect(startImpersonation(db(), viewer, await fakeSession(viewer.id), { userId: lena.id })).rejects.toMatchObject({
        status: 403,
      });
    }
    const sessionId = await fakeSession(chef.id);
    await expect(startImpersonation(db(), chef, sessionId, { userId: zweitchef.id })).rejects.toMatchObject({ status: 403 });
    await expect(startImpersonation(db(), chef, sessionId, { userId: chef.id })).rejects.toMatchObject({ status: 400 });
    await expect(startImpersonation(db(), chef, sessionId, { userId: "unknown" })).rejects.toMatchObject({ status: 404 });
    expect(await db().select().from(impersonations)).toEqual([]);
    expect(await events("users.impersonationStarted")).toEqual([]);
  });

  it("expires after 60 minutes", async () => {
    const sessionId = await fakeSession(chef.id);
    const start = new Date();
    await startImpersonation(db(), chef, sessionId, { userId: lena.id }, start);
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    expect((await activeImpersonation(db(), sessionId, chef, at(59)))?.target.id).toBe(lena.id);
    expect(await activeImpersonation(db(), sessionId, chef, at(60))).toBeNull();
    expect(await db().select().from(impersonations)).toEqual([]);
    expect((await events("users.impersonationEnded"))[0]?.details).toMatchObject({ reason: "impersonation.reasons.expired" });
  });

  it("ends when the person becomes a superuser or is deleted", async () => {
    const first = await fakeSession(chef.id);
    await startImpersonation(db(), chef, first, { userId: lena.id });
    await updateUser(db(), chef, { id: lena.id, role: "superuser" });
    expect(await activeImpersonation(db(), first, chef)).toBeNull();

    const second = await fakeSession(chef.id);
    await startImpersonation(db(), chef, second, { userId: tom.id });
    await deleteUser(db(), zweitchef, tom.id);
    expect(await activeImpersonation(db(), second, chef)).toBeNull();

    const reasons = (await events("users.impersonationEnded")).map((e) => e.details.reason);
    expect(reasons).toEqual(["impersonation.reasons.targetChanged", "impersonation.reasons.targetDeleted"]);
  });

  it("ends with the superuser's sign-out", async () => {
    const headers = await signIn("chef");
    const { sessionId, user } = await signedIn(headers);
    await startImpersonation(db(), user, sessionId, { userId: lena.id });
    await auth().api.signOut({ headers });
    expect(await db().select().from(impersonations)).toEqual([]);
    expect((await events("users.impersonationEnded"))[0]?.details).toMatchObject({ reason: "impersonation.reasons.signOut" });
  });

  it("names the superuser in the audited reads of the view", async () => {
    const headers = await signIn("chef");
    const { sessionId, user } = await signedIn(headers);
    await startImpersonation(db(), user, sessionId, { userId: lena.id });
    await withRequestMeta({ ip: "198.51.100.7", userAgent: "Firefox" }, async () => {
      const viewer = await sessionUser(headers);
      await exportCsv(db(), viewer as Viewer, {});
    });
    const [exported] = await events("export.transactionsCsv");
    expect(exported).toMatchObject({ userId: lena.id, ip: "198.51.100.7", details: { impersonatedBy: "chef" } });
  });

  describe("read-only guard", () => {
    let headers: Headers;

    beforeEach(async () => {
      headers = await signIn("chef");
      const { sessionId, user } = await signedIn(headers);
      await startImpersonation(db(), user, sessionId, { userId: lena.id });
      request.current = new Request("https://saldo.test/_serverFn/x", { method: "POST", headers });
    });

    const runFunctionGuard = async (fn: { name: string; method: string; filename: string }, sent = request.current.method) => {
      request.current = new Request(request.current.url, { method: sent, headers: request.current.headers });
      const next = vi.fn(async () => ({ result: "ran" }));
      const server = readOnlyWhileImpersonating.options.server as unknown as (options: object) => Promise<unknown>;
      const outcome = await server({ next, method: fn.method, serverFnMeta: { id: fn.name, ...fn }, context: {}, data: undefined }).then(
        () => "ran",
        (error: { status?: number; message?: string }) => `${error.status}: ${error.message}`,
      );
      return { outcome, ran: next.mock.calls.length > 0 };
    };

    it("is registered for every server function and every request", async () => {
      const options = await startInstance.getOptions();
      expect(options.functionMiddleware).toContain(readOnlyWhileImpersonating);
      expect(options.requestMiddleware).toContain(readOnlyRequests);
    });

    it("refuses every mutating server function, AI and bank ones included, and lets reads and ending the view run", async () => {
      const fns = serverFunctions();
      expect(fns.length).toBeGreaterThan(100);
      const mutations = fns.filter((fn) => fn.method !== "GET");
      for (const name of ["chatFn", "startAnalysisFn", "syncBankConnectionFn", "syncAllBankConnectionsFn", "markNotificationReadFn"]) {
        expect(mutations.map((fn) => fn.name)).toContain(name);
      }
      const exit = fns.find((fn) => fn.name === IMPERSONATION_EXIT_FN.name);
      expect(exit?.method).toBe("POST");
      for (const fn of fns) {
        const { outcome, ran } = await runFunctionGuard(fn, fn.method);
        if (fn.method === "GET" || fn === exit) expect({ fn: fn.name, outcome, ran }).toEqual({ fn: fn.name, outcome: "ran", ran: true });
        else expect({ fn: fn.name, outcome, ran }).toEqual({ fn: fn.name, outcome: `403: ${LOCKED}`, ran: false });
      }
    });

    it("decides by the HTTP method as well as the declared one, so a mismatched call is refused", async () => {
      const read = { name: "getAccountsFn", method: "GET", filename: "src/server/functions/accounts.ts" };
      request.current = new Request("https://saldo.test/_serverFn/x", { method: "POST", headers });
      expect(await runFunctionGuard(read)).toEqual({ outcome: `403: ${LOCKED}`, ran: false });
      request.current = new Request("https://saldo.test/_serverFn/x", { method: "GET", headers });
      expect(await runFunctionGuard({ ...read, method: "POST" })).toEqual({ outcome: `403: ${LOCKED}`, ran: false });
      expect(await runFunctionGuard(read)).toEqual({ outcome: "ran", ran: true });
    });

    it("leaves mutations alone outside of a view", async () => {
      request.current = new Request("https://saldo.test/_serverFn/x", { method: "POST", headers: await signIn("zweitchef") });
      expect(await runFunctionGuard({ name: "chatFn", method: "POST", filename: "src/server/functions/ai.ts" })).toEqual({
        outcome: "ran",
        ran: true,
      });
    });

    it("only lets the real exit function through by name", () => {
      expect(
        serverFnAllowedWhileImpersonating("POST", { name: "stopImpersonationFn", filename: "src/server/functions/impersonation.ts" }),
      ).toBe(true);
      expect(serverFnAllowedWhileImpersonating("POST", { name: "stopImpersonationFn", filename: "src/server/functions/ai.ts" })).toBe(
        false,
      );
    });

    it("refuses every mutating route and the auth API but signing out", async () => {
      const routes = serverRoutes();
      expect(routes.length).toBeGreaterThan(5);
      for (const { method, path } of routes) {
        const refused = refusedWhileImpersonating(method, path);
        if (path === "/api/mcp") expect(refused).toBe(false);
        else if (method === "GET") {
          expect({ path, refused }).toEqual({ path, refused: path === "/bank/callback" || path === "/api/backup/download" });
        } else expect({ method, path, refused }).toEqual({ method, path, refused: true });
      }
      for (const path of ["change-password", "update-user", "revoke-sessions", "revoke-other-sessions", "sign-in/username"]) {
        expect(refusedWhileImpersonating("POST", `/api/auth/${path}`)).toBe(true);
      }
      expect(refusedWhileImpersonating("POST", "/api/auth/sign-out")).toBe(false);
      expect(refusedWhileImpersonating("GET", "/api/auth/get-session")).toBe(false);

      const server = readOnlyRequests.options.server as unknown as (options: object) => Promise<Response | string>;
      const next = vi.fn(async () => "ran");
      const csv = await server({ next, request: new Request("https://saldo.test/api/accounts/1/import.csv", { method: "POST", headers }) });
      expect(csv).toBeInstanceOf(Response);
      expect((csv as Response).status).toBe(403);
      expect(await (csv as Response).json()).toEqual({ error: LOCKED, message: LOCKED });
      expect(await server({ next, request: new Request("https://saldo.test/api/auth/sign-out", { method: "POST", headers }) })).toBe("ran");
      expect(await server({ next, request: new Request("https://saldo.test/api/transactions/export.csv", { headers }) })).toBe("ran");
    });

    it("neither signs the person in nor tells them", async () => {
      expect(await db().select().from(impersonations).where(eq(impersonations.targetUserId, lena.id))).toHaveLength(1);
      expect(await db().select().from(session).where(eq(session.userId, lena.id))).toEqual([]);
      expect(await db().select().from(notifications).where(eq(notifications.userId, lena.id))).toEqual([]);
    });
  });
});
