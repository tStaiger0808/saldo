/**
 * Backup targets through rclone. Each call configures one remote named "saldo" purely through `RCLONE_CONFIG_SALDO_*`
 * environment variables (no config file; passwords obscured as rclone expects), with connect and I/O timeouts. Only an
 * SFTP host key list is written to disk: into a private temporary directory that is removed after the call.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { ARCHIVE_NAME, type BackupTargetConfig, type SecretField } from "../../../lib/backup.ts";
import { runTool, ToolError } from "./tools.ts";

export type TargetSecrets = Partial<Record<SecretField, string>>;
export type Target = { config: BackupTargetConfig; secrets: TargetSecrets };

const PREFIX = "RCLONE_CONFIG_SALDO_";
const COMMON_FLAGS = [
  "--contimeout=15s",
  "--timeout=60s",
  "--low-level-retries=3",
  "--retries=1",
  "--ask-password=false",
  "--log-level=ERROR",
];
const TOOL_TIMEOUT_MS = 6 * 60 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;

/** rclone's reversible "obscure" encoding for password options, computed by rclone itself. */
export async function obscure(value: string): Promise<string> {
  return (await runTool("rclone", ["obscure", "-"], { stdin: value, env: { RCLONE_CONFIG: "" }, timeoutMs: 10_000 }))
    .toString("utf8")
    .trim();
}

/** A relative folder below the backup directory; `..` and absolute paths are refused by validation already. */
export function localFolder(backupDir: string, path: string): string {
  const folder = normalize(join(backupDir, path));
  if (!isAbsolute(folder) || (folder !== normalize(backupDir) && !folder.startsWith(`${normalize(backupDir).replace(/\/$/, "")}/`))) {
    throw new ToolError("rclone", null, "path outside the backup folder");
  }
  return folder;
}

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");
const joinRemote = (...parts: string[]) => parts.map(trimSlashes).filter(Boolean).join("/");

type Remote = { env: Record<string, string>; base: string; flags: string[]; cleanup: () => Promise<void> };

async function remoteFor(target: Target, backupDir: string): Promise<Remote> {
  const { config, secrets } = target;
  const env: Record<string, string> = { RCLONE_CONFIG: "", RCLONE_CACHE_DIR: join(tmpdir(), "rclone-cache") };
  const set = (key: string, value: string | number | boolean) => {
    env[`${PREFIX}${key}`] = String(value);
  };
  const flags = [...COMMON_FLAGS];
  let cleanup: () => Promise<void> = async () => undefined;
  let base: string;
  switch (config.type) {
    case "local":
      set("TYPE", "local");
      base = `saldo:${localFolder(backupDir, config.path)}`;
      break;
    case "sftp": {
      set("TYPE", "sftp");
      set("HOST", config.host);
      set("PORT", config.port);
      set("USER", config.username);
      if (config.auth === "password" && secrets.password) set("PASS", await obscure(secrets.password));
      if (config.auth === "key" && secrets.privateKey) {
        set("KEY_PEM", secrets.privateKey.trim().replace(/\r?\n/g, "\\n"));
        if (secrets.privateKeyPassphrase) set("KEY_FILE_PASS", await obscure(secrets.privateKeyPassphrase));
      }
      if (config.knownHosts.trim()) {
        const dir = await mkdtemp(join(tmpdir(), "saldo-sftp-"));
        const file = join(dir, "known_hosts");
        await writeFile(file, `${config.knownHosts.trim()}\n`, { mode: 0o600 });
        set("KNOWN_HOSTS_FILE", file);
        cleanup = () => rm(dir, { recursive: true, force: true });
      }
      base = config.path.startsWith("/") ? `saldo:/${trimSlashes(config.path)}` : `saldo:${trimSlashes(config.path)}`;
      break;
    }
    case "ftp":
      set("TYPE", "ftp");
      set("HOST", config.host);
      set("PORT", config.port);
      set("USER", config.username);
      if (secrets.password) set("PASS", await obscure(secrets.password));
      if (config.tls === "implicit") set("TLS", true);
      if (config.tls === "explicit") set("EXPLICIT_TLS", true);
      if (config.skipVerify) set("NO_CHECK_CERTIFICATE", true);
      base = `saldo:${trimSlashes(config.path)}`;
      break;
    case "smb":
      set("TYPE", "smb");
      set("HOST", config.host);
      set("PORT", config.port);
      set("USER", config.username);
      set("DOMAIN", config.domain || "WORKGROUP");
      if (secrets.password) set("PASS", await obscure(secrets.password));
      base = `saldo:${joinRemote(config.share, config.path)}`;
      break;
    case "b2":
      set("TYPE", "b2");
      set("ACCOUNT", config.accountId);
      set("KEY", secrets.applicationKey ?? "");
      // Retention must free the space, not keep hidden old versions.
      set("HARD_DELETE", true);
      base = `saldo:${joinRemote(config.bucket, config.path)}`;
      break;
    case "s3":
      set("TYPE", "s3");
      set("PROVIDER", "Other");
      set("ENDPOINT", config.endpoint);
      if (config.region) set("REGION", config.region);
      set("ACCESS_KEY_ID", config.accessKeyId);
      set("SECRET_ACCESS_KEY", secrets.secretAccessKey ?? "");
      set("FORCE_PATH_STYLE", config.pathStyle);
      set("NO_CHECK_BUCKET", true);
      base = `saldo:${joinRemote(config.bucket, config.path)}`;
      break;
    case "webdav":
      set("TYPE", "webdav");
      set("URL", config.url);
      set("VENDOR", config.vendor);
      if (config.username) set("USER", config.username);
      if (secrets.password) set("PASS", await obscure(secrets.password));
      if (config.skipVerify) flags.push("--no-check-certificate");
      base = `saldo:${trimSlashes(config.path)}`;
      break;
  }
  return { env, base, flags, cleanup };
}

