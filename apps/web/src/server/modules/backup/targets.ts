/** Backup targets: validation, storage with encrypted secrets, and the views the settings page gets (without them). */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import {
  type BackupTargetConfig,
  type BackupTargetType,
  FTP_TLS_MODES,
  MAX_KEEP,
  SECRET_FIELDS,
  type SecretField,
  SFTP_AUTH,
  TARGET_SECRETS,
  WEBDAV_VENDORS,
} from "../../../lib/backup.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import { backupTargets } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import type { Target, TargetSecrets } from "./rclone.ts";

const CONTROL = /\p{Cc}/u;
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !CONTROL.test(value), "backup.errors.invalidCharacters");
const required = (max: number, message: string) => line(max).pipe(z.string().min(1, message));
const host = z
  .string()
  .trim()
  .min(1, "backup.errors.hostRequired")
  .max(255)
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, "backup.errors.hostFormat");
const port = z.number().int("backup.errors.portRange").min(1, "backup.errors.portRange").max(65535, "backup.errors.portRange");
const remotePath = line(500).refine((path) => !path.split("/").includes(".."), "backup.errors.pathInvalid");
const localPath = remotePath.refine((path) => !path.startsWith("/") && !path.includes("\\"), "backup.errors.pathRelative");
const bucket = required(255, "backup.errors.bucketRequired").refine((name) => !name.includes("/"), "backup.errors.bucketFormat");
const httpUrl = z
  .url("backup.errors.urlInvalid")
  .max(500)
  .refine((url) => /^https?:\/\//i.test(url), "backup.errors.urlInvalid");
const username = required(255, "backup.errors.usernameRequired");

export const targetConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: localPath.default("") }),
  z.object({
    type: z.literal("sftp"),
    host,
    port: port.default(22),
    username,
    auth: z.enum(SFTP_AUTH),
    path: remotePath.default(""),
    knownHosts: z.string().max(20_000).default(""),
  }),
  z.object({
    type: z.literal("ftp"),
    host,
    port: port.default(21),
    username,
    tls: z.enum(FTP_TLS_MODES),
    skipVerify: z.boolean().default(false),
    path: remotePath.default(""),
  }),
  z.object({
    type: z.literal("smb"),
    host,
    port: port.default(445),
    username,
    domain: line(100).default(""),
    share: required(255, "backup.errors.shareRequired").refine((share) => !/[/\\]/.test(share), "backup.errors.shareFormat"),
    path: remotePath.default(""),
  }),
  z.object({ type: z.literal("b2"), accountId: required(100, "backup.errors.accountRequired"), bucket, path: remotePath.default("") }),
  z.object({
    type: z.literal("s3"),
    endpoint: httpUrl,
    region: line(100).default(""),
    accessKeyId: required(255, "backup.errors.accessKeyRequired"),
    bucket,
    path: remotePath.default(""),
    pathStyle: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("webdav"),
    url: httpUrl,
    vendor: z.enum(WEBDAV_VENDORS),
    username: line(255).default(""),
    skipVerify: z.boolean().default(false),
    path: remotePath.default(""),
  }),
]);

const secret = z.string().max(20_000).optional();

export const targetInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, "backup.errors.nameRequired").max(64),
  keep: z.number().int("backup.errors.keepRange").min(1, "backup.errors.keepRange").max(MAX_KEEP, "backup.errors.keepRange"),
  config: targetConfigSchema,
  /** Empty or missing keeps what is stored for the same server and login. */
  secrets: z.object(Object.fromEntries(SECRET_FIELDS.map((field) => [field, secret])) as Record<SecretField, typeof secret>).default({}),
});

export const targetIdInput = z.object({ id: z.number().int().positive() });

export type TargetRow = typeof backupTargets.$inferSelect;

export type TargetView = {
  id: number;
  name: string;
  type: BackupTargetType;
  config: BackupTargetConfig;
  keep: number;
  /** Which secrets are stored; their values never leave the server. */
  secretsSet: SecretField[];
  updatedAt: string;
};

function secretsOf(row: TargetRow): TargetSecrets {
  return row.ciphertext ? (JSON.parse(decrypt(row.ciphertext)) as TargetSecrets) : {};
}

export function targetOf(row: TargetRow): Target {
  return { config: { ...row.config, type: row.type } as BackupTargetConfig, secrets: secretsOf(row) };
}

export function viewOf(row: TargetRow): TargetView {
  const secrets = secretsOf(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: { ...row.config, type: row.type } as BackupTargetConfig,
    keep: row.keep,
    secretsSet: SECRET_FIELDS.filter((field) => Boolean(secrets[field])),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTargetRows(db: Db): Promise<TargetRow[]> {
  return db.select().from(backupTargets).orderBy(asc(backupTargets.name), asc(backupTargets.id));
}

export async function targetRow(db: Db, id: number): Promise<TargetRow> {
  const [row] = await db.select().from(backupTargets).where(eq(backupTargets.id, id));
  if (!row) throw new NotFound(msg("backup.errors.targetNotFound"));
  return row;
}

/**
 * Where a target's stored secrets may go: every setting except the folder, so a new server, login, TLS mode, skipped
 * certificate check, host key list, endpoint or vendor (anything that could redirect or expose them) needs them again.
 */
export function identity(config: BackupTargetConfig): string {
  const entries = Object.entries(config)
    .filter(([key]) => key !== "path")
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/** The secrets to store: entered ones, else the stored ones for the same identity; a changed identity needs them again. */
export function mergeSecrets(
  config: BackupTargetConfig,
  entered: TargetSecrets,
  previous: { config: BackupTargetConfig; secrets: TargetSecrets } | null,
): TargetSecrets {
  const sameIdentity = previous !== null && identity(previous.config) === identity(config);
  let fields = TARGET_SECRETS[config.type];
  if (config.type === "sftp") fields = config.auth === "password" ? ["password"] : ["privateKey", "privateKeyPassphrase"];
  const merged: TargetSecrets = {};
  for (const field of fields) {
    const typed = entered[field];
    if (typed) merged[field] = typed;
    else if (sameIdentity && previous.secrets[field]) merged[field] = previous.secrets[field];
    else if (previous?.secrets[field] && field !== "privateKeyPassphrase") throw new UserError(msg("backup.errors.reenterSecret"));
  }
  if (config.type === "sftp" && !merged[config.auth === "password" ? "password" : "privateKey"]) {
    throw new UserError(msg(config.auth === "password" ? "backup.errors.passwordRequired" : "backup.errors.keyRequired"));
  }
  if (config.type === "b2" && !merged.applicationKey) throw new UserError(msg("backup.errors.applicationKeyRequired"));
  if (config.type === "s3" && !merged.secretAccessKey) throw new UserError(msg("backup.errors.secretKeyRequired"));
  return merged;
}

export function storedSecrets(secrets: TargetSecrets): string | null {
  return Object.values(secrets).some(Boolean) ? encrypt(JSON.stringify(secrets)) : null;
}

export function hostOf(config: BackupTargetConfig): string | undefined {
  switch (config.type) {
    case "sftp":
    case "ftp":
    case "smb":
      return config.host;
    case "s3":
      return new URL(config.endpoint).host;
    case "webdav":
      return new URL(config.url).host;
    default:
      return undefined;
  }
}
