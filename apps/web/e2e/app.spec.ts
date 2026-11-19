import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const MEMBER = { username: "kind.e2e", password: "mitglied-passwort-1" };
const GROUP = "E2E Kinder";
const GROUP_ACCOUNT = "ING Extra-Konto";

test.describe.configure({ mode: "serial" });

async function login(page: Page, who: { username: string; password: string }) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(who.username);
  await page.getByLabel("Passwort").fill(who.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
}

async function newSession(browser: Browser, who: { username: string; password: string }) {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
  const page = await context.newPage();
  await login(page, who);
  return page;
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setTheme(page: Page, theme: string, mode: string) {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption(theme);
  await page.getByLabel("Modus").selectOption(mode);
}

let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await newSession(browser, ADMIN);
});

test.afterAll(async () => {
  await admin.context().close();
});

test("an unknown password is rejected and stays on the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill("admin");
  await page.getByLabel("Passwort").fill("falsch-falsch-falsch");
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("alert")).toContainText("stimmt nicht");
});

test("admin creates a group with one account", async () => {
  await admin.goto("/einstellungen/gruppen");
  await admin.getByRole("button", { name: "Gruppe anlegen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Gruppe anlegen" });
  await dialog.getByRole("button", { name: "Gruppe anlegen" }).click();
  await expect(dialog.getByText("Bitte einen Namen eingeben.")).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await dialog.getByLabel("Name").fill(GROUP);
  await dialog.getByLabel(GROUP_ACCOUNT).check();
  await dialog.getByRole("button", { name: "Gruppe anlegen" }).click();
  await expect(admin.getByRole("status").filter({ hasText: `Gruppe „${GROUP}“ angelegt.` })).toBeVisible();
  await expect(admin.getByRole("listitem").filter({ hasText: GROUP })).toContainText(GROUP_ACCOUNT);
});

test("admin creates a member with access to that group", async () => {
  await admin.goto("/einstellungen/benutzer");
  await admin.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Benutzer anlegen" });
  await dialog.getByLabel("Benutzername").fill(MEMBER.username);
  await dialog.getByLabel("Startpasswort").fill("zu-kurz");
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(dialog.getByText("Mindestens 12 Zeichen.", { exact: true })).toBeVisible();
  await dialog.getByLabel("Startpasswort").fill(MEMBER.password);
  await dialog.getByLabel(GROUP).check();
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(admin.getByRole("row").filter({ hasText: MEMBER.username })).toContainText(GROUP);
});

