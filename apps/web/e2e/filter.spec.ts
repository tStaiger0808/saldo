import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";

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
  await page.context().close();
});

test("bookings filters are set in a dialog from the keyboard and removed as chips", async () => {
  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  const button = page.getByRole("button", { name: /^Filtern/ });
  const chips = page.getByRole("list", { name: "Aktive Filter" });
  await expect(button).toHaveAccessibleName("Filtern");
  await expect(chips).toHaveCount(0);

  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Gruppe", { exact: true })).toBeFocused();
  await dialog.getByLabel("Umsatzart").selectOption({ label: "Nur Ausgänge (−)" });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption({ label: "Lebensmittel" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/richtung=aus/);
  await expect(page).toHaveURL(/kategorie=\d+/);
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("Filtern, 2 aktiv");
  await expect(chips.getByRole("listitem")).toHaveText(["Kategorie: Lebensmittel", "Nur Ausgänge"]);
  const amounts = await page.locator(".booking-amount").allTextContents();
  expect(amounts.length).toBeGreaterThan(0);
  for (const amount of amounts) expect(amount).toContain("−");

  await page.getByLabel("Suche", { exact: true }).fill("rewe");
  await page.getByRole("button", { name: "Suchen", exact: true }).click();
  await expect(chips.getByRole("listitem")).toHaveText(["Kategorie: Lebensmittel", "Nur Ausgänge", "Suche: „rewe“"]);
  await expect(page.locator(".filter-bar [aria-live]")).toHaveText(/^\d+ Buchung(en)?$/);

  // Escape discards changes made in the dialog; "Zurücksetzen" only clears the dialog until it is applied.
  await button.click();
  await dialog.getByLabel("Umsatzart").selectOption({ label: "Nur Eingänge (+)" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page).toHaveURL(/richtung=aus/);
  await button.click();
  await dialog.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Umsatzart")).toHaveValue("");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(3);

  await page.getByRole("button", { name: "Filter Nur Ausgänge entfernen" }).click();
  await expect(page).not.toHaveURL(/richtung=/);
  await expect(chips.getByRole("listitem")).toHaveText(["Kategorie: Lebensmittel", "Suche: „rewe“"]);
  await expect(page.getByRole("button", { name: "Filter Suche: „rewe“ entfernen" })).toBeFocused();
  await expect(page.getByLabel("Suche", { exact: true })).toHaveValue("rewe");

  await page.getByRole("button", { name: "Alle Filter entfernen" }).click();
  await expect(chips).toHaveCount(0);
  await expect(page).not.toHaveURL(/kategorie=|q=/);
  await expect(page.getByLabel("Suche", { exact: true })).toHaveValue("");
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("Filtern");
});

test("a date range is checked and shown as one chip", async () => {
  await page.goto("/buchungen");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await dialog.getByLabel("Zeitraum").selectOption({ label: "Eigener Zeitraum" });
  await dialog.getByLabel("Von").fill("2026-03-31");
  await dialog.getByLabel("Bis").fill("2026-01-01");
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(dialog.getByText("Das Enddatum liegt vor dem Startdatum.")).toBeVisible();
  await expect(dialog.getByLabel("Bis")).toBeFocused();
  await dialog.getByLabel("Von").fill("2026-01-01");
  await dialog.getByLabel("Bis").fill("2026-03-31");
  await dialog.getByLabel("Umbuchungen ausblenden").check();
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  const chips = page.getByRole("list", { name: "Aktive Filter" });
  await expect(chips.getByRole("listitem")).toHaveText(["Zeitraum: 01.01.2026 – 31.03.2026", "Umbuchungen ausblenden"]);
  await expect(page.getByRole("button", { name: /^Filtern/ })).toHaveAccessibleName("Filtern, 2 aktiv");
  await expect(page.getByRole("link", { name: "CSV exportieren" })).toHaveAttribute("href", /from=2026-01-01&to=2026-03-31/);
  await page.getByRole("button", { name: "Filter Zeitraum: 01.01.2026 – 31.03.2026 entfernen" }).click();
  await expect(page).not.toHaveURL(/von=|bis=/);
  await expect(page).toHaveURL(/ohneUmbuchungen=true/);
});

test("a relative period is offered next to fixed dates and shown by its name", async () => {
  await page.goto("/buchungen");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  await expect(dialog.getByLabel("Von")).toHaveCount(0);
  await dialog.getByLabel("Zeitraum").selectOption({ label: "Letzte 3 Monate" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(page).toHaveURL(/zeitraum=last_3_months/);
  await expect(page.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem")).toHaveText(["Zeitraum: Letzte 3 Monate"]);
  await page.getByRole("button", { name: "Filter Zeitraum: Letzte 3 Monate entfernen" }).click();
  await expect(page).not.toHaveURL(/zeitraum=/);
});

test("the account page shares the filter dialog and chips", async () => {
  await page.goto("/konten");
  await page.getByRole("link", { name: new RegExp(ACCOUNT) }).click();
  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  await bookings.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen des Kontos filtern" });
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Konto", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Umsatzart").selectOption({ label: "Nur Eingänge (+)" });
  await dialog.getByRole("button", { name: "Anwenden" }).click();
  await expect(page).toHaveURL(/richtung=ein/);
  await expect(bookings.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem")).toHaveText(["Nur Eingänge"]);
  for (const amount of await bookings.locator(".booking-amount").allTextContents()) expect(amount).not.toContain("−");
  await bookings.getByRole("button", { name: "Filter Nur Eingänge entfernen" }).click();
  await expect(page).not.toHaveURL(/richtung=/);
  await expect(bookings.getByRole("button", { name: /^Filtern/ })).toBeFocused();
});

test("filter dialog and chips pass axe in light and dark mode and fit a phone screen", async () => {
  const filtered = "/buchungen?richtung=aus&neu=true&von=2026-01-01&q=eBay";
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto(filtered);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("button", { name: /^Neu/ })).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page, `Filterchips (${mode})`);
    await page.getByRole("button", { name: /^Filtern/ }).click();
    await expect(page.getByRole("dialog", { name: "Buchungen filtern" })).toBeVisible();
    await expectNoAxeViolations(page, `Filterdialog (${mode})`);
    await page.keyboard.press("Escape");
  }
  await setMode(page, "hell");
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(filtered);
  await page.waitForLoadState("networkidle");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", { name: "Buchungen filtern" });
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(375);
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 720 });
});
