import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";
const TOTALS = "Summen aller gefilterten Buchungen";
// Same database as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";

test.describe.configure({ mode: "serial" });

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

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `seitliches Scrollen auf ${label}`).toBeLessThanOrEqual(0);
}

/** The value next to a label in the totals bar, e.g. "Anzahl" → "123". */
const figure = (totals: Locator, label: string) => totals.locator(".totals-figure").filter({ hasText: label }).locator("dd");

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
  await page.context().close();
  // A default filter left behind would change what the later specs see on the bookings page.
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql`delete from saved_filters`;
  await sql.end();
});

test("the navigation has no view picker; the bookings page starts with all accounts and offers a group filter", async () => {
  await expect(page.getByLabel("Ansicht", { exact: true })).toHaveCount(0);
  // Links from before keep working; the old view parameter is ignored.
  await page.goto("/buchungen?ansicht=1");
  await expect(page.locator(".page-head .eyebrow")).toHaveText("Alle Konten");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await dialog.getByLabel("Gruppe", { exact: true }).selectOption({ label: "Meine Konten" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(page.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem")).toHaveText(["Gruppe: Meine Konten"]);
  await expect(page.locator(".page-head .eyebrow")).toHaveText("Meine Konten");
  await page.getByRole("button", { name: "Filter Gruppe: Meine Konten entfernen" }).click();
  await expect(page).not.toHaveURL(/gruppe=/);
});

test("the totals cover every matching booking and follow the filters", async () => {
  await page.goto("/buchungen");
  const totals = page.getByRole("region", { name: TOTALS });
  const heading = page.getByRole("heading", { level: 2, name: /Buchungen$/ });
  const count = (await figure(totals, "Anzahl").textContent()) ?? "";
  expect(Number(count.replace(/\D/g, ""))).toBeGreaterThan(50);
  await expect(heading).toHaveText(`${count} Buchungen`);
  await expect(totals).toContainText("nicht eingerechnet");

  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await dialog.getByLabel("Umsatzart").selectOption({ label: "Nur Ausgänge (−)" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(figure(totals, "Anzahl")).not.toHaveText(count);
  await expect(figure(totals, "Eingänge")).toHaveText(/^\+?0,00/);
  await expect(figure(totals, "Ausgänge")).toContainText("−");
  await expect(heading).toHaveText(`${(await figure(totals, "Anzahl").textContent()) ?? ""} Buchungen`);
});

test("quick filter pills switch with one click and show their counts", async () => {
  await page.goto("/buchungen");
  const pills = page.getByRole("group", { name: "Schnellfilter" });
  const all = pills.getByRole("button", { name: /^Alle/ });
  const fresh = pills.getByRole("button", { name: /^Neu/ });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  const newCount = Number(((await fresh.locator(".quick-count").textContent()) ?? "0").replace(/\D/g, ""));
  await fresh.click();
  await expect(page).toHaveURL(/neu=true/);
  await expect(fresh).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  const rows = page.locator("tr.booking-row");
  await expect(rows.first()).toHaveAttribute("data-unread", "true");
  expect(await rows.count()).toBe(Math.min(newCount, 50));

  const uncategorized = pills.getByRole("button", { name: /^Ohne Kategorie/ });
  await uncategorized.click();
  await expect(page).toHaveURL(/ohneKategorie=true/);
  await expect(uncategorized).toHaveAttribute("aria-pressed", "true");
  await expect(page).not.toHaveURL(/neu=true/);
  for (const text of await page.locator("td.booking-cat").allTextContents()) expect(text).toContain("Ohne Kategorie");
  await all.click();
  await expect(page).not.toHaveURL(/ohneKategorie|neu=/);
});

test("date and amount columns sort in both directions", async () => {
  await page.goto("/buchungen");
  const date = page.getByRole("columnheader", { name: /^Datum/ });
  const amount = page.getByRole("columnheader", { name: /^Betrag/ });
  await expect(date).toHaveAttribute("aria-sort", "descending");
  await expect(amount).not.toHaveAttribute("aria-sort");
  // Booked rows only: pending ones stay on top whatever the sort.
  const amounts = () => page.locator("tr.booking-row td.booking-amount").allTextContents();

  await amount.getByRole("button").click();
  await expect(page).toHaveURL(/sortierung=betrag-ab/);
  await expect(amount).toHaveAttribute("aria-sort", "descending");
  await expect(date).not.toHaveAttribute("aria-sort");
  expect((await amounts())[0]).not.toContain("−");

  await amount.getByRole("button").click();
  await expect(page).toHaveURL(/sortierung=betrag-auf/);
  await expect(amount).toHaveAttribute("aria-sort", "ascending");
  expect((await amounts())[0]).toContain("−");

  await date.getByRole("button").click();
  await date.getByRole("button").click();
  await expect(page).toHaveURL(/sortierung=datum-auf/);
  await expect(date).toHaveAttribute("aria-sort", "ascending");
  await date.getByRole("button").click();
  await expect(page).not.toHaveURL(/sortierung=/);
});

test("a row opens its booking from the keyboard", async () => {
  await page.goto("/buchungen");
  const first = page.locator(".booking-open").first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Buchung bearbeiten" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(first).toBeFocused();
});

test("a filter is saved, applied with one click, used as default when opening and managed", async () => {
  await page.goto("/buchungen");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption({ label: "Lebensmittel" });
  await dialog.getByLabel("Zeitraum").selectOption({ label: "Letzte 12 Monate" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(page).toHaveURL(/zeitraum=last_12_months/);

  const saved = page.getByRole("group", { name: "Gespeicherte Filter" });
  await saved.getByRole("button", { name: "Filter speichern" }).click();
  const save = page.getByRole("dialog", { name: "Aktuelle Filter speichern" });
  await expectNoAxeViolations(page, "Filter speichern");
  await save.getByRole("button", { name: "Speichern" }).click();
  await expect(save.getByText("Bitte einen Namen eingeben.")).toBeVisible();
  await save.getByLabel("Name").fill("Einkauf");
  await save.getByLabel("Beim Öffnen anwenden").check();
  await save.getByRole("button", { name: "Speichern" }).click();
  await expect(save).toBeHidden();
  const quick = saved.getByRole("button", { name: /^Einkauf/ });
  await expect(quick).toHaveAttribute("aria-pressed", "true");
  await expect(quick).toContainText("Standard");

  await page.getByRole("button", { name: "Alle Filter entfernen" }).click();
  await expect(page).not.toHaveURL(/kategorie=/);
  // Removing the filters on the page keeps them off; the default only applies when the page is opened.
  await expect(quick).toHaveAttribute("aria-pressed", "false");
  await quick.click();
  await expect(page).toHaveURL(/kategorie=\d+.*zeitraum=last_12_months|zeitraum=last_12_months.*kategorie=\d+/);

  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Konten" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Konten" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("link", { name: /^Buchungen/ })
    .click();
  await expect(page).toHaveURL(/kategorie=\d+/);
  await expect(page.getByRole("list", { name: "Aktive Filter" })).toContainText("Kategorie: Lebensmittel");

  await saved.getByRole("button", { name: "Verwalten" }).click();
  const manage = page.getByRole("dialog", { name: "Gespeicherte Filter" });
  await manage.getByLabel("Name von „Einkauf“").fill("Lebensmittel");
  await manage.getByRole("button", { name: /^Umbenennen\s*: Einkauf/ }).click();
  await expect(manage.getByRole("status")).toHaveText("Filter in „Lebensmittel“ umbenannt.");
  await manage.getByRole("button", { name: "Aktionen für Lebensmittel" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Beim Öffnen anwenden", checked: true }).click();
  await expect(manage.getByRole("status")).toHaveText("„Lebensmittel“ wird nicht mehr beim Öffnen angewendet.");
  await expectNoAxeViolations(page, "Gespeicherte Filter verwalten");
  await manage.getByRole("button", { name: "Schließen" }).last().click();

  await page.goto("/konten");
  await page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("link", { name: /^Buchungen/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Buchungen" })).toBeVisible();
  await expect(page).not.toHaveURL(/kategorie=/);

  await saved.getByRole("button", { name: "Verwalten" }).click();
  await manage.getByRole("button", { name: "Aktionen für Lebensmittel" }).click();
  await page.getByRole("menuitem", { name: "Löschen" }).click();
  await expect(manage.getByText("Noch keine gespeicherten Filter.")).toBeVisible();
  await manage.getByRole("button", { name: "Schließen" }).last().click();
  await expect(saved.getByRole("button", { name: /^Lebensmittel/ })).toHaveCount(0);
});

test("the account page uses the same table, quick filters and totals", async () => {
  await page.goto("/konten");
  await page.getByRole("link", { name: new RegExp(`^${ACCOUNT}`) }).click();
  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  // The row link opens all bookings; the quick filter "Alle" is the default.
  const all = bookings.getByRole("group", { name: "Schnellfilter" }).getByRole("button", { name: /^Alle/ });
  await all.click();
  await expect(page).not.toHaveURL(/neu=true/);
  // The address changes before the page has loaded it; sorting earlier would start from the old filters.
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(bookings.getByRole("columnheader", { name: /^Datum/ })).toHaveAttribute("aria-sort", "descending");
  await bookings
    .getByRole("columnheader", { name: /^Betrag/ })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(/sortierung=betrag-ab/);
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(bookings.getByRole("region", { name: TOTALS })).toBeVisible();
  // Without a filter set and nothing saved for accounts there is nothing to save or manage.
  await expect(bookings.getByRole("group", { name: "Gespeicherte Filter" })).toHaveCount(0);
});

test("the bookings pages pass axe in light and dark mode and fit 375 px", async () => {
  await page.goto("/konten");
  const detail = (await page.getByRole("link", { name: new RegExp(`^${ACCOUNT}`) }).getAttribute("href")) ?? "";
  const paths = ["/buchungen", "/buchungen?ohneKategorie=true&richtung=aus", "/buchungen?sortierung=betrag-auf", detail];
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1")).toBeVisible();
      await expectNoAxeViolations(page, `${path} (${mode})`);
    }
  }
  await setMode(page, "hell");
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of [...paths, "/konten"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page, path);
  }
  await page.goto("/buchungen");
  await expect(page.getByRole("region", { name: TOTALS })).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 720 });
});
