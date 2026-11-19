/** FinTS (HBCI PIN/TAN) via lib-fints: synchronization, TAN method choice, accounts, balances, statements and depots. */
import { toCents } from "@saldo/core";
import {
  type AccountBalanceResponse,
  AccountType,
  type BankAccount,
  type BankAnswer,
  type BankingInformation,
  type ClientResponse,
  type CreditCardStatement,
  FinTSClient,
  FinTSConfig,
  type PortfolioResponse,
  type StatementOfHoldings,
  type StatementResponse,
  type SynchronizeResponse,
} from "lib-fints";
import {
  BankError,
  type RawBooking,
  type RawHolding,
  type RemoteAccount,
  type RemoteBalance,
  type TanChallenge,
  type TanHandler,
} from "./types.ts";

// lib-fints prints an undecodable bank response (account data) with console.error; keep that out of the logs.
const LIBRARY_DUMP = /^(Error decoding response message:|Response Message Content:)/;
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && LIBRARY_DUMP.test(first)) {
    if (first.startsWith("Error decoding")) consoleError("FinTS: a bank response could not be decoded");
    return;
  }
  consoleError(...args);
};

export type TanMethod = FinTSConfig["availableTanMethods"][number];

export type FinTSPreset = { key: string; name: string; blz: string; server: string; confirmed: boolean };

// Taken from the legacy app and the banks' published endpoints; not yet confirmed with real accounts here.
export const FINTS_PRESETS: FinTSPreset[] = [
  { key: "dkb", name: "DKB", blz: "12030000", server: "https://fints.dkb.de/fints", confirmed: false },
  { key: "ing", name: "ING", blz: "50010517", server: "https://fints.ing.de/fints/", confirmed: false },
  { key: "comdirect", name: "Comdirect", blz: "20041111", server: "https://fints.comdirect.de/fints", confirmed: false },
];

export type FinTSAccess = {
  productId: string;
  productVersion?: string;
  blz: string;
  server: string;
  login: string;
  customerId?: string | null;
  pin: string;
  /** Stored from the previous session, so BPD/UPD and the system id are reused. */
  bankingInformation?: BankingInformation | null;
  tanMethodId?: number | null;
  tanMediaName?: string | null;
};

/** The part of lib-fints' FinTSClient this wrapper uses; tests provide a fake with the same shape. */
export type FinTSClientLike = {
  config: { bankingInformation: BankingInformation; availableTanMethods: TanMethod[]; selectedTanMethod?: TanMethod | undefined };
  selectTanMethod(tanMethodId: number): unknown;
  selectTanMedia(tanMediaName: string): void;
  synchronize(): Promise<SynchronizeResponse>;
  synchronizeWithTan(tanReference: string, tan?: string): Promise<SynchronizeResponse>;
  canGetAccountBalance(account?: BankAccount): boolean;
  getAccountBalance(account: BankAccount): Promise<AccountBalanceResponse>;
  getAccountBalanceWithTan(tanReference: string, tan?: string): Promise<AccountBalanceResponse>;
  canGetAccountStatements(account?: BankAccount): boolean;
  getAccountStatements(account: BankAccount, from?: Date, to?: Date): Promise<StatementResponse>;
  getAccountStatementsWithTan(tanReference: string, tan?: string): Promise<StatementResponse>;
  canGetPortfolio(account?: BankAccount): boolean;
  getPortfolio(account: BankAccount): Promise<PortfolioResponse>;
  getPortfolioWithTan(tanReference: string, tan?: string): Promise<PortfolioResponse>;
  canGetCreditCardStatements(account?: BankAccount): boolean;
  // lib-fints declares StatementResponse, but credit card answers carry CreditCardStatement items and a balance.
  getCreditCardStatements(account: BankAccount, from?: Date, to?: Date): Promise<ClientResponse>;
  getCreditCardStatementsWithTan(tanReference: string, tan?: string): Promise<ClientResponse>;
};

