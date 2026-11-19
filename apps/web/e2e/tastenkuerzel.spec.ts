import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContextOptions, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";
const BOOKING = "HUK-COBURG";

test.describe.configure({ mode: "serial" });

type Platform = "windows" | "mac";

/** Pins what the app reads as the platform, so the hints do not depend on the machine running the tests. */
async function signIn(
  browser: Browser,
  options: BrowserContextOptions = { viewport: { width: 1280, height: 800 } },
  platform: Platform = "windows",
): Promise<Page> {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce", locale: "de-DE", timezoneId: "Europe/Berlin" });
  await context.addInitScript((mac) => {
    Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => (mac ? "MacIntel" : "Win32") });
    Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => undefined });
  }, platform === "mac");
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  return page;
}

async function expectNoAxeViolations(page: Page, label: string, scope = "dialog[open]") {
  const result = await new AxeBuilder({ page }).include(scope).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.evaluate((value) => {
    localStorage.setItem("fw-modus", value);
    (window as { __fwApply?: () => void }).__fwApply?.();
  }, mode);
}

const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await signIn(browser);
});

test.afterAll(async () => {
  await page.context().close();
});

const nav = () => page.getByRole("navigation", { name: "Hauptnavigation" });
const settings = () => page.locator(".shortcut-settings");
const row = (action: string) =>
  settings()
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: action, exact: true }) });
const capture = () => page.getByRole("dialog", { name: /^(Kürzel|Einzeltaste) für/ });

test("the navigation names its shortcuts in aria-keyshortcuts and the tooltip", async () => {
  const konten = nav().getByRole("link", { name: "Konten", exact: true });
  await expect(konten).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+2");
  await expect(konten).toHaveAttribute("title", "Konten (Alt+Umschalt+2)");
  await nav().getByRole("button", { name: "Benutzerkonto" }).click();
  await expect(nav().getByRole("link", { name: "Einstellungen", exact: true })).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+6");
  await page.keyboard.press("Escape");
  const launcher = nav().getByRole("button", { name: /^Suchen oder springen/ });
  await expect(launcher).toHaveAttribute("aria-keyshortcuts", "Control+K");
  await expect(launcher.locator(".nav-kbd")).toHaveText("Strg+K");
  await expect(nav().getByRole("button", { name: "Beträge ausblenden" })).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+H");
  await expect(nav().getByRole("button", { name: "Benachrichtigungen" })).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+N");
  // No bank connection to fetch: the demo accounts are kept by hand, so "Konten abrufen" has no shortcut.
  await page.goto("/konten");
  await expect(page.getByRole("button", { name: "Konten abrufen" })).toHaveCount(0);
});

test("Alt+Shift with a digit opens the pages", async () => {
  await page.keyboard.press("Alt+Shift+Digit3");
  await expect(page).toHaveURL(/\/buchungen/);
  await page.keyboard.press("Alt+Shift+Digit5");
  await expect(page.getByRole("heading", { level: 1, name: "Verträge" })).toBeVisible();
  await page.keyboard.press("Alt+Shift+Digit6");
  await expect(page).toHaveURL(/\/einstellungen/);
  await page.keyboard.press("Alt+Shift+Digit1");
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});

test("Alt+Shift+→ and ← cycle through the top-bar tabs, wrap around and put focus on the content", async () => {
  await page.goto("/");
  await blur(page);
  const main = page.locator("main");
  for (const heading of ["Konten", "Buchungen", "Analyse", "Verträge", "Übersicht"]) {
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(main).toBeFocused();
  }
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(page).toHaveURL(/\/vertraege$/);
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(page).toHaveURL(/\/analyse$/);
  await expect(main).toBeFocused();

  await page.goto("/einstellungen");
  await blur(page);
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});

