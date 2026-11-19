import { guessMapping } from "@saldo/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accounts, bankConnections, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { listAccounts } from "../accounts/index.ts";
import {
  accountDetail,
  addManualBooking,
  balanceTimeline,
  createAccount,
  deleteAccount,
  deleteBalanceEntry,
  getAccountSharing,
  importCsvBookings,
  listBalanceEntries,
  MAX_CSV_BYTES,
  recordBalance,
  renameAccount,
  setAccountSharing,
} from "./index.ts";

const CSV = `Datum;Händler;Beschreibung;Betrag
05.11.2026;REWE Markt;Einkauf;-23,45
05.11.2026;REWE Markt;Einkauf;-23,45
01.11.2026;givve;Aufladung;50,00
kaputt;x;y;1
`;

describe("manual accounts", () => {
  let su: Viewer;
  let lena: Viewer;
  let max: Viewer;
  let card: number;

  beforeEach(async () => {
    await resetDb();
    su = await makeUser("chef", "superuser");
    lena = await makeUser("lena", "member");
    max = await makeUser("max", "member");
    card = await createAccount(db(), lena, { name: "Givve", bank: "givve", kind: "prepaid", color: "#1f6f5c" });
  });

  it("a member's new account is private to them", async () => {
    const [row] = await db().select().from(accounts).where(eq(accounts.id, card));
    expect(row).toMatchObject({ ownerUserId: lena.id, visibility: "private", kind: "prepaid", connectionId: null });
    await expect(
      createAccount(db(), lena, { name: "Haus", bank: "x", kind: "checking", color: "#1f6f5c", visibility: "household" }),
    ).rejects.toMatchObject({ status: 403 });
    const [own] = await listAccounts(db(), lena);
    expect(own).toMatchObject({
      manual: true,
      canManage: true,
      canShare: true,
      sharing: { visibility: "private", owner: null, sharedWith: [] },
    });
    expect(await listAccounts(db(), max)).toEqual([]);
    expect((await listAccounts(db(), su)).map((a) => a.sharing)).toEqual([{ visibility: "private", owner: "lena", sharedWith: [] }]);
  });

  it("records balances by date; the latest is the balance and the chart follows the entries", async () => {
    await recordBalance(db(), lena, { accountId: card, date: "2026-10-01", balanceCents: 10_000 });
    await recordBalance(db(), lena, { accountId: card, date: "2026-11-01", balanceCents: 5_000 });
    await recordBalance(db(), lena, { accountId: card, date: "2026-10-15", balanceCents: 7_500 });
    // A second entry for a day replaces the first.
    await recordBalance(db(), lena, { accountId: card, date: "2026-11-01", balanceCents: 6_000 });
    expect((await listBalanceEntries(db(), lena, card)).map((e) => [e.date, e.balanceCents])).toEqual([
      ["2026-11-01", 6_000],
      ["2026-10-15", 7_500],
      ["2026-10-01", 10_000],
    ]);
    const now = new Date("2026-11-02T12:00:00");
    const detail = await accountDetail(db(), lena, { accountId: card }, now);
    expect(detail.account).toMatchObject({ balanceCents: 6_000, balanceDate: "2026-11-01", manual: true });
    // The timeline starts at the first entry and changes on each later one.
    expect(await balanceTimeline(db(), lena, { accountId: card }, now)).toMatchObject({
      start: "2026-10-01",
      days: 33,
      balance: [
        [0, 10_000],
        [14, 7_500],
        [31, 6_000],
      ],
    });

    const latest = (await listBalanceEntries(db(), lena, card))[0]?.id ?? -1;
    await deleteBalanceEntry(db(), lena, { accountId: card, id: latest });
    expect((await listAccounts(db(), lena))[0]).toMatchObject({ balanceCents: 7_500, balanceDate: "2026-10-15" });
  });

  it("adds single bookings by hand, never deduplicated, already read", async () => {
    const booking = { accountId: card, bookingDate: "2026-11-03", amountCents: -450, counterparty: "Kiosk", purpose: "Zeitung" };
    await addManualBooking(db(), lena, booking);
    await addManualBooking(db(), lena, booking);
    const rows = await db().select().from(transactions).where(eq(transactions.accountId, card));
    expect(rows.map((r) => [r.source, r.amountCents, r.isUnread])).toEqual([
      ["manual", -450, false],
      ["manual", -450, false],
    ]);
    await expect(addManualBooking(db(), lena, { ...booking, amountCents: 0 })).rejects.toThrow();
  });

  it("imports a CSV file with its mapping; importing it again adds nothing", async () => {
    const mapping = guessMapping(CSV);
    const first = await importCsvBookings(db(), lena, { accountId: card, content: CSV, mapping });
    expect(first).toEqual({ rows: 3, imported: 3, duplicates: 0, invalidLines: [5], invalid: 1 });
    const again = await importCsvBookings(db(), lena, { accountId: card, content: CSV, mapping });
    expect(again).toMatchObject({ rows: 3, imported: 0, duplicates: 3 });
    const rows = await db().select().from(transactions).where(eq(transactions.accountId, card));
    expect(rows.map((r) => [r.source, r.bookingDate, r.amountCents, r.counterparty]).sort()).toEqual([
      ["csv", "2026-11-01", 5_000, "givve"],
      ["csv", "2026-11-05", -2_345, "REWE Markt"],
      ["csv", "2026-11-05", -2_345, "REWE Markt"],
    ]);
    // Imported bookings are classified like all others (the default rules know REWE).
    expect(rows.some((r) => r.categoryId !== null)).toBe(true);
    await expect(importCsvBookings(db(), lena, { accountId: card, content: "nur;text\nohne;datum", mapping })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses files over 2 MB, foreign accounts and accounts with a bank connection", async () => {
    const mapping = guessMapping(CSV);
    const big = `${CSV}${"x".repeat(MAX_CSV_BYTES)}`;
    await expect(importCsvBookings(db(), lena, { accountId: card, content: big, mapping })).rejects.toMatchObject({ status: 413 });
    await expect(importCsvBookings(db(), max, { accountId: card, content: CSV, mapping })).rejects.toMatchObject({ status: 404 });
    await expect(recordBalance(db(), max, { accountId: card, date: "2026-11-01", balanceCents: 1 })).rejects.toMatchObject({
      status: 404,
    });
    const [connection] = await db()
      .insert(bankConnections)
      .values({ name: "DKB", provider: "fints", bank: "dkb", ciphertext: "x", ownerUserId: lena.id, visibility: "private" })
      .returning({ id: bankConnections.id });
    await db()
      .update(accounts)
      .set({ connectionId: connection?.id ?? null })
      .where(eq(accounts.id, card));
    await expect(importCsvBookings(db(), lena, { accountId: card, content: CSV, mapping })).rejects.toMatchObject({ status: 409 });
    await expect(recordBalance(db(), lena, { accountId: card, date: "2026-11-01", balanceCents: 1 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(deleteAccount(db(), lena, card)).rejects.toMatchObject({ status: 409 });
  });

  it("shares with people and groups, only by the owner; a shared viewer can read but not manage", async () => {
    await setAccountSharing(db(), lena, { accountId: card, userIds: [max.id] });
    expect(await getAccountSharing(db(), lena, card)).toMatchObject({ userIds: [max.id], groupIds: [] });
    const [seen] = await listAccounts(db(), max);
    expect(seen).toMatchObject({ id: card, canManage: false, canShare: false, sharing: { owner: "lena", sharedWith: null } });
    expect((await listAccounts(db(), lena))[0]?.sharing.sharedWith).toEqual(["max"]);
    await expect(setAccountSharing(db(), max, { accountId: card, userIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(renameAccount(db(), max, { id: card, name: "Meins" })).rejects.toMatchObject({ status: 403 });
    await expect(deleteAccount(db(), max, card)).rejects.toMatchObject({ status: 403 });
    await setAccountSharing(db(), lena, { accountId: card, userIds: [] });
    expect(await listAccounts(db(), max)).toEqual([]);
    await renameAccount(db(), lena, { id: card, name: "Essenskarte" });
    await deleteAccount(db(), lena, card);
    expect(await listAccounts(db(), lena)).toEqual([]);
  });
});
