/**
 * The encrypted envelope of a `.saldo-backup` file: a 56-byte header, then the payload in AES-256-GCM chunks under a key
 * derived from the passphrase with scrypt. Every chunk authenticates the header and its own position (counter and a
 * final flag in the nonce), so a changed, reordered, cut-off or extended file is refused. Layout in README.md.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const MAGIC = Buffer.from("SALDOBAK", "ascii");
export const CONTAINER_VERSION = 1;
const KDF_SCRYPT = 1;
const SIGNED_BYTES = 40;
const CHECK_BYTES = 16;
export const HEADER_BYTES = SIGNED_BYTES + CHECK_BYTES;
const TAG_BYTES = 16;
const PREFIX_BYTES = 7;
const MAX_COUNTER = 0xffff_ffff;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export type KdfParams = { log2N: number; r: number; p: number };

/** 128 MiB of memory per derivation: a fraction of a second on the server, expensive for anyone guessing. */
export const DEFAULT_KDF: KdfParams = { log2N: 17, r: 8, p: 1 };
/** For throwaway keys that are random already (the spool file of a running backup) and for tests. */
export const FAST_KDF: KdfParams = { log2N: 10, r: 8, p: 1 };
// A header may ask for at most this much scrypt memory, so a crafted file cannot exhaust the server.
const MAX_KDF_MEMORY = 256 * 1024 * 1024;

export type ContainerFailure = "format" | "version" | "kdf" | "passphrase" | "damaged";

export class ContainerError extends Error {
  constructor(readonly reason: ContainerFailure) {
    super(`Backup container: ${reason}`);
    this.name = "ContainerError";
  }
}

export type Header = {
  version: number;
  kdf: KdfParams;
  salt: Buffer;
  prefix: Buffer;
  chunkBytes: number;
  check: Buffer;
  /** The 56 header bytes as written; every chunk authenticates them. */
  bytes: Buffer;
};

export type Keys = { enc: Buffer; mac: Buffer };

const kdfMemory = ({ log2N, r }: KdfParams) => 128 * r * 2 ** log2N;

function validKdf(kdf: KdfParams): boolean {
  return (
    Number.isInteger(kdf.log2N) &&
    kdf.log2N >= 10 &&
    kdf.log2N <= 20 &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= 32 &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= 16 &&
    kdfMemory(kdf) <= MAX_KDF_MEMORY
  );
}

function deriveBytes(passphrase: string, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      salt,
      64,
      { N: 2 ** kdf.log2N, r: kdf.r, p: kdf.p, maxmem: kdfMemory(kdf) + 32 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const keyCheck = (mac: Buffer, signed: Buffer) => createHmac("sha256", mac).update(signed).digest().subarray(0, CHECK_BYTES);

function signedPart(kdf: KdfParams, salt: Buffer, prefix: Buffer, chunkBytes: number): Buffer {
  const out = Buffer.alloc(SIGNED_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt8(CONTAINER_VERSION, 8);
  out.writeUInt8(KDF_SCRYPT, 9);
  out.writeUInt8(kdf.log2N, 10);
  out.writeUInt8(kdf.r, 11);
  out.writeUInt8(kdf.p, 12);
  salt.copy(out, 13);
  prefix.copy(out, 29);
  out.writeUInt32BE(chunkBytes, 36);
  return out;
}

/** A fresh header (random salt and nonce prefix) and the keys derived for it. */
export async function newHeader(
  passphrase: string,
  options: { kdf?: KdfParams; chunkBytes?: number } = {},
): Promise<{ header: Header; keys: Keys }> {
  const kdf = options.kdf ?? DEFAULT_KDF;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!validKdf(kdf)) throw new ContainerError("kdf");
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) throw new ContainerError("format");
  const salt = randomBytes(16);
  const prefix = randomBytes(PREFIX_BYTES);
  const derived = await deriveBytes(passphrase, salt, kdf);
  const keys = { enc: derived.subarray(0, 32), mac: derived.subarray(32) };
  const signed = signedPart(kdf, salt, prefix, chunkBytes);
  const check = keyCheck(keys.mac, signed);
  return {
    header: { version: CONTAINER_VERSION, kdf, salt, prefix, chunkBytes, check, bytes: Buffer.concat([signed, check]) },
    keys,
  };
}

/** Reads the header without a passphrase; refuses foreign files, unknown versions and KDF settings out of bounds. */
export function parseHeader(bytes: Buffer): Header {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) throw new ContainerError("format");
  const version = bytes.readUInt8(8);
  if (version !== CONTAINER_VERSION) throw new ContainerError("version");
  if (bytes.readUInt8(9) !== KDF_SCRYPT) throw new ContainerError("kdf");
  const kdf = { log2N: bytes.readUInt8(10), r: bytes.readUInt8(11), p: bytes.readUInt8(12) };
  if (!validKdf(kdf)) throw new ContainerError("kdf");
  const chunkBytes = bytes.readUInt32BE(36);
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) throw new ContainerError("format");
  const own = Buffer.from(bytes.subarray(0, HEADER_BYTES));
  return {
    version,
    kdf,
    salt: own.subarray(13, 29),
    prefix: own.subarray(29, 36),
    chunkBytes,
    check: own.subarray(SIGNED_BYTES, HEADER_BYTES),
    bytes: own,
  };
}