test("on Buchungen Alt+Shift+S jumps to the search and Alt+Shift+F opens the filters; no shortcut while typing or over a dialog", async () => {
  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  const search = page.locator('.filter-bar input[type="search"]');
  await expect(search).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+S");
  await page.keyboard.press("Alt+Shift+KeyS");
  await expect(search).toBeFocused();
  await page.keyboard.type("Miete");
  await page.keyboard.press("Alt+Shift+Digit1");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(page).toHaveURL(/\/buchungen/);
  await expect(search).toHaveValue("Miete");

  await blur(page);
  await page.keyboard.press("Alt+Shift+KeyF");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Alt+Shift+Digit1");
  await page.keyboard.press("Control+KeyK");
  await expect(page).toHaveURL(/\/buchungen/);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("single keys stay off until turned on under Tastenkürzel; the choice is kept in this browser", async () => {
  await page.goto("/");
  await blur(page);
  await page.keyboard.press("?");
  await page.keyboard.press("3");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();

  // The overview is reachable without single keys from the user menu.
  const userMenu = nav().getByRole("button", { name: "Benutzerkonto" });
  await userMenu.click();
  await nav().getByRole("button", { name: "Tastenkürzel" }).click();
  const overview = page.getByRole("dialog", { name: "Tastenkürzel" });
  await expect(overview).toContainText("Einzeltasten sind ausgeschaltet.");
  const pages = overview.getByRole("table", { name: "Seiten" });
  await expect(
    pages
      .getByRole("row", { name: /Buchungen/ })
      .locator("kbd")
      .first(),
  ).toHaveText("Alt+Umschalt+3");
  await expect(pages.getByRole("row", { name: /Einstellungen/ })).toContainText("Alt+Umschalt+6");
  await expect(pages.getByRole("row", { name: /Nächster Tab/ })).toContainText("Alt+Umschalt+→");
  await expect(pages.getByRole("row", { name: /Vorheriger Tab/ })).toContainText("Alt+Umschalt+←");
  await expect(overview.getByRole("link", { name: "Tastenkürzel anpassen" })).toHaveAttribute("href", "/persoenlich/tastenkuerzel");
  await page.keyboard.press("Escape");
  await expect(overview).toHaveCount(0);
  await expect(userMenu).toBeFocused();

  await page.goto("/persoenlich/tastenkuerzel");
  const setting = page.getByRole("checkbox", { name: "Einzeltasten als Kürzel verwenden" });
  await expect(setting).not.toBeChecked();
  await expect(settings().getByRole("columnheader", { name: "Einzeltaste" })).toHaveCount(0);
  await setting.check();
  await page.reload();
  await expect(setting).toBeChecked();
  await expect(settings().getByRole("columnheader", { name: "Einzeltaste" }).first()).toBeAttached();
  await expect(nav().getByRole("link", { name: "Konten", exact: true })).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+2 2");
  await expect(nav().getByRole("link", { name: "Konten", exact: true })).toHaveAttribute("title", "Konten (Alt+Umschalt+2 oder 2)");

  await blur(page);
  await page.keyboard.press("?");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText("Einzeltasten sind eingeschaltet.");
  await setMode(page, "hell");
  await expectNoAxeViolations(page, "Tastenkürzel hell");
  await setMode(page, "dunkel");
  await expectNoAxeViolations(page, "Tastenkürzel dunkel");
  await setMode(page, "hell");
  await page.keyboard.press("Escape");

  await blur(page);
  await page.keyboard.press("3");
  await expect(page).toHaveURL(/\/buchungen/);
  await page.getByRole("button", { name: "Filtern" }).first().focus();
  await page.keyboard.press("1");
  await expect(page).toHaveURL(/\/$/);
});

test("a single key can be changed only while single keys are on, and takes only a lone character", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  await row("Analyse").getByRole("button", { name: "Einzeltaste für „Analyse“ ändern" }).click();
  const dialog = capture();
  await expect(dialog.getByRole("textbox", { name: "Einzeltaste" })).toBeFocused();
  await page.keyboard.press("Alt+KeyX");
  await expect(dialog).toContainText("Hier zählt nur eine einzelne Zeichentaste ohne Zusatztaste.");
  await page.keyboard.press("x");
  await expect(dialog).toHaveCount(0);
  await expect(settings().getByRole("status")).toHaveText("„Analyse“: X");
  await blur(page);
  await page.keyboard.press("x");
  await expect(page).toHaveURL(/\/analyse$/);

  await page.goto("/persoenlich/tastenkuerzel");
  await row("Analyse").getByRole("button", { name: "„Analyse“ auf Standard zurücksetzen" }).click();
  await expect(row("Analyse").locator("kbd").nth(1)).toHaveText("4");
  await page.getByRole("checkbox", { name: "Einzeltasten als Kürzel verwenden" }).uncheck();
  await expect(row("Analyse").getByRole("button", { name: "Einzeltaste für „Analyse“ ändern" })).toHaveCount(0);
});

test("a shortcut is changed by pressing the new keys and kept after a reload", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  const change = row("Analyse").getByRole("button", { name: "Kürzel für „Analyse“ ändern" });
  await change.click();
  const dialog = capture();
  const field = dialog.getByRole("textbox", { name: "Tastenkombination" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Alt+Umschalt+4");
  await expect(dialog).toContainText("Halte Strg oder Alt (gern auch Umschalt)");
  await setMode(page, "hell");
  await expectNoAxeViolations(page, "Kürzel aufnehmen hell");
  await setMode(page, "dunkel");
  await expectNoAxeViolations(page, "Kürzel aufnehmen dunkel");
  await setMode(page, "hell");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(change).toBeFocused();
  await expect(row("Analyse")).toContainText("Alt+Umschalt+4");

  await change.click();
  await page.keyboard.press("Control+Shift+KeyE");
  await expect(dialog).toHaveCount(0);
  await expect(change).toBeFocused();
  await expect(settings().getByRole("status")).toHaveText("„Analyse“: Strg+Umschalt+E");
  await page.reload();
  await expect(row("Analyse").locator("kbd")).toHaveText("Strg+Umschalt+E");
  const analyse = nav().getByRole("link", { name: "Analyse", exact: true });
  await expect(analyse).toHaveAttribute("aria-keyshortcuts", "Control+Shift+E");
  await expect(analyse).toHaveAttribute("title", "Analyse (Strg+Umschalt+E)");

  await blur(page);
  await page.keyboard.press("Alt+Shift+Digit4");
  await expect(page).toHaveURL(/\/persoenlich\/tastenkuerzel$/);
  await page.keyboard.press("Control+Shift+KeyE");
  await expect(page.getByRole("heading", { level: 1, name: "Analyse" })).toBeVisible();
});

test("reserved combinations and keys without a modifier are refused with a reason", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  const change = row("Verträge").getByRole("button", { name: "Kürzel für „Verträge“ ändern" });
  await change.click();
  const dialog = capture();
  const field = dialog.getByRole("textbox", { name: "Tastenkombination" });
  await page.keyboard.press("Control+KeyC");
  await expect(dialog).toContainText("Diese Kombination brauchst du beim Bearbeiten von Text");
  await expect(field).toHaveValue("Strg+C");
  await page.keyboard.press("Control+Digit1");
  await expect(dialog).toContainText("Diese Kombination nutzt der Browser");
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Tab, Eingabe, Esc und die Leertaste allein brauchst du zum Bedienen der Seite.");
  await page.keyboard.press("KeyV");
  await expect(dialog).toContainText("Ein Kürzel braucht Strg oder Alt (gern auch Umschalt).");
  await page.keyboard.press("Meta+KeyE");
  await expect(dialog).toContainText("Diese Kombination gehört dem Betriebssystem");
  await page.keyboard.press("Control+Alt+KeyE");
  await expect(dialog).toContainText("Strg+Alt ist auf vielen Tastaturen AltGr");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row("Verträge").locator("kbd")).toHaveText("Alt+Umschalt+5");
});