const at = (base: string, name: string) => (base.endsWith(":") || base.endsWith("/") ? `${base}${name}` : `${base}/${name}`);

async function withRemote<T>(target: Target, backupDir: string, work: (remote: Remote) => Promise<T>): Promise<T> {
  const remote = await remoteFor(target, backupDir);
  try {
    return await work(remote);
  } finally {
    await remote.cleanup();
  }
}

/** Writes and deletes a small file, so both rights are checked. */
export async function testTarget(target: Target, backupDir: string): Promise<void> {
  const name = `saldo-connection-test-${randomBytes(6).toString("hex")}.txt`;
  await withRemote(target, backupDir, async ({ env, base, flags }) => {
    await runTool("rclone", ["rcat", ...flags, at(base, name)], { env, stdin: "Saldo connection test\n", timeoutMs: SHORT_TIMEOUT_MS });
    await runTool("rclone", ["deletefile", ...flags, at(base, name)], { env, timeoutMs: SHORT_TIMEOUT_MS });
  });
}

export async function uploadFile(target: Target, backupDir: string, localPath: string, name: string): Promise<void> {
  await withRemote(target, backupDir, ({ env, base, flags }) =>
    runTool("rclone", ["copyto", ...flags, localPath, at(base, name)], { env, timeoutMs: TOOL_TIMEOUT_MS }),
  );
  // rclone creates local files with the process umask; archives are for the owner only, like the dumps beside them.
  if (target.config.type === "local") await chmod(join(localFolder(backupDir, target.config.path), name), 0o600);
}

export async function downloadFile(target: Target, backupDir: string, name: string, localPath: string): Promise<void> {
  await withRemote(target, backupDir, ({ env, base, flags }) =>
    runTool("rclone", ["copyto", ...flags, at(base, name), localPath], { env, timeoutMs: TOOL_TIMEOUT_MS }),
  );
}

export type RemoteArchive = { name: string; size: number; modifiedAt: string | null };

/** Saldo's archives on the target, newest first; a folder that does not exist yet holds none. */
export async function listArchives(target: Target, backupDir: string): Promise<RemoteArchive[]> {
  const rows = await withRemote(target, backupDir, async ({ env, base, flags }) => {
    try {
      return await runTool("rclone", ["lsjson", ...flags, "--files-only", "--no-mimetype", base], { env, timeoutMs: SHORT_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof ToolError && error.code === 3) return Buffer.from("[]");
      throw error;
    }
  });
  const parsed = JSON.parse(rows.toString("utf8") || "[]") as { Name?: unknown; Size?: unknown; ModTime?: unknown }[];
  return parsed
    .filter((row): row is { Name: string; Size: number; ModTime?: unknown } => typeof row.Name === "string" && ARCHIVE_NAME.test(row.Name))
    .map((row) => ({
      name: row.Name,
      size: typeof row.Size === "number" ? row.Size : 0,
      modifiedAt: typeof row.ModTime === "string" ? row.ModTime : null,
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export async function deleteArchive(target: Target, backupDir: string, name: string): Promise<void> {
  if (!ARCHIVE_NAME.test(name)) throw new ToolError("rclone", null, "not an archive name");
  await withRemote(target, backupDir, ({ env, base, flags }) =>
    runTool("rclone", ["deletefile", ...flags, at(base, name)], { env, timeoutMs: SHORT_TIMEOUT_MS }),
  );
}

/** Streams one archive from the target; a failure part-way aborts the stream. */
export function archiveStream(target: Target, backupDir: string, name: string): ReadableStream<Uint8Array> {
  if (!ARCHIVE_NAME.test(name)) throw new ToolError("rclone", null, "not an archive name");
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void withRemote(target, backupDir, ({ env, base, flags }) =>
    runTool("rclone", ["cat", ...flags, at(base, name)], {
      env,
      timeoutMs: TOOL_TIMEOUT_MS,
      stdout: async (out) => {
        for await (const piece of out) await writer.write(piece);
      },
    }),
  ).then(
    () => writer.close(),
    (error: unknown) => writer.abort(error).catch(() => undefined),
  );
  return readable;
}
