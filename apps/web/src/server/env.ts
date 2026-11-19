import { z } from "zod";
import { parseTrustedProxy } from "./client-ip.ts";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Public address the browser and the bank redirect use, e.g. https://192.168.1.10:8445
  APP_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET muss mindestens 32 Zeichen lang sein"),
  ENCRYPTION_KEY: z.string().refine((key) => Buffer.from(key, "base64").length === 32, "ENCRYPTION_KEY muss 32 Byte (Base64) sein"),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().optional(),
  ENABLE_BANKING_API_URL: z.url().default("https://api.enablebanking.com"),
  // Only automated test runs point this at a stand-in.
  GIVVE_API_URL: z.url().default("https://www.givve.com/api"),
  // "off" stops scheduled syncs, summaries and reminders (tests, development).
  SALDO_SCHEDULER: z.enum(["on", "off"]).default("on"),
  // Whom X-Forwarded-For is believed from (server/client-ip.ts): "off" (default, the socket address counts), "on" or a
  // hop count for proxies in front of Saldo, or the proxies' addresses and CIDR ranges, comma-separated.
  TRUSTED_PROXY: z
    .string()
    .trim()
    .default("off")
    .refine((value) => parseTrustedProxy(value) !== null, "TRUSTED_PROXY: off, on, 1-10 or IP addresses/CIDR ranges"),
  // Sign-in attempts per address and 15 minutes; only automated test runs raise it.
  SIGN_IN_LIMIT: z.coerce.number().int().min(1).max(10_000).default(10),
  // Public address of the household sent to banks as Psu-Ip-Address when the browser's address is a private one.
  PSU_IP_ADDRESS: z.string().trim().default(""),
  PSU_IP_LOOKUP: z.enum(["on", "off"]).default("on"),
  // Audit log entries older than this are deleted by the daily scheduler run.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(365),
  // Local backup folder (compose mounts ./backups here): the "local" target, safety copies before a restore, spool files.
  BACKUP_DIR: z.string().trim().min(1).default("/backups"),
  // Recorded in backup manifests; the Containerfile sets it from its GIT_SHA build argument.
  SALDO_GIT_SHA: z.string().trim().max(64).default(""),
  // Further addresses Saldo is opened at (comma-separated), e.g. a host name next to the IP.
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

/** APP_URL plus extra origins; on a loopback address both spellings work, since browsers treat them as different sites. */
export function trustedOrigins(): string[] {
  const { APP_URL, TRUSTED_ORIGINS } = env();
  const origins = new Set([new URL(APP_URL).origin, ...TRUSTED_ORIGINS]);
  const url = new URL(APP_URL);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    for (const host of ["localhost", "127.0.0.1"]) origins.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
  }
  return [...origins];
}

export function bankRedirectUrl(): string {
  return `${env().APP_URL}/bank/callback`;
}
