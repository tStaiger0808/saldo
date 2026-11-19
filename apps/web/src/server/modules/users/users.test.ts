import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAuthRequest } from "../../auth.ts";
import { db } from "../../db/index.ts";
import { accounts, session, user } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import { createAccount, createGroup, listAccounts } from "../accounts/index.ts";
import {
  bootstrapAdmin,
  createUser,
  deleteUser,
  listPeople,
  listUsers,
  resetPassword,
  setOwnLocale,
  setOwnName,
  updateUser,
} from "./index.ts";

describe("users", () => {
  beforeEach(resetDb);

  it("bootstraps the first superuser only once, with AI allowed", async () => {
    expect(await bootstrapAdmin(db(), "admin", undefined)).toBe("no-password");
    expect(await bootstrapAdmin(db(), "admin", "first-password-123")).toBe("created");
    expect(await bootstrapAdmin(db(), "other", "first-password-123")).toBe("exists");
    expect((await listUsers(db(), { id: "x", role: "superuser" })).map((u) => [u.username, u.role, u.aiAllowed])).toEqual([
      ["admin", "superuser", true],
    ]);
  });

  it("lets an admin create members with groups, but not duplicate names or short passwords", async () => {
    const admin = await makeUser("admin", "superuser");
    const family = await createGroup(db(), admin, { name: "Familie" });
    await createUser(db(), admin, { username: "Lena", password: "lena-password-1", role: "member", groupIds: [family] });
    const lena = (await listUsers(db(), admin)).find((u) => u.username === "Lena");
    expect(lena).toMatchObject({ role: "member", groupIds: [family] });
    await expect(createUser(db(), admin, { username: "lena", password: "lena-password-1", role: "member" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(createUser(db(), admin, { username: "max", password: "short", role: "member" })).rejects.toThrow();
  });

  it("never removes the last superuser", async () => {
    const admin = await makeUser("admin", "superuser");
    await expect(updateUser(db(), admin, { id: admin.id, role: "member" })).rejects.toMatchObject({ status: 400 });
    await expect(deleteUser(db(), admin, admin.id)).rejects.toMatchObject({ status: 400 });
    const second = await makeUser("zweit", "superuser");
    await updateUser(db(), admin, { id: second.id, role: "member" });
    await expect(deleteUser(db(), { id: "someone", role: "superuser" }, admin.id)).rejects.toMatchObject({ status: 400 });
  });

  it("members cannot manage users", async () => {
    const member = await makeUser("kind", "member");
    const other = await makeUser("bruder", "member");
    await expect(listUsers(db(), member)).rejects.toMatchObject({ status: 403 });
    for (const role of ["superuser", "familyAdmin", "member"] as const) {
      await expect(createUser(db(), member, { username: "x", password: "x-password-123", role })).rejects.toMatchObject({ status: 403 });
    }
    await expect(updateUser(db(), member, { id: other.id, groupIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(resetPassword(db(), member, other.id, "brand-new-password")).rejects.toMatchObject({ status: 403 });
    await expect(deleteUser(db(), member, other.id)).rejects.toMatchObject({ status: 403 });
    expect((await listPeople(db(), member)).map((p) => p.username)).toEqual(["bruder"]);
  });

  it("lets a family admin manage members only, never superusers or other family admins", async () => {
    const chef = await makeUser("chef", "superuser");
    const mama = await makeUser("mama", "familyAdmin");
    const papa = await makeUser("papa", "familyAdmin");
    const family = await createGroup(db(), chef, { name: "Familie" });
    const kind = await createUser(db(), mama, { username: "kind", password: "kind-password-1", role: "member", groupIds: [family] });
    expect((await listUsers(db(), mama)).map((u) => u.username)).toEqual(["kind"]);
    for (const role of ["superuser", "familyAdmin"] as const) {
      await expect(createUser(db(), mama, { username: `neu${role}`, password: "neu-password-123", role })).rejects.toMatchObject({
        status: 403,
      });
      await expect(updateUser(db(), mama, { id: kind, role })).rejects.toMatchObject({ status: 403 });
    }
    // Superusers and other family admins do not exist for a family admin: 404, nothing to probe.
    for (const target of [chef.id, papa.id, mama.id]) {
      await expect(updateUser(db(), mama, { id: target, groupIds: [] })).rejects.toMatchObject({ status: 404 });
      await expect(resetPassword(db(), mama, target, "brand-new-password")).rejects.toMatchObject({ status: 404 });
    }
    await expect(deleteUser(db(), mama, chef.id)).rejects.toMatchObject({ status: 404 });
    // Only a superuser decides about AI.
    await expect(updateUser(db(), mama, { id: kind, aiAllowed: true })).rejects.toMatchObject({ status: 403 });
    await expect(
      createUser(db(), mama, { username: "kira", password: "kira-password-123", role: "member", aiAllowed: true }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await updateUser(db(), mama, { id: kind, groupIds: [] });
    await resetPassword(db(), mama, kind, "brand-new-password");
    await updateUser(db(), chef, { id: kind, aiAllowed: true });
    expect((await listUsers(db(), chef)).find((u) => u.id === kind)).toMatchObject({ aiAllowed: true, groupIds: [] });
    await updateUser(db(), chef, { id: papa.id, role: "member" });
    expect((await listUsers(db(), mama)).map((u) => u.username).sort()).toEqual(["kind", "papa"]);
    await deleteUser(db(), mama, kind);
    expect((await listUsers(db(), chef)).map((u) => u.username)).not.toContain("kind");
  });

  it("keeps a deleted person's accounts, private ones private, with a superuser as owner", async () => {
    const chef = await makeUser("chef", "superuser");
    const mama = await makeUser("mama", "familyAdmin");
    const kind = await makeUser("kind", "member");
    const own = await createAccount(db(), kind, { name: "Sparschwein", bank: "bar", kind: "savings", color: "#1f6f5c" });
    await deleteUser(db(), mama, kind.id);
    const [row] = await db().select().from(accounts).where(eq(accounts.id, own));
    expect(row).toMatchObject({ ownerUserId: chef.id, visibility: "private" });
    expect((await listAccounts(db(), mama)).map((a) => a.id)).not.toContain(own);
  });

  it("a password reset ends the user's sessions", async () => {
    const admin = await makeUser("admin", "superuser");
    const member = await makeUser("kind", "member");
    await db()
      .insert(session)
      .values({ id: "s1", userId: member.id, token: "t1", expiresAt: new Date(Date.now() + 1e6) });
    await resetPassword(db(), admin, member.id, "brand-new-password");
    expect(await db().select().from(session).where(eq(session.userId, member.id))).toEqual([]);
  });

  it("stores the language: automatic by default, set by an admin or by the user", async () => {
    const admin = await makeUser("admin", "superuser");
    await createUser(db(), admin, { username: "lena", password: "lena-password-1", role: "member" });
    await createUser(db(), admin, { username: "luca", password: "luca-password-1", role: "member", locale: "it" });
    const byName = async (name: string) => (await listUsers(db(), admin)).find((u) => u.username === name);
    expect((await byName("lena"))?.locale).toBeNull();
    expect((await byName("luca"))?.locale).toBe("it");

    const lena = await byName("lena");
    await updateUser(db(), admin, { id: lena?.id ?? "", locale: "fr" });
    expect(await byName("lena")).toMatchObject({ locale: "fr", role: "member" });
    await updateUser(db(), admin, { id: lena?.id ?? "", role: "superuser" });
    expect((await byName("lena"))?.locale).toBe("fr");

    await setOwnLocale(db(), { id: lena?.id ?? "", role: "superuser" }, null);
    expect((await byName("lena"))?.locale).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: an invalid value as it could arrive from outside
    await expect(setOwnLocale(db(), admin, "es" as any)).rejects.toThrow();
  });
});

describe("self-service profile changes", () => {
  beforeEach(resetDb);

  const ORIGIN = "https://saldo.test";
  const post = (path: string, body: object, cookie?: string) => {
    const request = new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    Object.defineProperty(request, "ip", { value: "192.0.2.80" });
    return handleAuthRequest(request);
  };

  it("never lets a member change the login name or the name others see through better-auth", async () => {
    const kid = await makeUser("kind", "member");
    await makeUser("anna", "member");
    const signedIn = await post("/sign-in/username", { username: "kind", password: "test-password-123" });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    for (const body of [
      { username: "kind2", displayUsername: "anna" },
      { displayUsername: "anna" },
      { username: "kind3" },
      { name: "Kind" },
    ]) {
      expect((await post("/update-user", body, cookie)).status).toBeGreaterThanOrEqual(400);
    }
    const [row] = await db().select().from(user).where(eq(user.id, kid.id));
    expect(row).toMatchObject({ username: "kind", displayUsername: "kind" });
    expect((await listPeople(db(), kid)).filter((p) => p.username === "anna")).toHaveLength(1);
  });

  it("lets everyone change their own display name, and only that", async () => {
    const kid = await makeUser("kind", "member");
    await setOwnName(db(), kid, { name: "  Kind  " });
    const [row] = await db().select().from(user).where(eq(user.id, kid.id));
    expect(row).toMatchObject({ name: "Kind", username: "kind", displayUsername: "kind" });
    await expect(setOwnName(db(), kid, { name: " " })).rejects.toThrow();
    await expect(setOwnName(db(), kid, { name: "x".repeat(65) })).rejects.toThrow();
  });
});
