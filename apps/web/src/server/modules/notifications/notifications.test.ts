import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import {
  accounts,
  bankConnections,
  type NotificationKind,
  notifications,
  pushSubscriptions,
  settings,
  transactions,
  user,
} from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createAccount, createGroup } from "../accounts/index.ts";
import { deleteUser, resetPassword } from "../users/index.ts";
import * as n from "./index.ts";

type Mail = { from: string; to: string; subject: string; text: string };
type Push = { endpoint: string; payload: { title: string; body: string; link: string | null } };

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

function fakes() {
  const mails: Mail[] = [];
  const pushes: Push[] = [];
  const state = { mailError: null as Error | null, pushStatus: null as number | null, smtpOptions: [] as unknown[] };
  n.setNotificationDepsForTests({
    createTransport: (options) => {
      state.smtpOptions.push(options);
      return {
        async sendMail(message) {
          if (state.mailError) throw state.mailError;
          mails.push(message);
        },
      };
    },
    sendPush: async (target, payload) => {
      if (state.pushStatus) throw Object.assign(new Error("Received unexpected response code"), { statusCode: state.pushStatus });
      pushes.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
    },
  });
  return { mails, pushes, state };
}

const SMTP = {
  host: "mail.example.org",
  port: 587,
  security: "starttls" as const,
  username: "saldo",
  fromAddress: "saldo@example.org",
  fromName: "Saldo",
};

