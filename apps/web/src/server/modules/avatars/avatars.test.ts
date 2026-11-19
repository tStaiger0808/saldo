import { beforeEach, describe, expect, it } from "vitest";
import { Route as AvatarRoute } from "../../../routes/api/avatars/$userId.ts";
import { auth, signedInSession } from "../../auth.ts";
import { bodyLimit } from "../../body-limit.ts";
import { db } from "../../db/index.ts";
import { userAvatars } from "../../db/schema.ts";
import { readOnlyRequests } from "../../middleware.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createAccount } from "../accounts/index.ts";
import { listContractViews, saveContractView } from "../contracts/index.ts";
import { refusedWhileImpersonating, serverFnAllowedWhileImpersonating, startImpersonation } from "../impersonation/index.ts";
import { deleteUser, listPeople, listUsers } from "../users/index.ts";
import { avatarUrlOf, MAX_AVATAR_BYTES, readAvatar, removeAvatar, setAvatar } from "./index.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Handler = (context: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handler = (method: "GET" | "POST") =>
  (AvatarRoute.options as unknown as { server: { handlers: Record<string, Handler> } }).server.handlers[method] as Handler;

async function signIn(username: string): Promise<Headers> {
  const { headers } = await auth().api.signInUsername({ body: { username, password: "test-password-123" }, returnHeaders: true });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}

const stored = (userId: string) => readAvatar(db(), { id: "x", role: "member" }, userId);