test("row actions open as a keyboard menu, return focus and pass axe in light and dark", async () => {
  await admin.goto("/einstellungen/benutzer");
  await admin.waitForLoadState("networkidle");
  const trigger = admin.getByRole("button", { name: `Aktionen für ${MEMBER.username}` });
  const menu = admin.getByRole("menu", { name: `Aktionen für ${MEMBER.username}` });
  const reset = menu.getByRole("menuitem", { name: "Passwort zurücksetzen" });
  const viewAs = menu.getByRole("menuitem", { name: `Als ${MEMBER.username} ansehen` });
  const remove = menu.getByRole("menuitem", { name: "Löschen" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.focus();
  await admin.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(reset).toBeFocused();
  await admin.keyboard.press("ArrowDown");
  await expect(viewAs).toBeFocused();
  await admin.keyboard.press("ArrowDown");
  await expect(remove).toBeFocused();
  await admin.keyboard.press("ArrowDown");
  await expect(reset).toBeFocused();
  await admin.keyboard.press("End");
  await expect(remove).toBeFocused();
  await admin.keyboard.press("Home");
  await expect(reset).toBeFocused();
  await expectNoAxeViolations(admin, "Aktionsmenü (hell)");
  await admin.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Delete keeps its confirmation, and focus comes back to the menu button afterwards.
  await admin.keyboard.press("ArrowUp");
  await expect(remove).toBeFocused();
  await admin.keyboard.press("Enter");
  const confirm = admin.getByRole("dialog", { name: `Benutzer „${MEMBER.username}“ löschen?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Abbrechen" }).click();
  await expect(confirm).toBeHidden();
  await expect(trigger).toBeFocused();

  await admin.keyboard.press("ArrowDown");
  await expect(reset).toBeFocused();
  await admin.keyboard.press("Tab");
  await expect(menu).toBeHidden();

  await setTheme(admin, "tanne", "dunkel");
  await admin.goto("/einstellungen/benutzer");
  await admin.waitForLoadState("networkidle");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expectNoAxeViolations(admin, "Aktionsmenü (dunkel)");
  await admin.getByRole("heading", { level: 1 }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await setTheme(admin, "tanne", "hell");
});

test("admin edits a booking in the drawer", async () => {
  await admin.goto("/buchungen");
  const row = admin.getByRole("row").filter({ hasText: "Rundfunk ARD ZDF" }).first();
  await row.getByRole("button", { name: "Rundfunk ARD ZDF" }).click();
  const drawer = admin.getByRole("dialog", { name: "Buchung bearbeiten" });
  // No AI provider is set up in this run.
  await expect(drawer.getByRole("button", { name: "Mit KI vorschlagen" })).toHaveCount(0);
  await drawer.getByLabel("Kategorie").selectOption({ label: "Abos & Medien" });
  await drawer.getByLabel("Notiz").fill("Beitrag laut Bescheid");
  await expectNoAxeViolations(admin, "Buchung bearbeiten");
  await drawer.getByRole("button", { name: "Speichern" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Buchung gespeichert." })).toBeVisible();
  const updated = admin.getByRole("row").filter({ hasText: "Rundfunk ARD ZDF" }).first();
  await expect(updated).toContainText("Abos & Medien");
  await expect(updated).toContainText("Kategorie gesetzt: von dir");
  await expect(updated).toContainText("Notiz: Beitrag laut Bescheid");
});

test("rules take a direction in the rule form, the list and the booking drawer, and pass axe", async () => {
  await admin.goto("/einstellungen/regeln");
  await admin.waitForLoadState("networkidle");
  await admin.getByRole("button", { name: "Regel anlegen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Regel anlegen" });
  const direction = dialog.getByLabel("Gilt für");
  await expect(direction).toHaveValue("any");
  await dialog.getByLabel("Enthält den Text").fill("Vodafone");
  await direction.selectOption({ label: "Nur Einnahmen" });
  await dialog.getByRole("button", { name: "Treffer prüfen" }).click();
  await expect(dialog.getByText("0 Buchungen passen")).toBeVisible();
  await direction.selectOption({ label: "Nur Ausgaben" });
  await dialog.getByRole("button", { name: "Treffer prüfen" }).click();
  await expect(dialog.getByText(/[1-9]\d* Buchungen? pass/)).toBeVisible();
  await dialog.getByLabel("Kategorie").selectOption({ label: "Abos & Medien" });
  await expectNoAxeViolations(admin, "Regel anlegen");
  await dialog.getByRole("button", { name: "Regel anlegen" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Regel angelegt" })).toBeVisible();
  await expect(admin.getByRole("row").filter({ hasText: "„Vodafone“" })).toContainText("Nur Ausgaben");

  await admin.goto("/buchungen?q=Vodafone");
  await admin.getByRole("row").filter({ hasText: "Vodafone GmbH" }).first().getByRole("button", { name: "Vodafone GmbH" }).click();
  const drawer = admin.getByRole("dialog", { name: "Buchung bearbeiten" });
  await expect(drawer.getByText("Zurzeit von einer Regel gesetzt")).toBeVisible();
  // Rules are kept in the settings; the drawer only offers the transfer flag, folded under "Erweitert" with its meaning.
  await expect(drawer.getByLabel("Als Regel speichern")).toHaveCount(0);
  const transfer = drawer.getByRole("checkbox", { name: "Übertrag zwischen eigenen Konten" });
  await expect(transfer).toBeHidden();
  await drawer.getByText("Erweitert", { exact: true }).click();
  await expect(transfer).toHaveAccessibleDescription(/zwischen deinen eigenen Konten verschoben/);
  await expectNoAxeViolations(admin, "Buchung mit Erweitert");
  await drawer.getByRole("button", { name: "Abbrechen" }).click();
  await expect(drawer).toBeHidden();
});

test("a click beside the booking drawer closes it, a click inside does not", async () => {
  await admin.goto("/buchungen");
  await admin.getByRole("row").filter({ hasText: "Rundfunk ARD ZDF" }).first().getByRole("button", { name: "Rundfunk ARD ZDF" }).click();
  const drawer = admin.getByRole("dialog", { name: "Buchung bearbeiten" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Notiz").click();
  await expect(drawer).toBeVisible();
  await admin.mouse.click(40, 300);
  await expect(drawer).toBeHidden();
});

test("CSV export link carries the filters and returns a CSV file", async () => {
  await admin.goto("/buchungen?neu=true");
  const link = admin.getByRole("link", { name: "CSV exportieren" });
  await expect(link).toHaveAttribute("href", /\/api\/transactions\/export\.csv\?.*unread=1/);
  const href = (await link.getAttribute("href")) ?? "";
  const response = await admin.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(await response.text()).toContain("Datum;Konto;Empfänger/Auftraggeber");
});

test("theme and mode switch, persist and pass axe in light and dark", async () => {
  await admin.goto("/persoenlich/darstellung");
  await expect(admin.getByLabel("Farbe").locator("option")).toHaveText([
    "Leinen",
    "Leinen Nacht",
    "Tanne",
    "Fjord",
    "Holunder",
    "Schiefer",
  ]);
  const html = admin.locator("html");
  for (const theme of ["leinen", "leinen-nacht", "tanne", "fjord", "holunder", "schiefer"]) {
    for (const mode of ["hell", "dunkel"]) {
      await setTheme(admin, theme, mode);
      await admin.goto("/");
      await expect(html).toHaveAttribute("data-theme", theme);
      await expect(html).toHaveAttribute("data-mode", mode === "dunkel" ? "dark" : "light");
      await expectNoAxeViolations(admin, `Übersicht ${theme}/${mode}`);
    }
  }
  await setTheme(admin, "fjord", "dunkel");
  await admin.reload();
  await expect(html).toHaveAttribute("data-theme", "fjord");
  await expect(html).toHaveAttribute("data-mode", "dark");
  await setTheme(admin, "tanne", "hell");
});

test("a theme stored under its earlier name is applied and stored under its new one", async () => {
  await admin.evaluate(() => localStorage.setItem("fw-theme", "wald"));
  await admin.goto("/persoenlich/darstellung");
  await expect(admin.locator("html")).toHaveAttribute("data-theme", "tanne");
  expect(await admin.evaluate(() => localStorage.getItem("fw-theme"))).toBe("tanne");
  await expect(admin.getByLabel("Farbe")).toHaveValue("tanne");

  await admin.evaluate(() => localStorage.setItem("fw-theme", "unbekannt"));
  await admin.reload();
  await expect(admin.locator("html")).toHaveAttribute("data-theme", "leinen");
  await expect(admin.getByLabel("Farbe")).toHaveValue("leinen");
  await setTheme(admin, "tanne", "hell");
});

test("every page passes axe in light and dark mode", async () => {
  const pages = [
    "/",
    "/buchungen",
    "/analyse",
    "/vertraege",
    "/einstellungen",
    "/einstellungen/gruppen",
    "/konten",
    "/einstellungen/kategorien",
    "/einstellungen/tags",
    "/einstellungen/regeln",
    "/einstellungen/bankverbindungen",
    "/einstellungen/ki",
    "/einstellungen/benutzer",
    "/einstellungen/mcp",
    "/einstellungen/email",
    "/persoenlich",
    "/persoenlich/daten",
    "/persoenlich/benachrichtigungen",
    "/persoenlich/darstellung",
    "/persoenlich/passwort",
  ];
  for (const mode of ["hell", "dunkel"]) {
    await admin.goto("/");
    await setTheme(admin, "tanne", mode);
    for (const path of pages) {
      await admin.goto(path);
      await admin.waitForLoadState("networkidle");
      await expect(admin.locator("h1")).toBeVisible();
      await expectNoAxeViolations(admin, `${path} (${mode})`);
    }
  }
  await setTheme(admin, "tanne", "hell");
});

test("notification settings save, and the bell lists a test notification", async () => {
  await admin.goto("/persoenlich/benachrichtigungen");
  const events = admin.getByRole("form", { name: "Ereignisse" });
  const large = events.getByRole("group", { name: "Große Ausgabe" });
  await large.getByLabel("Benachrichtigen").check();
  await large.getByLabel("Ab Betrag in Euro").fill("abc");
  await events.getByRole("button", { name: "Speichern" }).click();
  await expect(large.getByText("Betrag wie 250 oder 99,90 eingeben.")).toBeVisible();
  await expect(large.getByLabel("Ab Betrag in Euro")).toBeFocused();
  await large.getByLabel("Ab Betrag in Euro").fill("250");
  await events.getByRole("button", { name: "Speichern" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Benachrichtigungen gespeichert." })).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole("group", { name: "Große Ausgabe" }).getByLabel("Ab Betrag in Euro")).toHaveValue("250");

  await admin.getByRole("button", { name: "Testbenachrichtigung senden" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Testbenachrichtigung gespeichert." })).toBeVisible();
  const bell = admin.getByRole("button", { name: /^Benachrichtigungen/ });
  await expect(bell).toContainText("1");
  await bell.click();
  const panel = admin.getByRole("dialog", { name: "Benachrichtigungen" });
  await expect(panel.getByRole("listitem").filter({ hasText: "Testbenachrichtigung" })).toContainText("So sehen Benachrichtigungen");
  await expectNoAxeViolations(admin, "Benachrichtigungen");
  await panel.getByRole("button", { name: "Alle als gelesen markieren" }).click();
  await expect(panel.getByRole("button", { name: "Alle als gelesen markieren" })).toBeDisabled();
  await admin.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(bell).toBeFocused();
  await expect(bell).not.toContainText("1");

  await bell.click();
  await expect(panel.getByRole("link", { name: "Testbenachrichtigung" })).toBeVisible();
  await panel.getByRole("link", { name: "Testbenachrichtigung" }).click();
  await expect(panel).toBeHidden();
  await expect(admin).toHaveURL(/\/persoenlich\/benachrichtigungen$/);
});

test("the chart has a table view and the card editor opens", async () => {
  await admin.goto("/");
  const trend = admin.getByRole("region", { name: "Einnahmen & Ausgaben" });
  await trend.getByRole("button", { name: "Tabelle" }).click();
  await expect(trend.getByRole("table")).toContainText("Monat");
  await admin.getByRole("button", { name: "Bearbeiten" }).click();
  await admin.getByRole("button", { name: "Karte hinzufügen" }).click();
  const editor = admin.getByRole("dialog", { name: "Karte hinzufügen" });
  await expect(editor.getByRole("radio", { name: /Kennzahlen/ })).toBeChecked();
  await expectNoAxeViolations(admin, "Karte hinzufügen");
  await editor.getByRole("button", { name: "Abbrechen" }).click();
  await admin.getByRole("button", { name: "Abbrechen" }).click();
});

test("the quick switcher in the top bar opens with the keyboard and jumps to a page or an account", async () => {
  await admin.goto("/buchungen");
  await admin.waitForLoadState("networkidle");
  const trigger = admin.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: /^Suchen oder springen/ });
  // The device profile's user agent decides the platform, not the machine, so press what the app advertises.
  await expect(trigger).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+K$/);
  const open = `${(await trigger.getAttribute("aria-keyshortcuts"))?.replace(/\+K$/, "")}+KeyK`;
  await admin.locator("main").click({ position: { x: 5, y: 5 } });
  await admin.keyboard.press(open);
  const palette = admin.getByRole("dialog", { name: "Suchen oder springen" });
  const field = palette.getByRole("combobox", { name: "Seiten, Konten, Buchungen oder Aktionen suchen" });
  await expect(field).toBeFocused();
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expectNoAxeViolations(admin, "Schnellsuche");
  await field.fill("vertr");
  const contracts = palette.getByRole("group", { name: "Seiten und Einstellungen" }).getByRole("option").first();
  await expect(contracts).toContainText("Verträge");
  await expect(contracts).toHaveAttribute("aria-selected", "true");
  await admin.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(admin).toHaveURL(/\/vertraege$/);

  await trigger.click();
  await field.fill("girokonto");
  const account = palette.getByRole("group", { name: "Konten" }).getByRole("option").first();
  await expect(account).toHaveAttribute("aria-selected", "true");
  await admin.keyboard.press("ArrowDown");
  await admin.keyboard.press("ArrowUp");
  await expect(account).toHaveAttribute("aria-selected", "true");
  await admin.keyboard.press("Enter");
  await expect(admin).toHaveURL(/\/konten\/\d+/);

  await admin.keyboard.press(open);
  await admin.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("a member sees only the accounts of their group and no admin areas", async ({ browser }) => {
  const member = await newSession(browser, MEMBER);
  // No view picker any more: every page starts with all accounts the person may see.
  await expect(member.getByLabel("Ansicht", { exact: true })).toHaveCount(0);
  const nav = member.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: /Buchungen/ }).click();
  await expect(member.getByRole("heading", { level: 1, name: "Buchungen" })).toBeVisible();
  const accounts = await member.locator(".booking-account").allTextContents();
  expect(accounts.length).toBeGreaterThan(0);
  expect(new Set(accounts)).toEqual(new Set([GROUP_ACCOUNT]));
  await nav.getByRole("button", { name: "Benutzerkonto" }).click();
  await nav.getByRole("link", { name: "Einstellungen", exact: true }).click();
  const sections = member.getByRole("navigation", { name: "Bereiche der Einstellungen" });
  await expect(sections.getByRole("link")).toHaveText([/MCP/]);
  await nav.getByRole("button", { name: "Benutzerkonto" }).click();
  await nav.getByRole("link", { name: "Persönliche Einstellungen" }).click();
  await expect(member).toHaveURL(/\/persoenlich$/);
  const personal = member.getByRole("navigation", { name: "Bereiche der persönlichen Einstellungen" });
  await expect(personal.getByRole("link")).toHaveText([
    /Persönliche Daten/,
    /Benachrichtigungen/,
    /Darstellung/,
    /Tastenkürzel/,
    /Passwort/,
  ]);
  await member.goto("/einstellungen/benutzer");
  await expect(member).toHaveURL(/\/einstellungen$/);
  await member.goto("/");
  await expect(member.getByLabel("Ansicht", { exact: true })).toHaveCount(0);
  await expectNoAxeViolations(member, "Übersicht als Mitglied");
  await member.context().close();
});

test("a member switches the language to English in the personal settings", async ({ browser }) => {
  const member = await newSession(browser, MEMBER);
  await member.goto("/persoenlich/darstellung");
  const language = member.getByLabel("Sprache");
  await expect(language.locator("option").first()).toHaveText("Automatisch (Deutsch)");
  await language.selectOption("en");
  await expect(member.locator("html")).toHaveAttribute("lang", "en");
  const nav = member.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Transactions", exact: false })).toBeVisible();
  await expect(member.getByLabel("Language")).toHaveValue("en");
  await expectNoAxeViolations(member, "appearance in English");
  await member.goto("/");
  await expect(member.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(member.locator("html")).toHaveAttribute("lang", "en");
  await member.goto("/persoenlich/darstellung");
  await member.getByLabel("Language").selectOption("");
  await expect(member.locator("html")).toHaveAttribute("lang", "de");
  await member.context().close();
});

test("the sign-in page follows the browser language and offers no picker", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "fr-FR" });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("heading", { level: 1, name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expectNoAxeViolations(page, "sign-in page in French");
  await context.close();
});
