import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { createSavedFilter, deleteSavedFilter, listSavedFilters, updateSavedFilter } from "./index.ts";

describe("saved booking filters", () => {
  let anna: Viewer;
  let ben: Viewer;

  beforeEach(async () => {
    await resetDb();
    anna = await makeUser("anna", "familyAdmin");
    ben = await makeUser("ben", "member");
  });

  it("creates, renames, overwrites and deletes a filter, with relative periods kept relative", async () => {
    const saved = await createSavedFilter(db(), anna, {
      scope: "transactions",
      name: "Lebensmittel",
      filter: { categoryId: 4, period: "last_3_months", q: "rewe", groupId: 2 },
    });
    expect(saved).toMatchObject({ name: "Lebensmittel", isDefault: false, filter: { categoryId: 4, period: "last_3_months", q: "rewe" } });
    await updateSavedFilter(db(), anna, { id: saved.id, name: "Einkauf" });
    await updateSavedFilter(db(), anna, { id: saved.id, filter: { direction: "out", dateFrom: "2026-01-01", dateTo: "2026-03-31" } });
    expect(await listSavedFilters(db(), anna, { scope: "transactions" })).toEqual([
      { id: saved.id, name: "Einkauf", isDefault: false, filter: { direction: "out", dateFrom: "2026-01-01", dateTo: "2026-03-31" } },
    ]);
    await deleteSavedFilter(db(), anna, { id: saved.id });
    expect(await listSavedFilters(db(), anna, { scope: "transactions" })).toEqual([]);
  });

  it("keeps the names unique per page and refuses empty names", async () => {
    await createSavedFilter(db(), anna, { scope: "transactions", name: "Neu", filter: { unread: true } });
    await expect(createSavedFilter(db(), anna, { scope: "transactions", name: "Neu", filter: {} })).rejects.toMatchObject({ status: 409 });
    await expect(createSavedFilter(db(), anna, { scope: "transactions", name: "  ", filter: {} })).rejects.toThrow();
    // Another page or another person may use the same name.
    await createSavedFilter(db(), anna, { scope: "account", name: "Neu", filter: { unread: true } });
    await createSavedFilter(db(), ben, { scope: "transactions", name: "Neu", filter: {} });
  });

  it("is private: someone else's filter does not exist for them", async () => {
    const mine = await createSavedFilter(db(), anna, { scope: "transactions", name: "Privat", filter: { q: "arzt" } });
    expect(await listSavedFilters(db(), ben, { scope: "transactions" })).toEqual([]);
    await expect(updateSavedFilter(db(), ben, { id: mine.id, name: "Gekapert" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteSavedFilter(db(), ben, { id: mine.id })).rejects.toMatchObject({ status: 404 });
    expect((await listSavedFilters(db(), anna, { scope: "transactions" }))[0]?.name).toBe("Privat");
  });

  it("has at most one default per page, which can be moved and removed", async () => {
    const a = await createSavedFilter(db(), anna, { scope: "transactions", name: "A", filter: {}, isDefault: true });
    const b = await createSavedFilter(db(), anna, { scope: "transactions", name: "B", filter: { unread: true }, isDefault: true });
    const other = await createSavedFilter(db(), anna, { scope: "account", name: "C", filter: {}, isDefault: true });
    const defaults = async (scope: "transactions" | "account") =>
      (await listSavedFilters(db(), anna, { scope })).filter((s) => s.isDefault).map((s) => s.id);
    expect(await defaults("transactions")).toEqual([b.id]);
    expect(await defaults("account")).toEqual([other.id]);
    await updateSavedFilter(db(), anna, { id: a.id, isDefault: true });
    expect(await defaults("transactions")).toEqual([a.id]);
    await updateSavedFilter(db(), anna, { id: a.id, isDefault: false });
    expect(await defaults("transactions")).toEqual([]);
  });

  it("stores no account or group for an account's page and drops unknown keys", async () => {
    const saved = await createSavedFilter(db(), anna, {
      scope: "account",
      name: "Ohne Kategorie",
      filter: { uncategorized: true, accountId: 3, groupId: 1, unknown: "x" } as never,
    });
    expect(saved.filter).toEqual({ uncategorized: true });
  });
});
