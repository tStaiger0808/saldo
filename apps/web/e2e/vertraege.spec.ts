import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const NETFLIX = "Netflix International B.V.";
const euro = (text: string) => new RegExp(text.replace(/[.+]/g, "\\$&").replace(" €", "\\s€"));

test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Modus").selectOption(mode);
}

async function expectNoPageScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `waagerechtes Scrollen auf ${label}`).toBeLessThanOrEqual(0);
}

/** Every field of a dialog lies within the screen's width once scrolled to. */
async function expectFieldsFit(dialog: Locator, width: number) {
  const fields = dialog.locator("input:not([type=hidden]), select, textarea");
  const count = await fields.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect(box, `Feld ${i}`).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  }
}

/** The card shows the first suggestions; "show more" opens all of them in a dialog. Returns where every one is listed. */
async function allSuggestions(page: Page): Promise<Locator> {
  const region = page.getByRole("region", { name: "Vorschläge" });
  await expect(region.getByRole("heading", { name: "Vorschläge" })).toBeVisible();
  const more = region.getByRole("button", { name: /^\d+ weiteren? anzeigen$/ });
  if (!(await more.isVisible())) return region;
  await expect(more).toHaveAttribute("aria-haspopup", "dialog");
  await more.click();
  const dialog = page.getByRole("dialog", { name: "Alle Vorschläge" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Closes the suggestions dialog with Escape when one is open; focus goes back to the page. */
async function closeSuggestions(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Alle Vorschläge" });
  if (!(await dialog.isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

async function setTheme(page: Page, theme: string, mode: "hell" | "dunkel") {
  await page.evaluate(
    ([t, m]) => {
      localStorage.setItem("fw-theme", t);
      localStorage.setItem("fw-modus", m);
    },
    [theme, mode] as const,
  );
}

const THEMES = ["tanne", "fjord", "holunder", "schiefer"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return iso(d);
};

async function createContract(page: Page, name: string, fields: { amount: string; nextDue: string; payee?: string }) {
  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Betrag in Euro").fill(fields.amount);
  await form.getByLabel("Nächste Fälligkeit").fill(fields.nextDue);
  if (fields.payee) await form.getByLabel("Empfänger enthält").fill(fields.payee);
  await form.getByRole("button", { name: "Speichern" }).click();
  const detail = page.getByRole("dialog", { name });
  await expect(detail).toBeVisible();
  return detail;
}

async function deleteContract(page: Page, name: string) {
  await page.getByRole("region", { name: "Alle Verträge" }).getByRole("button", { name, exact: true }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Löschen", exact: true }).click();
  await page
    .getByRole("dialog", { name: `Vertrag „${name}“ löschen?` })
    .getByRole("button", { name: "Vertrag löschen" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: `Vertrag „${name}“ gelöscht.` })).toBeVisible();
}

/** The open drawer lies within the screen, neither it nor its body scrolls sideways, and it is not scrolled aside. */
async function expectDrawerFits(drawer: Locator, label: string) {
  await expect(drawer).toBeVisible();
  const size = await drawer.evaluate((node) => {
    const body = node.querySelector(".dialog-body");
    const box = node.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      viewport: document.documentElement.clientWidth,
      scrollLeft: node.scrollLeft,
      overflow: node.scrollWidth - node.clientWidth,
      bodyOverflow: body ? body.scrollWidth - body.clientWidth : -1,
      bodyScrollLeft: body?.scrollLeft ?? -1,
    };
  });
  expect(size.left, `${label}: links`).toBeGreaterThanOrEqual(0);
  expect(size.right, `${label}: rechts`).toBeLessThanOrEqual(size.viewport + 0.5);
  expect(size.overflow, `${label}: Drawer scrollt seitlich`).toBeLessThanOrEqual(0);
  expect(size.scrollLeft, `${label}: Drawer seitlich verschoben`).toBe(0);
  expect(size.bodyOverflow, `${label}: Inhalt scrollt seitlich`).toBeLessThanOrEqual(0);
  expect(size.bodyScrollLeft, `${label}: Inhalt seitlich verschoben`).toBe(0);
}

/** The number in the navigation badge of "Verträge", 0 without one. */
async function dueBadge(page: Page): Promise<number> {
  const link = page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: /^Verträge/ });
  return Number((await link.textContent())?.match(/\d+/)?.[0] ?? 0);
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
  page = await context.newPage();
  await login(page);
});

test.afterAll(async () => {
  await page.context().close();
});

test("a booking becomes a contract with its interval and all its payments", async () => {
  await page.goto(`/buchungen?q=${encodeURIComponent("Netflix")}`);
  await page.getByRole("row").filter({ hasText: NETFLIX }).first().getByRole("button", { name: NETFLIX }).click();
  const drawer = page.getByRole("dialog", { name: "Buchung bearbeiten" });
  await drawer.getByRole("link", { name: "Als Vertrag anlegen" }).click();

  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await expect(form.getByText(/Aus der Buchung vom \d{2}\.\d{2}\.\d{4} vorausgefüllt/)).toBeVisible();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue(NETFLIX);
  await expect(form.getByLabel("Art")).toHaveValue("expense");
  await expect(form.getByLabel("Betrag in Euro")).toHaveValue("13,99");
  await expect(form.getByLabel("Intervall")).toHaveValue("monthly");
  await expect(form.getByLabel("Konto")).toHaveValue(/\d+/);
  await expect(form.getByLabel("Empfänger enthält")).toHaveValue(NETFLIX);
  await form.getByRole("button", { name: "Speichern" }).click();

  const detail = page.getByRole("dialog", { name: NETFLIX });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("aktiv")).toBeVisible();
  expect(await detail.getByRole("listitem").count()).toBeGreaterThanOrEqual(11);
  await detail.getByRole("button", { name: "Schließen" }).first().click();
  await expect(detail).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: `Vertrag „${NETFLIX}“ angelegt.` })).toBeVisible();

  // The booking now points to its contract.
  await page.goto(`/buchungen?q=${encodeURIComponent("Netflix")}`);
  await page.getByRole("row").filter({ hasText: NETFLIX }).first().getByRole("button", { name: NETFLIX }).click();
  await expect(page.getByRole("dialog", { name: "Buchung bearbeiten" }).getByRole("link", { name: "Zum Vertrag" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Buchung bearbeiten" })).toBeHidden();
});

test("suggestions are taken over or ignored, and the head sums up income, expenses and the buffer", async () => {
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Verträge" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Verträge" })).toBeVisible();
  const suggestions = page.getByRole("region", { name: "Vorschläge" });
  await expect(suggestions.getByText(NETFLIX)).toHaveCount(0);

  await suggestions.getByRole("button", { name: "Muster GmbH als Vertrag übernehmen" }).click();
  const detail = page.getByRole("dialog", { name: "Muster GmbH" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("monatlich")).toBeVisible();
  await detail.getByRole("button", { name: "Schließen" }).first().click();
  await expect(suggestions.getByText("Muster GmbH")).toHaveCount(0);

  const all = await allSuggestions(page);
  await all.getByRole("button", { name: "Spotify AB ignorieren" }).click();
  await expect(all.getByRole("status").filter({ hasText: "„Spotify AB“ wird nicht mehr vorgeschlagen." })).toBeVisible();
  await closeSuggestions(page);
  await page.reload();
  await expect(page.getByRole("region", { name: "Vorschläge" }).getByText("Spotify AB")).toHaveCount(0);

  const totals = page.getByRole("region", { name: "Pro Monat" });
  await expect(
    totals
      .getByRole("definition")
      .filter({ hasText: euro("3.520,00 €") })
      .first(),
  ).toBeVisible();
  await expect(totals).toContainText("Einnahmen aus Verträgen");
  await expect(totals).toContainText(euro("−13,99 €"));
  await expect(totals).toContainText("Frei verfügbar/Monat");
  await expect(totals).toContainText(euro("+3.506,01 €"));
  await expect(totals).toContainText("2 laufende Verträge");
  const figure = (text: string) =>
    totals
      .getByRole("definition")
      .filter({ hasText: euro(text) })
      .first()
      .locator(".amount");
  await expect(figure("+3.506,01 €")).toHaveClass(/\bamount-in\b/);
  await expect(figure("+3.520,00 €")).toHaveClass(/\bamount-in\b/);
  await expect(figure("−13,99 €")).toHaveClass(/\bamount-out\b/);

  const list = page.getByRole("region", { name: "Alle Verträge" });
  await expect(list.getByRole("table", { name: "Gehalt" })).toContainText("Muster GmbH");
  const layout = list.getByRole("group", { name: "Darstellung" });
  await expect(layout.getByRole("button", { name: "Nach Kategorie" })).toHaveAttribute("aria-pressed", "true");
  await layout.getByRole("button", { name: "Nur auflisten" }).click();
  await expect(layout.getByRole("button", { name: "Nur auflisten" })).toHaveAttribute("aria-pressed", "true");
  // One list without income and expense sections or sums, in the chosen order (by name).
  await expect(list.getByRole("heading", { level: 3 })).toHaveCount(0);
  await expect(list.getByRole("table")).toHaveCount(0);
  const lines = list.getByRole("listitem");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("Muster GmbH");
  await expect(lines.nth(0)).toContainText("Gehalt");
  await expect(lines.nth(0)).toContainText("monatlich");
  await expect(lines.nth(0)).toContainText(euro("+3.520,00 €"));
  await expect(lines.nth(0).locator(".amount")).toHaveClass(/\bamount-in\b/);
  await expect(lines.nth(1)).toContainText(NETFLIX);
  await expect(lines.nth(1)).toContainText(euro("−13,99 €"));
  await expect(lines.nth(1).locator(".amount")).toHaveClass(/\bamount-out\b/);
  await expect(lines.nth(1).getByRole("button", { name: NETFLIX })).toBeVisible();
  await layout.getByRole("button", { name: "Nach Kategorie" }).click();
  const salary = list.getByRole("table", { name: "Gehalt" });
  await expect(salary.locator("tbody .amount").first()).toHaveClass(/\bamount-in\b/);
  await expect(list.getByRole("row").filter({ hasText: NETFLIX }).locator(".amount").first()).toHaveClass(/\bamount-out\b/);
  await expect(list.getByRole("table", { name: "Gehalt" })).toBeVisible();
});

