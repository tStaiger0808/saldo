import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../../crypto.ts";
import { db } from "../../db/index.ts";
import { accounts, type BankProvider, bankConnections, settings } from "../../db/schema.ts";
import { NotFound } from "../../errors.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createGroup } from "../accounts/index.ts";
import * as banking from "./index.ts";
import { declaredIcons, fetchLogo, logoCacheKey, SITES, siteIconCacheKey } from "./logos.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "00000000-1111-4222-8333-444455556666";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const DKB_LOGO = "https://enablebanking.com/brands/DE/DKB/";
const TR_LOGO = "https://enablebanking.com/brands/DE/Trade_Republic/";
const ICO = Buffer.from("00000100010010100000010020006804", "hex");

type Image = { status?: number; type?: string; body?: BodyInit; location?: string; length?: string };

/** Enable Banking's API plus the logo hosts; nothing leaves the process. */
function fakeNetwork() {
  const calls: string[] = [];
  const banks: { name: string; logo: string | null }[] = [{ name: "DKB", logo: DKB_LOGO }];
  const images = new Map<string, Image>([[DKB_LOGO, { type: "image/png", body: PNG }]]);
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname === "api.enablebanking.com") {
      if (url.pathname === "/application")
        return Response.json({ name: "Saldo", environment: "PRODUCTION", active: true, redirect_urls: [] });
      if (url.pathname === "/aspsps") return Response.json({ aspsps: banks.map((b) => ({ ...b, country: "DE" })) });
      return new Response("{}", { status: 404 });
    }
    expect(init.redirect).toBe("manual");
    const image = images.get(url.href);
    if (!image) return new Response("missing", { status: 404 });
    const headers = new Headers();
    if (image.type) headers.set("content-type", image.type);
    if (image.location) headers.set("location", image.location);
    if (image.length) headers.set("content-length", image.length);
    return new Response(image.body ?? null, { status: image.status ?? 200, headers });
  }) as typeof fetch;
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  return { calls, banks, images, fetch: fetchFn, count };
}