/** The keys for a header; a wrong passphrase fails here, before any chunk is touched. */
export async function unlock(header: Header, passphrase: string): Promise<Keys> {
  const derived = await deriveBytes(passphrase, header.salt, header.kdf);
  const keys = { enc: derived.subarray(0, 32), mac: derived.subarray(32) };
  if (!timingSafeEqual(keyCheck(keys.mac, header.bytes.subarray(0, SIGNED_BYTES)), header.check)) throw new ContainerError("passphrase");
  return keys;
}

function nonce(header: Header, counter: number, final: boolean): Buffer {
  if (counter > MAX_COUNTER) throw new ContainerError("format");
  const out = Buffer.alloc(12);
  header.prefix.copy(out, 0);
  out.writeUInt32BE(counter, PREFIX_BYTES);
  out.writeUInt8(final ? 1 : 0, 11);
  return out;
}

function seal(header: Header, keys: Keys, counter: number, plain: Buffer, final: boolean): Buffer {
  const cipher = createCipheriv("aes-256-gcm", keys.enc, nonce(header, counter, final), { authTagLength: TAG_BYTES });
  cipher.setAAD(header.bytes);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(header: Header, keys: Keys, counter: number, frame: Buffer, final: boolean): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", keys.enc, nonce(header, counter, final), { authTagLength: TAG_BYTES });
  decipher.setAAD(header.bytes);
  decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new ContainerError("damaged");
  }
}

/** The header, then the payload in chunks; only the last chunk is final (and may be shorter or empty). */
export async function* encryptStream(source: AsyncIterable<Uint8Array>, header: Header, keys: Keys): AsyncGenerator<Buffer> {
  yield header.bytes;
  let counter = 0;
  let pending = Buffer.alloc(0);
  for await (const piece of source) {
    pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece]);
    while (pending.length > header.chunkBytes) {
      yield seal(header, keys, counter++, pending.subarray(0, header.chunkBytes), false);
      pending = pending.subarray(header.chunkBytes);
    }
  }
  yield seal(header, keys, counter, pending, true);
}

/**
 * The plaintext of a container, chunk by chunk, each one authenticated before it is released. `keysFor` gets the
 * parsed header and returns the keys (or throws). A stream that ends early or carries extra bytes throws at its end,
 * so a consumer must treat what it received as valid only once the iteration completed.
 */
export async function* decryptStream(
  source: AsyncIterable<Uint8Array>,
  keysFor: (header: Header) => Promise<Keys>,
): AsyncGenerator<Buffer> {
  let header: Header | null = null;
  let keys: Keys | null = null;
  let counter = 0;
  let pending = Buffer.alloc(0);
  for await (const piece of source) {
    pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece]);
    if (!header) {
      if (pending.length < HEADER_BYTES) continue;
      header = parseHeader(pending);
      keys = await keysFor(header);
      pending = pending.subarray(HEADER_BYTES);
    }
    const frame = header.chunkBytes + TAG_BYTES;
    while (pending.length > frame) {
      yield open(header, keys as Keys, counter++, pending.subarray(0, frame), false);
      pending = pending.subarray(frame);
    }
  }
  if (!header || !keys) throw new ContainerError("format");
  if (pending.length < TAG_BYTES) throw new ContainerError("damaged");
  yield open(header, keys, counter, pending, true);
}