export type FinTSClientFactory = (access: FinTSAccess) => FinTSClientLike;

export const createFinTSClient: FinTSClientFactory = (access) => {
  const version = access.productVersion ?? "1.0";
  const customerId = access.customerId || undefined;
  const config = access.bankingInformation?.bpd
    ? FinTSConfig.fromBankingInformation(
        access.productId,
        version,
        access.bankingInformation,
        access.login,
        access.pin,
        undefined,
        undefined,
        customerId,
      )
    : FinTSConfig.forFirstTimeUse(access.productId, version, access.server, access.blz, access.login, access.pin, customerId);
  const client = new FinTSClient(config);
  // Selected after construction: a stored method the bank no longer offers must not break the whole session.
  try {
    if (access.tanMethodId) client.selectTanMethod(access.tanMethodId);
    if (access.tanMediaName) client.selectTanMedia(access.tanMediaName);
  } catch {
    // FinTSSession chooses a method again.
  }
  return client;
};

const PIN_CODES = new Set([9340, 9931, 9942]);
const LOCKED_CODES = new Set([3938, 9938]);
const DIALOG_ENDED = 9800;
const DECOUPLED_HINTS = ["app", "push", "decoupled", "secure", "seal"];
const SINGLE_STEP_METHOD = 999;
const TAN_MEDIA_REQUIRED = 2;

/** The bank's own words with their code, e.g. "PIN falsch (9942)"; they tell apart a wrong PIN from an unknown login. */
const answerText = (answer: BankAnswer) => `${answer.text.trim().slice(0, 200)} (${answer.code})`;

export function bankFailure(answers: BankAnswer[]): BankError {
  const rejected = answers.find((a) => PIN_CODES.has(a.code));
  if (rejected) return new BankError(`Die Bank hat Login oder PIN abgelehnt: ${answerText(rejected)}. Bitte Zugangsdaten prüfen.`);
  if (answers.some((a) => LOCKED_CODES.has(a.code)))
    return new BankError("Der Bankzugang ist vorübergehend gesperrt. Bitte bei der Bank entsperren.");
  // 9800 only says the dialog ended; the reason comes in the other error answers of the same response.
  const errors = answers.filter((a) => a.code >= 9000);
  const reasons = errors.filter((a) => a.code !== DIALOG_ENDED);
  const shown = (reasons.length > 0 ? reasons : errors.length > 0 ? errors : answers.slice(0, 1)).slice(0, 3);
  return new BankError(shown.length > 0 ? `Die Bank meldet: ${shown.map(answerText).join(" · ")}` : "Die Bank hat die Anfrage abgelehnt.");
}

function libraryFailure(error: unknown): BankError {
  if (error instanceof BankError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError || /fetch failed|Request failed with status/i.test(message)) {
    return new BankError("Der FinTS-Server der Bank ist nicht erreichbar. Bitte Adresse prüfen oder später erneut versuchen.");
  }
  return new BankError(`FinTS-Fehler: ${message.slice(0, 200)}`);
}

async function bankCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw libraryFailure(error);
  }
}

export function chooseTanMethod(methods: TanMethod[], preferredId?: number | null): TanMethod | undefined {
  const usable = methods.filter((m) => m.id !== SINGLE_STEP_METHOD);
  return (
    usable.find((m) => m.id === preferredId) ??
    usable.find((m) => m.isDecoupled) ??
    usable.find((m) => DECOUPLED_HINTS.some((hint) => m.name.toLowerCase().includes(hint))) ??
    usable[0]
  );
}

function challengeOf(response: ClientResponse, decoupled: boolean): TanChallenge {
  const photo = response.tanPhoto;
  const imageDataUrl =
    photo && /^image\/[a-z0-9.+-]+$/i.test(photo.mimeType) && photo.image.length > 0
      ? `data:${photo.mimeType};base64,${Buffer.from(photo.image).toString("base64")}`
      : null;
  const fallback = decoupled ? "Bitte den Auftrag in deiner Banking-App freigeben." : "Bitte TAN eingeben.";
  return { text: response.tanChallenge?.trim() || fallback, decoupled, imageDataUrl };
}

