import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { sendNotification } from "web-push";

export type MailTransport = { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushOptions = {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  timeout: number;
};

type NotificationDeps = {
  createTransport: (options: SMTPTransport.Options) => MailTransport;
  sendPush: (target: PushTarget, payload: string, options: PushOptions) => Promise<unknown>;
  now: () => Date;
};

const defaultDeps: NotificationDeps = {
  createTransport: (options) => nodemailer.createTransport(options),
  sendPush: (target, payload, options) => sendNotification(target, payload, options),
  now: () => new Date(),
};

// Replaced in tests; mail and push never leave the process there.
export let deps: NotificationDeps = defaultDeps;

export function setNotificationDepsForTests(overrides: Partial<NotificationDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** Only the error class, never its message: driver and network messages can carry addresses or content. */
export function logFailure(what: string, error: unknown): void {
  console.error(`${what} failed: ${error instanceof Error ? error.name : typeof error}`);
}
