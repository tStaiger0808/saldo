import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE", viewport: { width: 1280, height: 800 } });
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
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql`delete from saved_filters`;
  await sql.end();
});

const filterDialog = () => page.getByRole("dialog", { name: "Buchungen filtern" });
const saveButton = () => page.getByRole("group", { name: "Gespeicherte Filter" }).getByRole("button", { name: "Filter speichern" });

async function clickOutside() {
  await page.mouse.click(8, 400);
}

test("a click outside closes the unchanged filter dialog but not one with changes", async () => {
  await page.goto("/buchungen");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await expect(filterDialog()).toBeVisible();
  const backdrop = await page.evaluate(
    () => getComputedStyle(document.querySelector("dialog[open]") as Element, "::backdrop").backgroundColor,
  );
  expect(backdrop).toMatch(/0\.6\d?\)$/);
  await clickOutside();
  await expect(filterDialog()).toBeHidden();

  await page.getByRole("button", { name: /^Filtern/ }).click();
  await filterDialog().getByLabel("Zeitraum").selectOption({ label: "Letzte 12 Monate" });
  await clickOutside();
  await expect(filterDialog()).toBeVisible();
  // Putting the value back counts as unchanged again.
  await filterDialog().getByLabel("Zeitraum").selectOption({ index: 0 });
  await clickOutside();
  await expect(filterDialog()).toBeHidden();

  await page.getByRole("button", { name: /^Filtern/ }).click();
  await filterDialog().getByLabel("Zeitraum").selectOption({ label: "Letzte 12 Monate" });
  await filterDialog().getByRole("button", { name: "Abbrechen" }).click();
  await expect(filterDialog()).toBeHidden();
  await expect(page).not.toHaveURL(/zeitraum=/);
});

test("Filter speichern appears only for a set filter that is not saved yet", async () => {
  await page.goto("/buchungen");
  await expect(saveButton()).toHaveCount(0);

  await page.getByRole("button", { name: /^Filtern/ }).click();
  await filterDialog().getByLabel("Zeitraum").selectOption({ label: "Letzte 12 Monate" });
  await filterDialog().getByRole("button", { name: "Anwenden" }).click();
  await expect(page).toHaveURL(/zeitraum=last_12_months/);
  await saveButton().click();
  const save = page.getByRole("dialog", { name: "Aktuelle Filter speichern" });
  await save.getByLabel("Name").fill("Letztes Jahr");
  await save.getByRole("button", { name: "Speichern" }).click();
  await expect(save).toBeHidden();

  const group = page.getByRole("group", { name: "Gespeicherte Filter" });
  await expect(group.getByRole("button", { name: /^Letztes Jahr/ })).toHaveAttribute("aria-pressed", "true");
  await expect(saveButton()).toHaveCount(0);

  await page.goto("/buchungen");
  await expect(page).not.toHaveURL(/zeitraum=/);
  await expect(group.getByRole("button", { name: /^Letztes Jahr/ })).toHaveAttribute("aria-pressed", "false");
  await expect(saveButton()).toHaveCount(0);
  await group.getByRole("button", { name: /^Letztes Jahr/ }).click();
  await expect(saveButton()).toHaveCount(0);
});
