import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };

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

test("the admin finds their own sign-in in the audit log, filters it and it passes axe in light and dark", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();

  await page.goto("/einstellungen");
  await page
    .getByRole("navigation", { name: "Bereiche der Einstellungen" })
    .getByRole("link", { name: /Protokoll/ })
    .click();
  await expect(page).toHaveURL(/\/einstellungen\/protokoll$/);
  await expect(page.getByRole("heading", { level: 2, name: "Protokoll" })).toBeVisible();
  const signIn = page.getByRole("row").filter({ hasText: "Anmeldung" }).filter({ hasText: "Erfolgreich" }).first();
  await expect(signIn).toContainText("admin");

  await page.getByLabel("Bereich", { exact: true }).selectOption({ label: "Anmeldung" });
  await expect(page).toHaveURL(/bereich=auth/);
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasNotText: /Anmeldung|Abmeldung|Passwort|Sitzung/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "CSV exportieren" })).toHaveAttribute("href", "/api/audit/export.csv?category=auth");
  await expectNoAxeViolations(page, "Protokoll (hell)");

  // The second download lists the first, recorded with the browser's user agent from the request context.
  const exportCsv = "/api/audit/export.csv?category=export";
  expect((await page.request.get(exportCsv)).status()).toBe(200);
  const csv = await (await page.request.get(exportCsv)).text();
  expect(csv).toMatch(/;export\.auditCsv;ok;;.*;"Mozilla\//);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(signIn).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });

  await setMode(page, "dunkel");
  await page.goto("/einstellungen/protokoll");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 2, name: "Protokoll" })).toBeVisible();
  await expectNoAxeViolations(page, "Protokoll (dunkel)");
  await setMode(page, "hell");
  await context.close();
});
