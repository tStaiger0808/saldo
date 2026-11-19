/** Depot positions: replaced by each sync, with the depot's value as its balance and one balance entry per day. */
import type { RawHolding } from "@saldo/banking";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { accountBalanceEntries, accountHoldings, accounts } from "../../db/schema.ts";
import { requireVisibleAccount, type Viewer } from "../access/index.ts";

export type Holding = {
  isin: string | null;
  name: string;
  quantity: number;
  price: number | null;
  currency: string;
  valueCents: number;
  costBasisCents: number | null;
  asOf: string;
};

/**
 * Stores the positions of a depot as delivered and sets its balance to `totalCents` (the bank's total, or the sum of the
 * positions) as of `day`, also as that day's balance entry so the balance chart has a history.
 */
export async function replaceHoldings(db: Db, accountId: number, holdings: RawHolding[], totalCents: number, day: string): Promise<void> {
  await db.delete(accountHoldings).where(eq(accountHoldings.accountId, accountId));
  if (holdings.length > 0) await db.insert(accountHoldings).values(holdings.map((h) => ({ ...h, accountId })));
  await db
    .insert(accountBalanceEntries)
    .values({ accountId, date: day, balanceCents: totalCents, createdBy: null })
    .onConflictDoUpdate({
      target: [accountBalanceEntries.accountId, accountBalanceEntries.date],
      set: { balanceCents: totalCents, createdBy: null },
    });
  await db.update(accounts).set({ balanceCents: totalCents, balanceDate: day }).where(eq(accounts.id, accountId));
}

export async function listHoldings(db: Db, viewer: Viewer, accountId: number): Promise<Holding[]> {
  await requireVisibleAccount(db, viewer, accountId);
  const rows = await db
    .select()
    .from(accountHoldings)
    .where(eq(accountHoldings.accountId, accountId))
    .orderBy(desc(accountHoldings.valueCents), asc(accountHoldings.name));
  return rows.map(({ id: _, accountId: __, ...h }) => h);
}