test("keys another action has are offered for a swap; cancelling keeps both", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  const change = row("Analyse").getByRole("button", { name: "Kürzel für „Analyse“ ändern" });
  await change.click();
  const dialog = capture();
  await page.keyboard.press("Alt+Shift+Digit3");
  const warning = "Alt+Umschalt+3 gehört schon zu „Buchungen“. „Tauschen“ gibt „Buchungen“ dafür Strg+Umschalt+E.";
  await expect(dialog).toContainText(warning);
  await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-describedby", /\S+ \S+/);
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(row("Analyse").locator("kbd")).toHaveText("Strg+Umschalt+E");
  await expect(row("Buchungen").locator("kbd")).toHaveText("Alt+Umschalt+3");

  await change.click();
  await page.keyboard.press("Alt+Shift+Digit3");
  await expect(dialog).toContainText(warning);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Tauschen" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(row("Analyse").locator("kbd")).toHaveText("Alt+Umschalt+3");
  await expect(row("Buchungen").locator("kbd")).toHaveText("Strg+Umschalt+E");
  await expect(nav().getByRole("link", { name: /^Buchungen/ })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+E");
});

test("resetting one action offers a swap when its default is taken, and everything can be reset at once", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  await row("Buchungen").getByRole("button", { name: "„Buchungen“ auf Standard zurücksetzen" }).click();
  const dialog = capture();
  await expect(dialog).toContainText("Alt+Umschalt+3 gehört schon zu „Analyse“.");
  await dialog.getByRole("button", { name: "Tauschen" }).click();
  await expect(row("Buchungen").locator("kbd")).toHaveText("Alt+Umschalt+3");
  await expect(row("Analyse").locator("kbd")).toHaveText("Strg+Umschalt+E");

  await row("Analyse").getByRole("button", { name: "Kürzel für „Analyse“ ändern" }).click();
  await page.keyboard.press("Backspace");
  await expect(settings().getByRole("status")).toHaveText("„Analyse“: Kürzel entfernt.");
  await expect(row("Analyse")).toContainText("–");
  await expect(nav().getByRole("link", { name: "Analyse", exact: true })).not.toHaveAttribute("aria-keyshortcuts", /./);

  await settings().getByRole("button", { name: "Alle auf Standard zurücksetzen" }).click();
  await expect(settings().getByRole("status")).toHaveText("Alle Tastenkürzel sind wieder auf Standard.");
  await expect(row("Analyse").locator("kbd")).toHaveText("Alt+Umschalt+4");
  await expect(settings().getByRole("button", { name: /auf Standard zurücksetzen$/ })).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("fw-tastenkuerzel"))).toBeNull();
  await page.reload();
  await expect(row("Analyse").locator("kbd")).toHaveText("Alt+Umschalt+4");
});

