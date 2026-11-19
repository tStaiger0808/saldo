import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArchiveError, type Manifest, openArchive, sealArchive } from "./archive.ts";
import {
  ContainerError,
  DEFAULT_KDF,
  decryptStream,
  encryptStream,
  FAST_KDF,
  HEADER_BYTES,
  MAGIC,
  newHeader,
  parseHeader,
  unlock,
} from "./container.ts";
import { entryHeader, readTar, tarEnd, tarEntry } from "./tar.ts";

const PASSPHRASE = "korrekt pferd batterie heftklammer";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of source) parts.push(Buffer.from(piece));
  return Buffer.concat(parts);
}

/** The bytes in pieces of `size`, so chunk boundaries fall anywhere. */
async function* pieces(bytes: Buffer, size = 7): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function seal(plain: Buffer, chunkBytes: number, passphrase = PASSPHRASE): Promise<Buffer> {
  const { header, keys } = await newHeader(passphrase, { kdf: FAST_KDF, chunkBytes });
  return collect(encryptStream(pieces(plain), header, keys));
}

const open = (sealed: Buffer, passphrase = PASSPHRASE, size = 5) =>
  collect(decryptStream(pieces(sealed, size), (header) => unlock(header, passphrase)));

function manifestFor(dump: Buffer): Manifest {
  return {
    format: "saldo-backup",
    formatVersion: 1,
    createdAt: "2026-11-19T03:00:00.000Z",
    app: { version: "0.2.0", gitSha: null },
    postgres: { server: "17.11", dump: "pg_dump (PostgreSQL) 17.11" },
    migrations: { count: 1, hash: "a".repeat(64), applied: [{ hash: "b".repeat(64), createdAt: 1 }] },
    counts: { accounts: 2, transactions: 10 },
    excludedData: ["session"],
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    database: { file: "database.dump", bytes: dump.length, sha256: createHash("sha256").update(dump).digest("hex") },
  };
}

async function sealedArchive(dump: Buffer, manifest = manifestFor(dump)): Promise<Buffer> {
  return collect(await sealArchive(manifest, pieces(dump, 1000), PASSPHRASE, { kdf: FAST_KDF, chunkBytes: 256 }));
}

describe("container", () => {
  it.each([1, 16, 1000])("round-trips across chunk boundaries (chunks of %i bytes)", async (chunkBytes) => {
    for (const length of [0, 1, chunkBytes - 1, chunkBytes, chunkBytes + 1, 3 * chunkBytes, 3 * chunkBytes + 5]) {
      const plain = randomBytes(Math.max(0, length));
      const sealed = await seal(plain, chunkBytes);
      const chunks = Math.max(1, Math.ceil(plain.length / chunkBytes));
      expect(sealed.length, `${length} bytes`).toBe(HEADER_BYTES + plain.length + 16 * chunks);
      expect((await open(sealed)).equals(plain), `${length} bytes`).toBe(true);
    }
  });

  it("starts with the magic and records the KDF parameters, salt and chunk size", async () => {
    const sealed = await seal(Buffer.from("x"), 4096);
    expect(sealed.subarray(0, 8).equals(MAGIC)).toBe(true);
    const header = parseHeader(sealed);
    expect(header).toMatchObject({ version: 1, kdf: FAST_KDF, chunkBytes: 4096 });
    expect(header.salt).toHaveLength(16);
    const other = parseHeader(await seal(Buffer.from("x"), 4096));
    expect(other.salt.equals(header.salt)).toBe(false);
    expect(other.prefix.equals(header.prefix)).toBe(false);
  });

  it("uses scrypt with N = 2^17, r = 8, p = 1 by default", async () => {
    const { header } = await newHeader(PASSPHRASE);
    expect(header.kdf).toEqual({ log2N: 17, r: 8, p: 1 });
    expect(DEFAULT_KDF).toEqual(header.kdf);
    await expect(unlock(parseHeader(header.bytes), PASSPHRASE)).resolves.toBeDefined();
  });

  it("refuses KDF parameters out of bounds before deriving anything", async () => {
    const sealed = await seal(Buffer.from("x"), 16);
    for (const [offset, value] of [
      [10, 9],
      [10, 21],
      [10, 20],
      [11, 0],
      [12, 0],
      [9, 2],
    ] as const) {
      const bad = Buffer.from(sealed);
      bad.writeUInt8(value, offset);
      expect(() => parseHeader(bad), `byte ${offset} = ${value}`).toThrow(ContainerError);
    }
    await expect(newHeader(PASSPHRASE, { kdf: { log2N: 22, r: 8, p: 1 } })).rejects.toMatchObject({ reason: "kdf" });
  });

  it("refuses a wrong passphrase at the key check", async () => {
    const sealed = await seal(Buffer.from("geheim"), 16);
    await expect(open(sealed, "falsche passphrase")).rejects.toMatchObject({ reason: "passphrase" });
  });

  it("refuses foreign files and unknown versions", async () => {
    const sealed = await seal(Buffer.from("geheim"), 16);
    await expect(open(Buffer.from("PK\u0003\u0004 not a backup at all, just some zip bytes here ......."))).rejects.toMatchObject({
      reason: "format",
    });
    const newer = Buffer.from(sealed);
    newer.writeUInt8(2, 8);
    await expect(open(newer)).rejects.toMatchObject({ reason: "version" });
    await expect(open(sealed.subarray(0, 20))).rejects.toMatchObject({ reason: "format" });
  });

  it("detects every flipped byte", async () => {
    const plain = randomBytes(100);
    const sealed = await seal(plain, 32);
    for (let i = 0; i < sealed.length; i++) {
      const bad = Buffer.from(sealed);
      bad[i] = (bad[i] as number) ^ 0x01;
      const outcome = await open(bad).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome, `byte ${i}`).toBeInstanceOf(ContainerError);
      const reason = (outcome as ContainerError).reason;
      expect(i < HEADER_BYTES ? ["passphrase", "version", "kdf", "format"] : ["damaged"], `byte ${i}`).toContain(reason);
    }
  });

  it("detects truncation, extension and reordered chunks", async () => {
    const plain = randomBytes(96);
    const sealed = await seal(plain, 32);
    const frame = 32 + 16;
    const body = sealed.subarray(HEADER_BYTES);
    await expect(open(sealed.subarray(0, sealed.length - 1))).rejects.toMatchObject({ reason: "damaged" });
    await expect(open(sealed.subarray(0, HEADER_BYTES + 2 * frame))).rejects.toMatchObject({ reason: "damaged" });
    await expect(open(Buffer.concat([sealed, Buffer.from([0])]))).rejects.toMatchObject({ reason: "damaged" });
    await expect(open(Buffer.concat([sealed, sealed.subarray(HEADER_BYTES, HEADER_BYTES + frame)]))).rejects.toMatchObject({
      reason: "damaged",
    });
    const swapped = Buffer.concat([
      sealed.subarray(0, HEADER_BYTES),
      body.subarray(frame, 2 * frame),
      body.subarray(0, frame),
      body.subarray(2 * frame),
    ]);
    await expect(open(swapped)).rejects.toMatchObject({ reason: "damaged" });
  });
});

