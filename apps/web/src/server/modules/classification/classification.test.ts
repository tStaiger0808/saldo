import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accounts, categories, rules, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { addManualBooking, createAccount } from "../accounts/index.ts";
import { previewRule, saveRule } from "../catalog/index.ts";
import { createDemoData } from "../seed/demo.ts";
import { summary } from "../stats/index.ts";
import { importBookings, patchTransaction } from "../transactions/index.ts";
import { cleanupAiRules, reclassifyAll } from "./index.ts";

const categoryId = async (name: string) => (await db().select().from(categories).where(eq(categories.name, name)))[0]?.id ?? -1;
const dkbId = async () => (await db().select().from(accounts).where(eq(accounts.bank, "dkb")))[0]?.id ?? -1;
const booking = (counterparty: string, amountCents: number, purpose = "") => ({
  bookingDate: "2026-11-14",
  amountCents,
  currency: "EUR",
  counterparty,
  counterpartyIban: null,
  purpose,
});
const byId = async (ids: number[]) =>
  new Map((await db().select().from(transactions).where(inArray(transactions.id, ids))).map((t) => [t.id, t]));

let admin: Viewer;
beforeEach(async () => {
  await resetDb();
  admin = await makeUser("admin", "superuser");
  await createDemoData(db(), new Date("2026-11-15T12:00:00Z"));
});

describe("AI rule cleanup", () => {
  /** The shape seen on real data: several PayPal AI rules learned from either direction, next to ordinary AI rules. */
  async function arrange() {
    const [refunds, other, shopping, otherIncome, restaurant, gifts, saving] = (await Promise.all(
      [
        "Erstattungen",
        "Sonstiges",
        "Shopping",
        "Sonstige Einnahmen",
        "Restaurant & Café",
        "Geschenke & Spenden",
        "Sparen & Investieren",
      ].map(categoryId),
    )) as [number, number, number, number, number, number, number];
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [
        booking("PayPal Europe S.a.r.l. et Cie S.C.A", 2_599, "1043567891234 PP.1234.PP . Zalando SE, Ihr Einkauf bei Zalando SE"),
        booking("PayPal Europe S.a.r.l. et Cie S.C.A", -1_000, "1043567891235 PP.1235.PP . Spotify AB, Ihr Einkauf bei Spotify AB"),
        booking("PayPal (Europe) S.à r.l. et Cie, SCA", -4_999, "1043567891236 PP.1236.PP . Thalia, Ihr Einkauf bei Thalia"),
        booking("PAYPAL", -1_999, "PayPal Zahlung 4711"),
        booking("Max Mustermann", -5_000, "Geschenk"),
        booking("Max Mustermann", 2_500, "Anteil Geschenk"),
        booking("Bausparkasse Mainz", -10_000, "Sparrate"),
        booking("Bausparkasse Mainz", 50_000, "Auszahlung"),
      ],
      "test",
    );
    const [refund, payment, thalia, manual] = ids as [number, number, number, number];
    const aiRule = (pattern: string, category: number) => ({
      pattern,
      field: "counterparty" as const,
      categoryId: category,
      priority: 50,
      source: "ai" as const,
    });
    const inserted = await db()
      .insert(rules)
      .values([
        aiRule("PayPal Europe S.a.r.l. et Cie S.C.A", refunds),
        aiRule("PayPal (Europe) S.a r.l. et Cie, S.C.A.", other),
        aiRule("PayPal (Europe) S.à r.l. et Cie, SCA", shopping),
        aiRule("PAYPAL", otherIncome),
        aiRule("Paypal Europe S.a.r.l. et Cie S.C.A", other),
        aiRule("Gasthof Hirsch", restaurant),
        aiRule("Max Mustermann", gifts),
        aiRule("Bausparkasse Mainz", saving),
      ])
      .returning();
    await db().insert(rules).values({ pattern: "paypal", field: "counterparty", categoryId: shopping, priority: 5, source: "manual" });
    await db().update(transactions).set({ categoryId: gifts, categorySource: "manual" }).where(eq(transactions.id, manual));
    await reclassifyAll(db());
    return { inserted, refund, payment, thalia, manual, gifts, shopping, refunds };
  }

  it("removes intermediary AI rules, gives the others a direction their category fits and never touches manual bookings", async () => {
    const { inserted, refund, payment, thalia, manual, gifts, shopping } = await arrange();
    const before = await db().select().from(rules);

    const dryRun = await cleanupAiRules(db(), { dryRun: true });
    expect(dryRun.remove.map((r) => r.reason)).toEqual(Array(5).fill("intermediary"));
    // "Max Mustermann" matched money both ways; its gift category is an expense, so the rule keeps only outgoing money.
    expect(dryRun.narrow.map((n) => [inserted.find((r) => r.id === n.id)?.pattern, n.direction])).toEqual([
      ["Gasthof Hirsch", "out"],
      ["Max Mustermann", "out"],
    ]);
    expect(await db().select().from(rules)).toEqual(before);

    expect(await cleanupAiRules(db())).toEqual(dryRun);
    const after = await db().select().from(rules).where(eq(rules.source, "ai"));
    expect(after.map((r) => [r.pattern, r.direction]).sort()).toEqual([
      ["Bausparkasse Mainz", "any"],
      ["Gasthof Hirsch", "out"],
      ["Max Mustermann", "out"],
    ]);
    expect((await db().select().from(rules).where(eq(rules.source, "manual"))).map((r) => r.pattern)).toContain("paypal");

    const rows = await byId([refund, payment, thalia, manual]);
    expect(rows.get(manual)).toMatchObject({ categoryId: gifts, categorySource: "manual" });
    // Outgoing PayPal payments fall back to the other rules (the seed rule finds "spotify" in the purpose), the refund
    // gets no expense category.
    expect(rows.get(payment)).toMatchObject({ categoryId: await categoryId("Abos & Medien"), categorySource: "rule" });
    expect(rows.get(thalia)).toMatchObject({ categoryId: shopping, categorySource: "rule" });
    expect(rows.get(refund)).toMatchObject({ categoryId: null, categorySource: null });

    expect(await cleanupAiRules(db())).toEqual({ remove: [], narrow: [] });
  });
});

