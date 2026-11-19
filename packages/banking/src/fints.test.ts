import { AccountType } from "lib-fints";
import { describe, expect, it } from "vitest";
import { bankFailure, type FinTSClientLike, FinTSSession, fintsDay, mapPortfolio, mapStatements, type TanMethod } from "./fints.ts";
import type { TanChallenge } from "./types.ts";

type BankingInformation = FinTSClientLike["config"]["bankingInformation"];
type Account = NonNullable<BankingInformation["upd"]>["bankAccounts"][number];

const method = (id: number, name: string, isDecoupled = false): TanMethod => ({
  id,
  name,
  version: 6,
  isDecoupled,
  activeTanMediaCount: 0,
  activeTanMedia: [],
  tanMediaRequirement: 0,
});

const account = {
  accountNumber: "137075030",
  iban: "DE02500105170137075030",
  currency: "EUR",
  product: "Girokonto",
  accountType: AccountType.CheckingAccount,
} as Account;
const depot = {
  accountNumber: "5544332211",
  currency: "EUR",
  product: "Direkt-Depot",
  accountType: AccountType.SecuritiesAccount,
} as Account;
const card = { accountNumber: "4111", currency: "EUR", product: "VISA Card", accountType: AccountType.CreditCardAccount } as Account;

function base() {
  return { dialogId: "1", bankingInformationUpdated: false, bankAnswers: [] };
}

function fakeClient(options: { pinWrong?: boolean } = {}) {
  const methods = [method(999, "Einschritt"), method(900, "iTAN"), method(902, "Banking App", true)];
  const bankingInformation = { systemId: "0", bankMessages: [] } as BankingInformation;
  const log: string[] = [];
  let selected: TanMethod | undefined;
  const client: FinTSClientLike = {
    config: {
      bankingInformation,
      get availableTanMethods() {
        return bankingInformation.bpd ? methods : [];
      },
      get selectedTanMethod() {
        return selected;
      },
    },
    selectTanMethod(id) {
      selected = methods.find((m) => m.id === id);
      log.push(`select:${id}`);
    },
    selectTanMedia() {},
    async synchronize() {
      log.push("sync");
      if (options.pinWrong) return { ...base(), success: false, requiresTan: false, bankAnswers: [{ code: 9942, text: "PIN falsch" }] };
      bankingInformation.bpd = {} as NonNullable<BankingInformation["bpd"]>;
      if (selected) bankingInformation.upd = { version: 1, usage: 0, bankAccounts: [account, depot, card] } as BankingInformation["upd"];
      return { ...base(), success: true, requiresTan: false };
    },
    async synchronizeWithTan() {
      throw new Error("unused");
    },
    canGetAccountBalance: () => true,
    async getAccountBalance() {
      return { ...base(), success: true, requiresTan: true, tanReference: "bal", tanChallenge: "Bitte in der App freigeben" };
    },
    async getAccountBalanceWithTan(_ref, tan) {
      log.push(`balance-tan:${tan ?? "-"}`);
      return { ...base(), success: true, requiresTan: false, balance: { date: new Date("2026-11-15"), currency: "EUR", balance: 12500 } };
    },
    canGetAccountStatements: () => true,
    async getAccountStatements() {
      return { ...base(), success: true, requiresTan: true, tanReference: "st", tanChallenge: "", statements: [] };
    },
    async getAccountStatementsWithTan(_ref, tan) {
      log.push(`statements-tan:${tan ?? "-"}`);
      return {
        ...base(),
        success: true,
        requiresTan: false,
        statements: [
          {
            openingBalance: { date: new Date(), currency: "EUR", value: 0 },
            closingBalance: { date: new Date(), currency: "EUR", value: 0 },
            transactions: [
              {
                valueDate: new Date(2026, 10, 2),
                entryDate: new Date(2026, 10, 2),
                amount: -19.99,
                remoteName: "Spotify AB",
                purpose: "Spotify Premium",
                fundsCode: "",
                transactionType: "",
                customerReference: "NONREF",
                bankReference: "",
              },
            ],
          },
        ],
      };
    },
    canGetPortfolio: (a) => a?.accountType === AccountType.SecuritiesAccount,
    async getPortfolio() {
      return { ...base(), success: true, requiresTan: true, tanReference: "wpd", tanChallenge: "Depot freigeben" };
    },
    async getPortfolioWithTan(_ref, tan) {
      log.push(`portfolio-tan:${tan ?? "-"}`);
      return {
        ...base(),
        success: true,
        requiresTan: false,
        portfolioStatement: {
          totalValue: 1234.56,
          currency: "EUR",
          holdings: [
            {
              isin: "IE00B4L5Y983",
              name: "iShares Core MSCI World",
              amount: 10.5,
              price: 100.2,
              value: 1052.1,
              currency: "EUR",
              acquisitionPrice: 80,
              date: new Date("2026-11-14T12:00"),
            },
            { isin: "DE0001102580", name: "Bund 2032", amount: 200, price: 0.9123, value: 182.46, currency: "%" },
          ],
        },
      };
    },
    canGetCreditCardStatements: (a) => a?.accountType === AccountType.CreditCardAccount,
    async getCreditCardStatements() {
      return {
        ...base(),
        success: true,
        requiresTan: false,
        balance: { balance: -42.5, date: new Date("2026-11-15"), currency: "EUR" },
        statements: [
          { transactionDate: new Date(2026, 10, 3), valueDate: new Date(2026, 10, 4), currency: "EUR", amount: -42.5, purpose: "AMAZON" },
        ],
      } as Awaited<ReturnType<FinTSClientLike["getCreditCardStatements"]>>;
    },
    async getCreditCardStatementsWithTan() {
      throw new Error("unused");
    },
  };
  return { client, log };
}

