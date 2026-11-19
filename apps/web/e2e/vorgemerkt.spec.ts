import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { FAKE_EB_ACCOUNT, FAKE_EB_BOOK_PATH, FAKE_PENDING_PAYEE } from "./fake-enable-banking.ts";

const ADMIN = { username: "admin", password: "e2e-password-123" };
// Same database, key and bank stand-in as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";
const ENCRYPTION_KEY = Buffer.from("e2e-key-0123456789abcdef01234567");
const FAKE_BANK = process.env.ENABLE_BANKING_API_URL ?? "http://127.0.0.1:3101";
const ACCOUNT = "DKB Girokonto";
const SYNCED = "Vorgemerkt-Giro";
const CONNECTION = "Sparkasse Vorgemerkt";
const TOTALS = "Summen aller gefilterten Buchungen";
const EB_SETTINGS = ["enable_banking_app_id", "enable_banking_private_key"];

test.describe.configure({ mode: "serial" });

/** As src/server/crypto.ts stores secrets: AES-256-GCM, base64(iv | tag | ciphertext). */
function seal(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

type SettingRow = { key: string; value: unknown; ciphertext: string | null };
let savedSettings: SettingRow[] = [];

/** Enable Banking against the stand-in, and one connected account marked "only manually" so no other spec fetches it. */
async function seedConnection(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    savedSettings = await sql<SettingRow[]>`select key, value, ciphertext from settings where key in ${sql(EB_SETTINGS)}`;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await sql`insert into settings (key, value) values ('enable_banking_app_id', ${sql.json("00000000-1111-4222-8333-444455556666")})
      on conflict (key) do update set value = excluded.value, ciphertext = null`;
    await sql`insert into settings (key, value, ciphertext) values ('enable_banking_private_key', null, ${seal(privateKey)})
      on conflict (key) do update set value = null, ciphertext = excluded.ciphertext`;
    const [owner] = await sql<{ id: string }[]>`select id from "user" where username = ${ADMIN.username}`;
    if (!owner) throw new Error("admin missing");
    const secrets = { bankName: "Sparkasse", country: "DE", sessionId: "e2e-session", pendingState: null, pendingStateAt: null };
    const remote = [{ ref: FAKE_EB_ACCOUNT, iban: null, name: "Giro", currency: "EUR" }];
    const [connection] = await sql<{ id: number }[]>`
      insert into bank_connections (name, owner_user_id, visibility, provider, bank, status, ciphertext, remote_accounts, skip_sync_all)
      values (${CONNECTION}, ${owner.id}, 'household', 'enable_banking', 'sparkasse', 'active', ${seal(JSON.stringify(secrets))}, ${sql.json(remote)}, true)
      returning id`;
    await sql`insert into accounts (name, bank, kind, owner_user_id, visibility, color, connection_id, remote_ref)
      values (${SYNCED}, 'sparkasse', 'checking', ${owner.id}, 'household', '#c2410c', ${connection?.id ?? null}, ${FAKE_EB_ACCOUNT})`;
  } finally {
    await sql.end();
  }
  await fetch(`${FAKE_BANK}${FAKE_EB_BOOK_PATH}`, { method: "DELETE" });
}