describe("rule direction and category sources", () => {
  it("applies a rule only in its direction, also in the preview", async () => {
    const otherIncome = await categoryId("Sonstige Einnahmen");
    const { ids } = await importBookings(
      db(),
      await dkbId(),
      [booking("Max Mustermann", -5_000), booking("Max Mustermann", 2_500)],
      "test",
    );
    const [out, inn] = ids as [number, number];
    const draft = { pattern: "Max Mustermann", field: "counterparty" as const, direction: "in" as const };
    expect(await previewRule(db(), admin, draft)).toEqual({ matchCount: 1, examples: ["Max Mustermann"] });
    expect((await previewRule(db(), admin, { ...draft, direction: "any" })).matchCount).toBe(2);
    await saveRule(db(), admin, { ...draft, categoryId: otherIncome });
    const rows = await byId([out, inn]);
    expect(rows.get(inn)).toMatchObject({ categoryId: otherIncome, categorySource: "rule" });
    expect(rows.get(out)).toMatchObject({ categoryId: null });
    expect((await db().select().from(rules).where(eq(rules.pattern, "Max Mustermann")))[0]?.direction).toBe("in");
  });

  it("keeps AI categories when reclassifying and puts manual before AI before rules", async () => {
    const restaurant = await categoryId("Restaurant & Café");
    const shopping = await categoryId("Shopping");
    const rewe = (await db().select().from(transactions).where(eq(transactions.counterparty, "REWE Markt GmbH"))).slice(0, 3);
    const [byAi, byPerson, byRule] = rewe.map((t) => t.id) as [number, number, number];
    await db().update(transactions).set({ categoryId: restaurant, categorySource: "ai" }).where(eq(transactions.id, byAi));
    await db().update(transactions).set({ categoryId: shopping, categorySource: "manual" }).where(eq(transactions.id, byPerson));
    await db()
      .insert(rules)
      .values({ pattern: "REWE Markt GmbH", field: "counterparty", categoryId: shopping, priority: 900, source: "manual" });
    await reclassifyAll(db());
    const rows = await byId([byAi, byPerson, byRule]);
    expect(rows.get(byAi)).toMatchObject({ categoryId: restaurant, categorySource: "ai" });
    expect(rows.get(byPerson)).toMatchObject({ categoryId: shopping, categorySource: "manual" });
    expect(rows.get(byRule)).toMatchObject({ categoryId: shopping, categorySource: "rule" });
  });

  it("keeps a booking's own category when the rule saved from it does not reach it", async () => {
    const otherIncome = await categoryId("Sonstige Einnahmen");
    const shopping = await categoryId("Shopping");
    const { ids } = await importBookings(db(), await dkbId(), [booking("Max Mustermann", -5_000)], "test");
    const [id] = ids as [number];
    await patchTransaction(db(), admin, {
      id,
      categoryId: shopping,
      createRule: { pattern: "Max Mustermann", field: "counterparty", direction: "in" },
    });
    expect((await byId([id])).get(id)).toMatchObject({ categoryId: shopping, categorySource: "manual" });
    await patchTransaction(db(), admin, {
      id,
      categoryId: otherIncome,
      createRule: { pattern: "Max", field: "counterparty", direction: "any" },
    });
    // An income category never reaches an outgoing booking through a rule, so the booking keeps it as its own.
    expect((await byId([id])).get(id)).toMatchObject({ categoryId: otherIncome, categorySource: "manual" });
    await patchTransaction(db(), admin, {
      id,
      categoryId: shopping,
      createRule: { pattern: "Mustermann", field: "counterparty", direction: "out" },
    });
    expect((await byId([id])).get(id)).toMatchObject({ categoryId: shopping, categorySource: "rule" });
  });
});