describe("FinTS session", () => {
  it("prefers the decoupled app approval, repeats the sync for accounts and passes no TAN when polling", async () => {
    const { client, log } = fakeClient();
    const challenges: TanChallenge[] = [];
    const session = new FinTSSession(client, async (challenge) => {
      challenges.push(challenge);
      return "";
    });
    const result = await session.synchronize();
    expect(result.tanMethods).toEqual({ "900": "iTAN", "902": "Banking App" });
    expect(result.accounts).toEqual([
      {
        ref: "DE02500105170137075030",
        iban: "DE02500105170137075030",
        name: "Girokonto",
        currency: "EUR",
        product: "Girokonto",
        type: "CACC",
      },
      { ref: "5544332211", iban: null, name: "Direkt-Depot", currency: "EUR", product: "Direkt-Depot", type: "DEPOT" },
      { ref: "4111", iban: null, name: "VISA Card", currency: "EUR", product: "VISA Card", type: "CARD" },
    ]);
    expect(log.slice(0, 3)).toEqual(["sync", "select:902", "sync"]);

    expect(await session.balance("DE02500105170137075030")).toEqual({ amountCents: 1_250_000, date: "2026-11-15" });
    expect(challenges[0]).toEqual({ text: "Bitte in der App freigeben", decoupled: true, imageDataUrl: null });
    expect(log).toContain("balance-tan:-");
    expect(session.state().tanMethodId).toBe(902);
  });

  it("hands a typed TAN to the continuation", async () => {
    const { client, log } = fakeClient();
    const session = new FinTSSession(client, async () => "123456", 900);
    await session.synchronize();
    const bookings = await session.statements("DE02500105170137075030", "2026-10-01", "2026-11-15");
    expect(log).toContain("statements-tan:123456");
    expect(bookings).toEqual([
      {
        bookingDate: "2026-11-02",
        valueDate: "2026-11-02",
        amountCents: -1999,
        currency: "EUR",
        counterparty: "Spotify AB",
        counterpartyIban: null,
        purpose: "Spotify Premium",
        providerId: null,
      },
    ]);
  });

  it("reports a rejected PIN in German", async () => {
    const { client } = fakeClient({ pinWrong: true });
    await expect(new FinTSSession(client, async () => "").synchronize()).rejects.toMatchObject({
      message: "Die Bank hat Login oder PIN abgelehnt: PIN falsch (9942). Bitte Zugangsdaten prüfen.",
    });
  });

  it("names the reason beside the generic 9800 'dialog ended' answer", () => {
    expect(
      bankFailure([
        { code: 9800, text: "Der Dialog wurde abgebrochen." },
        { code: 9078, text: "Produkt nicht zugelassen" },
      ]).message,
    ).toBe("Die Bank meldet: Produkt nicht zugelassen (9078)");
    expect(bankFailure([{ code: 9800, text: "Der Dialog wurde abgebrochen." }]).message).toBe(
      "Die Bank meldet: Der Dialog wurde abgebrochen. (9800)",
    );
  });

  it("reads lib-fints dates as calendar days and skips statements without a date", () => {
    expect(fintsDay(new Date("2026-11-15"))).toBe("2026-11-15");
    expect(fintsDay(new Date(2026, 10, 15))).toBe("2026-11-15");
    expect(fintsDay(new Date(2026, 10, 15, 12))).toBe("2026-11-15");
    expect(mapStatements({ ...base(), success: true, requiresTan: false, statements: [] }, "EUR")).toEqual([]);
  });
});

describe("FinTS depots and cards", () => {
  it("reads depot positions through HKWPD with the TAN flow and uses the bank's total", async () => {
    const { client, log } = fakeClient();
    const session = new FinTSSession(client, async () => "654321", 900);
    await session.synchronize();
    const result = await session.fetchAccount("5544332211", "2026-10-01", "2026-11-15", "2026-11-15");
    expect(log).toContain("portfolio-tan:654321");
    expect(result.bookings).toEqual([]);
    expect(result.balance).toEqual({ amountCents: 123_456, date: "2026-11-15" });
    expect(result.holdings).toEqual([
      {
        isin: "IE00B4L5Y983",
        name: "iShares Core MSCI World",
        quantity: 10.5,
        price: 100.2,
        currency: "EUR",
        valueCents: 105_210,
        costBasisCents: 84_000,
        asOf: "2026-11-14",
      },
      {
        isin: "DE0001102580",
        name: "Bund 2032",
        quantity: 200,
        price: 0.9123,
        currency: "%",
        valueCents: 18_246,
        costBasisCents: null,
        asOf: "2026-11-15",
      },
    ]);
  });

  it("reads credit card statements and their balance", async () => {
    const { client } = fakeClient();
    const session = new FinTSSession(client, async () => "", 900);
    await session.synchronize();
    const result = await session.fetchAccount("4111", "2026-10-01", "2026-11-15", "2026-11-15");
    expect(result.balance).toEqual({ amountCents: -4250, date: "2026-11-15" });
    expect(result.bookings).toMatchObject([{ bookingDate: "2026-11-04", amountCents: -4250, purpose: "AMAZON" }]);
    expect(result.holdings).toBeNull();
  });

  it("sums the positions when the bank sends no total", () => {
    const { holdings, total } = mapPortfolio(
      {
        holdings: [
          { name: "A", value: 10 },
          { name: "B", value: 5.5 },
        ],
      },
      "2026-11-15",
    );
    expect(holdings).toHaveLength(2);
    expect(total).toEqual({ amountCents: 1550, date: "2026-11-15" });
    expect(mapPortfolio(undefined, "2026-11-15")).toEqual({ holdings: [], total: null });
  });
});
