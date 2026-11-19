import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PAUL = { username: "paul.e2e", password: "paul-passwort-1234" };
const PAULS_ACCOUNT = "Pauls Sparschwein";
const ADMINS_ACCOUNT = "DKB Girokonto";
const LOCKED = "Beim Ansehen als paul.e2e sind Änderungen gesperrt";

// Runs last (file name): the member's new account counts for the superuser and would change the totals konten.spec.ts expects.
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

const banner = (page: Page) => page.getByRole("region", { name: "Ansicht als andere Person" });

test("a member keeps a private account of his own", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await admin.goto("/einstellungen/benutzer");
  await admin.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Benutzer anlegen" });
  await dialog.getByLabel("Benutzername").fill(PAUL.username);
  await dialog.getByLabel("Startpasswort").fill(PAUL.password);
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(admin.getByRole("row").filter({ hasText: PAUL.username })).toBeVisible();
  // Superusers and oneself cannot be viewed.
  await admin.getByRole("button", { name: `Aktionen für ${ADMIN.username}` }).click();
  await expect(admin.getByRole("menuitem", { name: /ansehen/ })).toHaveCount(0);
  await admin.keyboard.press("Escape");
  await admin.context().close();

  const paul = await newSession(browser, PAUL);
  await paul.goto("/konten");
  await paul.getByRole("button", { name: "Konto hinzufügen" }).first().click();
  await paul.getByRole("dialog", { name: "Konto hinzufügen" }).getByRole("button", { name: "Manuelles Konto" }).click();
  const create = paul.getByRole("dialog", { name: "Manuelles Konto anlegen" });
  await create.getByLabel("Name", { exact: true }).fill(PAULS_ACCOUNT);
  await create.getByLabel("Bank oder Anbieter").fill("Bargeld");
  await create.getByRole("button", { name: "Konto anlegen" }).click();
  await expect(paul.locator(".account-item").filter({ hasText: PAULS_ACCOUNT })).toContainText("Privat");
  await paul.context().close();
});

test("the superuser views Saldo as the member, read-only, and returns to his own view", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await admin.goto("/einstellungen/benutzer");
  await admin.getByRole("button", { name: `Aktionen für ${PAUL.username}` }).click();
  await admin.getByRole("menuitem", { name: `Als ${PAUL.username} ansehen` }).click();
  await expect(admin.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await expect(banner(admin)).toContainText(`Du siehst Saldo als ${PAUL.username} (Mitglied) – nur lesen`);

  await admin.goto("/konten");
  await expect(banner(admin)).toBeVisible();
  await expect(admin.locator(".account-item").filter({ hasText: PAULS_ACCOUNT })).toBeVisible();
  await expect(admin.getByText(ADMINS_ACCOUNT)).toHaveCount(0);
  await admin.goto("/einstellungen");
  const sections = admin.getByRole("navigation", { name: "Bereiche der Einstellungen" });
  await expect(sections.getByRole("link")).toHaveText([/MCP/]);

  // A server function and the auth API both refuse changes.
  await admin.goto("/einstellungen/mcp");
  await admin.getByLabel("Name des neuen Tokens").fill("Laptop");
  await admin.getByRole("button", { name: "Token erstellen" }).click();
  await expect(admin.getByRole("alert")).toContainText(LOCKED);
  await admin.goto("/persoenlich/daten");
  await admin.getByLabel("Anzeigename").fill("Jemand anderes");
  await admin.getByRole("button", { name: "Speichern" }).click();
  await expect(admin.getByRole("alert")).toContainText(LOCKED);

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(admin, mode);
    await admin.goto("/");
    await admin.waitForLoadState("networkidle");
    await expect(banner(admin)).toBeVisible();
    await expectNoAxeViolations(admin, `Übersicht beim Ansehen (${mode})`);
  }
  await setMode(admin, "hell");

  await admin.goto("/");
  const stop = banner(admin).getByRole("button", { name: "Ansehen beenden" });
  await stop.focus();
  await admin.keyboard.press("Enter");
  await expect(admin).toHaveURL(/\/einstellungen\/benutzer$/);
  await expect(admin.getByRole("row").filter({ hasText: PAUL.username })).toBeVisible();
  await expect(banner(admin)).toHaveCount(0);
  await admin.goto("/konten");
  await expect(admin.getByText(ADMINS_ACCOUNT).first()).toBeVisible();

  await admin.goto("/einstellungen/protokoll");
  await expect(admin.getByText("Ansehen als andere Person begonnen").first()).toBeVisible();
  await expect(admin.getByText("Ansehen als andere Person beendet").first()).toBeVisible();
  await admin.context().close();

  const paul = await newSession(browser, PAUL);
  await paul.goto("/persoenlich/daten");
  await expect(paul.getByLabel("Anzeigename")).not.toHaveValue("Jemand anderes");
  await expect(banner(paul)).toHaveCount(0);
  await paul.context().close();
});

test("the banner fits a phone screen and the desktop", async ({ browser }) => {
  for (const width of [375, 1280]) {
    const admin = await newSession(browser, ADMIN, width);
    await admin.goto("/einstellungen/benutzer");
    await admin.getByRole("button", { name: `Aktionen für ${PAUL.username}` }).click();
    await admin.getByRole("menuitem", { name: `Als ${PAUL.username} ansehen` }).click();
    await expect(banner(admin)).toBeVisible();
    await expect(banner(admin).getByRole("button", { name: "Ansehen beenden" })).toBeInViewport();
    const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(admin, `Banner (${width} px)`);
    await banner(admin).getByRole("button", { name: "Ansehen beenden" }).click();
    await expect(admin).toHaveURL(/\/einstellungen\/benutzer$/);
    await admin.context().close();
  }
});