describe("transfers between people", () => {
  it("never matches another member's private booking to a member's own account, nor pairs a probe with it", async () => {
    const victim = await makeUser("opfer", "member");
    const attacker = await makeUser("neugier", "member");
    const own = await createAccount(db(), victim, { name: "V", bank: "x", kind: "checking", color: "#000000" });
    const salary = await addManualBooking(db(), victim, {
      accountId: own,
      bookingDate: "2026-11-01",
      amountCents: 350_000,
      counterparty: "ACME GmbH",
      purpose: "Gehalt",
    });
    const probeAccount = await createAccount(db(), attacker, {
      name: "A",
      bank: "x",
      kind: "savings",
      color: "#000000",
      transferPatterns: ["acme"],
    });
    const probe = await addManualBooking(db(), attacker, {
      accountId: probeAccount,
      bookingDate: "2026-11-02",
      amountCents: -350_000,
      counterparty: "x",
      purpose: "x",
    });
    const rows = await byId([salary, probe]);
    expect(rows.get(salary)).toMatchObject({ isTransfer: false, transferAccountId: null });
    expect(rows.get(probe)).toMatchObject({ isTransfer: false, transferAccountId: null });
  });

  it("still detects transfers between one person's accounts and between household accounts", async () => {
    const member = await makeUser("lena", "member");
    const giro = await createAccount(db(), member, { name: "Giro", bank: "x", kind: "checking", color: "#000000" });
    const savings = await createAccount(db(), member, {
      name: "Spar",
      bank: "x",
      kind: "savings",
      color: "#000000",
      transferPatterns: ["sparplan"],
    });
    const out = await addManualBooking(db(), member, {
      accountId: giro,
      bookingDate: "2026-11-01",
      amountCents: -10_000,
      counterparty: "Lena",
      purpose: "Sparplan",
    });
    const into = await addManualBooking(db(), member, {
      accountId: savings,
      bookingDate: "2026-11-01",
      amountCents: 10_000,
      counterparty: "Lena",
      purpose: "Eingang",
    });
    const rows = await byId([out, into]);
    expect(rows.get(out)).toMatchObject({ isTransfer: true, transferAccountId: savings });
    expect(rows.get(into)).toMatchObject({ isTransfer: true, transferAccountId: giro });
  });
});

