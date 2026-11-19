import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountGroups, accounts, categories, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createDemoData } from "../seed/demo.ts";
import * as stats from "../stats/index.ts";
import { exportCsv, importBookings, listTransactions, markAllRead, patchTransaction } from "./index.ts";

const TODAY = new Date("2026-11-15T12:00:00Z");
const NOVEMBER = { dateFrom: "2026-11-01", dateTo: "2026-11-30" };

async function setup() {
  await resetDb();
  const admin = await makeUser("admin", "superuser");
  await createDemoData(db(), TODAY);
  const groups = await db().select().from(accountGroups);
  const mine = groups.find((g) => g.name === "Meine Konten")?.id ?? -1;
  const shared = groups.find((g) => g.name === "Gemeinschaftskonto")?.id ?? -1;
  return { admin, mine, shared };
}

describe("bookings and statistics with groups", () => {
  let admin: Viewer;
  let mine: number;
  let shared: number;
  beforeEach(async () => ({ admin, mine, shared } = await setup()));

  it("hides transfers inside a group and counts the household contribution as leaving 'Meine Konten'", async () => {
    const own = await stats.categoryTotals(db(), admin, { ...NOVEMBER, groupId: mine }, "expense");
    expect(own.find((c) => c.name === "Übertrag an Comdirect Gemeinschaftskonto")?.amountCents).toBe(120_000);
    // Card settlement, savings and broker transfers stay inside the group.
    expect(own.some((c) => c.name.includes("Bank Norwegian") || c.name.includes("ING"))).toBe(false);
    const sharedIncome = await stats.summary(db(), admin, { ...NOVEMBER, groupId: shared });
    expect(sharedIncome.incomeCents).toBe(240_000);
    // Viewing everything, the contribution is internal and disappears from both sides.
    const all = await stats.categoryTotals(db(), admin, { ...NOVEMBER, groupId: null }, "expense");
    expect(all.some((c) => c.name.startsWith("Übertrag"))).toBe(false);
  });

  it("labels bookings with their transfer kind relative to the selected group", async () => {
    const page = await listTransactions(db(), admin, { groupId: mine, ...NOVEMBER, limit: 200 });
    const contribution = page.items.find((t) => t.purpose === "Beitrag Haushalt");
    expect(contribution).toMatchObject({ transferKind: "external", transferLabel: "Übertrag an Comdirect Gemeinschaftskonto" });
    const english = await listTransactions(db(), { ...admin, locale: "en" }, { groupId: mine, ...NOVEMBER, limit: 200 });
    expect(english.items.find((t) => t.purpose === "Beitrag Haushalt")?.transferLabel).toBe("Transfer to Comdirect Gemeinschaftskonto");
    expect(await exportCsv(db(), { ...admin, locale: "en" }, { groupId: mine, ...NOVEMBER })).toContain(
      "Übertrag an Comdirect Gemeinschaftskonto",
    );
    expect(page.items.find((t) => t.purpose === "Übertrag Extra-Konto")?.transferKind).toBe("internal");
    const withoutInternal = await listTransactions(db(), admin, { groupId: mine, ...NOVEMBER, includeTransfers: false, limit: 200 });
    expect(withoutInternal.items.some((t) => t.transferKind === "internal")).toBe(false);
  });

  it("lets a member see and edit only bookings of their groups", async () => {
    const partner = await makeUser("partnerin", "member", [shared]);
    const visible = await listTransactions(db(), partner, { limit: 500 });
    const jointId = (await db().select().from(accounts).where(eq(accounts.bank, "comdirect")))[0]?.id;
    expect(visible.items.every((t) => t.accountId === jointId)).toBe(true);
    await expect(listTransactions(db(), partner, { groupId: mine })).rejects.toMatchObject({ status: 404 });
    const foreign = (
      await db()
        .select()
        .from(transactions)
        .where(eq(transactions.accountId, (await db().select().from(accounts).where(eq(accounts.bank, "dkb")))[0]?.id ?? -1))
    )[0];
    await expect(patchTransaction(db(), partner, { id: foreign?.id ?? -1, note: "x" })).rejects.toMatchObject({ status: 404 });
    const own = visible.items[0];
    await patchTransaction(db(), partner, { id: own?.id ?? -1, note: "Gesehen", isUnread: false });
    await expect(patchTransaction(db(), partner, { id: own?.id ?? -1, isTransfer: true })).rejects.toMatchObject({ status: 403 });
    const csv = await exportCsv(db(), partner, {});
    expect(csv).toContain("Hausverwaltung Sonnenhalde");
    expect(csv).not.toContain("Muster GmbH");
  });

  it("creates a rule from a booking that then categorizes all matching bookings", async () => {
    const [food] = await db().select().from(categories).where(eq(categories.name, "Wohnen"));
    const rent = (await listTransactions(db(), admin, { q: "Hausverwaltung", limit: 50 })).items;
    await patchTransaction(db(), admin, {
      id: rent[0]?.id ?? -1,
      categoryId: food?.id,
      createRule: { pattern: "hausverwaltung", field: "counterparty" },
    });
    const after = (await listTransactions(db(), admin, { q: "Hausverwaltung", limit: 50 })).items;
    expect(after.every((t) => t.categoryId === food?.id && t.categorySource === "rule")).toBe(true);
  });

  it("finds bookings regardless of case and accents", async () => {
    const [first] = await db().select().from(transactions).limit(1);
    await db()
      .update(transactions)
      .set({ counterparty: "Bäckerei Allgäu" })
      .where(eq(transactions.id, first?.id ?? -1));
    const ids = (q: string) => listTransactions(db(), admin, { q, limit: 50 }).then((r) => r.items.map((t) => t.id));
    expect(await ids("backerei allgau")).toEqual([first?.id]);
    expect(await ids("BÄCKEREI")).toEqual([first?.id]);
  });

  it("marks only the selected group as read", async () => {
    await markAllRead(db(), admin, shared);
    expect((await listTransactions(db(), admin, { groupId: shared })).unread).toBe(0);
    expect((await listTransactions(db(), admin, { groupId: mine })).unread).toBeGreaterThan(0);
  });

  it("imports bank bookings once, cleans bad fields and neutralizes formulas in the export", async () => {
    const [account] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    const booking = {
      bookingDate: "2026-11-14",
      amountCents: -500,
      currency: "=A1",
      counterparty: '=HYPERLINK("x")',
      counterpartyIban: "DE00",
      purpose: "+1",
      providerId: "p1",
    };
    expect((await importBookings(db(), account?.id ?? -1, [booking, { ...booking, providerId: "p".repeat(80) }], "eb")).ids).toHaveLength(
      2,
    );
    expect((await importBookings(db(), account?.id ?? -1, [booking], "eb")).ids).toEqual([]);
    const [stored] = await db().select().from(transactions).where(eq(transactions.externalId, "eb:id:p1"));
    expect(stored).toMatchObject({ currency: "XXX", counterpartyIban: null });
    const csv = await exportCsv(db(), admin, { q: "HYPERLINK" });
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1");
  });

  it("marks bookings older than a week as read on an account's first import only", async () => {
    // The demo bookings do not count: the first bank import of this account is still its first import.
    const [account] = await db().select().from(accounts).where(eq(accounts.bank, "dkb"));
    const accountId = account?.id ?? -1;
    const booking = (day: string, id: string) => ({
      bookingDate: day,
      amountCents: -250,
      currency: "EUR",
      counterparty: "Bäckerei",
      counterpartyIban: null,
      purpose: "Brot",
      providerId: id,
    });
    const days = { a: "2026-11-14", b: "2026-11-08", c: "2026-11-07", d: "2026-02-01" };
    const first = await importBookings(
      db(),
      accountId,
      Object.entries(days).map(([id, day]) => booking(day, id)),
      "eb",
      "2026-11-15",
    );
    expect(first.firstImport).toBe(true);
    expect(first.ids).toHaveLength(4);
    const unread = async () =>
      (await db().select().from(transactions).where(eq(transactions.source, "eb")))
        .filter((t) => t.isUnread)
        .map((t) => t.externalId)
        .sort();
    expect(await unread()).toEqual(["eb:id:a", "eb:id:b"]);
    expect(first.unreadIds).toHaveLength(2);

    const next = await importBookings(db(), accountId, [booking("2026-01-05", "e")], "eb", "2026-11-15");
    expect(next).toMatchObject({ firstImport: false, unreadIds: next.ids });
    expect(await unread()).toEqual(["eb:id:a", "eb:id:b", "eb:id:e"]);
  });
});