/** lib-fints builds dates at local midnight or noon, except DAT fields which are UTC midnight. */
export function fintsDay(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0) return date.toISOString().slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function centsOf(amount: number): number {
  if (!Number.isFinite(amount)) throw new BankError("Unlesbarer Betrag von der Bank");
  return toCents(amount.toFixed(2));
}

export function accountRef(account: BankAccount): string {
  return account.iban || (account.subAccountId ? `${account.accountNumber}:${account.subAccountId}` : account.accountNumber);
}

/** ISO 20022 cash account types where they exist; DEPOT is ours and makes the account a brokerage account. */
const ACCOUNT_TYPES: Partial<Record<AccountType, string>> = {
  [AccountType.CheckingAccount]: "CACC",
  [AccountType.SavingsAccount]: "SVGS",
  [AccountType.FixedDepositAccount]: "SVGS",
  [AccountType.CreditCardAccount]: "CARD",
  [AccountType.SecuritiesAccount]: "DEPOT",
};

type CardResponse = ClientResponse & {
  balance?: { balance?: number; date?: Date | string; currency?: string };
  statements?: Partial<CreditCardStatement>[];
};

export function mapCardStatements(response: CardResponse, fallbackCurrency: string): RawBooking[] {
  const bookings: RawBooking[] = [];
  for (const s of response.statements ?? []) {
    const bookingDate = fintsDay(s.valueDate) ?? fintsDay(s.transactionDate);
    if (!bookingDate || typeof s.amount !== "number") continue;
    bookings.push({
      bookingDate,
      valueDate: fintsDay(s.valueDate),
      amountCents: centsOf(s.amount),
      currency: s.currency || fallbackCurrency,
      counterparty: s.remoteName || "",
      counterpartyIban: null,
      purpose: s.purpose?.trim() || "",
      providerId: s.reference || null,
    });
  }
  return bookings;
}

/** MT535 positions; the depot total is the bank's sum when it sends one, otherwise the sum of the positions. */
export function mapPortfolio(
  statement: StatementOfHoldings | undefined,
  today: string,
): { holdings: RawHolding[]; total: RemoteBalance | null } {
  const holdings: RawHolding[] = [];
  for (const h of statement?.holdings ?? []) {
    if (typeof h.value !== "number" || !Number.isFinite(h.value)) continue;
    const quantity = typeof h.amount === "number" && Number.isFinite(h.amount) ? h.amount : 0;
    const currency = h.currency || statement?.currency || "EUR";
    const perUnit = typeof h.acquisitionPrice === "number" && Number.isFinite(h.acquisitionPrice) ? h.acquisitionPrice : null;
    holdings.push({
      isin: h.isin ?? null,
      name: (h.name || h.isin || h.wkn || "Wertpapier").slice(0, 200),
      quantity,
      price: typeof h.price === "number" && Number.isFinite(h.price) ? h.price : null,
      currency,
      valueCents: centsOf(h.value),
      // Percent-quoted bonds would need the nominal factor; their cost basis stays unknown.
      costBasisCents: perUnit !== null && quantity > 0 && currency !== "%" ? centsOf(perUnit * quantity) : null,
      asOf: fintsDay(h.date) ?? today,
    });
  }
  const sum = holdings.reduce((total, h) => total + h.valueCents, 0);
  const total = typeof statement?.totalValue === "number" && Number.isFinite(statement.totalValue) ? centsOf(statement.totalValue) : sum;
  return { holdings, total: statement ? { amountCents: total, date: today } : null };
}

export type FetchedAccount = { bookings: RawBooking[]; balance: RemoteBalance | null; holdings: RawHolding[] | null };

