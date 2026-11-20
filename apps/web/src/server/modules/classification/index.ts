import { type AiRuleCleanup, type ClassifyRule, classify, planAiRuleCleanup } from "@saldo/core";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { accounts, bankConnections, categories, rules, ruleTags, transactions, transactionTags } from "../../db/schema.ts";

/** All rules with their tags and the kind of their category, as classification needs them. */
export async function loadClassifyRules(db: Db): Promise<(typeof rules.$inferSelect & ClassifyRule)[]> {
  const ruleRows = await db
    .select({ ...getTableColumns(rules), categoryKind: categories.kind })
    .from(rules)
    .leftJoin(categories, eq(categories.id, rules.categoryId));
  const ruleTagRows = await db.select().from(ruleTags);
  return ruleRows.map((r) => ({ ...r, tagIds: ruleTagRows.filter((t) => t.ruleId === r.id).map((t) => t.tagId) }));
}

/** Recomputes transfer flags, rule categories and the tags with their source for all bookings and stores what changed. */
export async function reclassifyAll(db: Db): Promise<void> {
  const accountRows = await db
    .select({
      id: accounts.id,
      iban: accounts.iban,
      transferPatterns: accounts.transferPatterns,
      ownerUserId: accounts.ownerUserId,
      visibility: accounts.visibility,
      name: accounts.name,
      bank: accounts.bank,
      connectionName: bankConnections.name,
      connectionBank: bankConnections.bank,
    })
    .from(accounts)
    .leftJoin(bankConnections, eq(bankConnections.id, accounts.connectionId));
  const classifyRules = await loadClassifyRules(db);
  const txns = await db.select().from(transactions);
  const tagRows = await db.select().from(transactionTags);
  const tagSignature = (tags: { id: number; source: string }[]) =>
    tags
      .map((t) => `${t.id}:${t.source}`)
      .sort()
      .join(",");
  const currentTags = new Map<number, { id: number; source: string }[]>();
  for (const row of tagRows) {
    currentTags.set(row.transactionId, [...(currentTags.get(row.transactionId) ?? []), { id: row.tagId, source: row.source }]);
  }

  const classifyAccounts = accountRows.map((a) => ({ ...a, names: [a.bank, a.name, a.connectionBank, a.connectionName] }));
  const result = classify(txns, classifyAccounts, classifyRules);
  await db.transaction(async (tx) => {
    for (const txn of txns) {
      const next = result.get(txn.id);
      if (!next) continue;
      if (
        next.isTransfer !== txn.isTransfer ||
        next.transferAccountId !== txn.transferAccountId ||
        next.categoryId !== txn.categoryId ||
        next.categorySource !== txn.categorySource
      ) {
        await tx
          .update(transactions)
          .set({
            isTransfer: next.isTransfer,
            transferAccountId: next.transferAccountId,
            categoryId: next.categoryId,
            categorySource: next.categorySource,
          })
          .where(eq(transactions.id, txn.id));
      }
      if (tagSignature(currentTags.get(txn.id) ?? []) !== tagSignature(next.tags)) {
        await tx.delete(transactionTags).where(eq(transactionTags.transactionId, txn.id));
        if (next.tags.length > 0) {
          await tx.insert(transactionTags).values(next.tags.map((t) => ({ transactionId: txn.id, tagId: t.id, source: t.source })));
        }
      }
    }
  });
}

export async function tagsOf(db: Db, transactionIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (transactionIds.length === 0) return map;
  for (const row of await db.select().from(transactionTags).where(inArray(transactionTags.transactionId, transactionIds))) {
    map.set(row.transactionId, [...(map.get(row.transactionId) ?? []), row.tagId]);
  }
  return map;
}

/**
 * Applies `planAiRuleCleanup` to the stored AI rules and reclassifies when something changed; idempotent, so it runs on
 * every start. Manual categories never change, because classification keeps them.
 */
export async function cleanupAiRules(db: Db, { dryRun = false }: { dryRun?: boolean } = {}): Promise<AiRuleCleanup> {
  const aiRules = (await loadClassifyRules(db)).filter((r) => r.source === "ai");
  if (aiRules.length === 0) return { remove: [], narrow: [] };
  const txns = await db
    .select({
      counterparty: transactions.counterparty,
      purpose: transactions.purpose,
      amountCents: transactions.amountCents,
      isTransfer: transactions.isTransfer,
    })
    .from(transactions);
  const plan = planAiRuleCleanup(aiRules, txns);
  if (dryRun || (plan.remove.length === 0 && plan.narrow.length === 0)) return plan;
  await db.transaction(async (tx) => {
    if (plan.remove.length > 0)
      await tx.delete(rules).where(
        inArray(
          rules.id,
          plan.remove.map((r) => r.id),
        ),
      );
    for (const { id, direction } of plan.narrow) await tx.update(rules).set({ direction }).where(eq(rules.id, id));
  });
  await reclassifyAll(db);
  return plan;
}
