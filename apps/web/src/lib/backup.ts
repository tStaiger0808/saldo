/** Backup settings shared by the settings page and the server (modules/backup). */

export const BACKUP_TARGET_TYPES = ["local", "sftp", "ftp", "smb", "b2", "s3", "webdav"] as const;
export type BackupTargetType = (typeof BACKUP_TARGET_TYPES)[number];

export const FTP_TLS_MODES = ["explicit", "implicit", "none"] as const;
export const WEBDAV_VENDORS = ["nextcloud", "owncloud", "other"] as const;
export const SFTP_AUTH = ["password", "key"] as const;

/** Non-secret settings per type; passwords and keys are stored apart, encrypted, and never sent back. */
export type BackupTargetConfig =
  | { type: "local"; path: string }
  | {
      type: "sftp";
      host: string;
      port: number;
      username: string;
      auth: (typeof SFTP_AUTH)[number];
      path: string;
      /** known_hosts lines; without them the server's host key is not checked. */
      knownHosts: string;
    }
  | {
      type: "ftp";
      host: string;
      port: number;
      username: string;
      tls: (typeof FTP_TLS_MODES)[number];
      skipVerify: boolean;
      path: string;
    }
  | { type: "smb"; host: string; port: number; username: string; domain: string; share: string; path: string }
  | { type: "b2"; accountId: string; bucket: string; path: string }
  | {
      type: "s3";
      endpoint: string;
      region: string;
      accessKeyId: string;
      bucket: string;
      path: string;
      pathStyle: boolean;
    }
  | {
      type: "webdav";
      url: string;
      vendor: (typeof WEBDAV_VENDORS)[number];
      username: string;
      skipVerify: boolean;
      path: string;
    };

export const SECRET_FIELDS = ["password", "privateKey", "privateKeyPassphrase", "applicationKey", "secretAccessKey"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** Which secrets a type takes; the first one listed is required unless the type has alternatives (SFTP). */
export const TARGET_SECRETS: Record<BackupTargetType, readonly SecretField[]> = {
  local: [],
  sftp: ["password", "privateKey", "privateKeyPassphrase"],
  ftp: ["password"],
  smb: ["password"],
  b2: ["applicationKey"],
  s3: ["secretAccessKey"],
  webdav: ["password"],
};

export const DEFAULT_PORTS: Partial<Record<BackupTargetType, number>> = { sftp: 22, ftp: 21, smb: 445 };

export const DEFAULT_KEEP = 14;
export const MAX_KEEP = 365;

export const BACKUP_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

/** ISO weekday, Monday = 1. `monthDay` 1–28 or the month's last day. */
export type BackupSchedule = {
  frequency: BackupFrequency;
  time: string;
  weekday: number;
  monthDay: number | "last";
  targetIds: number[];
};

export const DEFAULT_SCHEDULE: BackupSchedule = { frequency: "off", time: "03:00", weekday: 1, monthDay: 1, targetIds: [] };

export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 1024;

/** 0 (weak) to 4 (strong), from length and character variety; only a hint, the server checks the minimum length. */
export function passphraseStrength(passphrase: string): 0 | 1 | 2 | 3 | 4 {
  const length = [...passphrase].length;
  if (length < MIN_PASSPHRASE) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/, /\s/].filter((re) => re.test(passphrase)).length;
  const distinct = new Set(passphrase).size;
  if (distinct < 6) return 1;
  const score = (length >= 16 ? 1 : 0) + (length >= 24 ? 1 : 0) + (classes >= 3 ? 1 : 0) + (classes >= 2 ? 1 : 0);
  return Math.max(1, Math.min(4, score)) as 1 | 2 | 3 | 4;
}

export const BACKUP_TRIGGERS = ["scheduled", "manual", "safety"] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];
export const BACKUP_RUN_STATUSES = ["running", "ok", "partial", "failed"] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

/** Per target of one run. `error` is a message key or a tool's error text (admins only). */
export type BackupRunResult = { targetId: number | null; name: string; ok: boolean; error: string | null; deleted: number };

export const ARCHIVE_EXTENSION = ".saldo-backup";
/** Every archive Saldo writes; downloads and restores from a target accept only these names. */
export const ARCHIVE_NAME = /^saldo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-pre-restore)?\.saldo-backup$/;
/** The archives retention may delete: scheduled and manual ones, never the safety copies before a restore. */
export const RETAINED_ARCHIVE_NAME = /^saldo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.saldo-backup$/;

/** `saldo-2026-11-19T03-00-00Z.saldo-backup`, in UTC so names sort by time and never repeat across DST. */
export function archiveName(at: Date, suffix: "" | "-pre-restore" = ""): string {
  return `saldo-${at.toISOString().slice(0, 19).replaceAll(":", "-")}Z${suffix}${ARCHIVE_EXTENSION}`;
}

/** The time in an archive name, or null for names Saldo did not write. */
export function archiveTime(name: string): string | null {
  if (!ARCHIVE_NAME.test(name)) return null;
  const stamp = name.slice(6, 26);
  return `${stamp.slice(0, 10)}T${stamp.slice(11, 19).replaceAll("-", ":")}Z`;
}

/** Restore uploads may be this large. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