test("the shortcut settings pass axe in light and dark mode", async () => {
  await page.goto("/persoenlich/tastenkuerzel");
  await expect(row("Analyse")).toBeVisible();
  await setMode(page, "hell");
  await expectNoAxeViolations(page, "Tastenkürzel-Einstellungen hell", "main");
  await setMode(page, "dunkel");
  await expectNoAxeViolations(page, "Tastenkürzel-Einstellungen dunkel", "main");
  await setMode(page, "hell");
});

test("the search palette opens from the top bar field, lists the shortcuts and finds an account by keyboard", async () => {
  await page.goto("/");
  const launcher = nav().getByRole("button", { name: /^Suchen oder springen/ });
  await launcher.click();
  const palette = page.getByRole("dialog", { name: "Suchen oder springen" });
  const field = palette.getByRole("combobox", { name: "Seiten, Konten, Buchungen oder Aktionen suchen" });
  await expect(field).toBeFocused();
  const list = palette.getByRole("listbox");
  await expect(list.getByRole("group", { name: "Navigation" }).getByRole("option", { name: /Buchungen/ })).toContainText("Alt+Umschalt+3");
  const actions = list.getByRole("group", { name: "Aktionen" });
  await expect(actions.getByRole("option", { name: /Beträge ausblenden/ })).toBeVisible();
  await expect(actions.getByRole("option", { name: /Nächster Tab/ })).toContainText("Alt+Umschalt+→");
  await expect(list.getByRole("option", { name: /Konten abrufen/ })).toHaveCount(0);
  await setMode(page, "hell");
  await expectNoAxeViolations(page, "Suche hell");
  await setMode(page, "dunkel");
  await expectNoAxeViolations(page, "Suche dunkel");
  await setMode(page, "hell");

  await field.fill("girokonto");
  const account = list.getByRole("group", { name: "Konten" }).getByRole("option", { name: new RegExp(ACCOUNT) });
  await expect(account).toBeVisible();
  await expect(palette.locator('[aria-live="polite"]')).toHaveText(/^\d+ Treffer$/);
  await expect(field).toHaveAttribute("aria-activedescendant", (await account.getAttribute("id")) ?? "");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();

  await launcher.click();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test("Ctrl+K opens and closes the palette; a booking is found by the server search and opens Buchungen filtered to it", async () => {
  await page.goto("/");
  await blur(page);
  await page.keyboard.press("Control+KeyK");
  const palette = page.getByRole("dialog", { name: "Suchen oder springen" });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Control+KeyK");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Control+KeyK");
  await page.keyboard.type("HUK");
  const booking = palette
    .getByRole("group", { name: "Buchungen" })
    .getByRole("option", { name: new RegExp(BOOKING) })
    .first();
  await expect(booking).toBeVisible();
  await booking.click();
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/buchungen\?.*q=HUK-COBURG/);
  await expect(page.getByRole("main").getByRole("button", { name: BOOKING }).first()).toBeVisible();

  await blur(page);
  await page.keyboard.press("Control+KeyK");
  await expect(palette).toBeVisible();
  await page.keyboard.type("Analyse");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Analyse" })).toBeVisible();
});

