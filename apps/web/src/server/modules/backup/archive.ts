/**
 * A `.saldo-backup` archive: tar(manifest.json, database.dump) → gzip → encrypted container (container.ts). The
 * manifest describes the dump (size, SHA-256, migrations, row counts) and carries the ENCRYPTION_KEY of the source, so
 * secrets in the database can be re-keyed on restore.
 */
import { createHash } from "node:crypto";
import { type Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";
import {
  ContainerError,
  type ContainerFailure,
  decryptStream,
  encryptStream,
  type KdfParams,
  type Keys,
  newHeader,
  unlock,
} from "./container.ts";
import { readTar, TarError, tarEnd, tarEntry } from "./tar.ts";

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXTENSION = ".saldo-backup";
export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "database.dump";
const MAX_MANIFEST_BYTES = 1024 * 1024;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const manifestSchema = z.object({
  format: z.literal("saldo-backup"),
  formatVersion: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  app: z.object({ version: z.string().max(64).nullable(), gitSha: z.string().max(64).nullable() }),
  postgres: z.object({ server: z.string().max(200), dump: z.string().max(200).nullable() }),
  migrations: z.object({
    count: z.number().int().min(0),
    hash: hex64,
    applied: z.array(z.object({ hash: hex64, createdAt: z.number().int() })).max(10_000),
  }),
  counts: z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), z.number().int().min(0)),
  excludedData: z.array(z.string().max(63)).max(50),
  encryptionKey: z.string().refine((key) => Buffer.from(key, "base64").length === 32),
  database: z.object({ file: z.literal(DATABASE_FILE), bytes: z.number().int().min(0), sha256: hex64 }),
});

export type Manifest = z.infer<typeof manifestSchema>;

export type ArchiveFailure = ContainerFailure | "manifest";

export class ArchiveError extends Error {
  constructor(readonly reason: ArchiveFailure) {
    super(`Backup archive: ${reason}`);
    this.name = "ArchiveError";
  }
}

/** Only failures of the archive itself; whatever a dump consumer (pg_restore) throws passes through unchanged. */
function asArchiveError(error: unknown): unknown {
  if (error instanceof ArchiveError) return error;
  if (error instanceof ContainerError) return new ArchiveError(error.reason);
  if (error instanceof TarError || error instanceof SyntaxError) return new ArchiveError("damaged");
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("Z_")) return new ArchiveError("damaged");
  return error;
}

/** `source` through a Node transform; a failure on either side ends the iteration with that error. */
function through(source: AsyncIterable<Uint8Array>, transform: Duplex): AsyncIterable<Buffer> {
  pipeline(Readable.from(source), transform).catch(() => undefined);
  return transform;
}

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}

async function* tarStream(manifest: Manifest, dump: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const json = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const mtime = new Date(manifest.createdAt);
  yield* tarEntry(MANIFEST_FILE, json.length, mtime, once(json));
  yield* tarEntry(DATABASE_FILE, manifest.database.bytes, mtime, dump);
  yield tarEnd();
}

export type SealOptions = { kdf?: KdfParams; chunkBytes?: number };

/** The encrypted archive as a byte stream; `dump` must deliver exactly `manifest.database.bytes` bytes. */
export async function sealArchive(
  manifest: Manifest,
  dump: AsyncIterable<Uint8Array>,
  passphrase: string,
  options: SealOptions = {},
): Promise<AsyncIterable<Buffer>> {
  const { header, keys } = await newHeader(passphrase, options);
  return encryptStream(through(tarStream(manifest, dump), createGzip()), header, keys);
}

export type Unlock = { passphrase: string } | { keys: Keys };

export type OpenedArchive = { manifest: Manifest; keys: Keys };

async function readAll(body: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const piece of body) {
    size += piece.length;
    if (size > limit) throw new ArchiveError("manifest");
    parts.push(piece);
  }
  return Buffer.concat(parts);
}

function parseManifest(bytes: Buffer): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ArchiveError("manifest");
  }
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof version === "number" && version > ARCHIVE_VERSION) throw new ArchiveError("version");
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new ArchiveError("manifest");
  return parsed.data;
}

/**
 * Decrypts and checks a whole archive: container, manifest, dump size and SHA-256, and that nothing follows. `onManifest`
 * may refuse the archive before the dump is read; `onDump` receives the dump stream (by default it is only read).
 */
export async function openArchive(
  source: AsyncIterable<Uint8Array>,
  secret: Unlock,
  handlers: {
    onManifest?: (manifest: Manifest) => void | Promise<void>;
    onDump?: (dump: AsyncIterable<Buffer>, manifest: Manifest) => Promise<void>;
  } = {},
): Promise<OpenedArchive> {
  let keys: Keys | null = "keys" in secret ? secret.keys : null;
  try {
    const plain = decryptStream(source, async (header) => {
      keys ??= await unlock(header, "passphrase" in secret ? secret.passphrase : "");
      return keys;
    });
    const entries = readTar(through(plain, createGunzip()));
    const first = await entries.next();
    if (first.done || first.value.name !== MANIFEST_FILE) throw new ArchiveError("manifest");
    const manifest = parseManifest(await readAll(first.value.body, MAX_MANIFEST_BYTES));
    await handlers.onManifest?.(manifest);
    const second = await entries.next();
    if (second.done || second.value.name !== DATABASE_FILE || second.value.size !== manifest.database.bytes) {
      throw new ArchiveError("damaged");
    }
    const hash = createHash("sha256");
    async function* hashed(body: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const piece of body) {
        hash.update(piece);
        yield piece;
      }
    }
    const dump = hashed(second.value.body);
    if (handlers.onDump) await handlers.onDump(dump, manifest);
    for await (const _ of dump) void _;
    if (!(await entries.next()).done) throw new ArchiveError("damaged");
    if (hash.digest("hex") !== manifest.database.sha256) throw new ArchiveError("damaged");
    if (!keys) throw new ArchiveError("format");
    return { manifest, keys };
  } catch (error) {
    throw asArchiveError(error);
  }
}