/** Leaves the database as the other specs expect it. */
async function removeConnection(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from accounts where name = ${SYNCED}`;
    await sql`delete from bank_connections where name = ${CONNECTION}`;
    await sql`delete from settings where key in ${sql(EB_SETTINGS)}`;
    for (const row of savedSettings) {
      await sql`insert into settings (key, value, ciphertext) values (${row.key}, ${sql.json(row.value as never)}, ${row.ciphertext})`;
    }
  } finally {
    await sql.end();
  }
  await fetch(`${FAKE_BANK}${FAKE_EB_BOOK_PATH}`, { method: "DELETE" });
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption("tanne");
  await page.getByLabel("Modus").selectOption(mode);
}

const figure = (totals: Locator, label: string) => totals.locator(".totals-figure").filter({ hasText: label }).locator("dd");

let page: Page;

test.beforeAll(async ({ browser }) => {
  await seedConnection();
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
  page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
  await removeConnection();
});

const pendingRows = () => page.locator("tr.pending-row");

/** The account's page without filters; the link of an account with new bookings opens just those. */
async function accountPage(name: string) {
  await page.goto("/konten");
  const href =
    (await page
      .getByRole("link", { name: new RegExp(`^${name}`) })
      .first()
      .getAttribute("href")) ?? "";
  await page.goto(href.split("?")[0] ?? href);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("pending bookings stand above the booked ones on the bookings page, marked, not clickable and outside the totals", async () => {
  await page.goto("/buchungen");
  const table = page.getByRole("table", { name: "Buchungen", exact: true });
  await expect(table.locator("tbody").first()).toHaveClass("pending-rows");
  const bio = pendingRows().filter({ hasText: "Bio-Laden Sonthofen" });
  await expect(bio).toContainText("Vorgemerkt");
  await expect(bio).toContainText(ACCOUNT);
  await expect(bio).toContainText("Noch nicht gebucht");
  await expect(bio).not.toContainText("zählt nicht mit");
  await expect(bio.getByRole("button")).toHaveCount(0);
  await expect(pendingRows().filter({ hasText: "Bergbahnen Oberstdorf" })).toHaveCount(1);

  // Found by the search, yet the totals and the count stay at zero: only booked bookings count.
  await page.goto("/buchungen?q=Bio-Laden");
  await expect(pendingRows()).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "0 Buchungen" })).toBeVisible();
  const totals = page.getByRole("region", { name: TOTALS });
  await expect(figure(totals, "Anzahl")).toHaveText("0");
  await expect(page.getByText("Keine Buchungen für diese Filter.")).toHaveCount(0);

  // A filter they cannot match hides them and says so.
  await page.goto("/buchungen?ohneKategorie=true");
  await expect(pendingRows()).toHaveCount(0);
  await expect(page.getByText(/vorgemerkte Buchungen sind ausgeblendet: Vorgemerkte haben noch keine Kategorie/)).toBeVisible();
  await page.goto("/buchungen?q=Bio-Laden&neu=true");
  await expect(page.getByText("1 vorgemerkte Buchung ist ausgeblendet", { exact: false })).toBeVisible();
  await expect(pendingRows()).toHaveCount(0);

  // An old link to a later page opens the list from its start, with the pending bookings on top once.
  await page.goto("/buchungen?seite=2&q=Bio-Laden");
  await expect(pendingRows()).toHaveCount(1);
  await expect(page.locator("table.booking-table tbody").first()).toHaveClass("pending-rows");
});

test("the account page lists only its own pending bookings, also when sorted by amount", async () => {
  await accountPage(ACCOUNT);
  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  await expect(bookings.locator("tr.pending-row")).toHaveCount(2);
  await expect(bookings.locator("tr.pending-row").first()).toContainText("Bio-Laden Sonthofen");
  await expect(bookings.locator("tr.pending-row").nth(1)).toContainText("DB Fernverkehr AG");
  await expect(bookings.getByText("Bergbahnen Oberstdorf")).toHaveCount(0);
  await page.goto(`${page.url().split("?")[0]}?sortierung=betrag-auf`);
  await expect(page.locator("table.booking-table tbody").first()).toHaveClass("pending-rows");
});

test("a fetch shows the bank's pending booking; once booked it is there exactly once, as a booking", async () => {
  await page.goto("/konten");
  await page.getByRole("button", { name: new RegExp(`^Abrufen\\s*: ${SYNCED}`) }).click();
  await expect(page.locator(".toast").filter({ hasText: SYNCED })).toBeVisible();
  await accountPage(SYNCED);
  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  const pending = bookings.locator("tr.pending-row");
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText(FAKE_PENDING_PAYEE);
  await expect(pending).toContainText("Vorgemerkt");
  await expect(pending).toContainText("−7,80 €");
  await expect(bookings.getByRole("button", { name: "Stadtwerke Kempten" })).toBeVisible();
  await expect(figure(bookings.getByRole("region", { name: TOTALS }), "Anzahl")).toHaveText("1");

  await fetch(`${FAKE_BANK}${FAKE_EB_BOOK_PATH}`, { method: "POST" });
  await page.goto("/konten");
  await page.getByRole("button", { name: new RegExp(`^Abrufen\\s*: ${SYNCED}`) }).click();
  await expect(page.locator(".toast").filter({ hasText: `${SYNCED}: 1 neue Buchung` })).toBeVisible();
  await accountPage(SYNCED);
  await expect(bookings.locator("tr.pending-row")).toHaveCount(0);
  await expect(bookings.getByRole("button", { name: FAKE_PENDING_PAYEE })).toHaveCount(1);
  await expect(figure(bookings.getByRole("region", { name: TOTALS }), "Anzahl")).toHaveText("2");
});

test("pending rows pass axe in light and dark mode and fit 375 px", async () => {
  await accountPage(ACCOUNT);
  const paths = ["/buchungen", new URL(page.url()).pathname];
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of [...paths, "/buchungen?ohneKategorie=true"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1")).toBeVisible();
      await expectNoAxeViolations(page, `${path} (${mode})`);
    }
  }
  await setMode(page, "hell");
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(pendingRows().first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `seitliches Scrollen auf ${path}`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});
