import { describe, expect, it } from "vitest";
import {
  assignContracts,
  type ContractBooking,
  type ContractRule,
  type ContractTerms,
  contractState,
  dueDate,
  dueDatesBetween,
  dueWithin,
  expectedDueDates,
  firstDueFrom,
  guessSchedule,
  MAX_DUE_DATES,
  matchesContract,
  monthlyEquivalent,
  openSuggestions,
  regularSchedule,
  shiftMonths,
} from "./contracts.ts";
import { contractCandidates, recurringPayments, type StatTxn } from "./stats.ts";

const monthly = { interval: "monthly" } as const;

describe("interval math", () => {
  it("stops at the end of far-away ranges and walks a bounded number of dates", () => {
    const yearly = dueDatesBetween("2026-11-17", { interval: "yearly" }, "2026-11-17", "9999-12-31");
    expect(yearly.at(-1)?.startsWith("+")).toBe(false);
    expect(yearly.length).toBeLessThanOrEqual(MAX_DUE_DATES);
    expect(dueDatesBetween("2026-11-17", { interval: "weekly" }, "2026-11-17", "2200-12-31")).toHaveLength(MAX_DUE_DATES);
    expect(dueDatesBetween("9999-12-15", monthly, "9999-12-01", "9999-12-31")).toEqual(["9999-12-15"]);
  });

  it("normalizes amounts to a month", () => {
    expect(monthlyEquivalent(1_200, monthly)).toBe(1_200);
    expect(monthlyEquivalent(1_200, { interval: "weekly" })).toBe(5_200);
    expect(monthlyEquivalent(30_000, { interval: "quarterly" })).toBe(10_000);
    expect(monthlyEquivalent(60_000, { interval: "half_yearly" })).toBe(10_000);
    expect(monthlyEquivalent(12_000, { interval: "yearly" })).toBe(1_000);
    expect(monthlyEquivalent(10_000, { interval: "custom", intervalMonths: 3 })).toBe(3_333);
    expect(monthlyEquivalent(10_000, { interval: "custom", intervalMonths: null })).toBe(10_000);
  });

  it("keeps month ends and leap days from the anchor", () => {
    expect(shiftMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(dueDate("2026-01-31", monthly, 1)).toBe("2026-02-28");
    // Computed from the anchor, so March is the 31st again rather than the 28th.
    expect(dueDate("2026-01-31", monthly, 2)).toBe("2026-03-31");
    expect(dueDate("2028-02-29", { interval: "yearly" }, 1)).toBe("2029-02-28");
    expect(dueDate("2028-02-29", { interval: "yearly" }, 4)).toBe("2032-02-29");
    expect(dueDate("2026-11-30", { interval: "quarterly" }, 1)).toBe("2027-02-28");
    expect(dueDate("2026-12-29", { interval: "weekly" }, 1)).toBe("2027-01-05");
    expect(dueDate("2026-03-15", monthly, -3)).toBe("2025-12-15");
  });

  it("finds the next due dates on or after a day", () => {
    expect(firstDueFrom("2026-01-31", monthly, "2026-03-01")).toBe("2026-03-31");
    expect(firstDueFrom("2026-01-31", monthly, "2026-02-28")).toBe("2026-02-28");
    expect(firstDueFrom("2024-02-29", { interval: "yearly" }, "2026-01-01")).toBe("2026-02-28");
    expect(dueDatesBetween("2026-11-03", { interval: "weekly" }, "2026-12-01", "2026-12-31")).toEqual([
      "2026-12-01",
      "2026-12-08",
      "2026-12-15",
      "2026-12-22",
      "2026-12-29",
    ]);
    expect(dueDatesBetween("2026-01-15", { interval: "half_yearly" }, "2026-02-01", "2027-12-31")).toEqual([
      "2026-07-15",
      "2027-01-15",
      "2027-07-15",
    ]);
  });

  it("guesses the interval from the gaps between payments", () => {
    expect(guessSchedule(["2026-01-03"])).toEqual({ interval: "monthly", intervalMonths: null });
    expect(guessSchedule(["2026-01-03", "2026-02-02", "2026-03-04", "2026-04-03"])).toEqual({ interval: "monthly", intervalMonths: null });
    expect(guessSchedule(["2026-01-05", "2026-01-12", "2026-01-19"])).toEqual({ interval: "weekly", intervalMonths: null });
    expect(guessSchedule(["2025-01-15", "2025-04-14", "2025-07-15", "2025-10-15"])).toEqual({
      interval: "quarterly",
      intervalMonths: null,
    });
    expect(guessSchedule(["2024-03-01", "2025-03-03", "2026-03-02"])).toEqual({ interval: "yearly", intervalMonths: null });
    expect(guessSchedule(["2026-01-01", "2026-03-02", "2026-05-01"])).toEqual({ interval: "custom", intervalMonths: 2 });
  });
});

const rule = (extra: Partial<ContractRule> = {}): ContractRule => ({
  id: 1,
  direction: "expense",
  amountCents: 1_299,
  variable: false,
  tolerancePercent: 5,
  matchPayee: "Netflix",
  matchPurpose: "",
  accountIds: null,
  startDate: null,
  endDate: null,
  ...extra,
});
let nextId = 1;
const booking = (amountCents: number, extra: Partial<ContractBooking> = {}): ContractBooking => ({
  id: nextId++,
  accountId: 1,
  bookingDate: "2026-11-03",
  amountCents,
  counterparty: "NETFLIX International B.V.",
  purpose: "Abo",
  isTransfer: false,
  ...extra,
});

describe("matching", () => {
  it("matches payee and purpose text, direction, account and dates", () => {
    expect(matchesContract(rule(), booking(-1_299))).toBe(true);
    expect(matchesContract(rule(), booking(1_299))).toBe(false);
    expect(matchesContract(rule({ direction: "income" }), booking(1_299))).toBe(true);
    expect(matchesContract(rule(), booking(-1_299, { counterparty: "Spotify" }))).toBe(false);
    expect(matchesContract(rule({ matchPurpose: "premium" }), booking(-1_299))).toBe(false);
    expect(matchesContract(rule({ matchPayee: "", matchPurpose: "abo" }), booking(-1_299))).toBe(true);
    expect(matchesContract(rule({ matchPayee: "", matchPurpose: "" }), booking(-1_299))).toBe(false);
    expect(matchesContract(rule({ accountIds: [2] }), booking(-1_299))).toBe(false);
    expect(matchesContract(rule(), booking(-1_299, { isTransfer: true }))).toBe(false);
    expect(matchesContract(rule({ startDate: "2026-12-01" }), booking(-1_299))).toBe(false);
    expect(matchesContract(rule({ endDate: "2026-09-30" }), booking(-1_299))).toBe(false);
  });

  it("links a price change within the band but not another purchase from the same payee", () => {
    // 7.7 % more is beyond the 5 % tolerance, so it is a price change, yet still the contract.
    expect(matchesContract(rule(), booking(-1_399))).toBe(true);
    expect(matchesContract(rule(), booking(-4_999))).toBe(false);
    expect(matchesContract(rule({ variable: true }), booking(-4_999))).toBe(true);
    // A wide tolerance widens the band with it.
    expect(matchesContract(rule({ tolerancePercent: 40 }), booking(-2_300))).toBe(true);
  });

  it("gives each booking to the contract with the closest amount", () => {
    const power = rule({ id: 7, matchPayee: "Stadtwerke", amountCents: 8_000 });
    const water = rule({ id: 3, matchPayee: "Stadtwerke", amountCents: 3_000 });
    const variable = rule({ id: 2, matchPayee: "Stadtwerke", variable: true });
    const a = booking(-8_100, { counterparty: "Stadtwerke Kempten" });
    const b = booking(-2_900, { counterparty: "Stadtwerke Kempten" });
    const c = booking(-50_000, { counterparty: "Stadtwerke Kempten" });
    const result = assignContracts([power, water, variable], [a, b, c]);
    expect(result.get(a.id)).toBe(7);
    expect(result.get(b.id)).toBe(3);
    expect(result.get(c.id)).toBe(2);
    expect(assignContracts([power, water], [c]).size).toBe(0);
  });
});

const terms = (extra: Partial<ContractTerms> = {}): ContractTerms => ({
  interval: "monthly",
  intervalMonths: null,
  anchor: "2026-11-03",
  amountCents: 1_299,
  variable: false,
  tolerancePercent: 5,
  startDate: null,
  endDate: null,
  ...extra,
});
const paid = (bookingDate: string, amountCents = -1_299) => ({ id: nextId++, bookingDate, amountCents });

describe("contract state", () => {
  it("moves the next due date past the latest payment, also when it came early", () => {
    expect(contractState(terms(), [paid("2026-10-03")], "2026-10-20")).toMatchObject({ status: "active", nextDue: "2026-11-03" });
    expect(contractState(terms(), [paid("2026-10-03"), paid("2026-11-01")], "2026-11-02")).toMatchObject({ nextDue: "2026-12-03" });
    expect(contractState(terms({ anchor: "2027-01-31" }), [paid("2026-12-30")], "2027-01-05").nextDue).toBe("2027-01-31");
    expect(contractState(terms({ anchor: "2027-01-31" }), [paid("2027-01-29")], "2027-02-01").nextDue).toBe("2027-02-28");
  });

  it("is overdue once the due date plus grace days passed without a payment", () => {
    expect(contractState(terms(), [paid("2026-10-03")], "2026-11-08")).toMatchObject({ status: "active", overdue: false });
    expect(contractState(terms(), [paid("2026-10-03")], "2026-11-09")).toMatchObject({
      status: "overdue",
      overdue: true,
      nextDue: "2026-11-03",
    });
    expect(contractState(terms({ interval: "weekly" }), [paid("2026-10-27")], "2026-11-06")).toMatchObject({ status: "overdue" });
    expect(contractState(terms(), [], "2026-11-20")).toMatchObject({ status: "overdue", nextDue: "2026-11-03" });
  });

  it("marks a price change beyond the tolerance, never for variable amounts", () => {
    const state = contractState(terms(), [paid("2026-10-03"), paid("2026-11-03", -1_399)], "2026-11-04");
    expect(state.status).toBe("price_changed");
    expect(state.priceChange).toMatchObject({ expectedCents: 1_299, actualCents: 1_399 });
    expect(state.priceChange?.changePercent).toBeCloseTo(7.7, 1);
    expect(contractState(terms(), [paid("2026-11-03", -1_340)], "2026-11-04").priceChange).toBeNull();
    expect(contractState(terms({ variable: true }), [paid("2026-11-03", -1_399)], "2026-11-04").priceChange).toBeNull();
    expect(contractState(terms({ tolerancePercent: null }), [paid("2026-11-03", -1_399)], "2026-11-04").priceChange).toBeNull();
  });

  it("knows ending and ended contracts", () => {
    expect(contractState(terms({ endDate: "2027-03-31" }), [paid("2026-11-03")], "2026-11-04")).toMatchObject({
      status: "ending",
      nextDue: "2026-12-03",
    });
    expect(contractState(terms({ endDate: "2026-11-30" }), [paid("2026-11-03")], "2026-11-04")).toMatchObject({
      status: "ending",
      nextDue: null,
      overdue: false,
    });
    expect(contractState(terms({ endDate: "2026-10-31" }), [], "2026-11-20")).toMatchObject({ status: "ended", overdue: false });
    expect(contractState(terms({ anchor: "2026-01-03", startDate: "2027-02-01" }), [], "2026-11-20").nextDue).toBe("2027-02-03");
  });

  it("lists the payments still expected in a range", () => {
    const quarterly = terms({ interval: "quarterly", anchor: "2026-12-15" });
    const state = contractState(quarterly, [], "2026-11-20");
    expect(expectedDueDates(quarterly, state, "2026-12-01", "2026-12-31")).toEqual(["2026-12-15"]);
    expect(expectedDueDates(quarterly, state, "2027-01-01", "2027-01-31")).toEqual([]);
    const weekly = terms({ interval: "weekly", anchor: "2026-11-25" });
    expect(expectedDueDates(weekly, contractState(weekly, [], "2026-11-20"), "2026-12-01", "2026-12-31")).toHaveLength(5);
    const ending = terms({ endDate: "2026-12-01" });
    expect(expectedDueDates(ending, contractState(ending, [paid("2026-11-03")], "2026-11-20"), "2026-12-01", "2026-12-31")).toEqual([]);
  });
});

const stat = (bookingDate: string, amountCents: number, counterparty: string): StatTxn => ({
  id: nextId++,
  accountId: 4,
  bookingDate,
  amountCents,
  counterparty,
  isTransfer: false,
  transferAccountId: null,
  category: null,
  tags: [],
  transferAccount: null,
});

describe("suggestions", () => {
  const history = [
    ...["2026-08-03", "2026-09-03", "2026-10-03"].map((day) => stat(day, -1_299, "Netflix International B.V.")),
    ...["2026-08-28", "2026-09-28", "2026-10-28"].map((day) => stat(day, 352_000, "Muster GmbH")),
    ...["2026-08-10", "2026-09-10", "2026-10-10"].map((day) => stat(day, -8_950, "HUK-COBURG")),
  ];

  it("detects incoming recurring payments too, with interval and account", () => {
    expect(recurringPayments(history).map((r) => r.counterparty)).toEqual(["HUK-COBURG", "Netflix International B.V."]);
    expect(recurringPayments(history, 3, "in")).toEqual([
      expect.objectContaining({
        key: "muster gmbh",
        direction: "income",
        typicalAmountCents: 352_000,
        accountId: 4,
        schedule: { interval: "monthly", intervalMonths: null },
      }),
    ]);
  });

  it("leaves out dismissed ones, linked ones and those a contract already covers", () => {
    const candidates = [...recurringPayments(history), ...recurringPayments(history, 3, "in")];
    expect(openSuggestions(candidates, [], new Set(), new Set()).map((s) => s.key)).toEqual([
      "huk-coburg",
      "netflix international b.v.",
      "muster gmbh",
    ]);
    const open = openSuggestions(
      candidates,
      [
        { direction: "expense", matchPayee: "netflix" },
        // The salary is income; an expense contract with that payee does not cover it.
        { direction: "expense", matchPayee: "Muster" },
      ],
      new Set(["expense:huk-coburg"]),
      new Set(),
    );
    expect(open.map((s) => s.key)).toEqual(["muster gmbh"]);
    expect(openSuggestions(candidates, [], new Set(), new Set(["income:muster gmbh"])).map((s) => s.key)).not.toContain("muster gmbh");
  });
});

describe("variable amounts", () => {
  it("expects the latest payment of a variable contract, the agreed amount of a fixed one", () => {
    const side = terms({ variable: true, amountCents: 50_000, anchor: "2026-11-27" });
    const state = contractState(side, [paid("2026-09-26", 34_000), paid("2026-10-27", 83_000)], "2026-11-10");
    expect(state).toMatchObject({ nextDue: "2026-11-27", expectedCents: 83_000, monthlyCents: 83_000, priceChange: null });
    expect(contractState(side, [], "2026-11-10").expectedCents).toBe(50_000);
    expect(contractState(terms(), [paid("2026-11-03", -1_399)], "2026-11-04").expectedCents).toBe(1_299);
    expect(contractState(terms({ interval: "quarterly", variable: true }), [paid("2026-11-03", -3_000)], "2026-11-04").monthlyCents).toBe(
      1_000,
    );
  });

  it("counts the days until a due date within a window, not for overdue or ended contracts", () => {
    const state = (nextDue: string | null, extra: { overdue?: boolean; status?: "active" | "ended" } = {}) => ({
      nextDue,
      overdue: false,
      status: "active" as const,
      ...extra,
    });
    expect(dueWithin(state("2026-11-17"), "2026-11-17", 7)).toBe(0);
    expect(dueWithin(state("2026-11-20"), "2026-11-17", 7)).toBe(3);
    expect(dueWithin(state("2026-11-24"), "2026-11-17", 7)).toBe(7);
    expect(dueWithin(state("2026-11-25"), "2026-11-17", 7)).toBeNull();
    expect(dueWithin(state("2026-11-10", { overdue: true }), "2026-11-17", 7)).toBeNull();
    expect(dueWithin(state("2026-11-20", { status: "ended" }), "2026-11-17", 7)).toBeNull();
    expect(dueWithin(state(null), "2026-11-17", 7)).toBeNull();
  });
});

describe("rhythm", () => {
  it("finds a monthly rhythm around the same day, also across month ends and with a skipped month", () => {
    expect(regularSchedule(["2026-07-27", "2026-08-28", "2026-09-25", "2026-10-27"], 3)).toEqual({
      interval: "monthly",
      intervalMonths: null,
    });
    expect(regularSchedule(["2026-08-31", "2026-09-30", "2026-10-30", "2026-12-01"], 3)?.interval).toBe("monthly");
    expect(regularSchedule(["2026-06-27", "2026-07-27", "2026-09-28", "2026-10-27"], 3)?.interval).toBe("monthly");
  });

  it("refuses scattered days, two payments in one period, too few payments and weekly patterns", () => {
    expect(regularSchedule(["2026-08-03", "2026-09-15", "2026-10-27"], 3)).toBeNull();
    expect(regularSchedule(["2026-08-27", "2026-09-27", "2026-09-29", "2026-10-27"], 3)).toBeNull();
    expect(regularSchedule(["2026-09-27", "2026-10-27"], 3)).toBeNull();
    expect(regularSchedule(["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24"], 3)).toBeNull();
    expect(regularSchedule(["2026-03-27", "2026-07-27", "2026-10-27"], 3, { interval: "monthly" })).toBeNull();
  });

  it("checks a yearly rhythm against a forced interval", () => {
    const yearly = { interval: "yearly" } as const;
    expect(regularSchedule(["2025-01-15", "2026-01-20"], 2, yearly)).toEqual(yearly);
    expect(regularSchedule(["2025-01-15", "2026-03-20"], 2, yearly)).toBeNull();
    expect(regularSchedule(["2024-01-15", "2026-01-15"], 2, yearly)).toBeNull();
  });
});

describe("contract candidates", () => {
  const TODAY = "2026-11-17";
  const side = [
    ["2026-05-27", 34_000],
    ["2026-06-26", 83_000],
    ["2026-07-27", 51_000],
    ["2026-08-27", 41_500],
    ["2026-09-28", 62_000],
    ["2026-10-27", 47_300],
  ].map(([day, cents]) => stat(String(day), Number(cents), "Musterfirma Nebenjob GmbH"));

  it("suggests an income with varying amounts that arrives monthly around the same day as a variable contract", () => {
    expect(recurringPayments(side, 3, "in")).toEqual([]);
    expect(contractCandidates(side, "in", TODAY)).toEqual([
      expect.objectContaining({
        key: "musterfirma nebenjob gmbh",
        direction: "income",
        variable: true,
        latestAmountCents: 47_300,
        minAmountCents: 34_000,
        maxAmountCents: 83_000,
        lastDate: "2026-10-27",
        months: 6,
        schedule: { interval: "monthly", intervalMonths: null },
      }),
    ]);
  });

  it("keeps stable payments fixed and leaves out irregular and stopped ones", () => {
    const shopping = ["2026-08-02", "2026-08-09", "2026-08-21", "2026-09-04", "2026-09-30", "2026-10-11", "2026-11-02"].map((day, i) =>
      stat(day, -(2_000 + i * 1_700), "REWE Markt"),
    );
    const stopped = ["2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"].map((day, i) => stat(day, -(1_000 + i * 900), "Altvertrag"));
    const netflix = ["2026-08-03", "2026-09-03", "2026-10-03"].map((day) => stat(day, -1_299, "Netflix"));
    const found = contractCandidates([...shopping, ...stopped, ...netflix], "out", TODAY);
    expect(found.map((c) => [c.key, c.variable])).toEqual([["netflix", false]]);
  });

  it("finds yearly payments from two years of history while they still run", () => {
    const insurance = [stat("2025-01-10", -45_000, "Allianz"), stat("2026-01-12", -47_000, "Allianz")];
    expect(contractCandidates(insurance, "out", "2026-11-17")).toEqual([
      expect.objectContaining({
        key: "allianz",
        variable: false,
        schedule: { interval: "yearly", intervalMonths: null },
        lastDate: "2026-01-12",
      }),
    ]);
    expect(contractCandidates(insurance, "out", "2027-03-01")).toEqual([]);
    expect(contractCandidates(insurance.slice(1), "out", "2026-11-17")).toEqual([]);
  });

  it("sorts by the monthly amount, largest first", () => {
    const rent = ["2026-08-01", "2026-09-01", "2026-10-01"].map((day) => stat(day, -90_000, "Hausverwaltung"));
    const netflix = ["2026-08-03", "2026-09-03", "2026-10-03"].map((day) => stat(day, -1_299, "Netflix"));
    const yearly = [stat("2025-02-10", -120_000, "Kfz-Steuer"), stat("2026-02-10", -120_000, "Kfz-Steuer")];
    expect(contractCandidates([...netflix, ...yearly, ...rent], "out", TODAY).map((c) => c.key)).toEqual([
      "hausverwaltung",
      "kfz-steuer",
      "netflix",
    ]);
  });
});