describe("bank logos", () => {
  let admin: Viewer;
  let member: Viewer;
  let net: ReturnType<typeof fakeNetwork>;
  let now: Date;

  async function connection(provider: BankProvider, secrets: Record<string, unknown>): Promise<number> {
    const [row] = await db()
      .insert(bankConnections)
      .values({
        name: "Bank",
        provider,
        bank: "bank",
        status: "active",
        ciphertext: encrypt(JSON.stringify(secrets)),
        ownerUserId: admin.id,
      })
      .returning({ id: bankConnections.id });
    return row?.id ?? 0;
  }

  async function linkedAccount(connectionId: number): Promise<number> {
    const [row] = await db()
      .insert(accounts)
      .values({ name: "Girokonto", bank: "dkb", kind: "checking", connectionId, ownerUserId: admin.id })
      .returning({ id: accounts.id });
    return row?.id ?? 0;
  }

  const dkb = () => connection("enable_banking", { bankName: "DKB", country: "DE", sessionId: "s" });
  const tradeRepublic = () => connection("trade_republic", { phone: "+4915112345678", pin: "1234", deviceId: "d", session: null });
  const givve = () => connection("givve", { email: "ich@example.org", password: "x", session: null });
  const page = (html: string): Image => ({ type: "text/html; charset=utf-8", body: html });

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    member = await makeUser("kind", "member");
    net = fakeNetwork();
    now = new Date("2026-11-15T12:00:00Z");
    banking.setBankingDepsForTests({ fetch: net.fetch, now: () => now });
    await banking.saveEnableBankingSettings(db(), admin, { appId: APP_ID, privateKey: PEM });
  });

  afterEach(() => {
    banking.setBankingDepsForTests({});
  });

  it("serves the logo of a connection and caches it", async () => {
    const id = await dkb();
    const logo = await banking.connectionLogo(db(), admin, { id });
    expect(logo).toEqual({ contentType: "image/png", data: PNG });
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual(logo);
    expect(net.count(DKB_LOGO)).toBe(1);
    expect(net.count("https://api.enablebanking.com/aspsps")).toBe(1);
    const [row] = await db()
      .select()
      .from(settings)
      .where(eq(settings.key, logoCacheKey("DE", "DKB")));
    expect(row?.value).toMatchObject({ contentType: "image/png", data: PNG.toString("base64"), fetchedAt: now.toISOString() });
  });

  it("refreshes a logo after 30 days and keeps the old one when the refresh fails", async () => {
    const id = await dkb();
    await banking.connectionLogo(db(), admin, { id });
    now = new Date("2026-12-20T12:00:00Z");
    net.images.set(DKB_LOGO, { status: 500 });
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/png", data: PNG });
    expect(net.count(DKB_LOGO)).toBe(2);
    // The failed refresh is not repeated within a day.
    await banking.connectionLogo(db(), admin, { id });
    expect(net.count(DKB_LOGO)).toBe(2);
  });

  it("shows a member only the logos of connections behind an account they can see", async () => {
    const id = await dkb();
    await expect(banking.connectionLogo(db(), member, { id })).rejects.toBeInstanceOf(NotFound);
    const accountId = await linkedAccount(id);
    await expect(banking.connectionLogo(db(), member, { id })).rejects.toBeInstanceOf(NotFound);
    const group = await createGroup(db(), admin, { name: "Familie", accountIds: [accountId] });
    const allowed = await makeUser("partner", "member", [group]);
    expect(await banking.connectionLogo(db(), allowed, { id })).toMatchObject({ contentType: "image/png" });
    await expect(banking.connectionLogo(db(), admin, { id: 9999 })).rejects.toBeInstanceOf(NotFound);
  });

  it("has no logo for FinTS connections", async () => {
    const id = await connection("fints", { blz: "12030000", server: "https://fints.example", login: "x", pin: "y" });
    expect(await banking.connectionLogo(db(), admin, { id })).toBeNull();
    expect(net.count("https://api.enablebanking.com/aspsps")).toBe(0);
  });

  it("rejects logos from other hosts and remembers the miss for a day", async () => {
    net.banks[0] = { name: "DKB", logo: "https://evil.example/dkb.png" };
    const id = await dkb();
    expect(await banking.connectionLogo(db(), admin, { id })).toBeNull();
    expect(await banking.connectionLogo(db(), admin, { id })).toBeNull();
    expect(net.count("https://evil.example")).toBe(0);
    expect(net.count("https://api.enablebanking.com/aspsps")).toBe(1);
    now = new Date("2026-11-16T13:00:00Z");
    await banking.connectionLogo(db(), admin, { id });
    expect(net.count("https://api.enablebanking.com/aspsps")).toBe(2);
  });

  it("checks the address, type, size and redirects of a logo", async () => {
    const at = (path: string, image: Image) => {
      net.images.set(`https://enablebanking.com/${path}`, image);
      return fetchLogo(`https://enablebanking.com/${path}`, net.fetch);
    };
    expect(await fetchLogo("http://enablebanking.com/a.png", net.fetch)).toBeNull();
    expect(await fetchLogo("https://enablebanking.com.evil.example/a.png", net.fetch)).toBeNull();
    expect(await fetchLogo("https://user@enablebanking.com/a.png", net.fetch)).toBeNull();
    expect(await at("html", { type: "text/html", body: "<html></html>" })).toBeNull();
    expect(await at("svg", { type: "image/svg+xml; charset=utf-8", body: "<svg/>" })).toMatchObject({ contentType: "image/svg+xml" });
    expect(await at("big", { type: "image/png", body: new Uint8Array(300 * 1024) })).toBeNull();
    expect(await at("claims-big", { type: "image/png", body: PNG, length: String(300 * 1024) })).toBeNull();
    expect(await at("away", { status: 302, location: "https://cdn.example/a.png" })).toBeNull();
    net.images.set("https://cdn.enablebanking.com/a.png", { type: "image/webp", body: PNG });
    expect(await at("cdn", { status: 301, location: "https://cdn.enablebanking.com/a.png" })).toMatchObject({ contentType: "image/webp" });
    expect(net.count("https://cdn.example")).toBe(0);
  });

  it("looks up logos by name for everyone who may connect a bank, only for listed banks", async () => {
    expect(await banking.enableBankingLogo(db(), member, { country: "DE", name: "DKB" })).toMatchObject({ contentType: "image/png" });
    expect(await banking.enableBankingLogo(db(), admin, { country: "de", name: "DKB" })).toMatchObject({ contentType: "image/png" });
    expect(await banking.enableBankingLogo(db(), admin, { country: "DE", name: "Unbekannt" })).toBeNull();
    const [unknown] = await db()
      .select()
      .from(settings)
      .where(eq(settings.key, logoCacheKey("DE", "Unbekannt")));
    expect(unknown).toBeUndefined();
  });

  it("answers with headers that keep the image inert", () => {
    const response = banking.bankLogoResponse({ contentType: "image/svg+xml", data: Buffer.from("<svg/>") });
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/svg+xml",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    expect(banking.noBankLogoResponse(404).status).toBe(404);
  });

  it("gives Trade Republic the logo from Enable Banking's list when Enable Banking is set up", async () => {
    net.banks.push({ name: "Trade Republic", logo: TR_LOGO });
    net.images.set(TR_LOGO, { type: "image/png", body: PNG });
    const id = await tradeRepublic();
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/png", data: PNG });
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/png", data: PNG });
    expect(net.count(TR_LOGO)).toBe(1);
    expect(net.count("https://traderepublic.com")).toBe(0);
    const [row] = await db()
      .select()
      .from(settings)
      .where(eq(settings.key, logoCacheKey("DE", "Trade Republic")));
    expect(row?.value).toMatchObject({ contentType: "image/png" });
  });

  it("falls back to Trade Republic's own site icon without Enable Banking", async () => {
    await db().delete(settings);
    net.images.set("https://traderepublic.com/favicon.ico", { type: "image/vnd.microsoft.icon", body: ICO });
    const id = await tradeRepublic();
    const setup = net.calls.length;
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/vnd.microsoft.icon", data: ICO });
    expect(net.calls.slice(setup).filter((c) => c.startsWith("https://api.enablebanking.com"))).toEqual([]);
    expect(net.calls.filter((c) => c.startsWith("https://traderepublic.com"))).toEqual([
      "https://traderepublic.com/apple-touch-icon.png",
      "https://traderepublic.com/",
      "https://traderepublic.com/favicon.ico",
    ]);
  });

  it("finds givve's icon on its start page, following redirects on its own hosts, and caches it", async () => {
    net.images.set("https://givve.com/", { status: 307, location: "/de/" });
    net.images.set(
      "https://givve.com/de/",
      page(`<html><head>
        <link rel="mask-icon" href="/icons/pinned.svg">
        <link href="/icons/favicon-32.png?1" rel="icon" sizes="32x32">
        <link rel='apple-touch-icon' href='/icons/apple-touch-icon.png?17&amp;v=2'>
      </head><body>${"x".repeat(400 * 1024)}</body></html>`),
    );
    net.images.set("https://givve.com/icons/apple-touch-icon.png?17&v=2", { type: "image/png", body: PNG });
    const id = await givve();
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/png", data: PNG });
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/png", data: PNG });
    expect(net.count("https://givve.com/icons/")).toBe(1);
    expect(net.count("https://givve.com/favicon.ico")).toBe(0);
    const [row] = await db()
      .select()
      .from(settings)
      .where(eq(settings.key, siteIconCacheKey(SITES.givve)));
    expect(row?.value).toMatchObject({ contentType: "image/png", fetchedAt: now.toISOString() });
  });

  it("loads a site icon once for requests that arrive together", async () => {
    net.images.set("https://givve.com/apple-touch-icon.png", { type: "image/png", body: PNG });
    const id = await givve();
    const logos = await Promise.all([1, 2, 3].map(() => banking.connectionLogo(db(), admin, { id })));
    expect(logos.every((logo) => logo?.contentType === "image/png")).toBe(true);
    expect(net.count("https://givve.com/apple-touch-icon.png")).toBe(1);
  });

  it("fetches site icons only from the provider's own hosts", async () => {
    net.images.set("https://givve.com/apple-touch-icon.png", { status: 302, location: "https://cdn.example/touch.png" });
    net.images.set(
      "https://givve.com/",
      page(`<link rel="icon" href="https://givve.com.evil.example/a.png"><link rel="icon" href="//cdn.example/b.png">
        <link rel="icon" href="http://givve.com/c.png">`),
    );
    net.images.set("https://givve.com/favicon.ico", { type: "image/x-icon", body: ICO });
    const id = await givve();
    const setup = net.calls.length;
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/x-icon", data: ICO });
    expect(net.calls.slice(setup).filter((c) => !c.startsWith("https://givve.com/"))).toEqual([]);
    expect(declaredIcons('<link rel="shortcut icon" href="favicon.ico">', new URL("https://www.givve.com/de/"))).toEqual([
      "https://www.givve.com/de/favicon.ico",
    ]);
  });

  it("rejects site icons that are too big or no image, and remembers the miss for a day", async () => {
    net.images.set("https://givve.com/apple-touch-icon.png", { type: "image/png", body: new Uint8Array(300 * 1024) });
    net.images.set("https://givve.com/", page('<link rel="apple-touch-icon" href="/touch.png">'));
    net.images.set("https://givve.com/touch.png", { type: "text/html", body: "<html></html>" });
    net.images.set("https://givve.com/favicon.ico", { type: "image/x-icon", body: ICO, length: String(300 * 1024) });
    const id = await givve();
    expect(await banking.connectionLogo(db(), admin, { id })).toBeNull();
    expect(await banking.connectionLogo(db(), admin, { id })).toBeNull();
    expect(net.count("https://givve.com/favicon.ico")).toBe(1);
    now = new Date("2026-11-16T13:00:00Z");
    net.images.set("https://givve.com/favicon.ico", { type: "image/x-icon", body: ICO });
    expect(await banking.connectionLogo(db(), admin, { id })).toEqual({ contentType: "image/x-icon", data: ICO });
  });

  it("shows the logo of an unofficial connection only to those who see one of its accounts", async () => {
    net.images.set("https://givve.com/apple-touch-icon.png", { type: "image/png", body: PNG });
    const id = await givve();
    await expect(banking.connectionLogo(db(), member, { id })).rejects.toBeInstanceOf(NotFound);
    expect(net.count("https://givve.com")).toBe(0);
    const group = await createGroup(db(), admin, { name: "Familie", accountIds: [await linkedAccount(id)] });
    const allowed = await makeUser("partner", "member", [group]);
    expect(await banking.connectionLogo(db(), allowed, { id })).toMatchObject({ contentType: "image/png" });
  });
});