export function mapStatements(response: StatementResponse, fallbackCurrency: string): RawBooking[] {
  const bookings: RawBooking[] = [];
  for (const statement of response.statements ?? []) {
    const currency = statement.closingBalance?.currency || statement.openingBalance?.currency || fallbackCurrency;
    for (const t of statement.transactions ?? []) {
      const bookingDate = fintsDay(t.entryDate) ?? fintsDay(t.valueDate);
      if (!bookingDate || typeof t.amount !== "number") continue;
      bookings.push({
        bookingDate,
        valueDate: fintsDay(t.valueDate),
        amountCents: centsOf(t.amount),
        currency,
        counterparty: t.remoteName || t.bookingText || "",
        counterpartyIban: t.remoteAccountNumber || null,
        purpose: t.purpose || t.bookingText || t.additionalInformation || "",
        // MT940 references are often "NONREF"; the importer falls back to a content hash.
        providerId: null,
      });
    }
  }
  return bookings;
}

/** One FinTS session: resolves TAN challenges through `onTan` and turns bank answers into BankErrors. */
export class FinTSSession {
  constructor(
    private readonly client: FinTSClientLike,
    private readonly onTan: TanHandler,
    private readonly preferredTanMethodId: number | null = null,
  ) {}

  /** Errors of the TAN handler (e.g. a cancelled job) pass through unchanged; library errors become BankErrors. */
  private async resolve<T extends ClientResponse>(
    start: () => Promise<T>,
    next: (reference: string, tan?: string) => Promise<T>,
  ): Promise<T> {
    let response = await bankCall(start);
    while (response.requiresTan) {
      const reference = response.tanReference;
      if (!reference) throw new BankError("Die Bank verlangt eine Freigabe, liefert aber keinen Vorgang dazu.");
      const decoupled = this.client.config.selectedTanMethod?.isDecoupled ?? false;
      const tan = await this.onTan(challengeOf(response, decoupled));
      response = await bankCall(() => next(reference, decoupled ? undefined : tan));
    }
    if (!response.success) throw bankFailure(response.bankAnswers ?? []);
    return response;
  }

  private selectMethod(): boolean {
    const choice = chooseTanMethod(this.client.config.availableTanMethods, this.preferredTanMethodId);
    if (!choice) return false;
    const current = this.client.config.selectedTanMethod;
    if (current?.id !== choice.id) this.client.selectTanMethod(choice.id);
    const media = choice.activeTanMedia ?? [];
    if (choice.tanMediaRequirement === TAN_MEDIA_REQUIRED && media[0]) this.client.selectTanMedia(media[0]);
    return current?.id !== choice.id;
  }

  /**
   * Fetches BPD/UPD. Without a selected TAN method most banks send no accounts, so a method is chosen
   * (app approval preferred) and the synchronization repeated.
   */
  async synchronize(): Promise<{ tanMethods: Record<string, string>; accounts: RemoteAccount[] }> {
    await this.resolve(
      () => this.client.synchronize(),
      (ref, tan) => this.client.synchronizeWithTan(ref, tan),
    );
    if (this.selectMethod() || !this.client.config.bankingInformation.upd) {
      await this.resolve(
        () => this.client.synchronize(),
        (ref, tan) => this.client.synchronizeWithTan(ref, tan),
      );
    }
    return { tanMethods: this.tanMethods(), accounts: this.accounts() };
  }

  tanMethods(): Record<string, string> {
    return Object.fromEntries(
      this.client.config.availableTanMethods.filter((m) => m.id !== SINGLE_STEP_METHOD).map((m) => [String(m.id), m.name]),
    );
  }

  accounts(): RemoteAccount[] {
    return (this.client.config.bankingInformation.upd?.bankAccounts ?? []).map((a) => ({
      ref: accountRef(a),
      iban: a.iban ?? null,
      name: a.product || a.iban || a.accountNumber,
      currency: a.currency || null,
      product: a.product || null,
      ...(ACCOUNT_TYPES[a.accountType] ? { type: ACCOUNT_TYPES[a.accountType] } : {}),
    }));
  }

