/** Deterministic demo bookings so dashboards can be tried before a bank is connected. Only for an empty database. */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import {
  accountGroupMembers,
  accountGroups,
  accounts,
  categories,
  pendingTransactions,
  rules,
  transactions,
  user,
} from "../../db/schema.ts";
import { reclassifyAll } from "../classification/index.ts";
import { relinkContracts } from "../contracts/index.ts";

const MONTHS = 12;

function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)] as T,
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** The demo accounts are household accounts of the first superuser. */
export async function createDemoData(db: Db, today = new Date()): Promise<number> {
  if ((await db.select({ id: accounts.id }).from(accounts).limit(1)).length > 0)
    throw new Error("Es gibt schon Konten; Demodaten nur für eine leere Datenbank.");
  const [owner] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "superuser"))
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(1);
  if (!owner) throw new Error("Demodaten brauchen einen Super-User als Besitzer.");
  const rng = random(42);
  const insert = async (values: Omit<typeof accounts.$inferInsert, "ownerUserId">) =>
    (
      await db
        .insert(accounts)
        .values({ ...values, ownerUserId: owner.id })
        .returning()
    )[0] as typeof accounts.$inferSelect;
  const dkb = await insert({ name: "DKB Girokonto", bank: "dkb", kind: "checking", iban: "DE02120300000000202051", color: "#2563eb" });
  const ing = await insert({ name: "ING Extra-Konto", bank: "ing", kind: "savings", iban: "DE02500105170137075030", color: "#f97316" });
  const tr = await insert({
    name: "Trade Republic",
    bank: "trade_republic",
    kind: "brokerage",
    iban: "DE02100100100006820101",
    transferPatterns: ["trade republic"],
    color: "#111827",
  });
  const card = await insert({
    name: "Bank Norwegian Visa",
    bank: "bank_norwegian",
    kind: "credit_card",
    transferPatterns: ["bank norwegian"],
    color: "#dc2626",
  });
  const joint = await insert({
    name: "Comdirect Gemeinschaftskonto",
    bank: "comdirect",
    kind: "checking",
    iban: "DE02200411330506090200",
    color: "#facc15",
  });
  const [mine] = await db.insert(accountGroups).values({ name: "Meine Konten", position: 0 }).returning();
  const [shared] = await db.insert(accountGroups).values({ name: "Gemeinschaftskonto", position: 1 }).returning();
  if (!mine || !shared) throw new Error("Gruppen konnten nicht angelegt werden");
  await db
    .insert(accountGroupMembers)
    .values([...[dkb, ing, tr, card].map((a) => ({ accountId: a.id, groupId: mine.id })), { accountId: joint.id, groupId: shared.id }]);

  const rows: (typeof transactions.$inferInsert)[] = [];
  const todayIso = iso(today);
  const add = (account: { id: number }, day: Date, cents: number, counterparty: string, purpose: string, iban: string | null = null) => {
    if (iso(day) > todayIso) return;
    rows.push({
      accountId: account.id,
      externalId: `demo-${rows.length}`,
      source: "demo",
      bookingDate: iso(day),
      amountCents: cents,
      counterparty,
      counterpartyIban: iban,
      purpose,
      isUnread: (today.getTime() - day.getTime()) / 86_400_000 <= 3,
    });
  };

  for (let back = MONTHS - 1; back >= 0; back--) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    const month = String(first.getUTCMonth() + 1).padStart(2, "0");
    add(dkb, addDays(first, 27), 352_000, "Muster GmbH", `Lohn/Gehalt ${month}/${first.getUTCFullYear()}`);
    add(dkb, addDays(first, 1), -120_000, "Alex Beispiel", "Beitrag Haushalt", joint.iban);
    add(dkb, addDays(first, 2), -30_000, "Trade Republic", "Sparplan Einzahlung", tr.iban);
    add(tr, addDays(first, 2), 30_000, "Alex Beispiel", "Einzahlung", dkb.iban);
    add(tr, addDays(first, 3), -30_000, "Sparplan", "Sparplan MSCI World ETF");
    add(dkb, addDays(first, 5), -20_000, "ING", "Übertrag Extra-Konto", ing.iban);
    add(ing, addDays(first, 5), 20_000, "Alex Beispiel", "Übertrag", dkb.iban);
    add(dkb, addDays(first, 3), -1_399, "Netflix International B.V.", "Netflix Abo");
    add(dkb, addDays(first, 4), -1_099, "Spotify AB", "Spotify Premium");
    add(dkb, addDays(first, 10), -8_950, "HUK-COBURG", "KFZ-Versicherung");
    add(dkb, addDays(first, 12), -3_999, "Fitnessstudio Allgäu Aktiv", "Mitgliedsbeitrag");
    add(dkb, addDays(first, 15), -2_995, "Telekom Deutschland GmbH", "Mobilfunk Rechnung");

    const cardBookings: [number, number, string, string][] = [];
    for (let i = rng.int(6, 9); i > 0; i--)
      cardBookings.push([
        rng.int(0, 27),
        -rng.int(1_200, 9_500),
        rng.pick(["REWE Markt GmbH", "EDEKA Immenstadt", "ALDI SUED", "LIDL Dienstleistung"]),
        "Kartenzahlung",
      ]);
    for (let i = rng.int(2, 4); i > 0; i--)
      cardBookings.push([
        rng.int(0, 27),
        -rng.int(1_800, 6_500),
        rng.pick(["Gasthof Hirsch", "Cafe Kult", "Pizzeria Da Mario"]),
        "Kartenzahlung",
      ]);
    for (let i = rng.int(1, 3); i > 0; i--)
      cardBookings.push([rng.int(0, 27), -rng.int(5_000, 8_500), rng.pick(["ARAL Station", "Shell Deutschland"]), "Tanken"]);
    if (rng.next() < 0.7) cardBookings.push([rng.int(0, 27), -rng.int(1_500, 14_000), "AMAZON EU S.A R.L.", "Bestellung"]);
    if (rng.next() < 0.4) cardBookings.push([rng.int(0, 27), -rng.int(2_000, 12_000), "Bergsport Oberstdorf", "Ausrüstung"]);
    if ([7, 8].includes(first.getUTCMonth() + 1) && rng.next() < 0.9)
      cardBookings.push([rng.int(0, 20), -rng.int(30_000, 90_000), "Booking.com", "Hotel Urlaub Gardasee"]);
    let cardTotal = 0;
    for (const [offset, cents, counterparty, purpose] of cardBookings) {
      const day = addDays(first, offset);
      add(card, day, cents, counterparty, purpose);
      if (iso(day) <= todayIso) cardTotal += cents;
    }
    if (cardTotal && back > 0) {
      add(dkb, addDays(first, 35), cardTotal, "Bank Norwegian", "Kreditkartenabrechnung");
      add(card, addDays(first, 35), -cardTotal, "Zahlung erhalten", "Ausgleich Kreditkarte");
    }

    add(joint, addDays(first, 1), 120_000, "Alex Beispiel", "Beitrag Haushalt", dkb.iban);
    add(joint, addDays(first, 1), 120_000, "Partnerin Haushalt", "Beitrag Haushalt");
    add(joint, addDays(first, 3), -145_000, "Hausverwaltung Sonnenhalde", "Miete inkl. NK");
    add(joint, addDays(first, 8), -9_500, "Allgäuer Überlandwerk", "Abschlag Strom");
    add(joint, addDays(first, 9), -4_499, "Vodafone GmbH", "Internet");
    add(joint, addDays(first, 15), -1_899, "Rundfunk ARD ZDF", "Rundfunkbeitrag");
    for (let i = rng.int(4, 7); i > 0; i--) {
      add(
        joint,
        addDays(first, rng.int(0, 27)),
        -rng.int(2_500, 14_000),
        rng.pick(["REWE Markt GmbH", "Feneberg", "dm-drogerie markt", "EDEKA Immenstadt"]),
        "Einkauf",
      );
    }
    if (rng.next() < 0.5) add(joint, addDays(first, rng.int(0, 27)), -rng.int(10_000, 60_000), "IKEA Deutschland", "Möbel");
  }

  await db.insert(transactions).values(rows);
  const [contribution] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, "Sonstige Einnahmen"));
  await db.insert(rules).values({
    pattern: "partnerin haushalt",
    field: "counterparty",
    categoryId: contribution?.id ?? null,
    priority: 100,
    source: "manual",
  });
  await reclassifyAll(db);
  await relinkContracts(db);
  const balances: [number, number][] = [
    [dkb.id, 412_350],
    [ing.id, 1_250_000],
    [tr.id, 845_210],
    [card.id, -38_740],
    [joint.id, 186_420],
  ];
  for (const [id, cents] of balances)
    await db.update(accounts).set({ balanceCents: cents, balanceDate: todayIso }).where(eq(accounts.id, id));
  await db.insert(pendingTransactions).values([
    {
      accountId: dkb.id,
      bookingDate: todayIso,
      amountCents: -2_340,
      counterparty: "Bio-Laden Sonthofen",
      purpose: "Kartenzahlung girocard",
      fetchedAt: today,
    },
    {
      accountId: dkb.id,
      bookingDate: iso(addDays(today, -1)),
      amountCents: -4_990,
      counterparty: "DB Fernverkehr AG",
      purpose: "Fahrkarte Online",
      fetchedAt: today,
    },
    {
      accountId: card.id,
      bookingDate: todayIso,
      amountCents: -6_200,
      counterparty: "Bergbahnen Oberstdorf",
      purpose: "Kartenzahlung",
      fetchedAt: today,
    },
  ]);
  return rows.length;
}

if (import.meta.main) {
  const { db, closeDatabase } = await import("../../db/index.ts");
  const { seedDefaults } = await import("./index.ts");
  await seedDefaults(db());
  console.log(`Created ${await createDemoData(db())} demo transactions`);
  await closeDatabase();
}
