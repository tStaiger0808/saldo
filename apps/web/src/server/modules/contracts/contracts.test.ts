import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTRACT_PREFERENCES } from "../../../lib/contract-preferences.ts";
import { db } from "../../db/index.ts";
import {
  accounts,
  categories,
  contractPreferences,
  contractViewHidden,
  contractViewShares,
  contractViews,
  transactions,
} from "../../db/schema.ts";
import { localizeError } from "../../errors.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { addManualBooking, createAccount, createGroup, setAccountSharing } from "../accounts/index.ts";
import { serverFnAllowedWhileImpersonating } from "../impersonation/index.ts";
import {
  checkContracts,
  checkUpcomingContracts,
  listNotifications,
  notifyAfterSync,
  savePreferences,
  setNotificationDepsForTests,
} from "../notifications/index.ts";
import { summary } from "../stats/index.ts";
import { toolsFor } from "../tools/index.ts";
import { deleteUser } from "../users/index.ts";
import {
  acceptSuggestion,
  type ContractInput,
  contractDraftFromBooking,
  contractForecast,
  contractSuggestionOverview,
  contractSuggestions,
  contractsOverview,
  contractViewShareCoverage,
  deleteContract,
  deleteContractView,
  dismissSuggestion,
  getContract,
  getContractPreferences,
  listContracts,
  listContractViews,
  markDueSeen,
  relinkContracts,
  restoreSuggestion,
  saveContract,
  saveContractPreferences,
  saveContractView,
  setContractViewHidden,
  unseenDueCount,
} from "./index.ts";

const TODAY = "2026-11-17";

