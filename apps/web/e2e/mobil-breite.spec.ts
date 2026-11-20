import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const CONTRACT = "Schmal-Vertrag mit einem recht langen Namen";
const PAGES = [
  "/",
  "/buchungen",
  "/konten",
  "/analyse",
  "/vertraege",
  "/einstellungen",
  "/einstellungen/gruppen",
  "/einstellungen/konten",
  "/einstellungen/kategorien",
  "/einstellungen/tags",
  "/einstellungen/regeln",
  "/einstellungen/bankverbindungen",
  "/einstellungen/ki",
  "/einstellungen/benutzer",
  "/einstellungen/email",
  "/einstellungen/mcp",
  "/einstellungen/sicherung",
  "/einstellungen/protokoll",
  "/einstellungen/passwort",
  "/persoenlich",
  "/persoenlich/daten",
  "/persoenlich/darstellung",
  "/persoenlich/benachrichtigungen",
  "/persoenlich/tastenkuerzel",
  "/persoenlich/passwort",
];

test.describe.configure({ mode: "serial" });

async function phone(browser: Browser, width: number, look: { theme: string; mode: string } = { theme: "leinen", mode: "hell" }) {
  const context = await browser.newContext({
    viewport: { width, height: 720 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  await context.addInitScript(
    ([theme, mode]) => {
      try {
        localStorage.setItem("fw-theme", theme);
        localStorage.setItem("fw-modus", mode);
      } catch {
        // about:blank and other opaque documents have no storage.
      }
    },
    [look.theme, look.mode] as const,
  );
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  return page;
}

async function visit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
}

/** Neither the page nor its main area can be scrolled sideways. */
async function expectNoSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow, `seitliches Scrollen auf ${label}`).toEqual({ page: 0, main: 0 });
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

let contractPath = "";

test.beforeAll(async ({ browser }) => {
  const page = await phone(browser, 375);
  await visit(page, "/vertraege");
  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await form.getByLabel("Name", { exact: true }).fill(CONTRACT);
  await form.getByLabel("Betrag in Euro").fill("12,34");
  await form.getByLabel("Nächste Fälligkeit").fill(`${new Date().getFullYear() + 1}-02-01`);
  await form.getByLabel("Empfänger enthält").fill("schmal-vertrag-gibt-es-nicht");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("dialog", { name: CONTRACT })).toBeVisible();
  await expect(page).toHaveURL(/vertrag=\d+/);
  contractPath = `/vertraege?vertrag=${new URL(page.url()).searchParams.get("vertrag")}`;
  await page.context().close();
});

test.afterAll(async ({ browser }) => {
  const page = await phone(browser, 375);
  await visit(page, contractPath);
  const detail = page.getByRole("dialog", { name: CONTRACT });
  await detail.getByRole("button", { name: "Löschen", exact: true }).click();
  await page
    .getByRole("dialog", { name: /löschen/ })
    .getByRole("button", { name: "Löschen" })
    .click();
  await expect(detail).toBeHidden();
  await page.context().close();
});

for (const width of [320, 375]) {
  test(`at ${width} px no page scrolls sideways, a contract and an account included`, async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await phone(browser, width);
    await visit(page, "/konten");
    const account = (await page.locator("a.account-row").first().getAttribute("href")) ?? "/konten";
    for (const path of [...PAGES, account]) {
      await visit(page, path);
      await expectNoSidewaysScroll(page, `${path} (${width} px)`);
    }
    await visit(page, contractPath);
    await expect(page.getByRole("dialog", { name: CONTRACT })).toBeVisible();
    await expectNoSidewaysScroll(page, `Vertrag (${width} px)`);
    await page.keyboard.press("Escape");
    await page.context().close();
  });
}

test("on a phone the settings lists keep one ⋯ per row and an icon for adding, and pass axe in light and dark", async ({ browser }) => {
  for (const mode of ["hell", "dunkel"] as const) {
    const page = await phone(browser, 375, { theme: "leinen", mode });
    for (const [path, add, row] of [
      ["/einstellungen/kategorien", "Kategorie anlegen", "Lebensmittel"],
      ["/einstellungen/gruppen", "Gruppe anlegen", null],
      ["/einstellungen/regeln", "Regel anlegen", null],
      ["/einstellungen/benutzer", "Benutzer anlegen", "admin"],
    ] as const) {
      await visit(page, path);
      const button = page.getByRole("button", { name: add, exact: true });
      const box = await button.boundingBox();
      expect(box && box.width <= 48 && box.height >= 44, `${add} als Symbol`).toBe(true);
      const main = page.getByRole("main");
      await expect(main.getByRole("button", { name: /^(Bearbeiten|Löschen)/ })).toHaveCount(0);
      if (row) await expect(main.getByRole("button", { name: `Aktionen für ${row}`, exact: true })).toBeVisible();
      await expectNoAxeViolations(page, `${path} (375 px, ${mode})`);
    }
    await page.context().close();
  }
});