describe("payments through a connected wallet", () => {
  const range = (accountIds: number[]) => ({ dateFrom: "2026-10-01", dateTo: "2026-11-30", accountIds });
  const stored = (accountId: number, externalId: string, bookingDate: string, amountCents: number, counterparty: string, purpose = "") => ({
    accountId,
    externalId,
    source: "test",
    bookingDate,
    amountCents,
    counterparty,
    purpose,
  });

  it("stops counting a PayPal purchase twice, on import and for stored bookings, idempotently", async () => {
    const dkb = await dkbId();
    const paypal = await createAccount(db(), admin, { name: "PayPal", bank: "paypal", kind: "checking", color: "#000000" });
    // Bookings stored before wallet pairing existed: the bank debit and the purchase both count as expenses.
    const rows = await db()
      .insert(transactions)
      .values([
        stored(
          dkb,
          "pp-1",
          "2026-11-05",
          -4_999,
          "PayPal (Europe) S.à r.l. et Cie, S.C.A.",
          "1054534523152/PP.8419.PP/. AliExpress, Ihr Einkauf bei AliExpress",
        ),
        stored(paypal, "pp-2", "2026-11-03", -4_999, "AliExpress"),
        stored(dkb, "pp-3", "2026-11-12", -1_000, "PayPal Europe S.a.r.l. et Cie", "PP.8420.PP . Spotify AB, Ihr Einkauf bei Spotify AB"),
        stored(paypal, "pp-4", "2026-11-12", -1_000, "Spotify AB"),
        stored(dkb, "pp-5", "2026-11-14", -2_000, "PayPal Europe S.a.r.l. et Cie", "PP.8421.PP . Thalia, Ihr Einkauf bei Thalia"),
        stored(paypal, "pp-6", "2026-11-14", -2_500, "Thalia"),
        stored(paypal, "pp-7", "2026-11-14", 1_500, "Max Mustermann", "Anteil Pizza"),
      ])
      .returning({ id: transactions.id });
    const [aliDebit, aliPurchase, spotifyDebit, spotifyPurchase, partial, partialPurchase, receipt] = rows.map((r) => r.id) as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const before = await summary(db(), admin, range([dkb, paypal]));

    await reclassifyAll(db());
    const after = await summary(db(), admin, range([dkb, paypal]));
    expect(before.expensesCents - after.expensesCents).toBe(4_999 + 1_000);
    expect(after.incomeCents).toBe(before.incomeCents);
    const fixed = await byId([aliDebit, aliPurchase, spotifyDebit, spotifyPurchase, partial, partialPurchase, receipt]);
    expect(fixed.get(aliDebit)).toMatchObject({ isTransfer: true, transferAccountId: paypal, categoryId: null });
    expect(fixed.get(spotifyDebit)).toMatchObject({ isTransfer: true, transferAccountId: paypal });
    for (const id of [aliPurchase, spotifyPurchase, partial, partialPurchase, receipt]) {
      expect(fixed.get(id)).toMatchObject({ isTransfer: false, transferAccountId: null });
    }

    await reclassifyAll(db());
    expect(await byId([...fixed.keys()])).toEqual(fixed);
    expect(await summary(db(), admin, range([dkb, paypal]))).toEqual(after);

    await importBookings(db(), paypal, [{ ...booking("Teeladen", -1_299), bookingDate: "2026-11-16" }], "test");
    const { ids } = await importBookings(
      db(),
      dkb,
      [
        {
          ...booking("PayPal Europe S.a.r.l. et Cie", -1_299, "PP.8422.PP . Teeladen, Ihr Einkauf bei Teeladen"),
          bookingDate: "2026-11-18",
        },
      ],
      "test",
    );
    // A bank sync reclassifies right after storing its bookings.
    await reclassifyAll(db());
    const [imported] = ids as [number];
    expect((await byId([imported])).get(imported)).toMatchObject({ isTransfer: true, transferAccountId: paypal });
  });

  it("keeps a manual decision on the bank debit", async () => {
    const dkb = await dkbId();
    const paypal = await createAccount(db(), admin, { name: "PayPal", bank: "paypal", kind: "checking", color: "#000000" });
    await importBookings(db(), paypal, [{ ...booking("AliExpress", -4_999), bookingDate: "2026-11-03" }], "test");
    const { ids } = await importBookings(
      db(),
      dkb,
      [{ ...booking("PayPal Europe S.a.r.l. et Cie", -4_999), bookingDate: "2026-11-04" }],
      "test",
    );
    const [debit] = ids as [number];
    await reclassifyAll(db());
    expect((await byId([debit])).get(debit)).toMatchObject({ isTransfer: true, transferAccountId: paypal });
    await patchTransaction(db(), admin, { id: debit, isTransfer: false });
    await reclassifyAll(db());
    expect((await byId([debit])).get(debit)).toMatchObject({ isTransfer: false, transferManual: true });
  });
});
