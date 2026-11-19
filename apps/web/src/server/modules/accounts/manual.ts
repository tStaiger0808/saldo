/** Accounts without a bank connection: balances entered by hand, single bookings and CSV imports. */
import { randomUUID } from "node:crypto";
import { CSV_DELIMITERS, type CsvMapping, readCsvBookings } from "@saldo/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import { accountBalanceEntries, accounts, transactions } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import { requireManageableAccount, requireVisibleAccount, type Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import { reclassifyAll } from "../classification/index.ts";
import { relinkContracts } from "../contracts/index.ts";
import { importBookings } from "../transactions/index.ts";

/** Same as the reverse proxy's body limit in the README. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

const MAX_CENTS = 1e13;
const cents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);

async function requireManualAccount(db: Db, viewer: Viewer, accountId: number) {
  const account = await requireManageableAccount(db, viewer, accountId);
  if (account.connectionId !== null) throw new UserError(msg("settings.errors.accountLinked"), 409);
  return account;
}

/** The account's balance is its latest entry; without entries it keeps what it had. */
async function syncBalance(db: Db, accountId: number): Promise<void> {
  const [latest] = await db
    .select()
    .from(accountBalanceEntries)
    .where(eq(accountBalanceEntries.accountId, accountId))
    .orderBy(desc(accountBalanceEntries.date))
    .limit(1);
  if (latest)
    await db.update(accounts).set({ balanceCents: latest.balanceCents, balanceDate: latest.date }).where(eq(accounts.id, accountId));
}

export const balanceInput = z.object({ accountId: z.number().int(), date: z.iso.date(), balanceCents: cents });

export type BalanceEntry = { id: number; date: string; balanceCents: number };

export async function listBalanceEntries(db: Db, viewer: Viewer, accountId: number): Promise<BalanceEntry[]> {
  await requireVisibleAccount(db, viewer, accountId);
  const rows = await db
    .select()
    .from(accountBalanceEntries)
    .where(eq(accountBalanceEntries.accountId, accountId))
    .orderBy(desc(accountBalanceEntries.date));
  return rows.map((r) => ({ id: r.id, date: r.date, balanceCents: r.balanceCents }));
}

/** One balance per day: a second entry for the same day replaces the first. */
export async function recordBalance(db: Db, viewer: Viewer, input: z.input<typeof balanceInput>): Promise<void> {
  const data = balanceInput.parse(input);
  await requireManualAccount(db, viewer, data.accountId);
  await db
    .insert(accountBalanceEntries)
    .values({ ...data, createdBy: viewer.id })
    .onConflictDoUpdate({
      target: [accountBalanceEntries.accountId, accountBalanceEntries.date],
      set: { balanceCents: data.balanceCents, createdBy: viewer.id },
    });
  await syncBalance(db, data.accountId);
}

export const balanceEntryInput = z.object({ accountId: z.number().int(), id: z.number().int() });

export async function deleteBalanceEntry(db: Db, viewer: Viewer, input: z.input<typeof balanceEntryInput>): Promise<void> {
  const { accountId, id } = balanceEntryInput.parse(input);
  await requireManualAccount(db, viewer, accountId);
  const deleted = await db
    .delete(accountBalanceEntries)
    .where(and(eq(accountBalanceEntries.id, id), eq(accountBalanceEntries.accountId, accountId)))
    .returning({ id: accountBalanceEntries.id });
  if (deleted.length === 0) throw new NotFound();
  const left = await db
    .select({ id: accountBalanceEntries.id })
    .from(accountBalanceEntries)
    .where(eq(accountBalanceEntries.accountId, accountId));
  if (left.length === 0) await db.update(accounts).set({ balanceCents: null, balanceDate: null }).where(eq(accounts.id, accountId));
  else await syncBalance(db, accountId);
}

export const manualBookingInput = z.object({
  accountId: z.number().int(),
  bookingDate: z.iso.date(),
  amountCents: cents.refine((v) => v !== 0, "accounts.errors.amountZero"),
  counterparty: z.string().trim().max(200).default(""),
  purpose: z.string().trim().max(1000).default(""),
});

/** A booking typed in by hand: never deduplicated against others, already read. */
export async function addManualBooking(db: Db, viewer: Viewer, input: z.input<typeof manualBookingInput>): Promise<number> {
  const { accountId, ...booking } = manualBookingInput.parse(input);
  await requireManualAccount(db, viewer, accountId);
  const imported = await importBookings(
    db,
    accountId,
    [{ ...booking, currency: "EUR", counterpartyIban: null, providerId: randomUUID() }],
    "manual",
  );
  if (imported.ids.length > 0) await db.update(transactions).set({ isUnread: false }).where(inArray(transactions.id, imported.ids));
  await reclassifyAll(db);
  await relinkContracts(db);
  const id = imported.ids[0];
  if (id === undefined) throw new UserError(msg("accounts.errors.bookingNotSaved"));
  return id;
}

export const csvMappingSchema = z.object({
  delimiter: z.enum(CSV_DELIMITERS),
  hasHeader: z.boolean(),
  date: z.number().int().min(0).max(200),
  amount: z.number().int().min(0).max(200),
  payee: z.number().int().min(0).max(200).nullable(),
  purpose: z.number().int().min(0).max(200).nullable(),
  decimal: z.enum(["comma", "point"]),
  dateFormat: z.enum(["dmy", "ymd"]),
}) satisfies z.ZodType<CsvMapping>;

export const csvImportInput = z.object({ accountId: z.number().int(), content: z.string(), mapping: csvMappingSchema });

export type CsvImportResult = {
  /** Readable rows in the file. */
  rows: number;
  imported: number;
  /** Rows already stored, e.g. from an earlier import of the same file. */
  duplicates: number;
  /** Line numbers of rows without a valid date or amount (the first few). */
  invalidLines: number[];
  invalid: number;
};

/** Imports bookings of a CSV file; the same file twice adds nothing, since each row's id is a hash of its content. */
export async function importCsvBookings(db: Db, viewer: Viewer, input: z.input<typeof csvImportInput>): Promise<CsvImportResult> {
  const { accountId, content, mapping } = csvImportInput.parse(input);
  if (Buffer.byteLength(content, "utf8") > MAX_CSV_BYTES) throw new UserError(msg("accounts.errors.csvTooLarge"), 413);
  const account = await requireManualAccount(db, viewer, accountId);
  const parsed = readCsvBookings(content, mapping);
  if (parsed.tooMany) throw new UserError(msg("accounts.errors.csvTooManyRows"), 413);
  if (parsed.bookings.length === 0) throw new UserError(msg("accounts.errors.csvNoRows"));
  const imported = await importBookings(
    db,
    accountId,
    parsed.bookings.map((b) => ({ ...b, currency: "EUR", counterpartyIban: null, providerId: null })),
    "csv",
  );
  await reclassifyAll(db);
  await relinkContracts(db);
  await record(db, {
    action: "accounts.csvImported",
    actor: viewer,
    target: { type: "account", id: accountId },
    details: { name: account.name, rows: imported.ids.length },
  });
  return {
    rows: parsed.bookings.length,
    imported: imported.ids.length,
    duplicates: parsed.bookings.length - imported.ids.length,
    invalidLines: parsed.errors.slice(0, 10).map((e) => e.line),
    invalid: parsed.errors.length,
  };
}
