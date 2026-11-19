import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { accounts, settings, transactions } from "../../db/schema.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import * as notifications from "../notifications/index.ts";
import { tick } from "./index.ts";

describe("scheduler", () => {
  beforeEach(resetDb);

  it("claims the daily checks once per day from 08:00 on", async () => {
    const admin = await makeUser("admin", "superuser");
    await notifications.savePreferences(db(), admin, {
      preferences: [{ kind: "uncategorized", enabled: true, push: false, email: false, threshold: 0 }],
    });
    const [account] = await db()
      .insert(accounts)
      .values({ name: "Giro", bank: "dkb", kind: "checking", ownerUserId: admin.id })
      .returning();
    await db()
      .insert(transactions)
      .values({ accountId: account?.id ?? -1, externalId: "1", source: "test", bookingDate: "2026-11-10", amountCents: -100 });
    const claimed = async () => (await db().select().from(settings).where(eq(settings.key, "scheduler_daily")))[0]?.value ?? null;

    await tick(db(), new Date(2026, 10, 16, 7, 59));
    expect(await claimed()).toBeNull();
    expect((await notifications.listNotifications(db(), admin)).items).toEqual([]);
    await tick(db(), new Date(2026, 10, 16, 8, 0));
    await tick(db(), new Date(2026, 10, 16, 9, 0));
    expect(await claimed()).toBe("2026-11-16");
    expect((await notifications.listNotifications(db(), admin)).items.map((i) => i.kind)).toEqual(["uncategorized"]);
    await tick(db(), new Date(2026, 10, 17, 8, 0));
    expect(await claimed()).toBe("2026-11-17");
  });
});
