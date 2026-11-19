/** Outgoing mail over the SMTP server the admin configured; the password lives encrypted in `settings.ciphertext`. */
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";
import { msg, t } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE, type Locale } from "../../../i18n/locales.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import { UserError } from "../../errors.ts";
import { requireSuperuser, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import { deps, logFailure } from "./deps.ts";
import { readSetting, writeSetting } from "./settings.ts";

const SMTP_KEY = "smtp";

export type SmtpSecurity = "none" | "starttls" | "tls";

type SmtpValue = { host: string; port: number; security: SmtpSecurity; username: string; fromAddress: string; fromName: string };

export type MailSettings = (SmtpValue & { passwordSet: boolean }) | null;

export const mailTimeouts = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 20_000 };

async function storedSmtp(db: Db): Promise<{ value: SmtpValue; password: string | null } | null> {
  const row = await readSetting(db, SMTP_KEY);
  if (!row?.value) return null;
  return { value: row.value as SmtpValue, password: row.ciphertext ? decrypt(row.ciphertext) : null };
}

export async function getMailSettings(db: Db, viewer: Viewer): Promise<MailSettings> {
  requireSuperuser(viewer);
  const stored = await storedSmtp(db);
  return stored ? { ...stored.value, passwordSet: stored.password !== null } : null;
}

export async function mailConfigured(db: Db): Promise<boolean> {
  return (await readSetting(db, SMTP_KEY))?.value != null;
}

export const mailSettingsInput = z.object({
  host: z
    .string()
    .trim()
    .min(1, "notifications.errors.smtpHostRequired")
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, "notifications.errors.smtpHostFormat"),
  port: z
    .number()
    .int("notifications.errors.smtpPortInteger")
    .min(1, "notifications.errors.smtpPortRange")
    .max(65535, "notifications.errors.smtpPortRange"),
  security: z.enum(["none", "starttls", "tls"]),
  username: z.string().trim().max(255).default(""),
  // Empty keeps the stored password; without a user name it is removed.
  password: z.string().max(500).optional(),
  fromAddress: z.email("notifications.errors.validSender").max(255),
  fromName: z.string().trim().max(100).default(""),
});

export async function saveMailSettings(db: Db, viewer: Viewer, input: z.input<typeof mailSettingsInput>): Promise<MailSettings> {
  requireSuperuser(viewer);
  const { password, ...value } = mailSettingsInput.parse(input);
  const previous = await storedSmtp(db);
  // The stored password only ever goes to the server and login it was entered for.
  const sameLogin =
    previous !== null &&
    previous.value.host === value.host &&
    previous.value.port === value.port &&
    previous.value.security === value.security &&
    previous.value.username === value.username;
  if (value.username && !password && previous?.password && !sameLogin) {
    throw new UserError(msg("notifications.errors.smtpReenterPassword"));
  }
  const secret = value.username ? password || (sameLogin ? previous?.password : null) || null : null;
  await writeSetting(db, SMTP_KEY, value, secret ? encrypt(secret) : null);
  await record(db, {
    action: "settings.smtpChanged",
    actor: viewer,
    details: { host: value.host, port: value.port, security: value.security, passwordChanged: Boolean(value.username && password) },
  });
  return getMailSettings(db, viewer);
}

function transportOptions(value: SmtpValue, password: string | null): SMTPTransport.Options {
  return {
    host: value.host.replace(/^\[|\]$/g, ""),
    port: value.port,
    secure: value.security === "tls",
    requireTLS: value.security === "starttls",
    ignoreTLS: value.security === "none",
    auth: value.username ? { user: value.username, pass: password ?? "" } : undefined,
    connectionTimeout: mailTimeouts.connectionMs,
    greetingTimeout: mailTimeouts.greetingMs,
    socketTimeout: mailTimeouts.socketMs,
  };
}

function sender(value: SmtpValue): string {
  const name = value.fromName.replace(/["\\\r\n]/g, "");
  return name ? `"${name}" <${value.fromAddress}>` : value.fromAddress;
}

async function send(db: Db, to: string, subject: string, text: string): Promise<void> {
  const stored = await storedSmtp(db);
  if (!stored) throw new Error("not configured");
  await deps.createTransport(transportOptions(stored.value, stored.password)).sendMail({ from: sender(stored.value), to, subject, text });
}

/** Notification mail; failures are logged without content and never thrown. */
export async function sendNotificationMail(db: Db, to: string, subject: string, text: string): Promise<boolean> {
  try {
    await send(db, to, subject, text);
    return true;
  } catch (error) {
    logFailure("Notification mail", error);
    return false;
  }
}

export const testMailInput = z.object({ to: z.email("notifications.errors.validEmail").max(255) });

export type TestMailResult = { ok: boolean; message: string };

function describeMailError(error: unknown, locale: Locale): string {
  if (!(error instanceof Error)) return t(locale, "notifications.mail.unknownError");
  const code = (error as Error & { code?: unknown }).code;
  const text = error.message.replace(/\s+/g, " ").trim().slice(0, 400);
  return typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
}

/** Sends a test mail with the stored settings and reports the server's answer as is (admins only), in the admin's language. */
export async function sendTestMail(db: Db, viewer: Viewer, input: z.input<typeof testMailInput>): Promise<TestMailResult> {
  requireSuperuser(viewer);
  const { to } = testMailInput.parse(input);
  const locale = viewer.locale ?? DEFAULT_LOCALE;
  if (!(await mailConfigured(db))) return { ok: false, message: t(locale, "notifications.mail.testNotConfigured") };
  try {
    await send(db, to, t(locale, "notifications.mail.testSubject"), t(locale, "notifications.mail.testBody"));
    await record(db, { action: "settings.testMail", actor: viewer });
    return { ok: true, message: t(locale, "notifications.mail.testSent", { to }) };
  } catch (error) {
    await record(db, { action: "settings.testMail", actor: viewer, outcome: "failed" });
    return { ok: false, message: t(locale, "notifications.mail.testFailed", { reason: describeMailError(error, locale) }) };
  }
}