describe("contracts", () => {
  let admin: Viewer;
  let parent: Viewer;
  let member: Viewer;
  let outsider: Viewer;
  let kids: number;
  let shared: number;
  let household: number;
  let privateOfParent: number;

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser("admin", "superuser");
    parent = await makeUser("eltern", "familyAdmin");
    kids = await createGroup(db(), admin, { name: "Kinder" });
    member = await makeUser("kind", "member", [kids]);
    outsider = await makeUser("gast", "member");
    shared = await createAccount(db(), admin, { name: "Taschengeld", bank: "dkb", kind: "checking", color: "#1f6f5c", groupIds: [kids] });
    household = await createAccount(db(), admin, { name: "Haushalt", bank: "dkb", kind: "checking", color: "#1f6f5c" });
    privateOfParent = await createAccount(db(), parent, {
      name: "Eltern privat",
      bank: "dkb",
      kind: "checking",
      color: "#1f6f5c",
      visibility: "private",
    });
  });

  afterEach(() => setNotificationDepsForTests({}));

  async function book(accountId: number, amountCents: number, counterparty: string, bookingDate: string, purpose = "") {
    const [row] = await db()
      .insert(transactions)
      .values({ accountId, externalId: `x-${Math.random()}`, source: "test", bookingDate, amountCents, counterparty, purpose })
      .returning({ id: transactions.id });
    return row?.id ?? -1;
  }

  const netflix = (accountId: number | null, extra: Partial<ContractInput> = {}): ContractInput => ({
    name: "Netflix",
    direction: "expense",
    amountCents: 1_299,
    interval: "monthly",
    nextDue: "2026-12-03",
    accountId,
    matchPayee: "netflix",
    tolerancePercent: 5,
    ...extra,
  });

  it("creates a contract from a booking with the interval of the payee's history and links its bookings", async () => {
    await book(household, -1_299, "Netflix International B.V.", "2026-08-03");
    await book(household, -1_299, "Netflix International B.V.", "2026-09-03");
    await book(household, -1_299, "Netflix International B.V.", "2026-10-03");
    const latest = await book(household, -1_299, "Netflix International B.V.", "2026-11-03", "Abo");
    const [subscriptions] = await db().select().from(categories).where(eq(categories.name, "Abos & Medien"));
    await db().update(transactions).set({ categoryId: subscriptions?.id }).where(eq(transactions.id, latest));

    const { contract: draft, bookingDate } = await contractDraftFromBooking(db(), parent, latest);
    expect(bookingDate).toBe("2026-11-03");
    expect(draft).toMatchObject({
      name: "Netflix International B.V.",
      direction: "expense",
      amountCents: 1_299,
      interval: "monthly",
      nextDue: "2026-12-03",
      accountId: household,
      categoryId: subscriptions?.id,
      matchPayee: "Netflix International B.V.",
    });
    const id = await saveContract(db(), parent, draft);
    const { contract, payments } = await getContract(db(), parent, id, TODAY);
    expect(payments.map((p) => p.bookingDate)).toEqual(["2026-11-03", "2026-10-03", "2026-09-03", "2026-08-03"]);
    expect(contract.state).toMatchObject({ status: "active", nextDue: "2026-12-03", monthlyCents: 1_299 });
    expect(contract).toMatchObject({ visibility: "household", accountName: "Haushalt", categoryName: "Abos & Medien", canManage: true });

    // A member cannot see the household account, so neither the booking nor the contract.
    await expect(contractDraftFromBooking(db(), member, latest)).rejects.toMatchObject({ status: 404 });
    await expect(getContract(db(), member, id)).rejects.toMatchObject({ status: 404 });
  });

  it("links bookings imported later and frees them when the contract goes", async () => {
    const giro = await createAccount(db(), admin, { name: "Bar", bank: "bar", kind: "checking", color: "#1f6f5c" });
    // 7 % above the booking: still the contract, as a price change.
    const id = await saveContract(db(), admin, netflix(giro, { amountCents: 1_399 }));
    const booked = await addManualBooking(db(), admin, {
      accountId: giro,
      bookingDate: "2026-12-02",
      amountCents: -1_299,
      counterparty: "NETFLIX",
    });
    const purchase = await addManualBooking(db(), admin, {
      accountId: giro,
      bookingDate: "2026-12-05",
      amountCents: -6_000,
      counterparty: "Netflix Shop",
    });
    const income = await addManualBooking(db(), admin, {
      accountId: giro,
      bookingDate: "2026-12-06",
      amountCents: 1_299,
      counterparty: "Netflix",
    });
    const linked = async (txnId: number) => (await db().select().from(transactions).where(eq(transactions.id, txnId)))[0]?.contractId;
    expect(await linked(booked)).toBe(id);
    expect(await linked(purchase)).toBeNull();
    expect(await linked(income)).toBeNull();
    expect((await getContract(db(), admin, id, "2026-12-03")).contract.state.nextDue).toBe("2027-01-03");

    expect((await getContract(db(), admin, id, "2026-12-03")).contract.state.status).toBe("price_changed");

    // A second contract with the exact amount takes the booking over; without it the first one gets it back.
    const second = await saveContract(db(), admin, netflix(giro, { name: "Netflix 2" }));
    expect(await linked(booked)).toBe(second);
    await deleteContract(db(), admin, second);
    expect(await linked(booked)).toBe(id);
    expect(await relinkContracts(db())).toBe(0);
  });

  it("never lets someone who only sees an account take its bookings from the owner's contracts", async () => {
    const linked = async (txnId: number) => (await db().select().from(transactions).where(eq(transactions.id, txnId)))[0]?.contractId;
    await setAccountSharing(db(), parent, { accountId: privateOfParent, userIds: [member.id] });
    const booked = await book(privateOfParent, -1_299, "Netflix", "2026-11-03");
    const parents = await saveContract(db(), parent, netflix(privateOfParent, { amountCents: 1_330, nextDue: "2026-11-03" }));
    expect(await linked(booked)).toBe(parents);

    // An exact match without an account only covers accounts its owner manages, not ones shared with them.
    await saveContract(db(), member, netflix(null, { name: "x", visibility: "private" }));
    expect(await linked(booked)).toBe(parents);
    // Attaching a contract to an account needs authority over it.
    await expect(saveContract(db(), member, netflix(privateOfParent))).rejects.toMatchObject({ status: 403 });

    // Of several matching contracts the account owner's own wins, even against a closer amount.
    await saveContract(db(), admin, netflix(null, { name: "Admin", visibility: "private" }));
    expect(await linked(booked)).toBe(parents);
  });

  it("stops linking bookings of an account its contract's owner no longer manages", async () => {
    const linked = async (txnId: number) => (await db().select().from(transactions).where(eq(transactions.id, txnId)))[0]?.contractId;
    const booked = await book(household, -1_299, "Netflix", "2026-11-03");
    const parents = await saveContract(db(), parent, netflix(household, { nextDue: "2026-11-03" }));
    expect(await linked(booked)).toBe(parents);
    await db().update(accounts).set({ visibility: "private" }).where(eq(accounts.id, household));
    await relinkContracts(db());
    expect(await linked(booked)).toBeNull();
  });

  it("shows contracts like their accounts: shared, household, private and without account", async () => {
    const onShared = await saveContract(db(), admin, netflix(shared, { name: "Taschengeld-Abo" }));
    const onHousehold = await saveContract(db(), admin, netflix(household, { name: "Strom" }));
    const onPrivate = await saveContract(db(), parent, netflix(privateOfParent, { name: "Eltern-Abo", notes: "geheim" }));
    const householdWithout = await saveContract(db(), parent, netflix(null, { name: "Rundfunk" }));
    const privateWithout = await saveContract(db(), parent, netflix(null, { name: "Privatvertrag", visibility: "private" }));
    const membersOwn = await saveContract(db(), member, netflix(null, { name: "Handy" }));

    const names = async (viewer: Viewer, groupId?: number) => (await listContracts(db(), viewer, { groupId }, TODAY)).map((c) => c.name);
    expect(await names(admin)).toEqual(["Eltern-Abo", "Handy", "Privatvertrag", "Rundfunk", "Strom", "Taschengeld-Abo"]);
    expect(await names(parent)).toEqual(["Eltern-Abo", "Privatvertrag", "Rundfunk", "Strom", "Taschengeld-Abo"]);
    expect(await names(member)).toEqual(["Handy", "Rundfunk", "Taschengeld-Abo"]);
    expect(await names(outsider)).toEqual(["Rundfunk"]);
    // A group view only has the contracts on the group's accounts.
    expect(await names(member, kids)).toEqual(["Taschengeld-Abo"]);
    expect((await listContracts(db(), member, {}, TODAY)).find((c) => c.name === "Taschengeld-Abo")?.canManage).toBe(false);

    // A member only creates private contracts without an account; on a visible account the contract follows it.
    expect((await getContract(db(), member, membersOwn)).contract.visibility).toBe("private");
    await expect(saveContract(db(), member, netflix(null, { visibility: "household" }))).rejects.toMatchObject({ status: 403 });
    await expect(saveContract(db(), member, netflix(household))).rejects.toMatchObject({ status: 404 });

    // Foreign private contracts are a 404, visible ones the viewer may not change a 403.
    await expect(getContract(db(), member, onPrivate)).rejects.toMatchObject({ status: 404 });
    await expect(getContract(db(), parent, membersOwn)).rejects.toMatchObject({ status: 404 });
    await expect(deleteContract(db(), member, onShared)).rejects.toMatchObject({ status: 403 });
    await expect(saveContract(db(), member, netflix(shared), onHousehold)).rejects.toMatchObject({ status: 404 });
    await expect(deleteContract(db(), outsider, privateWithout)).rejects.toMatchObject({ status: 404 });
    await deleteContract(db(), parent, householdWithout);

    // Sharing the private account shares its contract.
    await setAccountSharing(db(), parent, { accountId: privateOfParent, userIds: [member.id] });
    expect(await names(member)).toContain("Eltern-Abo");
    expect((await getContract(db(), member, onPrivate)).contract.canManage).toBe(false);
  });

  it("suggests recurring payments that are no contract yet; accepting and dismissing remove them", async () => {
    for (const day of ["2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"]) await book(household, -1_299, "Spotify AB", day);
    for (const day of ["2026-08-28", "2026-09-28", "2026-10-28"]) await book(household, 352_000, "Muster GmbH", day, "Gehalt");
    for (const day of ["2026-08-10", "2026-09-10", "2026-10-10"]) await book(household, -8_950, "HUK-COBURG", day);
    for (const day of ["2026-08-10", "2026-09-10", "2026-10-10"]) await book(privateOfParent, -4_000, "Geheimabo", day);

    const keys = async (viewer: Viewer) => (await contractSuggestions(db(), viewer, {}, TODAY)).map((s) => `${s.direction}:${s.key}`);
    // Largest monthly amount first, whatever the direction.
    expect(await keys(parent)).toEqual(["income:muster gmbh", "expense:huk-coburg", "expense:geheimabo", "expense:spotify ab"]);
    expect(await keys(member)).toEqual([]);

    const id = await acceptSuggestion(db(), parent, { key: "spotify ab", direction: "expense" }, TODAY);
    const { contract, payments } = await getContract(db(), parent, id, TODAY);
    expect(contract).toMatchObject({
      name: "Spotify AB",
      amountCents: 1_299,
      interval: "monthly",
      anchor: "2026-12-03",
      accountId: household,
    });
    expect(payments).toHaveLength(4);
    await dismissSuggestion(db(), parent, { key: "huk-coburg", direction: "expense" });
    expect(await keys(parent)).toEqual(["income:muster gmbh", "expense:geheimabo"]);
    // Dismissing is per person.
    expect(await keys(admin)).toEqual(["income:muster gmbh", "expense:huk-coburg", "expense:geheimabo"]);
    await expect(acceptSuggestion(db(), parent, { key: "huk-coburg", direction: "expense" }, TODAY)).rejects.toMatchObject({ status: 404 });
  });

  it("sums monthly equivalents into income, expenses and the buffer and forecasts the next month", async () => {
    await saveContract(db(), admin, {
      name: "Gehalt",
      direction: "income",
      amountCents: 352_000,
      interval: "monthly",
      nextDue: "2026-11-28",
      accountId: household,
      matchPayee: "Muster",
    });
    await saveContract(
      db(),
      admin,
      netflix(household, { name: "Miete", amountCents: 145_000, nextDue: "2026-12-03", matchPayee: "Hausverwaltung" }),
    );
    await saveContract(
      db(),
      admin,
      netflix(household, { name: "KFZ", amountCents: 36_000, interval: "quarterly", nextDue: "2027-01-10", matchPayee: "HUK" }),
    );
    await saveContract(db(), admin, netflix(household, { name: "Alt", amountCents: 9_999, nextDue: "2026-01-01", endDate: "2026-06-30" }));
    const [savings] = await db().select().from(categories).where(eq(categories.name, "Sparen & Investieren"));
    await saveContract(
      db(),
      admin,
      netflix(household, { name: "Sparplan", amountCents: 30_000, nextDue: "2026-12-02", matchPayee: "Sparplan", categoryId: savings?.id }),
    );

    await saveContractPreferences(db(), admin, { dueSoonDays: 30 });
    const overview = await contractsOverview(db(), admin, {}, TODAY);
    expect(overview.totals).toEqual({ incomeCents: 352_000, expensesCents: 145_000 + 12_000 + 30_000, bufferCents: 165_000, count: 4 });
    expect(overview.upcoming.map((c) => [c.name, c.state.nextDue])).toEqual([
      ["Gehalt", "2026-11-28"],
      ["Sparplan", "2026-12-02"],
      ["Miete", "2026-12-03"],
    ]);
    expect(overview.items.find((c) => c.name === "Alt")?.state.status).toBe("ended");

    const december = await contractForecast(db(), admin, { dateFrom: "2026-12-01", dateTo: "2026-12-31" }, TODAY);
    // The salary of November 28 is still unpaid; only December's is expected in December.
    expect(december.totals).toEqual({ incomeCents: 352_000, expensesCents: 145_000, savingsCents: 30_000, bufferCents: 177_000 });
    expect(december.items.map((i) => [i.name, i.date])).toEqual([
      ["Sparplan", "2026-12-02"],
      ["Miete", "2026-12-03"],
      ["Gehalt", "2026-12-28"],
    ]);
    expect(december.categories.savings).toEqual([expect.objectContaining({ name: "Sparen & Investieren", amountCents: 30_000 })]);
    expect(december.categories.expense).toEqual([expect.objectContaining({ name: "Ohne Kategorie", amountCents: 145_000, count: 1 })]);
    const january = await contractForecast(db(), admin, { dateFrom: "2027-01-01", dateTo: "2027-01-31" }, TODAY);
    expect(january.items.map((i) => i.name)).toEqual(["Sparplan", "Miete", "KFZ", "Gehalt"]);
    // Members do not see the household account's contracts, so they forecast nothing.
    expect((await contractForecast(db(), member, { dateFrom: "2026-12-01", dateTo: "2026-12-31" }, TODAY)).items).toEqual([]);
  });

  it("forecasts only bounded ranges of at most ten years", async () => {
    await saveContract(db(), admin, netflix(household, { interval: "weekly" }));
    // As the server function middleware answers: a message-key validation error becomes a 400.
    const status = (run: Promise<unknown>) =>
      run.then(
        () => 200,
        (error: unknown) => (localizeError(error, "de") as { status?: number }).status ?? 500,
      );
    for (const range of [
      { dateFrom: "2026-11-17", dateTo: "9999-12-31" },
      { dateFrom: "0001-01-01", dateTo: "0002-01-01" },
      { dateFrom: "2026-01-01", dateTo: "2036-01-02" },
    ]) {
      expect(await status(contractForecast(db(), admin, range, TODAY))).toBe(400);
    }
    const decade = await contractForecast(db(), admin, { dateFrom: "2026-01-01", dateTo: "2036-01-01" }, TODAY);
    expect(decade.items.length).toBeGreaterThan(400);
    expect(await status(summary(db(), admin, { dateFrom: "2000-01-01", dateTo: "2026-12-31" }))).toBe(400);
  });

  it("notifies once about a price change after a sync and about a missed payment", async () => {
    setNotificationDepsForTests({ sendPush: async () => undefined });
    for (const viewer of [parent, member]) {
      await savePreferences(db(), viewer, {
        preferences: [
          { kind: "contract_changed", enabled: true, push: false, email: false, threshold: null },
          { kind: "contract_missed", enabled: true, push: false, email: false, threshold: null },
        ],
      });
    }
    await book(household, -1_299, "Netflix", "2026-10-03");
    const id = await saveContract(db(), admin, netflix(household, { nextDue: "2026-11-03" }));
    await saveContract(db(), admin, netflix(shared, { name: "Handyvertrag", matchPayee: "Telekom", nextDue: "2026-11-01" }));

    await checkContracts(db(), "2026-11-07");
    await checkContracts(db(), "2026-11-07");
    const titles = async (viewer: Viewer) => (await listNotifications(db(), viewer)).items.map((n) => n.title);
    expect(await titles(parent)).toEqual(["Handyvertrag: nicht abgebucht"]);
    expect(await titles(member)).toEqual(["Handyvertrag: nicht abgebucht"]);
    await checkContracts(db(), "2026-11-09");
    expect(await titles(parent)).toEqual(["Netflix: nicht abgebucht", "Handyvertrag: nicht abgebucht"]);

    const dearer = await book(household, -1_499, "Netflix", "2026-11-04");
    await relinkContracts(db());
    expect((await getContract(db(), parent, id, "2026-11-10")).contract.state.status).toBe("price_changed");
    await notifyAfterSync(db(), { jobId: "job-1", transactionIds: [dearer] });
    await notifyAfterSync(db(), { jobId: "job-2", transactionIds: [dearer] });
    const [latest] = (await listNotifications(db(), parent)).items;
    expect(latest).toMatchObject({ kind: "contract_changed", title: "Vertrag geändert: Netflix", link: `/vertraege?vertrag=${id}` });
    expect(latest?.body.replace(/ /g, " ")).toBe("Bisher 12,99 €, jetzt 14,99 € (+15 %) am 04.11.2026");
    expect((await titles(parent)).filter((t) => t.startsWith("Vertrag geändert"))).toHaveLength(1);
    // The member cannot see the household account, so hears nothing about its contract.
    expect((await titles(member)).some((t) => t.includes("Netflix"))).toBe(false);
  });

  it("gives the AI tool only the contracts of the view, with amounts and without notes", async () => {
    await saveContract(db(), admin, netflix(shared, { name: "Taschengeld-Abo", notes: "Kundennummer 4711" }));
    await saveContract(db(), admin, netflix(household, { name: "Strom" }));
    const tool = toolsFor("chat").find((t) => t.name === "list_contracts");
    expect(toolsFor("mcp").some((t) => t.name === "list_contracts")).toBe(true);
    const result = await tool?.run({ db: db(), viewer: member, audience: "chat", groupId: null }, {});
    const data = result?.data as { contracts: Record<string, unknown>[]; totals: { expensesCents: number } };
    expect(data.contracts.map((c) => c.name)).toEqual(["Taschengeld-Abo"]);
    expect(data.contracts[0]).toMatchObject({ amountCents: 1_299, interval: "monthly", monthlyCents: 1_299, account: "Taschengeld" });
    expect(JSON.stringify(data)).not.toContain("4711");
    expect(data.totals.expensesCents).toBe(1_299);
    expect(result?.lookup).toMatchObject({ tool: "list_contracts", count: 1 });
  });

  it("suggests a side job with varying amounts by its rhythm as a variable contract that forecasts its latest amount", async () => {
    const side: [string, number][] = [
      ["2026-05-27", 34_000],
      ["2026-06-26", 83_000],
      ["2026-07-27", 51_000],
      ["2026-08-27", 41_500],
      ["2026-09-28", 62_000],
      ["2026-10-27", 47_300],
    ];
    for (const [day, cents] of side) await book(household, cents, "Musterfirma Nebenjob GmbH", day, "Lohn Minijob");
    const [suggestion] = (await contractSuggestions(db(), parent, {}, TODAY)).filter((s) => s.key === "musterfirma nebenjob gmbh");
    expect(suggestion).toMatchObject({
      direction: "income",
      variable: true,
      latestAmountCents: 47_300,
      minAmountCents: 34_000,
      maxAmountCents: 83_000,
      schedule: { interval: "monthly" },
    });

    const id = await acceptSuggestion(db(), parent, { key: "musterfirma nebenjob gmbh", direction: "income" }, TODAY);
    const { contract, payments } = await getContract(db(), parent, id, TODAY);
    expect(contract).toMatchObject({ variable: true, amountCents: 47_300, tolerancePercent: null, anchor: "2026-11-27" });
    expect(payments).toHaveLength(6);

    const later = await book(household, 83_000, "Musterfirma Nebenjob GmbH", "2026-11-27", "Lohn Minijob");
    await relinkContracts(db());
    const after = (await getContract(db(), parent, id, "2026-11-28")).contract.state;
    expect(after).toMatchObject({ nextDue: "2026-12-27", expectedCents: 83_000, monthlyCents: 83_000, priceChange: null });
    const forecast = await contractForecast(db(), parent, { dateFrom: "2026-12-01", dateTo: "2026-12-31" }, "2026-11-28");
    expect(forecast.items).toEqual([expect.objectContaining({ contractId: id, amountCents: 83_000, date: "2026-12-27" })]);
    expect(forecast.totals.incomeCents).toBe(83_000);

    setNotificationDepsForTests({ sendPush: async () => undefined });
    await savePreferences(db(), parent, {
      preferences: [
        { kind: "price_change", enabled: true, push: false, email: false, threshold: 5 },
        { kind: "contract_changed", enabled: true, push: false, email: false, threshold: null },
      ],
    });
    // Stable history, then a jump: a price change, unless a variable contract takes the booking.
    for (const day of ["2026-08-15", "2026-09-15", "2026-10-15"]) {
      await book(household, -8_000, "Stadtwerke", day);
      await book(household, -5_000, "Gaswerk", day);
    }
    await saveContract(db(), admin, netflix(household, { name: "Strom", matchPayee: "Stadtwerke", amountCents: 8_000, variable: true }));
    const power = await book(household, -12_000, "Stadtwerke", "2026-11-15");
    const gas = await book(household, -7_500, "Gaswerk", "2026-11-15");
    await relinkContracts(db());
    await notifyAfterSync(db(), { jobId: "job-variable", transactionIds: [later, power, gas] });
    const titles = (await listNotifications(db(), parent)).items.map((n) => n.title);
    expect(titles).toEqual(["Gaswerk ist teurer geworden"]);
  });

  it("lists dismissed suggestions per person and brings them back", async () => {
    for (const day of ["2026-08-03", "2026-09-03", "2026-10-03"]) await book(household, -1_299, "Spotify AB", day);
    await dismissSuggestion(db(), parent, { key: "spotify ab", direction: "expense" });
    const keys = (list: { key: string }[]) => list.map((s) => s.key);
    const mine = await contractSuggestionOverview(db(), parent, {}, TODAY);
    expect({ open: keys(mine.open), dismissed: keys(mine.dismissed) }).toEqual({ open: [], dismissed: ["spotify ab"] });
    const theirs = await contractSuggestionOverview(db(), admin, {}, TODAY);
    expect({ open: keys(theirs.open), dismissed: keys(theirs.dismissed) }).toEqual({ open: ["spotify ab"], dismissed: [] });

    await restoreSuggestion(db(), parent, { key: "spotify ab", direction: "expense" });
    expect(keys(await contractSuggestions(db(), parent, {}, TODAY))).toEqual(["spotify ab"]);
    expect((await contractSuggestionOverview(db(), parent, {}, TODAY)).dismissed).toEqual([]);
  });

  it("narrows contracts and suggestions to a view's accounts; views belong to one person", async () => {
    const both = await saveContractView(db(), parent, { name: "Alles meins", accountIds: [household, privateOfParent] });
    const onlyPrivate = await saveContractView(db(), parent, { name: "Nur ich", accountIds: [privateOfParent] });
    const own = { sharedBy: null, sharedByAvatar: null, sharing: { scope: "private", userIds: [] }, hidden: false };
    expect(await listContractViews(db(), parent)).toEqual([
      { id: both, name: "Alles meins", accountIds: [household, privateOfParent], ...own },
      { id: onlyPrivate, name: "Nur ich", accountIds: [privateOfParent], ...own },
    ]);

    await saveContract(db(), admin, netflix(household));
    await saveContract(db(), parent, netflix(privateOfParent, { name: "Geheimabo", matchPayee: "Geheim" }));
    await saveContract(db(), admin, netflix(null, { name: "Rundfunkbeitrag", matchPayee: "Beitragsservice" }));
    const names = async (viewId?: number) => (await listContracts(db(), parent, { viewId }, TODAY)).map((c) => c.name);
    expect(await names()).toEqual(["Geheimabo", "Netflix", "Rundfunkbeitrag"]);
    expect(await names(both)).toEqual(["Geheimabo", "Netflix"]);
    expect(await names(onlyPrivate)).toEqual(["Geheimabo"]);
    expect((await contractsOverview(db(), parent, { viewId: onlyPrivate }, TODAY)).totals.count).toBe(1);

    for (const day of ["2026-08-10", "2026-09-10", "2026-10-10"]) {
      await book(household, -8_950, "HUK-COBURG", day);
      await book(privateOfParent, -2_500, "Fitnessstudio", day);
    }
    const suggested = async (viewId?: number) => (await contractSuggestions(db(), parent, { viewId }, TODAY)).map((s) => s.key);
    expect(await suggested()).toEqual(["huk-coburg", "fitnessstudio"]);
    expect(await suggested(onlyPrivate)).toEqual(["fitnessstudio"]);

    await saveContractView(db(), parent, { name: "Privat", accountIds: [privateOfParent] }, onlyPrivate);
    expect((await listContractViews(db(), parent)).map((v) => v.name)).toEqual(["Alles meins", "Privat"]);

    // Nobody else sees, uses, changes or deletes them; a view only holds accounts its owner sees.
    expect(await listContractViews(db(), member)).toEqual([]);
    await expect(listContracts(db(), member, { viewId: both }, TODAY)).rejects.toMatchObject({ status: 404 });
    await expect(contractSuggestions(db(), member, { viewId: both }, TODAY)).rejects.toMatchObject({ status: 404 });
    await expect(saveContractView(db(), member, { name: "x", accountIds: [shared] }, both)).rejects.toMatchObject({ status: 404 });
    await expect(deleteContractView(db(), member, both)).rejects.toMatchObject({ status: 404 });
    await expect(saveContractView(db(), member, { name: "Fremd", accountIds: [household] })).rejects.toMatchObject({ status: 404 });
    await expect(saveContractView(db(), member, { name: "Leer", accountIds: [] })).rejects.toThrow();

    await deleteContractView(db(), parent, both);
    expect((await listContractViews(db(), parent)).map((v) => v.name)).toEqual(["Privat"]);
  });

  it("shares a view with chosen people or the household; a recipient only ever gets the accounts they see themselves", async () => {
    const accountIds = [shared, household, privateOfParent];
    const id = await saveContractView(db(), parent, { name: "Familie", accountIds, sharing: "people", shareWith: [member.id] });
    await saveContract(db(), admin, netflix(shared, { name: "Handyvertrag", matchPayee: "Telekom", nextDue: "2026-12-01" }));
    await saveContract(db(), admin, netflix(household));
    await saveContract(db(), parent, netflix(privateOfParent, { name: "Geheimabo", matchPayee: "Geheim" }));
    for (const day of ["2026-08-10", "2026-09-10", "2026-10-10"]) {
      await book(shared, -4_000, "Musikschule", day);
      await book(household, -8_950, "HUK-COBURG", day);
      await book(privateOfParent, -2_500, "Fitnessstudio", day);
    }

    expect((await listContractViews(db(), parent))[0]).toMatchObject({ accountIds, sharing: { scope: "people", userIds: [member.id] } });
    const tabs = await listContractViews(db(), member);
    expect(tabs).toEqual([
      { id, name: "Familie", accountIds: [shared], sharedBy: "eltern", sharedByAvatar: null, sharing: null, hidden: false },
    ]);
    const overview = await contractsOverview(db(), member, { viewId: id }, TODAY);
    const suggestions = await contractSuggestionOverview(db(), member, { viewId: id }, TODAY);
    expect(overview.items.map((c) => c.name)).toEqual(["Handyvertrag"]);
    expect(suggestions.open.map((s) => s.key)).toEqual(["musikschule"]);
    // Names, counts and sums are those of the recipient's own accounts, exactly as on their "all" tab.
    const all = await contractsOverview(db(), member, {}, TODAY);
    expect(overview.totals).toEqual(all.totals);
    expect(overview.actual).toEqual(all.actual);
    expect(JSON.stringify([tabs, overview, suggestions])).not.toMatch(/Geheim|Fitness|HUK|Eltern privat|Haushalt|Netflix/);

    // The recipient's own due-soon window applies; the owner keeps theirs.
    expect(overview.upcoming).toEqual([]);
    await saveContractPreferences(db(), member, { dueSoonDays: 30 });
    expect((await contractsOverview(db(), member, { viewId: id }, TODAY)).upcoming.map((c) => c.name)).toEqual(["Handyvertrag"]);
    expect((await contractsOverview(db(), parent, { viewId: id }, TODAY)).upcoming).toEqual([]);

    // Read-only for the recipient, invisible for everyone else.
    await expect(saveContractView(db(), member, { name: "Meins", accountIds: [shared] }, id)).rejects.toMatchObject({ status: 403 });
    await expect(deleteContractView(db(), member, id)).rejects.toMatchObject({ status: 403 });
    expect(await listContractViews(db(), outsider)).toEqual([]);
    await expect(listContracts(db(), outsider, { viewId: id }, TODAY)).rejects.toMatchObject({ status: 404 });
    await expect(deleteContractView(db(), outsider, id)).rejects.toMatchObject({ status: 404 });

    // The owner learns how many chosen accounts someone misses, never which.
    expect(await contractViewShareCoverage(db(), parent, { accountIds })).toEqual([
      { userId: outsider.id, name: "gast", hiddenCount: 3 },
      { userId: member.id, name: "kind", hiddenCount: 2 },
    ]);
    await expect(contractViewShareCoverage(db(), member, { accountIds: [household] })).rejects.toMatchObject({ status: 404 });
    // Who else sees an account the viewer doesn't own is not theirs to learn, even if they see the account.
    expect(await contractViewShareCoverage(db(), member, { accountIds: [shared] })).toEqual([]);

    await saveContractView(db(), parent, { name: "Familie", accountIds, sharing: "household" }, id);
    expect(await listContractViews(db(), outsider)).toEqual([
      { id, name: "Familie", accountIds: [], sharedBy: "eltern", sharedByAvatar: null, sharing: null, hidden: false },
    ]);
    expect(await listContracts(db(), outsider, { viewId: id }, TODAY)).toEqual([]);
    expect(await contractSuggestions(db(), outsider, { viewId: id }, TODAY)).toEqual([]);
    expect((await listContractViews(db(), member)).map((v) => v.accountIds)).toEqual([[shared]]);

    await expect(saveContractView(db(), parent, { name: "x", accountIds, sharing: "people", shareWith: [] })).rejects.toThrow();
    await expect(saveContractView(db(), parent, { name: "x", accountIds, sharing: "people", shareWith: ["nobody"] })).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(
      saveContractView(db(), parent, { name: "x", accountIds, sharing: "people", shareWith: [parent.id] }),
    ).rejects.toMatchObject({ status: 400 });

    await saveContractView(db(), parent, { name: "Familie", accountIds }, id);
    expect(await listContractViews(db(), member)).toEqual([]);
    await expect(listContracts(db(), member, { viewId: id }, TODAY)).rejects.toMatchObject({ status: 404 });
  });

  it("lets a recipient hide a shared view; unsharing, deleting people or the view ends its shares", async () => {
    const id = await saveContractView(db(), parent, { name: "Familie", accountIds: [shared], sharing: "people", shareWith: [member.id] });
    await setContractViewHidden(db(), member, { id, hidden: true });
    expect((await listContractViews(db(), member))[0]?.hidden).toBe(true);
    expect(await listContracts(db(), member, { viewId: id }, TODAY)).toEqual([]);
    await setContractViewHidden(db(), member, { id, hidden: false });
    expect((await listContractViews(db(), member))[0]?.hidden).toBe(false);
    await expect(setContractViewHidden(db(), parent, { id, hidden: true })).rejects.toMatchObject({ status: 400 });
    await expect(setContractViewHidden(db(), outsider, { id, hidden: true })).rejects.toMatchObject({ status: 404 });

    // Whoever is no longer a recipient loses the choice to hide it, too.
    await setContractViewHidden(db(), member, { id, hidden: true });
    await saveContractView(db(), parent, { name: "Familie", accountIds: [shared], sharing: "people", shareWith: [outsider.id] }, id);
    expect(await db().select().from(contractViewHidden)).toEqual([]);
    expect(await listContractViews(db(), member)).toEqual([]);

    await deleteUser(db(), admin, outsider.id);
    expect(await db().select().from(contractViewShares)).toEqual([]);
    await saveContractView(db(), parent, { name: "Familie", accountIds: [shared], sharing: "people", shareWith: [member.id] }, id);
    await setContractViewHidden(db(), member, { id, hidden: true });
    await deleteUser(db(), admin, parent.id);
    expect(await db().select().from(contractViews)).toEqual([]);
    expect(await db().select().from(contractViewShares)).toEqual([]);
    expect(await db().select().from(contractViewHidden)).toEqual([]);
    expect(await listContractViews(db(), member)).toEqual([]);
  });

  it("names the all tab per person; empty brings back the default", async () => {
    expect((await getContractPreferences(db(), parent)).allViewName).toBeNull();
    await saveContractPreferences(db(), parent, { allViewName: "  Alle Verträge " });
    await saveContractPreferences(db(), parent, { dueSoonDays: 14 });
    expect(await getContractPreferences(db(), parent)).toEqual({
      ...DEFAULT_CONTRACT_PREFERENCES,
      dueSoonDays: 14,
      allViewName: "Alle Verträge",
    });
    expect((await contractsOverview(db(), parent, {}, TODAY)).preferences.allViewName).toBe("Alle Verträge");
    expect((await getContractPreferences(db(), member)).allViewName).toBeNull();
    await saveContractPreferences(db(), parent, { allViewName: "" });
    expect((await getContractPreferences(db(), parent)).allViewName).toBeNull();
    await expect(saveContractPreferences(db(), parent, { allViewName: "x".repeat(65) })).rejects.toThrow();
  });

  it("never changes or shares views while viewing as someone else", () => {
    const file = "src/server/functions/contracts.ts";
    for (const name of ["saveContractViewFn", "deleteContractViewFn", "hideContractViewFn", "saveContractPreferencesFn"])
      expect(serverFnAllowedWhileImpersonating("POST", { name, filename: file })).toBe(false);
    expect(serverFnAllowedWhileImpersonating("GET", { name: "getContractViewShareCoverageFn", filename: file })).toBe(true);
  });

  it("marks what is due within a week and counts unseen due dates per person until they are marked", async () => {
    const netflixId = await saveContract(db(), admin, netflix(household, { nextDue: "2026-11-20" }));
    await saveContract(db(), admin, netflix(household, { name: "Miete", matchPayee: "Hausverwaltung", nextDue: "2026-12-01" }));
    await saveContract(db(), admin, netflix(shared, { name: "Handyvertrag", matchPayee: "Telekom", nextDue: "2026-11-17" }));
    const due = async (viewer: Viewer, today = TODAY) =>
      Object.fromEntries((await listContracts(db(), viewer, {}, today)).map((c) => [c.name, c.dueInDays]));
    expect(await due(parent)).toEqual({ Handyvertrag: 0, Miete: null, Netflix: 3 });
    expect((await contractsOverview(db(), parent, {}, TODAY)).unseenDue).toBe(2);

    expect(await unseenDueCount(db(), parent, TODAY)).toBe(2);
    expect(await unseenDueCount(db(), member, TODAY)).toBe(1);
    await markDueSeen(db(), parent, TODAY);
    expect(await unseenDueCount(db(), parent, TODAY)).toBe(0);
    expect(await unseenDueCount(db(), member, TODAY)).toBe(1);

    // Once paid, the next due date is new again; an overdue one has its own status instead.
    await book(household, -1_299, "Netflix", "2026-11-20");
    await relinkContracts(db());
    expect((await getContract(db(), parent, netflixId, "2026-12-15")).contract.dueInDays).toBe(5);
    expect(await unseenDueCount(db(), parent, "2026-12-15")).toBe(1);
  });

  it("keeps each person's list choices and due-soon window, which decides what is due soon on the page and in the badge", async () => {
    await saveContract(db(), admin, netflix(household, { nextDue: "2026-11-20" }));
    const rentId = await saveContract(
      db(),
      admin,
      netflix(household, { name: "Miete", matchPayee: "Hausverwaltung", nextDue: "2026-12-01" }),
    );
    const overview = (viewer: Viewer) => contractsOverview(db(), viewer, {}, TODAY);
    const upcoming = async (viewer: Viewer) => (await overview(viewer)).upcoming.map((c) => [c.name, c.dueInDays]);
    expect(await getContractPreferences(db(), parent)).toEqual(DEFAULT_CONTRACT_PREFERENCES);
    expect(await upcoming(parent)).toEqual([["Netflix", 3]]);

    expect(await saveContractPreferences(db(), parent, { dueSoonDays: 14 })).toEqual({ ...DEFAULT_CONTRACT_PREFERENCES, dueSoonDays: 14 });
    await saveContractPreferences(db(), parent, { listMode: "list", sort: "next_due" });
    const stored = { listMode: "list", sort: "next_due", dueSoonDays: 14, allViewName: null };
    expect(await getContractPreferences(db(), parent)).toEqual(stored);
    expect((await overview(parent)).preferences).toEqual(stored);
    expect(await upcoming(parent)).toEqual([
      ["Netflix", 3],
      ["Miete", 14],
    ]);
    expect((await overview(parent)).unseenDue).toBe(2);
    expect((await getContract(db(), parent, rentId, TODAY)).contract.dueInDays).toBe(14);

    // Everyone else keeps their own choices.
    expect(await getContractPreferences(db(), admin)).toEqual(DEFAULT_CONTRACT_PREFERENCES);
    expect(await unseenDueCount(db(), admin, TODAY)).toBe(1);

    await saveContractPreferences(db(), parent, { dueSoonDays: 3 });
    expect(await unseenDueCount(db(), parent, TODAY)).toBe(1);
    expect(await getContractPreferences(db(), parent)).toEqual({ ...stored, dueSoonDays: 3 });

    await expect(saveContractPreferences(db(), parent, { dueSoonDays: 10 as 7 })).rejects.toThrow();
    await expect(saveContractPreferences(db(), parent, { listMode: "direction" as "list" })).rejects.toThrow();
    await expect(saveContractPreferences(db(), parent, { sort: "amount" as "name" })).rejects.toThrow();
  });

  it("never saves list choices while viewing as someone else; reading them writes nothing", async () => {
    const file = "src/server/functions/contracts.ts";
    expect(serverFnAllowedWhileImpersonating("POST", { name: "saveContractPreferencesFn", filename: file })).toBe(false);
    expect(serverFnAllowedWhileImpersonating("GET", { name: "getContractsFn", filename: file })).toBe(true);
    await saveContractPreferences(db(), member, { listMode: "list" });
    const before = await db().select().from(contractPreferences);
    expect((await contractsOverview(db(), member, {}, TODAY)).preferences).toEqual({ ...DEFAULT_CONTRACT_PREFERENCES, listMode: "list" });
    await contractsOverview(db(), outsider, {}, TODAY);
    await unseenDueCount(db(), outsider, TODAY);
    expect(await db().select().from(contractPreferences)).toEqual(before);
  });

  it("reminds once per due date as many days ahead as each person chose", async () => {
    setNotificationDepsForTests({ sendPush: async () => undefined });
    await savePreferences(db(), parent, {
      preferences: [{ kind: "contract_upcoming", enabled: true, push: false, email: false, threshold: 3 }],
    });
    await savePreferences(db(), member, {
      preferences: [{ kind: "contract_upcoming", enabled: true, push: false, email: false, threshold: 1 }],
    });
    await expect(
      savePreferences(db(), member, {
        preferences: [{ kind: "contract_upcoming", enabled: true, push: false, email: false, threshold: 31 }],
      }),
    ).rejects.toThrow();
    const id = await saveContract(db(), admin, netflix(household, { nextDue: "2026-11-20" }));
    await saveContract(db(), admin, netflix(shared, { name: "Handyvertrag", matchPayee: "Telekom", nextDue: "2026-11-18" }));
    const titles = async (viewer: Viewer) => (await listNotifications(db(), viewer)).items.map((n) => n.title);

    await checkUpcomingContracts(db(), "2026-11-16");
    expect(await titles(parent)).toEqual(["Handyvertrag: fällig in 2 Tagen"]);
    expect(await titles(member)).toEqual([]);

    await checkUpcomingContracts(db(), "2026-11-17");
    await checkUpcomingContracts(db(), "2026-11-17");
    expect(await titles(parent)).toEqual(["Netflix: fällig in 3 Tagen", "Handyvertrag: fällig in 2 Tagen"]);
    expect(await titles(member)).toEqual(["Handyvertrag: morgen fällig"]);
    const [latest] = (await listNotifications(db(), parent)).items;
    expect(latest).toMatchObject({ kind: "contract_upcoming", link: `/vertraege?vertrag=${id}` });
    expect(latest?.body.replace(/\u00a0/g, " ")).toBe("Abbuchung von voraussichtlich 12,99 € am 20.11.2026.");

    await checkUpcomingContracts(db(), "2026-11-20");
    expect((await titles(parent)).filter((t) => t.startsWith("Netflix"))).toHaveLength(1);
  });
});
