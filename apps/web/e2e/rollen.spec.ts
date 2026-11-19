import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const LENA = { username: "lena.e2e", password: "lena-passwort-123" };
const TOM = { username: "tom.e2e", password: "tom-passwort-1234" };
const MAMA = { username: "mama.e2e", password: "mama-passwort-123" };
const CARD = "Givve Karte";
const CSV = `Datum;Händler;Beschreibung;Betrag
05.11.2026;REWE Markt;Einkauf;-23,45
03.11.2026;Bäckerei Krume;Frühstück;-4,80
01.11.2026;givve;Aufladung November;50,00
`;

test.describe.configure({ mode: "serial" });

/** A fresh browser context per person; playwright.config.ts raises SIGN_IN_LIMIT for the many sign-ins from one address. */
async function newSession(browser: Browser, who: { username: string; password: string }, width = 1280): Promise<Page> {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    locale: "de-DE",
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(who.username);
  await page.getByLabel("Passwort").fill(who.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  return page;
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

async function createUser(page: Page, who: { username: string; password: string }, role?: string) {
  await page.goto("/einstellungen/benutzer");
  await page.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Benutzer anlegen" });
  await dialog.getByLabel("Benutzername").fill(who.username);
  await dialog.getByLabel("Startpasswort").fill(who.password);
  if (role) await dialog.getByLabel("Rolle").selectOption({ label: role });
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(page.getByRole("row").filter({ hasText: who.username })).toBeVisible();
}

const cardRow = (page: Page) => page.locator(".account-item").filter({ hasText: CARD });

let accountPath = "";

test("the superuser creates a family admin; the family admin may only create members", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await createUser(admin, MAMA, "Familien-Admin");
  await createUser(admin, LENA);
  await expect(admin.getByRole("row").filter({ hasText: MAMA.username })).toContainText("Familien-Admin");
  await admin.context().close();

  const mama = await newSession(browser, MAMA);
  await mama.goto("/einstellungen");
  const sections = mama.getByRole("navigation", { name: "Bereiche der Einstellungen" });
  await expect(sections.getByRole("link")).toHaveText([/Gruppen/, /Kategorien/, /Tags/, /Regeln/, /Benutzer/, /MCP/]);
  await mama.goto("/einstellungen/benutzer");
  // Superusers and other family admins are not listed; the only role on offer is member.
  await expect(mama.getByRole("row").filter({ hasText: "admin" })).toHaveCount(0);
  await expect(mama.getByRole("row").filter({ hasText: LENA.username })).toBeVisible();
  await mama.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = mama.getByRole("dialog", { name: "Benutzer anlegen" });
  await expect(dialog.getByLabel("Rolle")).toHaveCount(0);
  await expect(dialog.getByLabel("Darf KI nutzen")).toHaveCount(0);
  await dialog.getByLabel("Benutzername").fill(TOM.username);
  await dialog.getByLabel("Startpasswort").fill(TOM.password);
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(mama.getByRole("row").filter({ hasText: TOM.username })).toContainText("Mitglied");
  await mama.goto("/einstellungen/bankverbindungen");
  await expect(mama).toHaveURL(/\/konten$/);
  await mama.context().close();
});

test("a member creates a manual account, imports a CSV twice without duplicates and shares the account", async ({ browser }) => {
  const lena = await newSession(browser, LENA);
  await lena.goto("/konten");
  await lena.getByRole("button", { name: "Konto hinzufügen" }).first().click();
  const choice = lena.getByRole("dialog", { name: "Konto hinzufügen" });
  await expect(choice).toContainText("Neue Konten sind privat");
  await choice.getByRole("button", { name: "Manuelles Konto" }).click();
  const create = lena.getByRole("dialog", { name: "Manuelles Konto anlegen" });
  await create.getByLabel("Name", { exact: true }).fill(CARD);
  await create.getByLabel("Bank oder Anbieter").fill("Givve");
  await create.getByLabel("Art").selectOption({ label: "Prepaid- oder Gutscheinkarte" });
  await create.getByRole("button", { name: "Konto anlegen" }).click();
  await expect(cardRow(lena)).toContainText("Privat");

  const menu = lena.getByRole("button", { name: `Aktionen für ${CARD}` });
  await menu.click();
  await lena.getByRole("menuitem", { name: "CSV importieren …" }).click();
  const csv = lena.getByRole("dialog", { name: `CSV in „${CARD}“ importieren` });
  await csv.getByLabel("Datei").setInputFiles({ name: "givve.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(csv.getByText("Vorschau: 3 Buchungen erkannt")).toBeVisible();
  await expect(csv.getByLabel("Betrag", { exact: true })).toHaveValue("3");
  await expect(csv.getByRole("table")).toContainText("REWE Markt");
  await csv.getByRole("button", { name: "Importieren" }).click();
  await expect(lena.getByRole("status").filter({ hasText: "Import fertig: 3 neu, 0 schon vorhanden" })).toBeVisible();

  await menu.click();
  await lena.getByRole("menuitem", { name: "CSV importieren …" }).click();
  await csv.getByLabel("Datei").setInputFiles({ name: "givve.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await csv.getByRole("button", { name: "Importieren" }).click();
  await expect(lena.getByRole("status").filter({ hasText: "Import fertig: 0 neu, 3 schon vorhanden" })).toBeVisible();

  await menu.click();
  await lena.getByRole("menuitem", { name: "Saldo eintragen …" }).click();
  const balance = lena.getByRole("dialog", { name: `Saldo von „${CARD}“ eintragen` });
  await balance.getByLabel("Kontostand").fill("21,75");
  await balance.getByRole("button", { name: "Speichern" }).click();
  await expect(cardRow(lena)).toContainText("21,75");

  await menu.click();
  await lena.getByRole("menuitem", { name: "Gruppen und Teilen …" }).click();
  const share = lena.getByRole("dialog", { name: `„${CARD}“ teilen` });
  await share.getByLabel(TOM.username).check();
  await share.getByRole("button", { name: "Speichern" }).click();
  await expect(cardRow(lena)).toContainText(`Geteilt mit ${TOM.username}`);

  accountPath = (await cardRow(lena).getByRole("link").getAttribute("href")) ?? "";
  expect(accountPath).toMatch(/^\/konten\/\d+$/);
  await lena.goto(accountPath);
  await expect(lena.getByRole("heading", { level: 1, name: CARD })).toBeVisible();
  await expect(lena.getByRole("region", { name: "Buchungen", exact: true })).toContainText("REWE Markt");
  await lena.context().close();
});

test("the shared account reaches the person it is shared with and the superuser, nobody else", async ({ browser }) => {
  const tom = await newSession(browser, TOM);
  await tom.goto("/konten");
  await expect(cardRow(tom)).toContainText(`Geteilt von ${LENA.username}`);
  await tom.goto(accountPath);
  await expect(tom.getByRole("heading", { level: 1, name: CARD })).toBeVisible();
  // Read access only: no bookkeeping actions on someone else's account.
  await expect(tom.getByRole("button", { name: `Aktionen für ${CARD}` })).toHaveCount(0);
  await tom.context().close();

  const mama = await newSession(browser, MAMA);
  await mama.goto("/konten");
  await expect(cardRow(mama)).toHaveCount(0);
  await mama.goto(accountPath);
  await expect(mama.getByRole("heading", { level: 1, name: "Seite nicht gefunden" })).toBeVisible();
  await mama.goto("/buchungen?q=REWE%20Markt");
  await expect(mama.getByText("Bäckerei Krume")).toHaveCount(0);
  await mama.context().close();

  const admin = await newSession(browser, ADMIN);
  await admin.goto("/konten");
  await expect(cardRow(admin)).toContainText(`Geteilt mit ${TOM.username}`);
  await admin.context().close();
});

test("the new dialogs pass axe in light and dark mode and fit a phone screen", async ({ browser }) => {
  const lena = await newSession(browser, LENA, 375);
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(lena, mode);
    await lena.goto("/konten");
    await lena.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(lena);
    await expectNoAxeViolations(lena, `Konten (${mode}, 375 px)`);

    await lena.getByRole("button", { name: "Konto hinzufügen" }).first().click();
    const choice = lena.getByRole("dialog", { name: "Konto hinzufügen" });
    await expect(choice).toBeVisible();
    await expectNoAxeViolations(lena, `Konto hinzufügen (${mode})`);
    await choice.getByRole("button", { name: "Abbrechen" }).click();

    const menu = lena.getByRole("button", { name: `Aktionen für ${CARD}` });
    for (const [item, title] of [
      ["CSV importieren …", `CSV in „${CARD}“ importieren`],
      ["Gruppen und Teilen …", `„${CARD}“ teilen`],
      ["Saldo eintragen …", `Saldo von „${CARD}“ eintragen`],
      ["Buchung hinzufügen …", `Buchung für „${CARD}“`],
    ] as const) {
      // On a phone the "⋯" button opens the account's action sheet.
      await menu.click();
      await lena.getByRole("dialog", { name: CARD }).getByRole("button", { name: item }).click();
      const dialog = lena.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      if (item === "CSV importieren …") {
        await dialog.getByLabel("Datei").setInputFiles({ name: "givve.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
        await expect(dialog.getByRole("table")).toBeVisible();
      }
      if (item === "Gruppen und Teilen …") await expect(dialog.getByLabel(TOM.username)).toBeVisible();
      await expectNoHorizontalScroll(lena);
      await expectNoAxeViolations(lena, `${title} (${mode})`);
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await expect(dialog).toBeHidden();
    }
  }
  await setMode(lena, "hell");
  await lena.context().close();
});