test("an ignored suggestion comes back by undo or from the ignored ones in the suggestions dialog", async () => {
  await page.goto("/vertraege");
  const suggestions = page.getByRole("region", { name: "Vorschläge" });
  const all = await allSuggestions(page);
  await all.getByRole("button", { name: "HUK-COBURG ignorieren" }).click();
  await expect(all.getByRole("status").filter({ hasText: "„HUK-COBURG“ wird nicht mehr vorgeschlagen." })).toBeVisible();
  await expect(all.getByRole("button", { name: "HUK-COBURG als Vertrag übernehmen" })).toHaveCount(0);
  await all.getByRole("button", { name: "Ignorieren von HUK-COBURG rückgängig machen" }).click();
  await expect(all.getByRole("status").filter({ hasText: "„HUK-COBURG“ wird wieder vorgeschlagen." })).toBeVisible();
  await expect(all.getByRole("button", { name: "HUK-COBURG als Vertrag übernehmen" })).toBeVisible();
  await closeSuggestions(page);

  // The ignored ones open in the same dialog, focus on their heading; a click outside closes it and focus returns.
  const toggle = suggestions.getByRole("button", { name: "1 ignorierten anzeigen" });
  await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Alle Vorschläge" });
  await expect(dialog.getByRole("heading", { name: "Ignoriert" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: /als Vertrag übernehmen$/ }).first()).toBeVisible();
  expect(await dialog.evaluate((node) => getComputedStyle(node, "::backdrop").backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await expectNoAxeViolations(page, "Alle Vorschläge mit ignorierten");
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await dialog.getByRole("button", { name: "Spotify AB wiederherstellen" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "„Spotify AB“ wird wieder vorgeschlagen." })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Spotify AB als Vertrag übernehmen" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Ignoriert" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Nothing is ignored any more, so the button that opened the dialog is gone and the card takes the focus.
  await expect(suggestions.getByRole("heading", { name: "Vorschläge" })).toBeFocused();
});

test("views are tabs with their own accounts, added with plus, renamed and deleted", async () => {
  await page.goto("/vertraege");
  const tabs = page.getByRole("navigation", { name: "Ansichten der Verträge" });
  await expect(tabs.getByRole("link", { name: "Alle" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", { name: "Ansicht hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: "Neue Ansicht" });
  await dialog.getByRole("button", { name: "Ansicht anlegen" }).click();
  await expect(dialog.getByText("Mindestens ein Konto wählen.")).toBeVisible();
  await expectNoAxeViolations(page, "Neue Ansicht");
  await dialog.getByLabel("Name", { exact: true }).fill("Gemeinsam");
  await dialog.getByRole("checkbox", { name: /Comdirect Gemeinschaftskonto/ }).check();
  await dialog.getByRole("button", { name: "Ansicht anlegen" }).click();
  await expect(dialog).toBeHidden();
  await expect(tabs.getByRole("link", { name: "Gemeinsam" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/ansicht=\d+/);
  const list = page.getByRole("region", { name: "Alle Verträge" });
  await expect(list.getByRole("button", { name: NETFLIX })).toHaveCount(0);

  await page.getByRole("button", { name: "Ansicht bearbeiten" }).click();
  const edit = page.getByRole("dialog", { name: "Ansicht „Gemeinsam“ bearbeiten" });
  await edit.getByLabel("Name", { exact: true }).fill("Giro");
  await edit.getByRole("checkbox", { name: /Comdirect Gemeinschaftskonto/ }).uncheck();
  await edit.getByRole("checkbox", { name: /DKB Girokonto/ }).check();
  await edit.getByRole("button", { name: "Speichern" }).click();
  await expect(tabs.getByRole("link", { name: "Giro" })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("button", { name: NETFLIX })).toBeVisible();

  await page.getByRole("button", { name: "Ansicht bearbeiten" }).click();
  await page.getByRole("dialog", { name: "Ansicht „Giro“ bearbeiten" }).getByRole("button", { name: "Ansicht löschen" }).click();
  await page.getByRole("dialog", { name: "Ansicht „Giro“ löschen?" }).getByRole("button", { name: "Ansicht löschen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ansicht „Giro“ gelöscht." })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Giro" })).toHaveCount(0);
  await expect(tabs.getByRole("link", { name: "Alle" })).toHaveAttribute("aria-current", "page");
});

test("what is due within a week is marked and counted in the navigation until marked as read", async () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 2);
  await page.goto("/vertraege");
  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await form.getByLabel("Name", { exact: true }).fill("Zahnzusatz");
  await form.getByLabel("Betrag in Euro").fill("12,50");
  await form.getByLabel("Nächste Fälligkeit").fill(iso(soon));
  await form.getByRole("button", { name: "Speichern" }).click();
  const detail = page.getByRole("dialog", { name: "Zahnzusatz" });
  await expect(detail.getByText("fällig in 2 Tagen")).toBeVisible();
  await detail.getByRole("button", { name: "Schließen" }).first().click();

  const upcoming = page.getByRole("region", { name: "Demnächst fällig" });
  await expect(upcoming.getByRole("listitem").filter({ hasText: "Zahnzusatz" })).toContainText("fällig in 2 Tagen");
  await expect(page.getByRole("region", { name: "Alle Verträge" }).getByRole("row").filter({ hasText: "Zahnzusatz" })).toContainText(
    "fällig in 2 Tagen",
  );
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("link", { name: /^Verträge\s*\d+ demnächst fällig$/ })).toBeVisible();

  await upcoming.getByRole("button", { name: "Als gelesen markieren" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Fälligkeiten als gelesen markiert." })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Verträge", exact: true })).toBeVisible();
  await expect(upcoming.getByRole("button", { name: "Als gelesen markieren" })).toHaveCount(0);
  await page.reload();
  await expect(nav.getByRole("link", { name: "Verträge", exact: true })).toBeVisible();
});

test("documents are uploaded, downloaded and deleted on a contract", async () => {
  await page.goto("/vertraege");
  await page.getByRole("region", { name: "Alle Verträge" }).getByRole("button", { name: "Zahnzusatz" }).click();
  const detail = page.getByRole("dialog", { name: "Zahnzusatz" });
  const documents = detail.getByRole("region", { name: "Dokumente" });
  await expect(documents).toContainText("Noch keine Dokumente.");
  const input = documents.locator("input[type=file]");

  await input.setInputFiles({ name: "notiz.pdf", mimeType: "application/pdf", buffer: Buffer.from("kein PDF") });
  await expect(documents.getByText("Nur PDF-, PNG-, JPEG- oder WebP-Dateien")).toBeVisible();

  await input.setInputFiles({ name: "Police.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(documents.getByRole("status").filter({ hasText: "„Police.pdf“ hochgeladen." })).toBeVisible();
  const link = documents.getByRole("link", { name: "Police.pdf herunterladen" });
  await expect(link).toBeVisible();
  await expectNoAxeViolations(page, "Vertrag mit Dokument");
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("Police.pdf");

  await documents.getByRole("button", { name: "Police.pdf löschen" }).click();
  await page.getByRole("dialog", { name: "Dokument „Police.pdf“ löschen?" }).getByRole("button", { name: "Löschen" }).click();
  await expect(documents.getByRole("status").filter({ hasText: "„Police.pdf“ gelöscht." })).toBeVisible();
  await expect(documents).toContainText("Noch keine Dokumente.");

  // The later tests count on the seeded contracts only.
  await detail.getByRole("button", { name: "Löschen", exact: true }).click();
  await page.getByRole("dialog", { name: "Vertrag „Zahnzusatz“ löschen?" }).getByRole("button", { name: "Vertrag löschen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vertrag „Zahnzusatz“ gelöscht." })).toBeVisible();
});

test("the list layout, its sorting and the due-soon window are remembered, and the window drives the marks and the badge", async () => {
  await page.goto("/vertraege");
  const detail = await createContract(page, "Kfz-Steuer", { amount: "8,00", nextDue: inDays(10), payee: "Bundeskasse" });
  await detail.getByRole("button", { name: "Schließen" }).first().click();
  const before = await dueBadge(page);

  const upcoming = page.getByRole("region", { name: "Demnächst fällig" });
  const list = page.getByRole("region", { name: "Alle Verträge" });
  const row = list.getByRole("row").filter({ hasText: "Kfz-Steuer" });
  const lines = list.getByRole("listitem");
  const line = lines.filter({ hasText: "Kfz-Steuer" });
  await expect(upcoming.getByLabel("Zeitraum")).toHaveValue("7");
  await expect(upcoming).not.toContainText("Kfz-Steuer");
  await expect(row).not.toContainText("fällig in");

  await upcoming.getByLabel("Zeitraum").selectOption("14");
  await expect(upcoming.getByRole("listitem").filter({ hasText: "Kfz-Steuer" })).toContainText("fällig in 10 Tagen");
  await expect(row).toContainText("fällig in 10 Tagen");
  await expect.poll(() => dueBadge(page)).toBeGreaterThan(before);

  await list.getByRole("group", { name: "Darstellung" }).getByRole("button", { name: "Nur auflisten" }).click();
  await expect(lines.first()).toContainText("Kfz-Steuer");
  await expect(line).toContainText("fällig in 10 Tagen");
  const stored = page.waitForResponse((response) => response.request().method() === "POST");
  await list.getByLabel("Sortieren nach").selectOption("monthly");
  expect((await stored).ok()).toBe(true);
  // Largest monthly amount first, income and expenses in one order.
  await expect(lines.first()).toContainText("Muster GmbH");
  await expect(lines.nth(1)).toContainText(NETFLIX);
  await expect(lines.last()).toContainText("Kfz-Steuer");

  for (const leave of [() => page.reload(), () => page.goto("/").then(() => page.goto("/vertraege"))]) {
    await leave();
    await expect(page.getByRole("region", { name: "Demnächst fällig" }).getByLabel("Zeitraum")).toHaveValue("14");
    await expect(list.getByRole("button", { name: "Nur auflisten" })).toHaveAttribute("aria-pressed", "true");
    await expect(list.getByLabel("Sortieren nach")).toHaveValue("monthly");
    await expect(list.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(lines.first()).toContainText("Muster GmbH");
    await expect(line).toContainText("fällig in 10 Tagen");
  }

  await upcoming.getByLabel("Zeitraum").selectOption("3");
  await expect(upcoming).not.toContainText("Kfz-Steuer");
  await expect(line).not.toContainText("fällig in");
  await expect.poll(() => dueBadge(page)).toBeLessThanOrEqual(before);

  await upcoming.getByLabel("Zeitraum").selectOption("7");
  await list.getByRole("button", { name: "Nach Kategorie" }).click();
  const reset = page.waitForResponse((response) => response.request().method() === "POST");
  await list.getByLabel("Sortieren nach").selectOption("name");
  expect((await reset).ok()).toBe(true);
  await deleteContract(page, "Kfz-Steuer");
});

test("the contract drawer fits the screen at every width and only its body scrolls", async () => {
  const name = "Hausrat-Glas-Elementarschadenversicherung-Vertragsnummer-HR-2026-0042-1337";
  await page.goto("/vertraege");
  const detail = await createContract(page, name, { amount: "17,40", nextDue: inDays(40), payee: `${name}-Beitragskonto` });
  const documents = detail.getByRole("region", { name: "Dokumente" });
  const file = "Versicherungsschein-und-Allgemeine-Versicherungsbedingungen-Hausrat-2026.pdf";
  await documents
    .locator("input[type=file]")
    .setInputFiles({ name: file, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(documents.getByRole("link", { name: `${file} herunterladen` })).toBeVisible();
  await page.reload();
  const drawer = page.getByRole("dialog", { name });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 740 });
    await expectDrawerFits(drawer, `Vertrag bei ${width} px`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await drawer.getByRole("button", { name: "Schließen" }).first().click();

  await page.goto(`/buchungen?q=${encodeURIComponent("Netflix")}`);
  await page.getByRole("row").filter({ hasText: NETFLIX }).first().getByRole("button", { name: NETFLIX }).click();
  const booking = page.getByRole("dialog", { name: "Buchung bearbeiten" });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 740 });
    await expectDrawerFits(booking, `Buchung bei ${width} px`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Escape");
  await page.goto("/vertraege");
  await deleteContract(page, name);
});

test("on a wide screen the top spans the page and the suggestions stand beside the list, on a phone below it", async () => {
  const boxes = async () => {
    const box = async (name: string) => {
      const found = await page.getByRole("region", { name }).boundingBox();
      if (!found) throw new Error(`Bereich ${name} fehlt`);
      return found;
    };
    return {
      list: await box("Alle Verträge"),
      upcoming: await box("Demnächst fällig"),
      totals: await box("Pro Monat"),
      suggestions: await box("Vorschläge"),
    };
  };
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto("/vertraege");
  await page.waitForLoadState("networkidle");
  const wide = await boxes();
  expect(wide.suggestions.x).toBeGreaterThanOrEqual(wide.list.x + wide.list.width);
  expect(Math.abs(wide.suggestions.y - wide.list.y)).toBeLessThan(1);
  for (const top of [wide.upcoming, wide.totals]) {
    expect(top.x).toBe(wide.list.x);
    expect(top.x + top.width).toBeCloseTo(wide.suggestions.x + wide.suggestions.width, 0);
    expect(top.y + top.height).toBeLessThanOrEqual(wide.list.y);
  }
  await expectNoPageScroll(page, "/vertraege breit");

  // Both layouts of the list and the suggestions dialog (with an ignored one) in every theme, light and dark.
  const all = await allSuggestions(page);
  await all.getByRole("button", { name: "HUK-COBURG ignorieren" }).click();
  await expect(all.getByRole("status").filter({ hasText: "„HUK-COBURG“ wird nicht mehr vorgeschlagen." })).toBeVisible();
  await closeSuggestions(page);
  const layout = page.getByRole("region", { name: "Alle Verträge" }).getByRole("group", { name: "Darstellung" });
  const ignored = page.getByRole("region", { name: "Vorschläge" }).getByRole("button", { name: "1 ignorierten anzeigen" });
  const dialog = page.getByRole("dialog", { name: "Alle Vorschläge" });
  for (const theme of THEMES) {
    for (const mode of ["hell", "dunkel"] as const) {
      await setTheme(page, theme, mode);
      await page.goto("/vertraege");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const name of ["Nur auflisten", "Nach Kategorie"]) {
        await layout.getByRole("button", { name }).click();
        await expectNoAxeViolations(page, `/vertraege ${name} (${theme}, ${mode})`);
        await page.screenshot({ path: test.info().outputPath(`vertraege-${theme}-${mode}-${name.replace(" ", "-")}.png`), fullPage: true });
      }
      await ignored.click();
      await expect(dialog.getByRole("heading", { name: "Ignoriert" })).toBeFocused();
      await expectNoAxeViolations(page, `Alle Vorschläge (${theme}, ${mode})`);
      await closeSuggestions(page);
    }
  }
  await ignored.click();
  await dialog.getByRole("button", { name: "HUK-COBURG wiederherstellen" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "„HUK-COBURG“ wird wieder vorgeschlagen." })).toBeVisible();
  await closeSuggestions(page);
  await setTheme(page, "tanne", "hell");

  await page.setViewportSize({ width: 375, height: 740 });
  for (const name of ["Nur auflisten", "Nach Kategorie"]) {
    await page.goto("/vertraege");
    await page.waitForLoadState("networkidle");
    await layout.getByRole("button", { name }).click();
    const narrow = await boxes();
    expect(Math.round(narrow.suggestions.x)).toBe(Math.round(narrow.list.x));
    expect(narrow.suggestions.y).toBeGreaterThan(narrow.list.y + narrow.list.height);
    await expectNoPageScroll(page, `/vertraege einspaltig (${name})`);
    await page.screenshot({ path: test.info().outputPath(`vertraege-375-${name.replace(" ", "-")}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("amounts are green coming in and red going out, balances only red below zero, and hidden amounts stay neutral", async () => {
  await page.goto(`/buchungen?q=${encodeURIComponent("Muster GmbH")}`);
  const salary = page.getByRole("row").filter({ hasText: "Muster GmbH" }).first().locator(".amount");
  await expect(salary).toHaveClass(/\bamount-in\b/);
  await expect(salary).toContainText("+");
  const green = await salary.evaluate((e) => getComputedStyle(e).color);
  await page.goto(`/buchungen?q=${encodeURIComponent("Netflix")}`);
  const streaming = page.getByRole("row").filter({ hasText: NETFLIX }).first().locator(".amount");
  await expect(streaming).toHaveClass(/\bamount-out\b/);
  await expect(streaming).toContainText("−");
  expect(await streaming.evaluate((e) => getComputedStyle(e).color)).not.toBe(green);

  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  const totals = page.getByRole("region", { name: "Summen aller gefilterten Buchungen" });
  await expect(totals.locator(".amount").first()).toHaveClass(/\bamount-in\b/);
  await expect(totals.locator(".amount").nth(1)).toHaveClass(/\bamount-out\b/);

  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  for (const amount of await page.locator("main .account-list .amount").all()) {
    const text = (await amount.textContent()) ?? "";
    if (text.includes("−")) await expect(amount).toHaveClass(/\bamount-out\b/);
    else await expect(amount).not.toHaveClass(/\bamount-(in|out)\b/);
  }

  await page.goto("/buchungen");
  await page.getByRole("button", { name: "Beträge ausblenden" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-amounts", "hidden");
  const masks = await page
    .locator(".amount-in .money, .amount-out .money")
    .evaluateAll((elements) => [...new Set(elements.map((e) => `${getComputedStyle(e).color}|${getComputedStyle(e, "::after").color}`))]);
  expect(masks).toHaveLength(1);
  await page.getByRole("button", { name: "Beträge ausblenden" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-amounts", "hidden");
});

test("the upcoming-charge notification is set up with its days ahead", async () => {
  await page.goto("/persoenlich/benachrichtigungen");
  await expect(page.getByRole("group", { name: "Preisänderung bei wiederkehrenden Zahlungen" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Betrag eines Vertrags geändert" })).toBeVisible();
  const upcoming = page.getByRole("group", { name: "Vertrag demnächst fällig" });
  await expect(upcoming.getByLabel("Tage vorher")).toHaveValue("3");
  await upcoming.getByRole("checkbox", { name: "Benachrichtigen" }).check();
  await upcoming.getByLabel("Tage vorher").fill("5");
  await page.getByRole("button", { name: "Speichern" }).last().click();
  await expect(page.getByRole("status").filter({ hasText: "Benachrichtigungen gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: "Vertrag demnächst fällig" }).getByLabel("Tage vorher")).toHaveValue("5");
  await expect(
    page.getByRole("group", { name: "Vertrag demnächst fällig" }).getByRole("checkbox", { name: "Benachrichtigen" }),
  ).toBeChecked();
});

test("the dashboard period changes every card at once, forecasts next month and persists", async () => {
  await page.goto("/");
  // A new card follows the dashboard; the seeded payee card keeps its own three months.
  await page.getByRole("button", { name: "Bearbeiten" }).click();
  await page.getByRole("button", { name: "Karte hinzufügen" }).click();
  const editor = page.getByRole("dialog", { name: "Karte hinzufügen" });
  await editor.getByRole("radio", { name: /^Empfänger/ }).check();
  await expect(editor.getByLabel("Zeitraum", { exact: true })).toHaveValue("dashboard");
  await editor.getByLabel("Titel", { exact: true }).fill("Empfänger im Zeitraum");
  await editor.getByRole("button", { name: "Karte hinzufügen" }).click();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Dashboard gespeichert." })).toBeVisible();

  const period = page.getByLabel("Zeitraum", { exact: true });
  await expect(period).toHaveValue("this_month");
  await period.selectOption("next_month");
  await expect(page).toHaveURL(/zeitraum=next_month/);
  const summary = page.getByRole("region", { name: "Kennzahlen" });
  await expect(summary).toContainText("Prognose aus Verträgen");
  await expect(summary).toContainText(euro("3.520,00 €"));
  await expect(summary).toContainText(euro("+3.506,01 €"));
  await expect(page.getByRole("region", { name: "Empfänger im Zeitraum" })).toContainText("Keine Daten für die Zukunft.");
  await expect(page.getByRole("region", { name: "Größte Empfänger" })).toContainText("Hausverwaltung");
  await expect(page.getByRole("region", { name: "Ausgaben nach Kategorie" })).toContainText("Prognose aus Verträgen");
  await expect(page.getByRole("region", { name: "Einnahmen & Ausgaben" })).not.toContainText("Prognose");

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: /^Buchungen/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Buchungen" })).toBeVisible();
  await nav.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await expect(page).not.toHaveURL(/zeitraum/);
  await expect(period).toHaveValue("next_month");
  await expect(summary).toContainText("Prognose aus Verträgen");

  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const to = new Date(today.getFullYear(), today.getMonth(), 0);
  await period.selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "Eigener Zeitraum" });
  await dialog.getByLabel("Von").fill(iso(to));
  await dialog.getByLabel("Bis").fill(iso(from));
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await expect(dialog.getByText("Das Ende liegt vor dem Beginn.")).toBeVisible();
  await dialog.getByLabel("Von").fill(iso(from));
  await dialog.getByLabel("Bis").fill(iso(to));
  await expectNoAxeViolations(page, "Eigener Zeitraum");
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /^Eigenen Zeitraum ändern/ })).toBeVisible();
  await expect(summary).not.toContainText("Prognose");

  await page.goto("/");
  await expect(period).toHaveValue("custom");
  await expect(page.getByRole("button", { name: /^Eigenen Zeitraum ändern/ })).toContainText(String(from.getFullYear()));

  const stored = page.waitForResponse((response) => response.request().method() === "POST");
  await period.selectOption("this_month");
  await expect(page).toHaveURL(/zeitraum=this_month/);
  expect((await stored).ok()).toBe(true);
  await page.goto("/");
  await expect(period).toHaveValue("this_month");
});

test("contracts, their dialogs and the forecast pass axe in light and dark mode", async () => {
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/vertraege");
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, `/vertraege (${mode})`);

    await page.getByRole("button", { name: "Vertrag anlegen" }).click();
    const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
    await form.getByLabel("Intervall").selectOption("custom");
    await form.getByRole("button", { name: "Speichern" }).click();
    await expect(form.getByText("Bitte ausfüllen.")).toBeVisible();
    await expectNoAxeViolations(page, `Neuer Vertrag (${mode})`);
    await form.getByRole("button", { name: "Abbrechen" }).click();

    await page.getByRole("region", { name: "Alle Verträge" }).getByRole("button", { name: NETFLIX }).click();
    const detail = page.getByRole("dialog", { name: NETFLIX });
    await expect(detail).toBeVisible();
    await expectNoAxeViolations(page, `Vertrag (${mode})`);
    await detail.getByRole("button", { name: "Bearbeiten" }).click();
    await expect(page.getByRole("dialog", { name: "Vertrag bearbeiten" })).toBeVisible();
    await expectNoAxeViolations(page, `Vertrag bearbeiten (${mode})`);
    await page.getByRole("dialog", { name: "Vertrag bearbeiten" }).getByRole("button", { name: "Abbrechen" }).click();

    await page.goto("/?zeitraum=next_month");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("region", { name: "Kennzahlen" })).toContainText("Prognose aus Verträgen");
    await expectNoAxeViolations(page, `Übersicht nächster Monat (${mode})`);
  }
  await setMode(page, "hell");
});

test("on a phone the pages do not scroll sideways and every field of the forms is usable", async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/vertraege");
  await page.waitForLoadState("networkidle");
  await expectNoPageScroll(page, "/vertraege");
  await allSuggestions(page);
  await expectNoPageScroll(page, "Alle Vorschläge");
  await closeSuggestions(page);

  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await form.getByLabel("Intervall").selectOption("custom");
  await form.getByLabel("Betrag schwankt", { exact: false }).check();
  await form.getByLabel("Betrag schwankt", { exact: false }).uncheck();
  await expectFieldsFit(form, 375);
  await form.getByLabel("Name", { exact: true }).fill("Handyvertrag");
  await form.getByLabel("Betrag in Euro").fill("29,95");
  await form.getByLabel("Abstand in Monaten").fill("2");
  await form.getByLabel("Nächste Fälligkeit").fill(iso(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 15)));
  await form.getByLabel("Empfänger enthält").fill("Telekom");
  await form.getByLabel("Notizen").fill("Kundennummer 4711");
  await form.getByRole("button", { name: "Speichern" }).click();
  const detail = page.getByRole("dialog", { name: "Handyvertrag" });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("alle 2 Monate");
  await expect(detail).toContainText("Kundennummer 4711");
  await detail.getByRole("button", { name: "Schließen" }).first().click();
  await expectNoPageScroll(page, "/vertraege mit drei Verträgen");

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expectNoPageScroll(page, "/");
  await page.getByLabel("Zeitraum", { exact: true }).selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "Eigener Zeitraum" });
  await expectFieldsFit(dialog, 375);
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});
