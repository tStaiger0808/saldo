/**
 * Stand-ins for bank APIs in e2e runs: Enable Banking (application check, a German bank list of realistic length, one
 * account with a booked and a pending entry) and givve.
 */
import { createServer } from "node:http";

const NAMED = ["Ärzte- und Apothekerbank", "comdirect", "Commerzbank", "Deutsche Bank", "DKB", "ING", "N26", "Thüringer Aufbaubank"];
const KINDS = ["Sparkasse", "Volksbank", "Raiffeisenbank", "VR Bank"];

export const FAKE_BANK_COUNT = 1077;

function bankNames(): string[] {
  const names = [...NAMED];
  for (let i = 1; names.length < FAKE_BANK_COUNT; i++) names.push(`${KINDS[i % KINDS.length]} Region ${i}`);
  return names;
}

/** givve's login asks this address for the e-mailed code, every other one signs in at once. */
export const FAKE_GIVVE_OTP_EMAIL = "code@e2e.invalid";
export const FAKE_GIVVE_OTP = "123456";

const today = () => new Date().toISOString().slice(0, 10);

export const FAKE_EB_ACCOUNT = "e2e-giro";
export const FAKE_PENDING_PAYEE = "Kiosk am Bahnhof";
/** POST here and the pending entry arrives booked from then on; DELETE announces it again. */
export const FAKE_EB_BOOK_PATH = "/e2e/book-pending";

const enableBankingState = { pendingBooked: false };

/** Enable Banking's account data for one account: balance and transactions of every status, as the API sends them. */
function accountData(method: string, path: string): { status: number; body: unknown } | null {
  if (path === FAKE_EB_BOOK_PATH && (method === "POST" || method === "DELETE")) {
    enableBankingState.pendingBooked = method === "POST";
    return { status: 200, body: enableBankingState };
  }
  if (method !== "GET") return null;
  if (path === `/accounts/${FAKE_EB_ACCOUNT}/balances`) {
    return {
      status: 200,
      body: { balances: [{ balance_type: "CLBD", balance_amount: { amount: "512.30", currency: "EUR" }, reference_date: today() }] },
    };
  }
  if (path !== `/accounts/${FAKE_EB_ACCOUNT}/transactions`) return null;
  const entry = (ref: string, status: string, amount: string, name: string, day: string) => ({
    entry_reference: ref,
    transaction_amount: { amount, currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status,
    booking_date: day,
    creditor: { name },
    remittance_information: ["Kartenzahlung"],
  });
  return {
    status: 200,
    body: {
      transactions: [
        entry("e2e-booked", "BOOK", "41.20", "Stadtwerke Kempten", today()),
        entry("e2e-pending", enableBankingState.pendingBooked ? "BOOK" : "PDNG", "7.80", FAKE_PENDING_PAYEE, today()),
      ],
      continuation_key: null,
    },
  };
}

/** Stand-in for the givve card portal: one card with one booking of today. */
function givve(method: string, path: string, body: Record<string, unknown>): { status: number; body: unknown } | null {
  if (method === "POST" && path === "/givve/authorizations") {
    if (body.identifier === FAKE_GIVVE_OTP_EMAIL && body.otp !== FAKE_GIVVE_OTP) {
      return body.otp === undefined ? { status: 200, body: { data: { auth_status: "otp_required" } } } : { status: 422, body: {} };
    }
    return { status: 200, body: { data: { access_token: "e2e-token", refresh_token: null } } };
  }
  const card = { id: "card-1", number: "**** 1234", balance: { cents: 4_210, currency: "EUR" }, updated_at: `${today()}T08:00:00Z` };
  if (method === "GET" && path === "/givve/voucher_owners/me/vouchers") return { status: 200, body: { data: [card] } };
  if (method === "GET" && path === "/givve/voucher_owners/me/vouchers/card-1") return { status: 200, body: { data: card } };
  if (method === "GET" && path === "/givve/voucher_owners/me/vouchers/card-1/transaction_groups") {
    const group = {
      id: "g-1",
      first_booked_at: `${today()}T09:00:00Z`,
      latest_booked_at: `${today()}T09:00:00Z`,
      status: "ok",
      category: "purchase",
      amount: { cents: -1_250, currency: "EUR" },
      description: "Mittagessen",
      merchant_name: "Kantine Süd",
    };
    return { status: 200, body: { data: [group], links: { next: null } } };
  }
  return null;
}

export function startFakeEnableBanking(port: number, appUrl: string): Promise<void> {
  const aspsps = bankNames().map((name) => ({ name, country: "DE", logo: null, sandbox: false, beta: false }));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const card = path.startsWith("/givve/") ? givve(request.method ?? "GET", path, parsed) : accountData(request.method ?? "GET", path);
      const body =
        path === "/application"
          ? { name: "Saldo E2E", environment: "SANDBOX", active: true, redirect_urls: [`${appUrl}/bank/callback`] }
          : path === "/aspsps"
            ? { aspsps }
            : null;
      response.writeHead(card?.status ?? (body ? 200 : 404), { "Content-Type": "application/json" });
      response.end(JSON.stringify(card?.body ?? body ?? { message: "Not found" }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}
