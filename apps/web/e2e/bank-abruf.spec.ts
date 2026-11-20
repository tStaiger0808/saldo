import { createCipheriv, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { FAKE_GIVVE_OTP, FAKE_GIVVE_OTP_EMAIL } from "./fake-enable-banking.ts";

const ADMIN = { username: "admin", password: "e2e-password-123" };
// Same database and key as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";
const ENCRYPTION_KEY = Buffer.from("e2e-key-0123456789abcdef01234567");
const CARD = "Essenskarte";
const SECOND = "Zweitkarte";

test.describe.configure({ mode: "serial" });

/** As src/server/crypto.ts stores secrets: AES-256-GCM, base64(iv | tag | ciphertext). */
function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Two givve cards against the stand-in in fake-enable-banking.ts: one signed in already and fetched by "Konten abrufen",
 * one marked "only manually" that has to sign in with an e-mailed code. Each has one older booking, so a fetch is no
 * first import.
 */
async function seedCards(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [owner] = await sql<{ id: string }[]>`select id from "user" where username = ${ADMIN.username}`;
    if (!owner) throw new Error("admin missing");
    await sql`insert into settings (key, value) values ('givve_enabled', 'true'::jsonb) on conflict (key) do update set value = 'true'::jsonb`;
    const remote = [{ ref: "card-1", iban: null, name: "givve Card 1234", currency: "EUR", type: "PREPAID" }];
    const cards = [
      {
        connection: "givve Kantine",
        account: CARD,
        email: "karte@e2e.invalid",
        session: { accessToken: "e2e-token", refreshToken: null, expiresAt: null },
        manual: false,
      },
      { connection: "givve Code", account: SECOND, email: FAKE_GIVVE_OTP_EMAIL, session: null, manual: true },
    ];
    for (const card of cards) {
      const secrets = { email: card.email, password: "x", session: card.session };
      const [connection] = await sql<{ id: number }[]>`
        insert into bank_connections (name, owner_user_id, visibility, provider, bank, status, ciphertext, remote_accounts, last_sync_at, skip_sync_all)
        values (${card.connection}, ${owner.id}, 'household', 'givve', 'givve', 'active', ${seal(secrets)}, ${sql.json(remote)}, now(), ${card.manual})
        returning id`;
      const [account] = await sql<{ id: number }[]>`
        insert into accounts (name, bank, kind, owner_user_id, visibility, color, balance_cents, balance_date, connection_id, remote_ref)
        values (${card.account}, 'givve', 'prepaid', ${owner.id}, 'household', '#e87ba4', 5460, ${isoDay(-10)}, ${connection?.id ?? null}, 'card-1')
        returning id`;
      await sql`insert into transactions (account_id, external_id, source, booking_date, amount_cents, counterparty, is_unread)
        values (${account?.id ?? 0}, ${`givve:old:${card.account}`}, 'givve', ${isoDay(-10)}, -800, 'Bäckerei', false)`;
    }
  } finally {
    await sql.end();
  }
}