describe("notifications", () => {
  let admin: Viewer;
  let member: Viewer;
  let shared: number;
  let hidden: number;
  let f: ReturnType<typeof fakes>;

  beforeEach(async () => {
    await resetDb();
    f = fakes();
    admin = await makeUser("admin", "superuser");
    const group = await createGroup(db(), admin, { name: "Kinder" });
    member = await makeUser("kind", "member", [group]);
    shared = await createAccount(db(), admin, { name: "Taschengeld", bank: "dkb", kind: "checking", color: "#1f6f5c", groupIds: [group] });
    hidden = await createAccount(db(), admin, { name: "Eltern Giro", bank: "dkb", kind: "checking", color: "#1f6f5c" });
  });

  afterEach(() => n.setNotificationDepsForTests({}));

  async function enable(
    viewer: Viewer,
    kind: NotificationKind,
    extra: { push?: boolean; email?: boolean; threshold?: number | null } = {},
  ) {
    await n.savePreferences(db(), viewer, {
      preferences: [{ kind, enabled: true, push: extra.push ?? false, email: extra.email ?? false, threshold: extra.threshold ?? null }],
    });
  }

  async function book(
    accountId: number,
    amountCents: number,
    counterparty: string,
    bookingDate = "2026-11-14",
    extra: Partial<typeof transactions.$inferInsert> = {},
  ) {
    const [row] = await db()
      .insert(transactions)
      .values({ accountId, externalId: `x-${Math.random()}`, source: "test", bookingDate, amountCents, counterparty, ...extra })
      .returning({ id: transactions.id });
    return row?.id ?? -1;
  }

  // Amounts come with a non-breaking space before the euro sign.
  const plain = (text: string) => text.replace(/\u00a0/g, " ");
  const inbox = async (viewer: Viewer) =>
    (await n.listNotifications(db(), viewer)).items.map((i) => ({ ...i, title: plain(i.title), body: plain(i.body) }));

  it("keeps preferences per user and defaults everything to off", async () => {
    await enable(admin, "large_expense", { push: true, threshold: 20_000 });
    // Reading the settings never creates the VAPID key pair; startup does.
    expect((await n.getNotificationSettings(db(), admin)).pushPublicKey).toBeNull();
    await n.ensureVapidKeys(db());
    const mine = await n.getNotificationSettings(db(), admin);
    expect(mine.preferences.find((p) => p.kind === "large_expense")).toEqual({
      kind: "large_expense",
      enabled: true,
      push: true,
      email: false,
      threshold: 20_000,
    });
    expect(mine.pushPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const theirs = await n.getNotificationSettings(db(), member);
    expect(theirs.preferences.find((p) => p.kind === "large_expense")).toMatchObject({ enabled: false, threshold: 50_000 });
    // Members may own bank connections, so they can hear about their problems, too.
    expect(theirs.preferences.map((p) => p.kind)).toContain("bank_problem");
    await expect(enable(admin, "price_change", { threshold: 0 })).rejects.toMatchObject({ status: 400 });
    // The VAPID key pair is created once; the private half stays encrypted.
    await n.ensureVapidKeys(db());
    expect((await n.getNotificationSettings(db(), member)).pushPublicKey).toBe(mine.pushPublicKey);
    const [vapid] = await db().select().from(settings).where(eq(settings.key, "web_push_vapid"));
    expect(vapid?.value).toEqual({ publicKey: mine.pushPublicKey });
  });

  it("validates the contact address and keeps the login email untouched", async () => {
    await expect(n.saveContactEmail(db(), member, { notifyEmail: "kein-mail" })).rejects.toThrow();
    await n.saveContactEmail(db(), member, { notifyEmail: "kind@example.org" });
    expect((await n.getNotificationSettings(db(), member)).notifyEmail).toBe("kind@example.org");
    await n.saveContactEmail(db(), member, { notifyEmail: "" });
    expect((await n.getNotificationSettings(db(), member)).notifyEmail).toBeNull();
  });

  it("reports new bookings once per sync and only for accounts the member can see", async () => {
    await enable(admin, "new_bookings");
    await enable(member, "new_bookings");
    const ids = [await book(shared, -450, "Kiosk"), await book(hidden, -99_000, "Autohaus"), await book(hidden, 250_000, "Arbeitgeber")];
    await n.notifyAfterSync(db(), { jobId: "job-1", transactionIds: ids });
    await n.notifyAfterSync(db(), { jobId: "job-1", transactionIds: ids });
    const [forMember, ...more] = await inbox(member);
    expect(more).toEqual([]);
    expect(forMember).toMatchObject({ kind: "new_bookings", title: "1 neue Buchung", link: "/buchungen?neu=true", read: false });
    expect(forMember?.body).toContain("Kiosk");
    expect(forMember?.body).not.toContain("Autohaus");
    expect((await inbox(admin))[0]).toMatchObject({ title: "3 neue Buchungen" });

    await n.notifyAfterSync(db(), { jobId: "job-2", transactionIds: [ids[1] ?? -1] });
    expect(await inbox(member)).toHaveLength(1);
    expect(await inbox(admin)).toHaveLength(2);
  });

  it("flags a large expense once, but not internal transfers or smaller amounts", async () => {
    await enable(admin, "large_expense", { threshold: 10_000 });
    await enable(member, "large_expense", { threshold: 10_000 });
    const big = await book(hidden, -15_000, "Möbelhaus");
    const small = await book(hidden, -5_000, "Bäcker");
    const move = await book(hidden, -20_000, "Ich selbst", "2026-11-14", { isTransfer: true, transferAccountId: shared });
    await n.notifyAfterSync(db(), { jobId: "a", transactionIds: [big, small, move] });
    await n.notifyAfterSync(db(), { jobId: "b", transactionIds: [big] });
    const items = await inbox(admin);
    expect(items.map((i) => i.title)).toEqual(["Große Ausgabe: 150,00 €"]);
    expect(items[0]?.body).toBe("Möbelhaus am 14.11.2026 (Eltern Giro)");
    expect(await inbox(member)).toEqual([]);
  });

  it("warns once per account when the balance falls below the limit and again after it recovered", async () => {
    await enable(member, "low_balance", { threshold: 10_000 });
    const setBalance = (id: number, cents: number) =>
      db().update(accounts).set({ balanceCents: cents, balanceDate: "2026-11-14" }).where(eq(accounts.id, id));
    await setBalance(shared, 5_000);
    await setBalance(hidden, -1_000);
    await n.checkBalances(db());
    await n.checkBalances(db());
    expect((await inbox(member)).map((i) => i.title)).toEqual(["Niedriger Kontostand: Taschengeld"]);
    await setBalance(shared, 20_000);
    await n.checkBalances(db());
    await setBalance(shared, 3_000);
    await n.checkBalances(db());
    expect(await inbox(member)).toHaveLength(2);
  });

  it("detects a price change of a recurring payment once", async () => {
    await enable(admin, "price_change", { threshold: 5 });
    for (const day of ["2026-08-03", "2026-09-03", "2026-10-03"]) await book(hidden, -1_299, "Netflix", day);
    const raised = await book(hidden, -1_499, "Netflix", "2026-11-03");
    const steady = await book(hidden, -1_299, "Netflix", "2026-11-04");
    await n.notifyAfterSync(db(), { jobId: "a", transactionIds: [raised, steady] });
    await n.notifyAfterSync(db(), { jobId: "b", transactionIds: [raised] });
    const items = await inbox(admin);
    expect(items.map((i) => i.title)).toEqual(["Netflix ist teurer geworden"]);
    expect(items[0]?.body).toContain("Bisher 12,99 €, jetzt 14,99 € (+15 %)");
  });

  it("sends weekly reminders and summaries on Monday, the monthly summary on the 1st, each once", async () => {
    await enable(member, "uncategorized", { threshold: 2 });
    await enable(member, "weekly_summary");
    await enable(member, "monthly_summary");
    await enable(admin, "uncategorized", { threshold: 1 });
    await enable(admin, "monthly_summary");
    await book(shared, 3_000, "Oma", "2026-11-10");
    await book(shared, -1_200, "Kino", "2026-11-12");
    for (const day of ["2026-10-02", "2026-10-03", "2026-10-04"]) await book(hidden, -500, "Kantine", day);
    const monday = new Date(2026, 10, 16, 8, 0);
    await n.runDailyChecks(db(), monday);
    await n.runDailyChecks(db(), monday);
    const mine = await inbox(member);
    expect(mine.map((i) => i.kind).sort()).toEqual(["weekly_summary"]);
    expect(mine[0]).toMatchObject({ title: "Wochenrückblick 09.11.–15.11.", link: "/buchungen?von=2026-11-09&bis=2026-11-15" });
    expect(mine[0]?.body).toContain("Einnahmen 30,00 € · Ausgaben 12,00 €");
    expect((await inbox(admin)).map((i) => i.title)).toEqual(["5 Buchungen ohne Kategorie"]);

    await n.runDailyChecks(db(), new Date(2026, 10, 1, 8, 0));
    expect((await inbox(member)).filter((i) => i.kind === "monthly_summary")).toEqual([]);
    const [monthly] = (await inbox(admin)).filter((i) => i.kind === "monthly_summary");
    expect(monthly).toMatchObject({ title: "Monatsrückblick Oktober 2026", link: "/analyse?zeitraum=last_month" });
    expect(monthly?.body).toContain("Ausgaben 15,00 €");
  });

  it("tells admins about expiring and expired consents, once per consent", async () => {
    await enable(admin, "bank_problem", { threshold: 14 });
    const now = new Date();
    const inDays = (d: number) => new Date(now.getTime() + d * 24 * 3600_000);
    await db()
      .insert(bankConnections)
      .values([
        {
          name: "DKB",
          provider: "enable_banking",
          bank: "dkb",
          status: "active",
          ciphertext: "x",
          consentValidUntil: inDays(5),
          ownerUserId: admin.id,
        },
        {
          name: "Sparkasse",
          provider: "enable_banking",
          bank: "spk",
          status: "active",
          ciphertext: "x",
          consentValidUntil: inDays(60),
          ownerUserId: admin.id,
        },
        {
          name: "Comdirect",
          provider: "enable_banking",
          bank: "cd",
          status: "needs_reauth",
          ciphertext: "x",
          consentValidUntil: inDays(-1),
          ownerUserId: admin.id,
        },
      ]);
    await n.runDailyChecks(db(), now);
    await n.runDailyChecks(db(), now);
    expect((await inbox(admin)).map((i) => i.title).sort()).toEqual(["Comdirect: Freigabe abgelaufen", "DKB: Freigabe läuft bald ab"]);
    expect(await inbox(member)).toEqual([]);
  });

  it("sends push and mail on the enabled channels and keeps the in-app list per user", async () => {
    await n.saveMailSettings(db(), admin, { ...SMTP, password: "smtp-geheim" });
    await n.saveContactEmail(db(), member, { notifyEmail: "kind@example.org" });
    await n.savePushSubscription(db(), member, { endpoint: ENDPOINT, keys: KEYS }, "Firefox");
    await enable(member, "new_bookings", { push: true, email: true });
    const id = await book(shared, -450, "Kiosk");
    await n.notifyAfterSync(db(), { jobId: "j", transactionIds: [id] });
    expect(f.pushes).toEqual([
      { endpoint: ENDPOINT, payload: expect.objectContaining({ title: "1 neue Buchung", link: "/buchungen?neu=true" }) },
    ]);
    expect(f.mails).toEqual([
      expect.objectContaining({
        to: "kind@example.org",
        from: '"Saldo" <saldo@example.org>',
        subject: "Saldo: 1 neue Buchung",
        text: expect.stringContaining("https://saldo.test/buchungen?neu=true"),
      }),
    ]);
    const [item] = await inbox(member);
    expect((await n.listNotifications(db(), member)).unread).toBe(1);
    await expect(n.markNotificationRead(db(), admin, { id: item?.id ?? -1 })).rejects.toMatchObject({ status: 404 });
    await n.markNotificationRead(db(), member, { id: item?.id ?? -1 });
    expect((await n.listNotifications(db(), member)).unread).toBe(0);
  });

  it("renders list entry, mail and push in the recipient's language", async () => {
    await db().update(user).set({ locale: "en" }).where(eq(user.id, member.id));
    await n.saveMailSettings(db(), admin, { ...SMTP, password: "smtp-geheim" });
    await n.saveContactEmail(db(), member, { notifyEmail: "kind@example.org" });
    await n.savePushSubscription(db(), member, { endpoint: ENDPOINT, keys: KEYS });
    await enable(member, "large_expense", { push: true, email: true, threshold: 10_000 });
    await enable(admin, "large_expense", { threshold: 10_000 });
    const id = await book(shared, -123_456, "Furniture shop");
    await n.notifyAfterSync(db(), { jobId: "j", transactionIds: [id] });

    const [item] = await inbox(member);
    expect(item).toMatchObject({ title: "Large expense: €1,234.56", body: "Furniture shop on 14/11/2026 (Taschengeld)" });
    expect(f.mails).toEqual([
      expect.objectContaining({
        subject: "Saldo: Large expense: €1,234.56",
        text: expect.stringContaining("Furniture shop on 14/11/2026"),
      }),
    ]);
    expect(f.pushes[0]?.payload).toMatchObject({ title: "Large expense: €1,234.56" });
    expect((await inbox(admin))[0]?.title).toBe("Große Ausgabe: 1.234,56 €");

    const test = await n.sendTestNotification(db(), { ...member, locale: "en" });
    expect(test).toEqual({ push: "Sent to 1 of 1 device.", email: "Email sent to kind@example.org." });
    expect((await inbox(member))[0]).toMatchObject({ title: "Test notification" });
  });

  it("deletes push subscriptions the push service reports as gone and keeps them on other errors", async () => {
    await n.savePushSubscription(db(), member, { endpoint: ENDPOINT, keys: KEYS });
    await expect(n.savePushSubscription(db(), member, { endpoint: "https://intranet.local/push", keys: KEYS })).rejects.toThrow();
    f.state.pushStatus = 500;
    expect((await n.sendTestNotification(db(), member)).push).toBe("An 0 von 1 Geräten gesendet.");
    expect(await db().select().from(pushSubscriptions)).toHaveLength(1);
    f.state.pushStatus = 410;
    expect((await n.sendTestNotification(db(), member)).push).toContain("1 abgelaufene Anmeldung entfernt");
    expect(await db().select().from(pushSubscriptions)).toEqual([]);
    expect(await db().select().from(notifications)).toHaveLength(2);
  });

  it("forgets a person's browsers when their password is reset or the person is deleted", async () => {
    await n.savePushSubscription(db(), member, { endpoint: ENDPOINT, keys: KEYS });
    await n.savePushSubscription(db(), admin, { endpoint: `${ENDPOINT}-admin`, keys: KEYS });
    await resetPassword(db(), admin, member.id, "new-password-1234");
    expect((await db().select().from(pushSubscriptions)).map((s) => s.userId)).toEqual([admin.id]);
    await n.savePushSubscription(db(), member, { endpoint: ENDPOINT, keys: KEYS });
    await deleteUser(db(), admin, member.id);
    expect((await db().select().from(pushSubscriptions)).map((s) => s.userId)).toEqual([admin.id]);
  });

  describe("SMTP", () => {
    it("asks for the password again when the server or login changes", async () => {
      await n.saveMailSettings(db(), admin, { ...SMTP, password: "smtp-geheim" });
      for (const change of [{ host: "evil.example" }, { port: 2525 }, { security: "none" as const }, { username: "other" }]) {
        await expect(n.saveMailSettings(db(), admin, { ...SMTP, ...change })).rejects.toMatchObject({ status: 400 });
      }
      expect(await n.getMailSettings(db(), admin)).toMatchObject({ host: "mail.example.org", passwordSet: true });
      await n.saveMailSettings(db(), admin, { ...SMTP, fromName: "Haushalt" });
      expect(await n.getMailSettings(db(), admin)).toMatchObject({ fromName: "Haushalt", passwordSet: true });
      await n.saveMailSettings(db(), admin, { ...SMTP, host: "smtp.example.net", password: "neu-geheim" });
      expect(await n.getMailSettings(db(), admin)).toMatchObject({ host: "smtp.example.net", passwordSet: true });
    });

    it("never returns the password and keeps it when saved without one", async () => {
      const saved = await n.saveMailSettings(db(), admin, { ...SMTP, password: "smtp-geheim" });
      expect(saved).toEqual({ ...SMTP, passwordSet: true });
      expect(JSON.stringify(await n.getMailSettings(db(), admin))).not.toContain("smtp-geheim");
      const [row] = await db().select().from(settings).where(eq(settings.key, "smtp"));
      expect(row?.ciphertext).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain("smtp-geheim");

      await n.saveMailSettings(db(), admin, { ...SMTP, fromName: "Haushalt" });
      expect(await n.sendTestMail(db(), admin, { to: "ich@example.org" })).toEqual({
        ok: true,
        message: "Testmail an ich@example.org verschickt.",
      });
      expect(f.state.smtpOptions.at(-1)).toMatchObject({
        host: "mail.example.org",
        port: 587,
        secure: false,
        auth: { user: "saldo", pass: "smtp-geheim" },
        connectionTimeout: n.mailTimeouts.connectionMs,
      });
      await n.saveMailSettings(db(), admin, { ...SMTP, username: "" });
      expect(await n.getMailSettings(db(), admin)).toMatchObject({ passwordSet: false });
    });

    it("surfaces the server's error on a test mail and is admin only", async () => {
      expect((await n.sendTestMail(db(), admin, { to: "ich@example.org" })).ok).toBe(false);
      await n.saveMailSettings(db(), admin, { ...SMTP, password: "falsch" });
      f.state.mailError = Object.assign(new Error("Invalid login: 535 5.7.8 Authentication failed"), { code: "EAUTH" });
      expect(await n.sendTestMail(db(), admin, { to: "ich@example.org" })).toEqual({
        ok: false,
        message: "Versand fehlgeschlagen: EAUTH: Invalid login: 535 5.7.8 Authentication failed",
      });
      await expect(n.getMailSettings(db(), member)).rejects.toMatchObject({ status: 403 });
      await expect(n.saveMailSettings(db(), member, SMTP)).rejects.toMatchObject({ status: 403 });
      await expect(n.sendTestMail(db(), member, { to: "x@example.org" })).rejects.toMatchObject({ status: 403 });
    });
  });
});
