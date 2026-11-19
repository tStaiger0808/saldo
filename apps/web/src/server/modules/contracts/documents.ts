/**
 * Files kept with a contract (the contract itself, invoices, letters). Whoever sees the contract may list and download
 * them, whoever may change it uploads and deletes. The type comes from the file's first bytes, never from its name or
 * the browser, and the stored name carries the matching extension.
 */
import { and, asc, count, eq, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { contractDocuments, user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { sniffFileType } from "../../file-types.ts";
import type { Viewer } from "../access/index.ts";
import { requireManageableContract, requireVisibleContract } from "./guard.ts";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CONTRACT_DOCUMENTS_BYTES = 50 * 1024 * 1024;
export const MAX_CONTRACT_DOCUMENTS = 50;

export { sniffFileType as sniffDocumentType } from "../../file-types.ts";

/** The last path segment without characters that break a download header or a file system, with the real extension. */
export function documentFileName(raw: string, extension: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .replace(/[\p{Cc}"<>:|?*]/gu, "")
    .trim()
    .slice(0, 120);
  return `${stem || "dokument"}.${extension}`;
}

export type ContractDocumentView = {
  id: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: string | null;
};

/** The files of a contract the caller has already checked access to, oldest first; without their contents. */
export async function listContractDocuments(db: Db, contractId: number): Promise<ContractDocumentView[]> {
  const rows = await db
    .select({
      id: contractDocuments.id,
      fileName: contractDocuments.fileName,
      contentType: contractDocuments.contentType,
      sizeBytes: contractDocuments.sizeBytes,
      createdAt: contractDocuments.createdAt,
      uploadedBy: user.name,
    })
    .from(contractDocuments)
    .leftJoin(user, eq(user.id, contractDocuments.uploadedBy))
    .where(eq(contractDocuments.contractId, contractId))
    .orderBy(asc(contractDocuments.createdAt), asc(contractDocuments.id));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Stores a file with a contract the viewer may change; limits apply per file and per contract. */
export async function addContractDocument(
  db: Db,
  viewer: Viewer,
  input: { contractId: number; fileName: string; bytes: Uint8Array },
): Promise<number> {
  await requireManageableContract(db, viewer, input.contractId);
  if (input.bytes.byteLength === 0) throw new UserError(msg("contracts.documents.errors.empty"));
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new UserError(msg("contracts.documents.errors.tooLarge"), 413);
  const type = sniffFileType(input.bytes);
  if (!type) throw new UserError(msg("contracts.documents.errors.type"), 415);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('contract-documents'), ${input.contractId})`);
    const [stored] = await tx
      .select({ files: count(), bytes: sum(contractDocuments.sizeBytes).mapWith(Number) })
      .from(contractDocuments)
      .where(eq(contractDocuments.contractId, input.contractId));
    if ((stored?.files ?? 0) >= MAX_CONTRACT_DOCUMENTS) throw new UserError(msg("contracts.documents.errors.tooMany"), 409);
    if ((stored?.bytes ?? 0) + input.bytes.byteLength > MAX_CONTRACT_DOCUMENTS_BYTES)
      throw new UserError(msg("contracts.documents.errors.totalTooLarge"), 413);
    const [row] = await tx
      .insert(contractDocuments)
      .values({
        contractId: input.contractId,
        uploadedBy: viewer.id,
        fileName: documentFileName(input.fileName, type.extension),
        contentType: type.contentType,
        sizeBytes: input.bytes.byteLength,
        data: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      })
      .returning({ id: contractDocuments.id });
    if (!row) throw new UserError(msg("contracts.documents.errors.saveFailed"));
    return row.id;
  });
}

export const documentIdInput = z.object({ id: z.number().int() });

async function documentMeta(db: Db, id: number) {
  const [row] = await db
    .select({ id: contractDocuments.id, contractId: contractDocuments.contractId })
    .from(contractDocuments)
    .where(eq(contractDocuments.id, id));
  if (!row) throw new NotFound(msg("contracts.documents.errors.notFound"));
  return row;
}

/** A file of a contract the viewer sees; a hidden contract's file is a 404 like a missing one. */
export async function readContractDocument(
  db: Db,
  viewer: Viewer,
  id: number,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const meta = await documentMeta(db, id);
  try {
    await requireVisibleContract(db, viewer, meta.contractId);
  } catch (error) {
    if (error instanceof NotFound) throw new NotFound(msg("contracts.documents.errors.notFound"));
    throw error;
  }
  const [row] = await db
    .select({ fileName: contractDocuments.fileName, contentType: contractDocuments.contentType, data: contractDocuments.data })
    .from(contractDocuments)
    .where(and(eq(contractDocuments.id, id), eq(contractDocuments.contractId, meta.contractId)));
  if (!row) throw new NotFound(msg("contracts.documents.errors.notFound"));
  return row;
}

export async function deleteContractDocument(db: Db, viewer: Viewer, id: number): Promise<void> {
  const meta = await documentMeta(db, id);
  await requireManageableContract(db, viewer, meta.contractId);
  await db.delete(contractDocuments).where(eq(contractDocuments.id, id));
}