/** Leaves the database as the other specs expect it. */
async function removeCards(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from accounts where name in (${CARD}, ${SECOND})`;
    await sql`delete from bank_connections where provider = 'givve'`;
    await sql`delete from settings where key = 'givve_enabled'`;
  } finally {
    await sql.end();
  }
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  await seedCards();
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
  await removeCards();
});

const row = (name: string) => page.getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(`^${name}`) }) });

test("'Konten abrufen' fetches quietly: progress ring and bar, a notice with the new bookings, no dialog", async () => {
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const card = row(CARD);
  await expect(card.getByRole("link", { name: /neue Buchung/ })).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: "Konten abrufen" }).click();

  await expect(card.locator(".monogram[data-syncing]")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Konten werden abgerufen" })).toBeVisible();
  // The card marked "only manually" is left out without a word.
  await expect(row(SECOND).locator(".monogram[data-syncing]")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Abruf gestartet: givve Kantine" })).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const notice = page.locator(".toast").getByRole("status");
  await expect(notice).toHaveText(`${CARD}: 1 neue Buchung`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".toasts")).not.toContainText("Übersprungen");
  await expect(card.locator(".monogram[data-syncing]")).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expectNoAxeViolations(page, "Konten nach dem Abruf");

  // A second fetch stacks its notice above the first instead of replacing it; both hide themselves after a few seconds.
  await page.getByRole("main").getByRole("button", { name: "Konten abrufen" }).click();
  await expect(page.locator(".toast")).toHaveCount(2);
  await expect(page.locator(".toast").first()).toContainText(`${CARD}: 1 neue Buchung`);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
});

test("Alt+Shift+R and the top bar button fetch from any page; both and 'Konten' turn while it runs", async () => {
  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const konten = nav.getByRole("link", { name: /^Konten/ });
  const sync = nav.getByRole("button", { name: "Konten abrufen" });
  await expect(konten).toHaveAccessibleName("Konten");
  await expect(konten.locator(".nav-busy")).toHaveCount(0);
  await expect(sync).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+R");
  await expect(sync).toHaveAttribute("title", /^Konten abrufen \((Alt\+Umschalt\+R|⌥⇧R)\)$/);
  await expect(sync).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Alt+Shift+KeyR");

  await expect(konten.locator(".nav-busy")).toBeVisible();
  // The hidden status is its own span, so the name may read "Konten , Abruf läuft".
  await expect(konten).toHaveAccessibleName(/^Konten ?, Abruf läuft$/);
  await expect(sync).toHaveAttribute("aria-busy", "true");
  await expect(sync).toHaveAttribute("aria-disabled", "true");
  await expect(sync).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Abruf gestartet: givve Kantine" })).toHaveCount(1);
  await expect(page.locator(".toast").first()).toBeVisible();
  await expect(konten.locator(".nav-busy")).toHaveCount(0);
  await expect(konten).toHaveAccessibleName("Konten");
  await expect(sync).toHaveAttribute("aria-busy", "false");
  await expect(sync).not.toHaveAttribute("aria-disabled");
  await expect(page).toHaveURL(/\/buchungen/);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });

  await sync.click();
  await expect(page.locator(".toast").first()).toBeVisible();
  await expect(sync).toHaveAttribute("aria-busy", "false");
  await expect(page).toHaveURL(/\/buchungen/);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
  await page.goto("/konten");
});

test("an account with new bookings opens all its bookings, the new one on top and marked", async () => {
  const link = row(CARD).getByRole("link", { name: /1 neue Buchung/ });
  await expect(link.locator('.unread-badge [aria-hidden="true"]')).toHaveText("1 neu");
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: CARD })).toBeVisible();
  await expect(page).not.toHaveURL(/neu=true/);
  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  await expect(bookings.getByRole("group", { name: "Schnellfilter" }).getByRole("button", { name: /^Alle/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const first = bookings.locator("tbody tr.booking-row").first();
  await expect(first).toHaveAttribute("data-unread", "true");
  await expect(first.getByRole("button", { name: "Kantine Süd" })).toBeVisible();
  await expect(bookings.getByRole("button", { name: "Bäckerei" })).toBeVisible();
});

test("a bank asking for a code still opens the job dialog", async () => {
  await page.goto("/konten");
  await row(SECOND)
    .getByRole("button", { name: `Aktionen für ${SECOND}` })
    .click();
  await page.getByRole("menuitem", { name: "Abrufen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Abruf bei der Bank" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Freigabe nötig").first()).toBeVisible();
  await expectNoAxeViolations(page, "TAN-Abfrage");
  await dialog.getByLabel("TAN").fill(FAKE_GIVVE_OTP);
  await dialog.getByRole("button", { name: "TAN senden" }).click();
  const done = page.getByRole("dialog", { name: "Abruf beendet" });
  await expect(done).toContainText(`${SECOND}: 1 neue Buchung`);
  await done.getByRole("button", { name: "Schließen" }).last().click();
  await expect(done).toBeHidden();
  await expect(row(SECOND).getByRole("link", { name: /1 neue Buchung/ })).toBeVisible();
});

test("'Nur manuell abrufen' is one checkbox in the account menu", async () => {
  await page.goto("/konten");
  const menuButton = page.getByRole("button", { name: `Aktionen für ${CARD}` });
  await menuButton.click();
  const item = page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen" });
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  await expect(row(CARD).getByText("nur manuell")).toBeVisible();
  await menuButton.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
});