test("on macOS the hints use the symbols ⌃⌥⇧⌘ and ⌘K opens the palette", async ({ browser }) => {
  const mac = await signIn(browser, undefined, "mac");
  try {
    const bar = mac.getByRole("navigation", { name: "Hauptnavigation" });
    const konten = bar.getByRole("link", { name: "Konten", exact: true });
    await expect(konten).toHaveAttribute("title", "Konten (⌥⇧2)");
    await expect(konten).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+2");
    const launcher = bar.getByRole("button", { name: /^Suchen oder springen/ });
    await expect(launcher).toHaveAttribute("aria-keyshortcuts", "Meta+K");
    await expect(launcher.locator(".nav-kbd")).toHaveText("⌘K");

    await mac.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await mac.keyboard.press("Meta+KeyK");
    const palette = mac.getByRole("dialog", { name: "Suchen oder springen" });
    await expect(palette.getByRole("option", { name: /Buchungen/ }).first()).toContainText("⌥⇧3");
    await expect(palette.getByRole("option", { name: /Vorheriger Tab/ })).toContainText("⌥⇧←");
    await mac.keyboard.press("Escape");

    await mac.goto("/persoenlich/tastenkuerzel");
    const settingsCard = mac.locator(".shortcut-settings");
    await expect(settingsCard.getByRole("row").filter({ hasText: "Suchen oder springen" }).locator("kbd")).toHaveText("⌘K");
    await expect(settingsCard.getByRole("row").filter({ hasText: "Nächster Tab" }).locator("kbd")).toHaveText("⌥⇧→");
    await settingsCard.getByRole("button", { name: "Kürzel für „Analyse“ ändern" }).click();
    const dialog = mac.getByRole("dialog", { name: "Kürzel für „Analyse“" });
    await expect(dialog).toContainText("Halte ⌃, ⌥ oder ⌘ (gern auch ⇧)");
    await mac.keyboard.press("Meta+KeyW");
    await expect(dialog).toContainText("Diese Kombination nutzt der Browser");
    await mac.keyboard.press("Control+Alt+KeyE");
    await expect(dialog).toContainText("⌃⌥ ist die Taste von VoiceOver");
    await mac.keyboard.press("Control+Shift+KeyE");
    await expect(dialog).toHaveCount(0);
    await expect(settingsCard.getByRole("status")).toHaveText("„Analyse“: ⌃⇧E");
  } finally {
    await mac.context().close();
  }
});

test("on a 375 px phone the shortcut settings fit the screen and pass axe", async ({ browser }) => {
  const phone = await signIn(browser, { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  try {
    await phone.goto("/persoenlich/tastenkuerzel");
    const card = phone.locator(".shortcut-settings");
    await card.getByRole("checkbox", { name: "Einzeltasten als Kürzel verwenden" }).check();
    await expect(card.getByRole("button", { name: "Einzeltaste für „Analyse“ ändern" })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await expectNoAxeViolations(phone, "Tastenkürzel am Telefon", "main");
    await card.getByRole("button", { name: "Kürzel für „Analyse“ ändern" }).click();
    const dialog = phone.getByRole("dialog", { name: "Kürzel für „Analyse“" });
    const box = await dialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    await expectNoAxeViolations(phone, "Kürzel aufnehmen am Telefon");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await card.getByRole("checkbox", { name: "Einzeltasten als Kürzel verwenden" }).uncheck();
  } finally {
    await phone.context().close();
  }
});

test("on a 375 px phone the palette opens from the menu and fits the screen", async ({ browser }) => {
  const phone = await signIn(browser, { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  try {
    await phone.getByRole("button", { name: "Menü" }).click();
    await phone
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("button", { name: /^Suchen oder springen/ })
      .click();
    const palette = phone.getByRole("dialog", { name: "Suchen oder springen" });
    await expect(palette).toBeVisible();
    await phone.keyboard.type("giro");
    await expect(palette.getByRole("option", { name: new RegExp(ACCOUNT) })).toBeVisible();
    const box = await palette.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await expectNoAxeViolations(phone, "Suche am Telefon");
    await palette.getByRole("button", { name: "Schließen" }).click();
    await expect(palette).toHaveCount(0);
  } finally {
    await phone.context().close();
  }
});
