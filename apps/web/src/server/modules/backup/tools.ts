/**
 * The external programs of a backup: pg_dump, pg_restore and rclone. They are spawned with argument arrays (no shell),
 * see only the environment given here (never AUTH_SECRET, ENCRYPTION_KEY or DATABASE_URL) and stream through pipes.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Tool = "pg_dump" | "pg_restore" | "rclone";

export class ToolError extends Error {
  constructor(
    readonly tool: Tool,
    /** Exit code; null when the program was missing, timed out or was stopped. */
    readonly code: number | null,
    /** The last meaningful line the program wrote to stderr, without timestamps or control characters. */
    readonly detail: string,
    readonly missing = false,
  ) {
    super(`${tool} failed${code === null ? "" : ` (exit ${code})`}`);
    this.name = "ToolError";
  }
}

const STDERR_KEEP = 16 * 1024;
const MAX_COLLECTED_STDOUT = 32 * 1024 * 1024;

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tmpdir(), LANG: "C.UTF-8" };
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

/** The last line that says what went wrong, at most 300 characters. */
export function errorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\p{Cc}/gu, " ")
        .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "")
        .trim(),
    )
    .filter(Boolean);
  const telling = lines.filter((line) => /error|fail|fatal|denied|refused|timeout|not found|no such/i.test(line));
  return (telling.at(-1) ?? lines.at(-1) ?? "").slice(0, 300);
}

export type RunOptions = {
  env?: Record<string, string>;
  /** Fed to the program's stdin; without it stdin is closed at once. */
  stdin?: AsyncIterable<Uint8Array> | Buffer | string;
  /** Consumes stdout; without it stdout is collected and returned. */
  stdout?: (out: AsyncIterable<Buffer>) => Promise<void>;
  timeoutMs?: number;
};

/**
 * Runs a program to its end. A failure of the stdin source (a damaged archive) wins over the program's own exit, so
 * the caller learns the cause; the program is stopped then.
 */
export async function runTool(tool: Tool, args: string[], options: RunOptions = {}): Promise<Buffer> {
  const child = spawn(tool, args, { env: { ...baseEnv(), ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-STDERR_KEEP);
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
    : null;

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  let sourceError: unknown = null;
  const input = (async () => {
    if (options.stdin === undefined) return child.stdin.end();
    const source = typeof options.stdin === "string" || Buffer.isBuffer(options.stdin) ? [Buffer.from(options.stdin)] : options.stdin;
    try {
      await pipeline(Readable.from(source), child.stdin);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // The program closing its stdin early is reported by its exit; anything else is the source's failure.
      if (code !== "EPIPE" && code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ERR_STREAM_DESTROYED") {
        sourceError = error;
        child.kill("SIGTERM");
      }
    }
  })();

  const collected: Buffer[] = [];
  let consumerError: unknown = null;
  const output = (async () => {
    try {
      if (options.stdout) return await options.stdout(child.stdout);
      let size = 0;
      for await (const piece of child.stdout as AsyncIterable<Buffer>) {
        size += piece.length;
        if (size > MAX_COLLECTED_STDOUT) throw new ToolError(tool, null, "output too large");
        collected.push(piece);
      }
    } catch (error) {
      consumerError = error;
      child.stdout.destroy();
      child.kill("SIGTERM");
    }
  })();

  try {
    const code = await exited;
    await Promise.all([input, output]);
    if (sourceError) throw sourceError;
    if (consumerError) throw consumerError;
    if (timedOut) throw new ToolError(tool, null, "timeout");
    if (code !== 0) throw new ToolError(tool, code, errorLine(stderr));
    return Buffer.concat(collected);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") throw new ToolError(tool, null, `${tool} is not installed`, true);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** libpq connection settings from a postgres:// URL, optionally for another database on the same server. */
export function pgEnv(url: string, database?: string): Record<string, string> {
  const parsed = new URL(url);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(parsed.hostname.replace(/^\[|\]$/g, "")),
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database ?? decodeURIComponent(parsed.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "saldo-backup",
  };
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** The first line of `<tool> --version`, or null when the program is missing. */
export async function toolVersion(tool: Tool): Promise<string | null> {
  try {
    const out = await runTool(tool, tool === "rclone" ? ["version"] : ["--version"], { timeoutMs: 10_000 });
    return out.toString("utf8").split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}
