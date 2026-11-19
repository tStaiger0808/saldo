/** The plain ustar subset a backup needs: regular files with known sizes, written and read as streams. */

const BLOCK = 512;
// Eleven octal digits in the size field.
export const MAX_TAR_ENTRY_BYTES = 8 ** 11 - 1;

export class TarError extends Error {
  constructor(message: string) {
    super(`tar: ${message}`);
    this.name = "TarError";
  }
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  return sum;
}

export function entryHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100 || !/^[\w.-]+$/.test(name)) throw new TarError("unsupported name");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_ENTRY_BYTES) throw new TarError("unsupported size");
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, "utf8");
  block.write(octal(0o600, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\u000000", 257, "ascii");
  block.write(`${checksum(block).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** One entry: header, exactly `size` body bytes (anything else throws) and the padding to the next block. */
export async function* tarEntry(name: string, size: number, mtime: Date, body: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  yield entryHeader(name, size, mtime);
  let written = 0;
  for await (const piece of body) {
    written += piece.byteLength;
    if (written > size) throw new TarError(`${name} is longer than announced`);
    yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
  }
  if (written !== size) throw new TarError(`${name} is shorter than announced`);
  const pad = padding(size);
  if (pad.length > 0) yield pad;
}

export const tarEnd = () => Buffer.alloc(2 * BLOCK);

/** Exact reads from a byte stream. */
class ByteReader {
  private pending = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  private async fill(bytes: number): Promise<void> {
    while (this.pending.length < bytes && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else this.pending = this.pending.length === 0 ? Buffer.from(next.value) : Buffer.concat([this.pending, next.value]);
    }
  }

  async read(bytes: number): Promise<Buffer> {
    await this.fill(bytes);
    if (this.pending.length < bytes) throw new TarError("unexpected end");
    const out = this.pending.subarray(0, bytes);
    this.pending = this.pending.subarray(bytes);
    return out;
  }

  /** Up to `state.left` bytes in pieces; `state.left` stays accurate when the consumer stops early. */
  async *take(state: { left: number }): AsyncGenerator<Buffer> {
    while (state.left > 0) {
      if (this.pending.length === 0) await this.fill(1);
      if (this.pending.length === 0) throw new TarError("unexpected end");
      const out = this.pending.subarray(0, Math.min(state.left, this.pending.length));
      this.pending = this.pending.subarray(out.length);
      state.left -= out.length;
      yield out;
    }
  }

  async skip(bytes: number): Promise<void> {
    for await (const _ of this.take({ left: bytes })) void _;
  }

  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.pending.length === 0;
  }
}

export type TarEntry = { name: string; size: number; body: AsyncIterable<Buffer> };

function parseOctal(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new TarError("bad number");
  return Number.parseInt(text, 8);
}

/**
 * The entries of a tar stream in order. Each body must be read (or is skipped) before the next entry comes; the stream
 * must end with the two zero blocks and nothing after them.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  for (;;) {
    const block = await reader.read(BLOCK);
    if (block.every((byte) => byte === 0)) {
      if (!(await reader.read(BLOCK)).every((byte) => byte === 0)) throw new TarError("bad end");
      if (!(await reader.atEnd())) throw new TarError("data after the end");
      return;
    }
    if (block.toString("ascii", 257, 262) !== "ustar") throw new TarError("not ustar");
    if (parseOctal(block.subarray(148, 156)) !== checksum(block)) throw new TarError("bad header checksum");
    const type = block.toString("ascii", 156, 157);
    if (type !== "0" && type !== "\0") throw new TarError("unsupported entry type");
    const name = block.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const size = parseOctal(block.subarray(124, 136));
    const state = { left: size };
    yield { name, size, body: { [Symbol.asyncIterator]: () => reader.take(state) } };
    await reader.skip(state.left);
    await reader.read(padding(size).length);
  }
}
