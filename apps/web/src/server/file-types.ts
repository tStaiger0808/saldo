/** What uploaded bytes are, read from their first bytes, never from a file name or the browser's claim. */
export type FileType = { contentType: string; extension: string };

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: readonly (FileType & { matches: (bytes: Uint8Array) => boolean })[] = [
  { contentType: "application/pdf", extension: "pdf", matches: (b) => startsWith(b, ascii("%PDF-")) },
  { contentType: "image/png", extension: "png", matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", extension: "jpg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { contentType: "image/webp", extension: "webp", matches: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) },
];

/** PDF, PNG, JPEG or WebP by their magic bytes; null for anything else. */
export function sniffFileType(bytes: Uint8Array): FileType | null {
  const found = SIGNATURES.find((s) => s.matches(bytes));
  return found ? { contentType: found.contentType, extension: found.extension } : null;
}