describe("profile pictures", () => {
  let admin: Viewer;
  let lena: Viewer;
  let tom: Viewer;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    lena = await makeUser("lena", "member");
    tom = await makeUser("tom", "member");
  });

  it("stores PNG, JPEG and WebP by their first bytes and replaces the picture with a new address", async () => {
    for (const [bytes, type] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      const before = await avatarUrlOf(db(), lena.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const url = await setAvatar(db(), lena, lena.id, bytes);
      expect(url).toMatch(new RegExp(`^/api/avatars/${lena.id}\\?v=\\d+$`));
      expect(url).not.toBe(before);
      expect(await avatarUrlOf(db(), lena.id)).toBe(url);
      const avatar = await stored(lena.id);
      expect([avatar.contentType, new Uint8Array(avatar.data)]).toEqual([type, bytes]);
    }
    expect(await db().select({ userId: userAvatars.userId }).from(userAvatars)).toEqual([{ userId: lena.id }]);
  });

  it("refuses other types, empty and too large files and other people's pictures", async () => {
    const set = (bytes: Uint8Array) => setAvatar(db(), lena, lena.id, bytes);
    await expect(set(PDF)).rejects.toMatchObject({ status: 415 });
    await expect(set(SVG)).rejects.toMatchObject({ status: 415 });
    await expect(set(new Uint8Array())).rejects.toMatchObject({ status: 400 });
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(PNG);
    await expect(set(big)).rejects.toMatchObject({ status: 413 });
    await expect(setAvatar(db(), admin, lena.id, PNG)).rejects.toMatchObject({ status: 403 });
    expect(await avatarUrlOf(db(), lena.id)).toBeNull();
  });

  it("shows everyone's picture to everyone signed in and lets only the owner or a superuser remove it", async () => {
    const url = await setAvatar(db(), lena, lena.id, PNG);
    expect(new Uint8Array((await readAvatar(db(), tom, lena.id)).data)).toEqual(PNG);
    expect((await listPeople(db(), tom)).find((p) => p.id === lena.id)?.avatar).toBe(url);
    expect((await listUsers(db(), admin)).map((u) => [u.username, u.avatar])).toEqual([
      ["admin", null],
      ["lena", url],
      ["tom", null],
    ]);

    await expect(removeAvatar(db(), tom, { userId: lena.id })).rejects.toMatchObject({ status: 403 });
    await removeAvatar(db(), lena, { userId: lena.id });
    await expect(stored(lena.id)).rejects.toMatchObject({ status: 404 });
    await removeAvatar(db(), lena, { userId: lena.id });

    await setAvatar(db(), lena, lena.id, PNG);
    await removeAvatar(db(), admin, { userId: lena.id });
    expect(await avatarUrlOf(db(), lena.id)).toBeNull();
  });

  it("names the sharer's picture on a shared contract view", async () => {
    const url = await setAvatar(db(), lena, lena.id, JPEG);
    const giro = await createAccount(db(), lena, { name: "Giro", bank: "dkb", kind: "checking", color: "#1f6f5c" });
    await saveContractView(db(), lena, { name: "Familie", accountIds: [giro], sharing: "household" });
    expect(await listContractViews(db(), tom)).toMatchObject([{ name: "Familie", sharedBy: "lena", sharedByAvatar: url }]);
  });

  it("goes with its user", async () => {
    await setAvatar(db(), lena, lena.id, PNG);
    await deleteUser(db(), admin, lena.id);
    expect(await db().select().from(userAvatars)).toEqual([]);
  });

  it("stays read-only while a superuser views Saldo as someone else", async () => {
    expect(refusedWhileImpersonating("POST", `/api/avatars/${lena.id}`)).toBe(true);
    expect(refusedWhileImpersonating("GET", `/api/avatars/${lena.id}`)).toBe(false);
    expect(serverFnAllowedWhileImpersonating("POST", { name: "removeAvatarFn", filename: "src/server/functions/users.ts" })).toBe(false);

    const headers = await signIn("admin");
    const signedIn = await signedInSession(headers);
    if (!signedIn) throw new Error("not signed in");
    await startImpersonation(db(), signedIn.user, signedIn.sessionId, { userId: lena.id });
    const server = readOnlyRequests.options.server as unknown as (options: object) => Promise<Response | string>;
    const next = async () => "ran";
    const upload = await server({ next, request: new Request(`https://saldo.test/api/avatars/${lena.id}`, { method: "POST", headers }) });
    expect((upload as Response).status).toBe(403);
    expect(await server({ next, request: new Request(`https://saldo.test/api/avatars/${lena.id}`, { headers }) })).toBe("ran");
  });

  it("uploads through its route with a raised body limit and serves the picture inline, cacheable and sandboxed", async () => {
    expect(bodyLimit(`/api/avatars/${lena.id}`)).toBeGreaterThan(MAX_AVATAR_BYTES);
    expect(bodyLimit(`/api/avatars/${lena.id}/x`)).toBe(1024 * 1024);

    const post = (headers: Headers, userId: string, body: Uint8Array) =>
      handler("POST")({
        request: new Request(`https://saldo.test/api/avatars/${userId}`, { method: "POST", headers, body: new Blob([body.slice()]) }),
        params: { userId },
      });
    const get = (headers: Headers, userId: string) =>
      handler("GET")({ request: new Request(`https://saldo.test/api/avatars/${userId}?v=1`, { headers }), params: { userId } });

    const lenaHeaders = await signIn("lena");
    const tomHeaders = await signIn("tom");
    const created = await post(lenaHeaders, lena.id, WEBP);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ url: await avatarUrlOf(db(), lena.id) });
    expect((await post(lenaHeaders, lena.id, SVG)).status).toBe(415);
    expect((await post(tomHeaders, lena.id, PNG)).status).toBe(403);
    expect((await post(new Headers(), lena.id, PNG)).status).toBe(401);
    const oversized = new Headers(lenaHeaders);
    oversized.set("content-length", String(MAX_AVATAR_BYTES + 1));
    expect((await post(oversized, lena.id, PNG)).status).toBe(413);

    const picture = await get(tomHeaders, lena.id);
    expect(picture.status).toBe(200);
    expect(Object.fromEntries(picture.headers)).toMatchObject({
      "content-type": "image/webp",
      "content-length": String(WEBP.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    expect(picture.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(WEBP);
    expect((await get(tomHeaders, tom.id)).status).toBe(404);
    expect((await get(new Headers(), lena.id)).status).toBe(401);
  });
});
