import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const APP_ID = "1a2b3c4d-0000-4000-8000-00000000e2e0";
const DEPOT = "ING Depot";
// Same database and key as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";
const ENCRYPTION_KEY = Buffer.from("e2e-key-0123456789abcdef01234567");

test.describe.configure({ mode: "serial" });

/** As src/server/crypto.ts stores secrets: AES-256-GCM, base64(iv | tag | ciphertext). */
function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A FinTS depot as a sync leaves it: connection, account, three positions and two daily values. Nothing talks to a bank. */
async function seedDepot(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [owner] = await sql<{ id: string }[]>`select id from "user" where username = ${ADMIN.username}`;
    if (!owner) throw new Error("admin missing");
    const secrets = {
      blz: "50010517",
      server: "https://fints.ing.de/fints/",
      login: "e2e",
      customerId: null,
      pin: "x",
      tanMethodId: null,
      tanMediaName: null,
      bankingInformation: null,
    };
    const remote = [{ ref: "depot-1", iban: null, name: "Direkt-Depot", currency: "EUR", type: "DEPOT" }];
    const [connection] = await sql<{ id: number }[]>`
      insert into bank_connections (name, owner_user_id, visibility, provider, bank, status, ciphertext, remote_accounts, last_sync_at)
      values ('ING Direkt', ${owner.id}, 'household', 'fints', 'ing', 'active', ${seal(secrets)}, ${sql.json(remote)}, now())
      returning id`;
    const [account] = await sql<{ id: number }[]>`
      insert into accounts (name, bank, kind, owner_user_id, visibility, color, balance_cents, balance_date, connection_id, remote_ref)
      values (${DEPOT}, 'ing', 'brokerage', ${owner.id}, 'household', '#f97316', 1261550, ${isoDay(0)}, ${connection?.id ?? null}, 'depot-1')
      returning id`;
    const id = account?.id ?? 0;
    await sql`insert into account_holdings (account_id, isin, name, quantity, price, currency, value_cents, cost_basis_cents, as_of) values
      (${id}, 'IE00B4L5Y983', 'iShares Core MSCI World UCITS ETF USD (Acc)', 98.123456, 101.25, 'EUR', 993500, 800000, ${isoDay(0)}),
      (${id}, 'US0378331005', 'Apple Inc.', 12, 210.5, 'EUR', 252600, 260000, ${isoDay(0)}),
      (${id}, 'DE0001102580', 'Bund 2032', 1000, 0.1545, '%', 15450, null, ${isoDay(0)})`;
    await sql`insert into account_balance_entries (account_id, date, balance_cents) values
      (${id}, ${isoDay(-1)}, 1250000), (${id}, ${isoDay(0)}, 1261550)`;
  } finally {
    await sql.end();
  }
}

/** An Enable Banking consent that came back without accounts, as with a restricted app. */
async function seedConsentWithoutAccounts(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [owner] = await sql<{ id: string }[]>`select id from "user" where username = ${ADMIN.username}`;
    if (!owner) throw new Error("admin missing");
    const secrets = {
      bankName: "Bank Norwegian",
      country: "NO",
      sessionId: "s",
      pendingState: null,
      pendingStateAt: null,
      pendingValidUntil: null,
    };
    await sql`insert into bank_connections (name, owner_user_id, visibility, provider, bank, status, ciphertext)
      values ('Bank Norwegian', ${owner.id}, 'household', 'enable_banking', 'bank-norwegian', 'no_accounts', ${seal(secrets)})`;
  } finally {
    await sql.end();
  }
}

