import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accountGroups, rules, ruleTags, tags, transactions, transactionTags } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { reclassifyAll } from "../classification/index.ts";
import { createDemoData } from "../seed/demo.ts";
import { deleteTag, ensureAiTags, mergeTag, tagOverview } from "./index.ts";

let admin: Viewer;
let member: Viewer;
beforeEach(async () => {
  await resetDb();
  admin = await makeUser("admin", "superuser");
  await createDemoData(db(), new Date("2026-11-15T12:00:00Z"));
  const [shared] = await db().select().from(accountGroups).where(eq(accountGroups.name, "Gemeinschaftskonto"));
  member = await makeUser("partnerin", "member", [shared?.id ?? -1]);
});

const bookingOf = async (counterparty: string) =>
  (await db().select().from(transactions).where(eq(transactions.counterparty, counterparty)))[0];

async function arrange() {
  const [holiday, trip, other] = await db()
    .insert(tags)
    .values([
      { name: "Urlaub", color: "#123456" },
      { name: "Reise", color: "#123456", createdBy: "ai" },
      { name: "Sonstwas", color: "#123456" },
    ])
    .returning();
  const [rule] = await db().insert(rules).values({ pattern: "Netflix", field: "counterparty", priority: 100 }).returning();
  await db()
    .insert(ruleTags)
    .values([
      { ruleId: rule?.id ?? -1, tagId: trip?.id ?? -1 },
      { ruleId: rule?.id ?? -1, tagId: holiday?.id ?? -1 },
    ]);
  const rent = await bookingOf("Hausverwaltung Sonnenhalde");
  const cafe = await bookingOf("Cafe Kult");
  await db()
    .update(transactions)
    .set({ manualTagIds: [trip?.id ?? -1, other?.id ?? -1] })
    .where(eq(transactions.id, rent?.id ?? -1));
  await db()
    .update(transactions)
    .set({ aiTagIds: [trip?.id ?? -1] })
    .where(eq(transactions.id, cafe?.id ?? -1));
  await reclassifyAll(db());
  return { holiday, trip, other, rule, rent, cafe };
}

describe("tag review", () => {
  it("lists who created each tag and counts only the bookings the viewer may see", async () => {
    const { trip } = await arrange();
    const overview = await tagOverview(db(), admin);
    const reise = overview.find((t) => t.id === trip?.id);
    const netflix = (await db().select().from(transactions).where(eq(transactions.counterparty, "Netflix International B.V."))).length;
    expect(reise).toMatchObject({ name: "Reise", createdBy: "ai" });
    expect(reise?.bookings).toBe(netflix + 2);
    // The member sees the joint account only: the rent booking, not the card or Netflix.
    expect((await tagOverview(db(), member)).find((t) => t.id === trip?.id)?.bookings).toBe(1);
  });

  it("merges a tag into another: bookings keep their source, rules move, the old tag is gone", async () => {
    const { holiday, trip, other, rule, rent, cafe } = await arrange();
    await expect(mergeTag(db(), member, { id: trip?.id ?? -1, intoId: holiday?.id ?? -1 })).rejects.toMatchObject({ status: 403 });
    await expect(mergeTag(db(), admin, { id: trip?.id ?? -1, intoId: trip?.id ?? -1 })).rejects.toMatchObject({ status: 400 });
    await expect(mergeTag(db(), admin, { id: 999_999, intoId: holiday?.id ?? -1 })).rejects.toMatchObject({ status: 404 });

    await mergeTag(db(), admin, { id: trip?.id ?? -1, intoId: holiday?.id ?? -1 });
    expect((await db().select().from(tags)).map((t) => t.name).sort()).toEqual(["Sonstwas", "Urlaub"]);
    expect(
      (
        await db()
          .select()
          .from(ruleTags)
          .where(eq(ruleTags.ruleId, rule?.id ?? -1))
      ).map((l) => l.tagId),
    ).toEqual([holiday?.id]);
    const [rentAfter] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.id, rent?.id ?? -1));
    const [cafeAfter] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.id, cafe?.id ?? -1));
    expect(rentAfter?.manualTagIds).toEqual([holiday?.id, other?.id].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(cafeAfter?.aiTagIds).toEqual([holiday?.id]);
    const links = await db()
      .select()
      .from(transactionTags)
      .where(eq(transactionTags.tagId, holiday?.id ?? -1));
    expect(links.find((l) => l.transactionId === rent?.id)?.source).toBe("manual");
    expect(links.find((l) => l.transactionId === cafe?.id)?.source).toBe("ai");
  });

  it("deletes a tag from manual and AI lists alike", async () => {
    const { trip, rent, cafe } = await arrange();
    await deleteTag(db(), admin, trip?.id ?? -1);
    const [rentAfter] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.id, rent?.id ?? -1));
    const [cafeAfter] = await db()
      .select()
      .from(transactions)
      .where(eq(transactions.id, cafe?.id ?? -1));
    expect(rentAfter?.manualTagIds).not.toContain(trip?.id);
    expect(cafeAfter?.aiTagIds).toEqual([]);
  });

  it("reuses an existing tag of the same normalized name instead of creating an AI tag", async () => {
    await db().insert(tags).values({ name: "Home Office", color: "#123456" });
    const { ids, created } = await ensureAiTags(db(), ["home-office", "Garten", "garten"]);
    expect(created).toBe(1);
    expect(ids).toHaveLength(2);
    expect((await db().select().from(tags)).map((t) => [t.name, t.createdBy]).sort()).toEqual([
      ["Garten", "ai"],
      ["Home Office", "user"],
    ]);
  });
});
