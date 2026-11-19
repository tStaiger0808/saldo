import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Route as DownloadRoute } from "../../../routes/api/contract-documents/$documentId.ts";
import { Route as UploadRoute } from "../../../routes/api/contracts/$contractId/documents.ts";
import { auth } from "../../auth.ts";
import { bodyLimit } from "../../body-limit.ts";
import { db } from "../../db/index.ts";
import { contractDocuments } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createAccount, createGroup } from "../accounts/index.ts";
import { refusedWhileImpersonating } from "../impersonation/index.ts";
import {
  addContractDocument,
  deleteContract,
  deleteContractDocument,
  getContract,
  MAX_CONTRACT_DOCUMENTS,
  MAX_CONTRACT_DOCUMENTS_BYTES,
  MAX_DOCUMENT_BYTES,
  readContractDocument,
  saveContract,
  sniffDocumentType,
} from "./index.ts";

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

type Handler = (context: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handler = (route: { options: unknown }, method: "GET" | "POST") =>
  (route.options as { server: { handlers: Record<string, Handler> } }).server.handlers[method] as Handler;

async function signIn(username: string): Promise<Headers> {
  const { headers } = await auth().api.signInUsername({ body: { username, password: "test-password-123" }, returnHeaders: true });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}

describe("contract documents", () => {
  let admin: Viewer;
  let member: Viewer;
  let outsider: Viewer;
  let contractId: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    const kids = await createGroup(db(), admin, { name: "Kinder" });
    member = await makeUser("kind", "member", [kids]);
    outsider = await makeUser("gast", "member");
    const shared = await createAccount(db(), admin, {
      name: "Taschengeld",
      bank: "dkb",
      kind: "checking",
      color: "#1f6f5c",
      groupIds: [kids],
    });
    contractId = await saveContract(db(), admin, {
      name: "Handyvertrag",
      direction: "expense",
      amountCents: 1_999,
      interval: "monthly",
      nextDue: "2026-12-01",
      accountId: shared,
      matchPayee: "Telekom",
    });
  });

  it("knows PDF and images by their first bytes, not by their name", () => {
    expect(sniffDocumentType(PDF)).toEqual({ contentType: "application/pdf", extension: "pdf" });
    expect(sniffDocumentType(PNG)).toEqual({ contentType: "image/png", extension: "png" });
    expect(sniffDocumentType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe("image/jpeg");
    expect(sniffDocumentType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))?.contentType).toBe("image/webp");
    expect(sniffDocumentType(HTML)).toBeNull();
    expect(sniffDocumentType(new Uint8Array())).toBeNull();
  });

  it("stores files for those who may change the contract and shows them to everyone who sees it", async () => {
    const id = await addContractDocument(db(), admin, { contractId, fileName: "../../Vertrag 2026.PDF", bytes: PDF });
    await addContractDocument(db(), admin, { contractId, fileName: "scan.html", bytes: PNG });
    const { documents } = await getContract(db(), member, contractId);
    expect(documents.map((d) => [d.fileName, d.contentType, d.sizeBytes, d.uploadedBy])).toEqual([
      ["Vertrag 2026.pdf", "application/pdf", PDF.byteLength, "admin"],
      ["scan.png", "image/png", PNG.byteLength, "admin"],
    ]);
    const file = await readContractDocument(db(), member, id);
    expect(new Uint8Array(file.data)).toEqual(PDF);

    // Seeing is not changing; not seeing is not knowing.
    await expect(addContractDocument(db(), member, { contractId, fileName: "x.pdf", bytes: PDF })).rejects.toMatchObject({ status: 403 });
    await expect(deleteContractDocument(db(), member, id)).rejects.toMatchObject({ status: 403 });
    await expect(readContractDocument(db(), outsider, id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteContractDocument(db(), outsider, id)).rejects.toMatchObject({ status: 404 });
    await expect(addContractDocument(db(), outsider, { contractId, fileName: "x.pdf", bytes: PDF })).rejects.toMatchObject({
      status: 404,
    });

    await deleteContractDocument(db(), admin, id);
    expect((await getContract(db(), admin, contractId)).documents.map((d) => d.fileName)).toEqual(["scan.png"]);
    await deleteContract(db(), admin, contractId);
    expect(await db().select({ id: contractDocuments.id }).from(contractDocuments)).toEqual([]);
  });

  it("refuses other types, empty and too large files and caps each contract", async () => {
    const add = (bytes: Uint8Array) => addContractDocument(db(), admin, { contractId, fileName: "x.pdf", bytes });
    await expect(add(HTML)).rejects.toMatchObject({ status: 415 });
    await expect(add(new Uint8Array())).rejects.toMatchObject({ status: 400 });
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PDF);
    await expect(add(big)).rejects.toMatchObject({ status: 413 });

    const filler = { contractId, fileName: "alt.pdf", contentType: "application/pdf", data: Buffer.from(PDF) };
    await db()
      .insert(contractDocuments)
      .values({ ...filler, sizeBytes: MAX_CONTRACT_DOCUMENTS_BYTES - 10 });
    await expect(add(PDF)).rejects.toMatchObject({ status: 413 });
    await db().delete(contractDocuments).where(eq(contractDocuments.contractId, contractId));
    await db()
      .insert(contractDocuments)
      .values(Array.from({ length: MAX_CONTRACT_DOCUMENTS }, () => ({ ...filler, sizeBytes: PDF.byteLength })));
    await expect(add(PDF)).rejects.toMatchObject({ status: 409 });
  });

  it("uploads through its own route with a raised body limit and serves files only as attachments", async () => {
    expect(bodyLimit(`/api/contracts/${contractId}/documents`)).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    expect(bodyLimit(`/api/contracts/${contractId}/documents/x`)).toBe(1024 * 1024);
    expect(bodyLimit("/_serverFn/abc")).toBe(1024 * 1024);
    // Viewing as someone else stays read-only: uploads are refused, downloads are reads.
    expect(refusedWhileImpersonating("POST", `/api/contracts/${contractId}/documents`)).toBe(true);
    expect(refusedWhileImpersonating("GET", "/api/contract-documents/1")).toBe(false);

    const upload = handler(UploadRoute, "POST");
    const post = (headers: Headers, body: Uint8Array, name = "Rechnung März.pdf") =>
      upload({
        request: new Request(`https://saldo.test/api/contracts/${contractId}/documents?${new URLSearchParams({ name })}`, {
          method: "POST",
          headers,
          body: new Blob([body.slice()]),
        }),
        params: { contractId: String(contractId) },
      });
    const adminHeaders = await signIn("admin");
    const created = await post(adminHeaders, PDF);
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: number };
    expect((await post(adminHeaders, HTML, "x.pdf")).status).toBe(415);
    expect((await post(new Headers(), PDF)).status).toBe(401);
    const memberHeaders = await signIn("kind");
    expect((await post(memberHeaders, PDF)).status).toBe(403);
    const oversized = new Headers(adminHeaders);
    oversized.set("content-length", String(MAX_DOCUMENT_BYTES + 1));
    expect((await post(oversized, PDF)).status).toBe(413);

    const download = handler(DownloadRoute, "GET");
    const get = (headers: Headers) =>
      download({
        request: new Request(`https://saldo.test/api/contract-documents/${id}`, { headers }),
        params: { documentId: String(id) },
      });
    const file = await get(memberHeaders);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="Rechnung Ma_rz.pdf"; filename*=UTF-8''${encodeURIComponent("Rechnung März.pdf")}`,
    );
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    expect((await get(await signIn("gast"))).status).toBe(404);
    expect((await get(new Headers())).status).toBe(401);
  });
});