/** Later spec files count the demo accounts; the seeded depot goes again (positions and entries with it). */
async function removeDepot(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from accounts where name = ${DEPOT}`;
    await sql`delete from bank_connections where name in ('ING Direkt', 'Bank Norwegian')`;
    await sql`delete from settings where key = 'bank_sync_schedule'`;
  } finally {
    await sql.end();
  }
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

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

let page: Page;

test.beforeAll(async ({ browser }) => {
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
  await removeDepot();
  await page.context().close();
});

async function openAddDialog() {
  await page.goto("/konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
  await page.getByRole("dialog", { name: "Konto hinzufügen" }).getByRole("button", { name: "Bank verbinden" }).click();
  const dialog = page.getByRole("dialog", { name: "Bankverbindung über Enable Banking" });
  await expect(dialog.getByText("1.077 Banken verfügbar")).toBeVisible();
  return dialog;
}

// The bank list comes from the stand-in Enable Banking API started by e2e/server.ts.
test("Enable Banking is set up against the stand-in API", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  await page.goto("/einstellungen/bankverbindungen");
  await page.getByLabel("App-ID").fill(APP_ID);
  await page.getByLabel("Schlüssel als Text").fill(privateKey);
  await page.getByRole("button", { name: "Speichern und prüfen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Zugangsdaten geprüft" })).toBeVisible();
});

test("the bank list grows back to full height after a search without matches", async () => {
  const dialog = await openAddDialog();
  const bank = dialog.getByRole("combobox", { name: "Bank" });
  await bank.fill("xyzxyz");
  await bank.fill("ing");
  const list = dialog.getByRole("listbox", { name: "Bank" });
  await expect(list.getByRole("option")).toHaveCount(2);
  const box = await list.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(60);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("the bank picker filters a long list and works from the keyboard", async () => {
  const dialog = await openAddDialog();
  const bank = dialog.getByRole("combobox", { name: "Bank" });
  const list = dialog.getByRole("listbox", { name: "Bank" });
  const options = list.getByRole("option");
  const live = dialog.locator(".combobox [aria-live]");
  await expect(bank).toHaveAttribute("aria-expanded", "false");
  await expect(bank).toHaveAttribute("aria-controls", /.+/);

  await bank.focus();
  await page.keyboard.type("ing");
  await expect(bank).toHaveAttribute("aria-expanded", "true");
  await expect(options).toHaveText(["ING", "Thüringer Aufbaubank"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(bank).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id")) ?? "");
  await expect(live).toHaveText("2 Treffer");

  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(bank).toHaveValue("ING");
  await expect(bank).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();

  // Escape closes the list, a second one clears the field; neither closes the dialog.
  await page.keyboard.press("ArrowDown");
  await expect(bank).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(bank).toHaveAttribute("aria-expanded", "false");
  await expect(bank).toHaveValue("ING");
  await page.keyboard.press("Escape");
  await expect(bank).toHaveValue("");
  await expect(dialog).toBeVisible();

  await page.keyboard.type("arzte");
  await expect(options).toHaveText(["Ärzte- und Apothekerbank"]);
  await page.keyboard.press("Enter");
  await expect(bank).toHaveValue("Ärzte- und Apothekerbank");

  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowDown");
  await expect(options).toHaveCount(50);
  await expect(dialog.getByText("… 1.027 weitere Treffer, bitte genauer suchen")).toBeVisible();
  await expect(live).toHaveText("1.077 Treffer, die ersten 50 werden angezeigt");
  await page.keyboard.press("Tab");
  await expect(bank).not.toBeFocused();
  await expect(bank).toHaveAttribute("aria-expanded", "false");
  await expect(bank).toHaveValue("");

  await bank.fill("region 1");
  await expect(live).toContainText("Treffer");
  await list.getByRole("option", { name: "Raiffeisenbank Region 10", exact: true }).click();
  await expect(bank).toHaveValue("Raiffeisenbank Region 10");
  await expect(bank).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bank).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the bank picker reports a missing bank on the field", async () => {
  const dialog = await openAddDialog();
  const bank = dialog.getByRole("combobox", { name: "Bank" });
  await dialog.getByLabel("Name", { exact: true }).fill("Praxiskonto");
  await bank.fill("Nicht vorhanden");
  await expect(dialog.getByText("Keine Treffer", { exact: true })).toBeVisible();
  await expect(bank).toHaveAttribute("aria-expanded", "false");
  await dialog.getByRole("button", { name: "Weiter zur Bank" }).click();
  await expect(bank).toHaveAttribute("aria-invalid", "true");
  await expect(bank).toBeFocused();
  await expect(bank).toHaveAccessibleDescription(/Bitte eine Bank auswählen\./);
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
});

test("the bank picker passes axe with the list open in light and dark mode", async () => {
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    const dialog = await openAddDialog();
    const bank = dialog.getByRole("combobox", { name: "Bank" });
    await bank.fill("co");
    await expect(dialog.getByRole("listbox", { name: "Bank" })).toBeVisible();
    await expectNoAxeViolations(page, `Bankauswahl (${mode})`);
    await dialog.getByRole("option", { name: "Commerzbank" }).click();
    await expect(bank).toHaveValue("Commerzbank");
    await expectNoAxeViolations(page, `Bankauswahl mit gewählter Bank (${mode})`);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
  }
  await setMode(page, "hell");

  // On a phone the open list stays within the screen and the dialog.
  await page.setViewportSize({ width: 375, height: 667 });
  const dialog = await openAddDialog();
  await dialog.getByRole("combobox", { name: "Bank" }).fill("co");
  const list = dialog.getByRole("listbox", { name: "Bank" });
  await expect(list).toBeVisible();
  const [box, frame] = await Promise.all([list.boundingBox(), dialog.boundingBox()]);
  expect(box && frame && box.x >= frame.x && box.x + box.width <= frame.x + frame.width).toBe(true);
  await expectNoHorizontalScroll(page);
  await dialog.getByRole("option", { name: "Commerzbank" }).click();
  await expect(dialog.getByRole("button", { name: "Weiter zur Bank" })).toBeInViewport();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});

// Runs after the Enable Banking tests above: from here on more than one provider is set up.
test("FinTS is set up next to Enable Banking", async () => {
  await seedDepot();
  await page.goto("/einstellungen/bankverbindungen");
  const fints = page.getByRole("region", { name: "FinTS" });
  await expect(fints.getByText("Nicht eingerichtet")).toBeVisible();
  await fints.getByLabel("FinTS-Produktregistrierungsnummer").fill("E2EPRODUCT1");
  await fints.getByLabel("Produktversion").fill("1.0");
  await fints.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Produktregistrierungsnummer gespeichert." })).toBeVisible();
  await expect(fints.getByText("Eingerichtet", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Enable Banking" }).getByText("Eingerichtet", { exact: true })).toBeVisible();
});

test("Trade Republic needs the confirmed warning before it is offered", async () => {
  await page.goto("/einstellungen/bankverbindungen");
  const section = page.getByRole("region", { name: "Trade Republic (inoffiziell)" });
  await expect(section.getByRole("note")).toContainText("Nutzungsbedingungen von Trade Republic");
  await expect(section.getByRole("note")).toContainText("verschlüsselt gespeichert");
  const enable = section.getByRole("button", { name: "Trade Republic (inoffiziell) einschalten" });
  await enable.click();
  const accept = section.getByRole("checkbox", { name: /Ich habe die Hinweise gelesen/ });
  await expect(accept).toHaveAttribute("aria-invalid", "true");
  await expect(accept).toHaveAccessibleDescription("Bitte bestätigen, dass du die Hinweise gelesen hast.");
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/einstellungen/bankverbindungen");
    await expectNoAxeViolations(page, `Bankverbindungen (${mode})`);
  }
  await setMode(page, "hell");
  await page.goto("/einstellungen/bankverbindungen");
  await section.getByRole("checkbox", { name: /Ich habe die Hinweise gelesen/ }).check();
  await section.getByRole("button", { name: "Trade Republic (inoffiziell) einschalten" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Trade Republic (inoffiziell) ist eingeschaltet." })).toBeVisible();
  await expect(section.getByRole("button", { name: "Trade Republic (inoffiziell) ausschalten" })).toBeVisible();
});

async function openProviderChoice() {
  await page.goto("/konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
  await page.getByRole("dialog", { name: "Konto hinzufügen" }).getByRole("button", { name: "Bank verbinden" }).click();
  const dialog = page.getByRole("dialog", { name: "Bankzugang wählen" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("connecting a bank asks for the provider among those set up", async () => {
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    const dialog = await openProviderChoice();
    // Official accesses one by one; every custom integration sits behind "Weitere Zugänge".
    await expect(dialog.getByRole("radio")).toHaveCount(3);
    await expect(dialog.getByRole("radio", { name: /Enable Banking/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^FinTS/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Weitere Zugänge.*Trade Republic \(inoffiziell\)/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Trade Republic/ })).toHaveCount(0);
    await expectNoAxeViolations(page, `Zugangswahl (${mode})`);

    await dialog.getByRole("radio", { name: /^Weitere Zugänge/ }).check();
    await dialog.getByRole("button", { name: "Weiter" }).click();
    const custom = page.getByRole("dialog", { name: "Weiteren Zugang wählen" });
    await expect(custom.getByRole("radio", { name: /^Trade Republic \(inoffiziell\)/ })).toBeChecked();
    await expectNoAxeViolations(page, `Weitere Zugänge (${mode})`);
    await custom.getByRole("button", { name: "Zurück" }).click();
    await expect(dialog.getByRole("radio", { name: /^Weitere Zugänge/ })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Weitere Zugänge/ }).check();
    await dialog.getByRole("button", { name: "Weiter" }).click();
    await custom.getByRole("button", { name: "Weiter" }).click();
    const tr = page.getByRole("dialog", { name: "Trade Republic verbinden (inoffiziell)" });
    await expect(tr.getByRole("note")).toContainText("Nutzungsbedingungen von Trade Republic");
    // Only the form's own checks run: nothing is sent to Trade Republic in tests.
    await tr.getByRole("button", { name: "Anmelden" }).click();
    await expect(tr.getByLabel("Telefonnummer")).toHaveAttribute("aria-invalid", "true");
    await expect(tr.getByRole("checkbox", { name: /Ich habe die Hinweise gelesen/ })).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(page, `Trade-Republic-Anmeldung (${mode})`);
    await tr.getByRole("button", { name: "Abbrechen" }).click();
  }
  await setMode(page, "hell");
  const dialog = await openProviderChoice();
  await dialog.getByRole("radio", { name: /^FinTS/ }).check();
  await dialog.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("dialog", { name: "Bankverbindung über FinTS" })).toBeVisible();
  await page.getByRole("dialog", { name: "Bankverbindung über FinTS" }).getByRole("button", { name: "Abbrechen" }).click();
});

test("a depot shows its value change in the overview and its positions as a table", async () => {
  await page.goto("/konten");
  const row = page.getByRole("link", { name: new RegExp(DEPOT) });
  await expect(row).toContainText("12.615,50 €");
  await expect(row).toContainText("+115,50 € seit");
  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: DEPOT })).toBeVisible();
  const table = page.getByRole("table", { name: "3 Positionen des Depots" });
  await expect(table.getByRole("columnheader")).toHaveText(["Wertpapier", "ISIN", "Stück", "Kurs", "Wert", "Anteil", "Gewinn/Verlust"]);
  const etf = table.getByRole("row", { name: /MSCI World/ });
  await expect(etf.getByRole("rowheader")).toHaveText("iShares Core MSCI World UCITS ETF USD (Acc)");
  await expect(etf).toContainText("IE00B4L5Y983");
  await expect(etf).toContainText("98,123456");
  await expect(etf).toContainText("9.935,00 €");
  await expect(etf).toContainText("79 %");
  await expect(etf).toContainText("+1.935,00 €");
  await expect(table.getByRole("row", { name: /Apple/ })).toContainText("−74,00 €");
  await expect(table.getByRole("row", { name: /Bund 2032/ })).toContainText("15,45 %");
  await expect(table.getByRole("row", { name: /Bund 2032/ }).getByText("Einstandswert unbekannt")).toBeAttached();
  await expect(table.getByRole("row", { name: /Summe/ })).toContainText("12.615,50 €");

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/konten");
      await page.getByRole("link", { name: new RegExp(DEPOT) }).click();
      await expect(page.getByRole("table", { name: "3 Positionen des Depots" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoAxeViolations(page, `Depot (${mode}, ${width}px)`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await setMode(page, "hell");
});

test("a connection is taken out of 'Konten abrufen' from the account menu and marked as manual only", async () => {
  await page.goto("/konten");
  const row = page.getByRole("link", { name: new RegExp(DEPOT) });
  await expect(row.getByText("nur manuell")).toHaveCount(0);
  await page.getByRole("button", { name: `Aktionen für ${DEPOT}` }).click();
  const manualOnly = page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen" });
  await expect(manualOnly).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("menuitem", { name: /überspringen|wieder abrufen/ })).toHaveCount(0);
  await manualOnly.click();
  await expect(page.getByRole("status").filter({ hasText: "„ING Direkt“ wird nur noch manuell abgerufen." })).toBeVisible();
  await expect(row.getByText("nur manuell")).toBeVisible();
  await page.getByRole("button", { name: `Aktionen für ${DEPOT}` }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen" })).toHaveAttribute("aria-checked", "true");
  await expectNoAxeViolations(page, "Menü mit Markierung");
  await page.keyboard.press("Escape");
  await expectNoAxeViolations(page, "Konten mit Markierung");

  await page.goto("/einstellungen/bankverbindungen");
  const overview = page.getByRole("region", { name: "Alle Bankverbindungen" });
  await expect(overview.getByRole("listitem").filter({ hasText: "ING Direkt" }).getByText("nur manuell")).toBeVisible();
  await overview.getByRole("button", { name: "Aktionen für ING Direkt" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen", checked: true }).click();
  await expect(overview.getByRole("listitem").filter({ hasText: "ING Direkt" }).getByText("nur manuell")).toHaveCount(0);
});

test("the account and connection menus offer neither a schedule nor a manual account mapping", async () => {
  await page.goto("/konten");
  await page.getByRole("button", { name: `Aktionen für ${DEPOT}` }).click();
  await expect(page.getByRole("menuitem", { name: "Abrufen", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Zeitplan/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Konten zuordnen/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/einstellungen/bankverbindungen");
  await page.getByRole("region", { name: "Alle Bankverbindungen" }).getByRole("button", { name: "Aktionen für ING Direkt" }).click();
  await expect(page.getByRole("menuitem", { name: "Zugang prüfen" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Zeitplan/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("one automatic sync is set for all connections, leaving out the manual-only ones", async () => {
  await page.goto("/einstellungen/bankverbindungen");
  const section = page.getByRole("region", { name: "Automatischer Abruf" });
  await expect(section.getByText("Aus", { exact: true })).toBeVisible();
  await section.getByRole("checkbox", { name: "Täglich automatisch abrufen" }).check();
  await section.getByLabel("Uhrzeit 1").fill("07:30");
  await section.getByRole("button", { name: "Uhrzeit hinzufügen" }).click();
  await section.getByLabel("Uhrzeit 2").fill("18:00");
  await section.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Automatischer Abruf täglich um 07:30, 18:00 Uhr." })).toBeVisible();
  const overview = page.getByRole("region", { name: "Alle Bankverbindungen" });
  const ing = overview.getByRole("listitem").filter({ hasText: "ING Direkt" });
  await expect(ing).toContainText("automatisch um 07:30, 18:00 Uhr");

  await overview.getByRole("button", { name: "Aktionen für ING Direkt" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen", checked: false }).click();
  await expect(ing.getByText("nur manuell")).toBeVisible();
  await expect(ing).not.toContainText("automatisch um");

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/einstellungen/bankverbindungen");
    await expect(page.getByRole("region", { name: "Automatischer Abruf" })).toBeVisible();
    await expectNoAxeViolations(page, `Automatischer Abruf (${mode})`);
  }
  await setMode(page, "hell");
  await page.goto("/einstellungen/bankverbindungen");
  await page.getByRole("region", { name: "Alle Bankverbindungen" }).getByRole("button", { name: "Aktionen für ING Direkt" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Nur manuell abrufen", checked: true }).click();
});

test("a consent without accounts explains the control panel step and offers renewal and removal", async () => {
  await seedConsentWithoutAccounts();
  await page.goto("/konten");
  const pending = page.getByRole("region", { name: "Angefangene Bankverbindungen" });
  const row = pending.getByRole("listitem").filter({ hasText: "Bank Norwegian" });
  await expect(row.getByText("Keine Konten freigegeben", { exact: true })).toBeVisible();
  await expect(row.getByText("Freigabe fehlt")).toHaveCount(0);
  await expect(row).toContainText("„Link accounts“");
  await expect(row.getByRole("button", { name: /^Freigabe erneuern\s*: Bank Norwegian$/ })).toBeVisible();
  await row.getByRole("button", { name: "Aktionen für Bank Norwegian" }).click();
  await expect(page.getByRole("menuitem", { name: "Löschen" })).toBeVisible();
  await page.keyboard.press("Escape");

  const fold = pending.getByRole("button", { name: "Angefangene Bankverbindungen einklappen" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  const unfold = pending.getByRole("button", { name: "Angefangene Bankverbindungen ausklappen" });
  await expect(unfold).toHaveAttribute("aria-expanded", "false");
  await expect(row).toBeHidden();
  await pending.getByRole("heading", { name: "Angefangene Bankverbindungen" }).click({ force: true });
  await expect(row).toBeVisible();
  await pending.getByRole("heading", { name: "Angefangene Bankverbindungen" }).click({ force: true });
  await expect(unfold).toHaveAttribute("aria-expanded", "false");
  await expect(row).toBeHidden();
  await page.reload();
  await expect(unfold).toHaveAttribute("aria-expanded", "false");
  await expect(row).toBeHidden();
  const preview = await page.context().newPage();
  await preview.route(/\.m?js(\?.*)?$/, (route) => route.abort());
  await preview.goto("/konten");
  await expect(preview.getByRole("heading", { name: "Angefangene Bankverbindungen" })).toBeVisible();
  await expect(preview.locator('[data-fold="konten-angefangen"]')).toBeHidden();
  await preview.close();
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/konten");
    await expect(unfold).toBeVisible();
    await expectNoAxeViolations(page, `Angefangene Verbindungen eingeklappt (${mode})`);
  }
  await setMode(page, "hell");
  await page.goto("/konten");
  await unfold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeVisible();

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/konten?abruf=hinweis&meldung=Die%20Bank%20hat%20keine%20Konten%20freigegeben.");
    await expect(page.getByText("Die Bank hat keine Konten freigegeben.")).toBeVisible();
    await expectNoAxeViolations(page, `Konten ohne Freigabe (${mode})`);
  }
  await setMode(page, "hell");
});