  /** What to persist (encrypted) for the next session. */
  state(): { bankingInformation: BankingInformation; tanMethodId: number | null; tanMediaName: string | null } {
    const selected = this.client.config.selectedTanMethod;
    const media = selected?.tanMediaRequirement === TAN_MEDIA_REQUIRED ? (selected.activeTanMedia?.[0] ?? null) : null;
    return { bankingInformation: this.client.config.bankingInformation, tanMethodId: selected?.id ?? null, tanMediaName: media };
  }

  private account(ref: string): BankAccount {
    const account = this.client.config.bankingInformation.upd?.bankAccounts.find((a) => accountRef(a) === ref || a.accountNumber === ref);
    if (!account) throw new BankError(`Das Konto ${ref} ist bei der Bank nicht mehr vorhanden.`);
    return account;
  }

  async balance(ref: string): Promise<RemoteBalance | null> {
    if (!this.client.config.selectedTanMethod) this.selectMethod();
    const account = this.account(ref);
    if (!this.client.canGetAccountBalance(account)) return null;
    const response = await this.resolve(
      () => this.client.getAccountBalance(account),
      (r, tan) => this.client.getAccountBalanceWithTan(r, tan),
    );
    const balance = response.balance;
    if (!balance || typeof balance.balance !== "number") return null;
    const date = fintsDay(balance.date);
    return date ? { amountCents: centsOf(balance.balance), date } : null;
  }

  async statements(ref: string, from: string, to: string): Promise<RawBooking[]> {
    if (!this.client.config.selectedTanMethod) this.selectMethod();
    const account = this.account(ref);
    if (!this.client.canGetAccountStatements(account)) {
      throw new BankError(`Für das Konto ${ref} bietet die Bank keine Umsätze per FinTS an.`);
    }
    const response = await this.resolve(
      () => this.client.getAccountStatements(account, new Date(`${from}T12:00:00Z`), new Date(`${to}T12:00:00Z`)),
      (r, tan) => this.client.getAccountStatementsWithTan(r, tan),
    );
    return mapStatements(response, account.currency || "EUR");
  }

  /**
   * Everything one account offers: depots their positions (no bookings), credit cards their card statement where the bank
   * has one, every other account bookings and balance. A depot without HKWPD keeps no positions (null).
   */
  async fetchAccount(ref: string, from: string, to: string, today: string): Promise<FetchedAccount> {
    if (!this.client.config.selectedTanMethod) this.selectMethod();
    const account = this.account(ref);
    if (account.accountType === AccountType.SecuritiesAccount) {
      if (!this.client.canGetPortfolio(account)) return { bookings: [], balance: null, holdings: null };
      const response = await this.resolve(
        () => this.client.getPortfolio(account),
        (r, tan) => this.client.getPortfolioWithTan(r, tan),
      );
      if (!response.portfolioStatement) throw new BankError("Die Bank hat den Depotbestand in einem unlesbaren Format geliefert.");
      const { holdings, total } = mapPortfolio(response.portfolioStatement, today);
      return { bookings: [], balance: total, holdings };
    }
    if (account.accountType === AccountType.CreditCardAccount && this.client.canGetCreditCardStatements(account)) {
      const response: CardResponse = await this.resolve(
        () => this.client.getCreditCardStatements(account, new Date(`${from}T12:00:00Z`), new Date(`${to}T12:00:00Z`)),
        (r, tan) => this.client.getCreditCardStatementsWithTan(r, tan),
      );
      const balance = response.balance;
      const date = fintsDay(balance?.date);
      return {
        bookings: mapCardStatements(response, account.currency || "EUR"),
        balance: balance && typeof balance.balance === "number" && date ? { amountCents: centsOf(balance.balance), date } : null,
        holdings: null,
      };
    }
    return { bookings: await this.statements(ref, from, to), balance: await this.balance(ref), holdings: null };
  }
}