describe("tar", () => {
  it("writes ustar entries that read back, and checks sizes", async () => {
    const stream = (async function* () {
      yield* tarEntry("a.txt", 3, new Date(0), pieces(Buffer.from("abc"), 1));
      yield* tarEntry("b.bin", 600, new Date(0), pieces(Buffer.alloc(600, 9), 100));
      yield tarEnd();
    })();
    const bytes = await collect(stream);
    expect(bytes.length % 512).toBe(0);
    const names: string[] = [];
    for await (const entry of readTar(pieces(bytes, 333))) {
      names.push(entry.name);
      if (entry.name === "a.txt") expect((await collect(entry.body)).toString()).toBe("abc");
    }
    expect(names).toEqual(["a.txt", "b.bin"]);
    await expect(collect(tarEntry("c", 5, new Date(0), pieces(Buffer.from("abc"))))).rejects.toThrow(/shorter/);
    expect(() => entryHeader("../evil", 1, new Date(0))).toThrow();
  });
});

describe("archive", () => {
  it("round-trips manifest and dump", async () => {
    const dump = randomBytes(5000);
    const sealed = await sealedArchive(dump);
    let received: Buffer = Buffer.alloc(0);
    const opened = await openArchive(
      pieces(sealed, 777),
      { passphrase: PASSPHRASE },
      {
        onDump: async (body) => {
          received = await collect(body);
        },
      },
    );
    expect(opened.manifest).toEqual(manifestFor(dump));
    expect(received.equals(dump)).toBe(true);
    await expect(openArchive(pieces(sealed), { keys: opened.keys })).resolves.toMatchObject({ manifest: { counts: { accounts: 2 } } });
  });

  it("refuses a wrong passphrase", async () => {
    const sealed = await sealedArchive(randomBytes(10));
    await expect(openArchive(pieces(sealed), { passphrase: "nicht die richtige" })).rejects.toEqual(new ArchiveError("passphrase"));
  });

  it("refuses a tampered byte anywhere in the payload", async () => {
    const sealed = await sealedArchive(randomBytes(3000));
    for (const offset of [HEADER_BYTES, HEADER_BYTES + 300, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[offset] = (bad[offset] as number) ^ 0x80;
      await expect(openArchive(pieces(bad), { passphrase: PASSPHRASE }), `byte ${offset}`).rejects.toEqual(new ArchiveError("damaged"));
    }
  });

  it("refuses a dump that does not match the manifest", async () => {
    const dump = randomBytes(100);
    const manifest = { ...manifestFor(dump), database: { ...manifestFor(dump).database, sha256: "0".repeat(64) } };
    await expect(openArchive(pieces(await sealedArchive(dump, manifest)), { passphrase: PASSPHRASE })).rejects.toEqual(
      new ArchiveError("damaged"),
    );
  });

  it("refuses a newer archive version and an incomplete manifest before reading the dump", async () => {
    const dump = randomBytes(10);
    let read = false;
    const onDump = async () => {
      read = true;
    };
    const newer = { ...manifestFor(dump), formatVersion: 2 };
    await expect(openArchive(pieces(await sealedArchive(dump, newer)), { passphrase: PASSPHRASE }, { onDump })).rejects.toEqual(
      new ArchiveError("version"),
    );
    const broken = { ...manifestFor(dump), encryptionKey: "short" };
    await expect(openArchive(pieces(await sealedArchive(dump, broken)), { passphrase: PASSPHRASE }, { onDump })).rejects.toEqual(
      new ArchiveError("manifest"),
    );
    expect(read).toBe(false);
  });

  it("lets the manifest check refuse an archive and passes the consumer's own error through", async () => {
    const dump = randomBytes(10);
    const sealed = await sealedArchive(dump);
    const refusal = new Error("newer schema");
    await expect(
      openArchive(
        pieces(sealed),
        { passphrase: PASSPHRASE },
        {
          onManifest: () => {
            throw refusal;
          },
        },
      ),
    ).rejects.toBe(refusal);
    const failure = new Error("pg_restore failed");
    await expect(
      openArchive(
        pieces(sealed),
        { passphrase: PASSPHRASE },
        {
          onDump: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
  });
});
