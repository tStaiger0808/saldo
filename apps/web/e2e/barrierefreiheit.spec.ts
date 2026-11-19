import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContextOptions, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { startFakeModel } from "./fake-model.ts";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const FAMILY = { username: "familie.a11y", password: "familie-passwort-1" };
const MEMBER = { username: "mitglied.a11y", password: "mitglied-passwort-1" };
const ACCOUNT = "DKB Girokonto";
const PHONE: BrowserContextOptions = { ...devices["iPhone SE (3rd gen)"] };
const PHONE_LARGE: BrowserContextOptions = { ...devices["iPhone 12"], viewport: { width: 390, height: 844 } };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const THEMES = ["tanne", "fjord", "holunder", "schiefer"] as const;
const PAGES = [
  "/",
  "/konten",
  "/buchungen",
  "/analyse",
  "/vertraege",
  "/einstellungen",
  "/einstellungen/gruppen",
  "/einstellungen/kategorien",
  "/einstellungen/tags",
  "/einstellungen/regeln",
  "/einstellungen/bankverbindungen",
  "/einstellungen/ki",
  "/einstellungen/benutzer",
  "/einstellungen/email",
  "/einstellungen/mcp",
  "/einstellungen/protokoll",
  "/persoenlich",
  "/persoenlich/daten",
  "/persoenlich/darstellung",
  "/persoenlich/tastenkuerzel",
  "/persoenlich/passwort",
  "/persoenlich/benachrichtigungen",
];

test.describe.configure({ mode: "serial" });

/** A fresh browser context per person; playwright.config.ts raises SIGN_IN_LIMIT for the many sign-ins from one address. */
async function newSession(
  browser: Browser,
  who: { username: string; password: string },
  options: BrowserContextOptions = DESKTOP,
  prefs: { theme?: string; mode?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    ...options,
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
    [prefs.theme ?? "tanne", prefs.mode ?? "hell"] as const,
  );
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

async function visit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1")).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `seitliches Scrollen auf ${label}`).toBeLessThanOrEqual(0);
}

/**
 * Every visible control in `scope` (default: the open dialog, else the page) offers a touch area of at least `min`
 * pixels; a larger hit area drawn by `::after` counts. Month slots of charts are left out: the table view lists them.
 */
async function expectTouchTargets(page: Page, label: string, min = 44) {
  const small = await page.evaluate((size) => {
    const root = document.querySelector("dialog[open]") ?? document.body;
    const controls = root.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="menuitem"], [role="slider"], [tabindex="0"]',
    );
    const found: string[] = [];
    for (const el of controls) {
      const style = getComputedStyle(el);
      if (el.closest(".visually-hidden, .skip-link, svg") || style.visibility === "hidden") continue;
      let box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const label = (el as HTMLInputElement).labels?.[0];
      if (label && (box.width < 4 || /checkbox|radio/.test((el as HTMLInputElement).type))) box = label.getBoundingClientRect();
      const after = getComputedStyle(el, "::after");
      const hit = after.position === "absolute" && after.content !== "none";
      const width = Math.max(box.width, hit ? Number.parseFloat(after.width) || 0 : 0);
      const height = Math.max(box.height, hit ? Number.parseFloat(after.height) || 0 : 0);
      if (width < size - 0.5 || height < size - 0.5) {
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        found.push(`${el.tagName.toLowerCase()} „${name}“ ${Math.round(width)}×${Math.round(height)}`);
      }
    }
    return found;
  }, min);
  expect.soft(small, `zu kleine Bedienelemente auf ${label}`).toEqual([]);
}

/** The open dialog lies inside the viewport, and its last footer button can be reached by scrolling inside it. */
async function expectDialogFits(page: Page, dialog: Locator, label: string) {
  const size = page.viewportSize();
  const box = await dialog.boundingBox();
  if (!size || !box) throw new Error(`kein Dialog: ${label}`);
  expect(box.x, label).toBeGreaterThanOrEqual(0);
  expect(box.y, label).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, label).toBeLessThanOrEqual(size.width + 0.5);
  expect(box.y + box.height, label).toBeLessThanOrEqual(size.height + 0.5);
  const last = dialog.locator(".dialog-foot .btn, .confirm-dialog-actions .btn").last();
  if ((await last.count()) > 0) await expect(last, `Fußzeile von ${label}`).toBeInViewport();
  await expectNoHorizontalScroll(page, label);
}

async function createUser(page: Page, who: { username: string; password: string }, role?: string) {
  await visit(page, "/einstellungen/benutzer");
  await page.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Benutzer anlegen" });
  await dialog.getByLabel("Benutzername").fill(who.username);
  await dialog.getByLabel("Startpasswort").fill(who.password);
  if (role) await dialog.getByLabel("Rolle").selectOption({ label: role });
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(page.getByRole("row").filter({ hasText: who.username })).toBeVisible();
}

async function accountPath(page: Page): Promise<string> {
  await visit(page, "/konten");
  const link = page.getByRole("link", { name: new RegExp(ACCOUNT) }).first();
  return (await link.getAttribute("href")) ?? "";
}

test("every page passes axe in every colour theme, light and dark", async ({ browser }) => {
  test.setTimeout(600_000);
  for (const theme of THEMES) {
    for (const mode of ["hell", "dunkel"]) {
      const page = await newSession(browser, ADMIN, DESKTOP, { theme, mode });
      for (const path of [...PAGES, await accountPath(page)]) {
        await visit(page, path);
        await expectNoAxeViolations(page, `${path} (${theme}/${mode})`);
      }
      await page.context().close();
    }
  }
});

/** Relative luminance of the background colours of `selectors`, 0 (black) to 1 (white). */
async function backgroundLuminance(page: Page, selectors: string[]): Promise<number[]> {
  return page.evaluate(
    (list) =>
      list.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`fehlt: ${selector}`);
        const channels = (getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const [r, g, b] = channels.map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
      }),
    selectors,
  );
}

test("Leinen Nacht keeps the page light under a dark top bar, and its bar and menus pass axe", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const mode of ["hell", "dunkel"] as const) {
    for (const [device, size] of [
      [DESKTOP, "Desktop"],
      [PHONE, "375 px"],
    ] as const) {
      const page = await newSession(browser, ADMIN, device, { theme: "leinen-nacht", mode });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "leinen-nacht");
      const [bar, ground] = await backgroundLuminance(page, [".topbar", "body"]);
      expect(bar, `Kopfleiste (${mode})`).toBeLessThan(0.05);
      if (mode === "hell") expect(ground, "Seite (hell)").toBeGreaterThan(0.8);
      else expect(ground, "Seite (dunkel)").toBeLessThan(0.05);

      for (const path of ["/", "/konten", "/buchungen", "/persoenlich/darstellung"]) {
        await visit(page, path);
        await expectNoAxeViolations(page, `${path} (Leinen Nacht, ${mode}, ${size})`);
      }
      if (device === PHONE) {
        await page.getByRole("button", { name: "Menü" }).click();
        await expect(page.locator("#hauptmenue")).toBeVisible();
        await expectNoAxeViolations(page, `Hauptmenü (Leinen Nacht, ${mode})`);
        await page.keyboard.press("Escape");
      }
      await page.getByRole("button", { name: "Benutzerkonto" }).click();
      await expect(page.getByRole("link", { name: "Persönliche Einstellungen" })).toBeVisible();
      await expectNoAxeViolations(page, `Benutzermenü (Leinen Nacht, ${mode}, ${size})`);
      await page.keyboard.press("Escape");
      await page.context().close();
    }
  }
});

test("family admins and members pass axe on their pages, and the 404 page too", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await createUser(admin, FAMILY, "Familien-Admin");
  await createUser(admin, MEMBER);
  await admin.context().close();

  for (const [who, pages] of [
    [
      FAMILY,
      [
        "/",
        "/konten",
        "/buchungen",
        "/einstellungen/gruppen",
        "/einstellungen/regeln",
        "/einstellungen/benutzer",
        "/einstellungen/bankverbindungen",
      ],
    ],
    [MEMBER, ["/", "/konten", "/buchungen", "/analyse", "/vertraege", "/einstellungen", "/einstellungen/mcp", "/persoenlich/daten"]],
  ] as const) {
    for (const mode of ["hell", "dunkel"]) {
      const page = await newSession(browser, who, DESKTOP, { mode });
      for (const path of pages) {
        await visit(page, path);
        await expectNoAxeViolations(page, `${path} als ${who.username} (${mode})`);
      }
      await page.goto("/konten");
      await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
      await expect(page.getByRole("dialog", { name: "Konto hinzufügen" })).toBeVisible();
      await expectNoAxeViolations(page, `Konto hinzufügen als ${who.username} (${mode})`);
      await page.keyboard.press("Escape");
      await page.goto("/gibt-es-nicht");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoAxeViolations(page, `404 (${mode})`);
      await page.context().close();
    }
  }
});

test("the keyboard reaches the content, the charts and keeps its place when a row goes away", async ({ browser }) => {
  const page = await newSession(browser, ADMIN);
  await visit(page, "/buchungen");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Zum Inhalt springen" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("main")).toContainText(await page.evaluate(() => document.activeElement?.textContent ?? ""));

  // A month chart is one tab stop; the arrow keys walk through the months.
  await visit(page, "/");
  const trend = page.getByRole("region", { name: "Einnahmen & Ausgaben" });
  const slots = trend.locator("svg [role=img]");
  await expect(trend.locator('svg [role=img][tabindex="0"]')).toHaveCount(1);
  await slots.last().focus();
  const last = await slots.last().getAttribute("aria-label");
  await page.keyboard.press("ArrowLeft");
  await expect(slots.nth((await slots.count()) - 2)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(slots.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(slots.last()).toHaveAttribute("aria-label", last ?? "");
  await expect(slots.last()).toBeFocused();

  // Alt+Shift+H toggles hidden amounts, but not while typing.
  await visit(page, "/buchungen");
  const toggle = page.getByRole("button", { name: "Beträge ausblenden" });
  await page.getByLabel("Suche").focus();
  await page.keyboard.press("Alt+Shift+KeyH");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // After a deletion confirmed from the keyboard, focus stays in the list instead of falling back to the page.
  await visit(page, "/einstellungen/tags");
  await page.getByRole("button", { name: "Tag anlegen" }).click();
  const create = page.getByRole("dialog", { name: "Tag anlegen" });
  await create.getByLabel("Name", { exact: true }).fill("Wegwerf-Tag");
  await create.getByRole("button", { name: "Tag anlegen" }).click();
  const menu = page.getByRole("button", { name: "Aktionen für Wegwerf-Tag" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Löschen" }).focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: /Wegwerf-Tag/ });
  await confirm.getByRole("button", { name: "Löschen" }).focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await page.context().close();
});

test("text spacing, 200 % zoom and 320 px reflow keep every page readable without sideways scrolling", async ({ browser }) => {
  const page = await newSession(browser, ADMIN, { viewport: { width: 640, height: 800 }, deviceScaleFactor: 2 });
  const path = await accountPath(page);
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const target of [...PAGES, path]) {
      await visit(page, target);
      await page.addStyleTag({
        content:
          "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
      });
      await expectNoHorizontalScroll(page, `${target} (${width} px, Textabstände)`);
    }
  }
  await page.context().close();
});

test("on phones nothing scrolls sideways, every control is 44 px and dialogs and menus fit", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const [device, name] of [
    [PHONE, "375 × 667"],
    [PHONE_LARGE, "390 × 844"],
  ] as const) {
    const page = await newSession(browser, ADMIN, device);
    const detail = await accountPath(page);
    for (const path of [...PAGES, detail]) {
      await visit(page, path);
      await expectNoHorizontalScroll(page, `${path} (${name})`);
      await expectTouchTargets(page, `${path} (${name})`);
    }
    await expectNoAxeViolations(page, `Konto (${name})`);
    // The timeline pans sideways only; vertical swipes scroll the page.
    expect(await page.locator(".timeline-plot").evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");

    await visit(page, "/");
    await page.getByRole("button", { name: "Menü" }).click();
    await expect(page.locator("#hauptmenue")).toBeVisible();
    await expectTouchTargets(page, `Hauptmenü (${name})`);
    await expectNoAxeViolations(page, `Hauptmenü (${name})`);
    await page.keyboard.press("Escape");

    await visit(page, "/konten");
    await page
      .getByRole("button", { name: `Aktionen für ${ACCOUNT}` })
      .first()
      .click();
    // On a phone the "⋯" button opens the account's action sheet.
    const sheet = page.getByRole("dialog", { name: ACCOUNT });
    await expect(sheet).toBeInViewport({ ratio: 1 });
    await expectTouchTargets(page, `Kontoaktionen (${name})`);
    await page.keyboard.press("Escape");

    const dialogs: [string, string, () => Promise<void>][] = [
      ["/konten", "Konto hinzufügen", () => page.getByRole("button", { name: "Konto hinzufügen" }).first().click()],
      ["/buchungen", "Buchungen filtern", () => page.getByRole("button", { name: /^Filtern/ }).click()],
      ["/buchungen", "Buchung bearbeiten", () => page.locator(".booking-open").first().click()],
      ["/einstellungen/regeln", "Regel anlegen", () => page.getByRole("button", { name: "Regel anlegen" }).click()],
      ["/einstellungen/kategorien", "Kategorie anlegen", () => page.getByRole("button", { name: "Kategorie anlegen" }).click()],
      ["/einstellungen/benutzer", "Benutzer anlegen", () => page.getByRole("button", { name: "Benutzer anlegen" }).click()],
      ["/einstellungen/ki", "KI-Anbieter hinzufügen", () => page.getByRole("button", { name: "Anbieter hinzufügen" }).click()],
      ["/vertraege", "Neuer Vertrag", () => page.getByRole("button", { name: "Vertrag anlegen" }).click()],
      ["/", "Neues Dashboard", () => page.getByRole("button", { name: "Neues Dashboard" }).click()],
    ];
    for (const [path, title, open] of dialogs) {
      await visit(page, path);
      await open();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expectDialogFits(page, dialog, `${title} (${name})`);
      await expectTouchTargets(page, `${title} (${name})`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    await page.context().close();
  }
});

test("viewing as a member on a phone, dark and with hidden amounts, keeps every page usable", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN, PHONE, { theme: "holunder", mode: "dunkel" });
  await visit(admin, "/einstellungen/benutzer");
  await admin.getByRole("button", { name: `Aktionen für ${MEMBER.username}` }).click();
  await admin.getByRole("menuitem", { name: `Als ${MEMBER.username} ansehen` }).click();
  const banner = admin.locator(".impersonation-bar");
  await expect(banner).toBeVisible();
  await admin.getByRole("button", { name: "Beträge ausblenden" }).click();
  for (const path of ["/", "/konten", "/buchungen", "/analyse", "/vertraege", "/einstellungen/mcp", "/persoenlich/daten"]) {
    await visit(admin, path);
    await expect(banner).toBeVisible();
    await expect(admin.locator("html")).toHaveAttribute("data-amounts", "hidden");
    await expectNoHorizontalScroll(admin, `${path} beim Ansehen`);
    await expectTouchTargets(admin, `${path} beim Ansehen`);
    await expectNoAxeViolations(admin, `${path} beim Ansehen (375 px, dunkel, Beträge verborgen)`);
  }
  await admin.getByRole("button", { name: "Beträge ausblenden" }).click();
  await banner.getByRole("button", { name: "Ansehen beenden" }).click();
  await expect(banner).toHaveCount(0);
  await admin.context().close();
});

test("at 375 px the personal settings can be filled in and saved", async ({ browser }) => {
  const page = await newSession(browser, MEMBER, PHONE);
  await visit(page, "/persoenlich/daten");
  await page.getByLabel("Anzeigename").fill("Mitglied Barrierefrei");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Name gespeichert." })).toBeVisible();

  await visit(page, "/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption("fjord");
  await page.getByLabel("Modus").selectOption("dunkel");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fjord");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expectNoAxeViolations(page, "Darstellung dunkel (375 px)");
  await page.getByLabel("Modus").selectOption("hell");

  await visit(page, "/persoenlich/benachrichtigungen");
  const events = page.getByRole("form", { name: "Ereignisse" });
  const large = events.getByRole("group", { name: "Große Ausgabe" });
  await large.getByLabel("Benachrichtigen").check();
  await large.getByLabel("Ab Betrag in Euro").fill("120");
  await events.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Benachrichtigungen gespeichert." })).toBeVisible();
  await expectNoHorizontalScroll(page, "Benachrichtigungen");

  await visit(page, "/persoenlich/passwort");
  await page.getByLabel("Bisheriges Passwort").fill(MEMBER.password);
  await page.getByLabel("Neues Passwort", { exact: true }).fill(`${MEMBER.password}-neu`);
  await page.getByLabel("Neues Passwort wiederholen").fill(`${MEMBER.password}-neu`);
  await page.getByRole("button", { name: /ändern|Speichern/ }).click();
  await expect(page.getByText("Passwort geändert.")).toBeVisible();
  await page.context().close();
});

test("at 375 px the admin forms can be filled in and saved", async ({ browser }) => {
  test.setTimeout(180_000);
  const model = await startFakeModel((_body, send) => send({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  const page = await newSession(browser, ADMIN, PHONE);
  const status = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

  await visit(page, "/einstellungen/kategorien");
  await page.getByRole("button", { name: "Kategorie anlegen" }).click();
  const category = page.getByRole("dialog", { name: "Kategorie anlegen" });
  await category.getByLabel("Name", { exact: true }).fill("Handy-Kategorie");
  await category.getByRole("button", { name: "Kategorie anlegen" }).click();
  await expect(status("Kategorie „Handy-Kategorie“ angelegt.")).toBeVisible();

  await visit(page, "/einstellungen/tags");
  await page.getByRole("button", { name: "Tag anlegen" }).click();
  const tag = page.getByRole("dialog", { name: "Tag anlegen" });
  await tag.getByLabel("Name", { exact: true }).fill("Handy-Tag");
  await tag.getByRole("button", { name: "Tag anlegen" }).click();
  await expect(status(/Tag „Handy-Tag“/)).toBeVisible();

  await visit(page, "/einstellungen/regeln");
  await page.getByRole("button", { name: "Regel anlegen" }).click();
  const rule = page.getByRole("dialog", { name: "Regel anlegen" });
  await rule.getByLabel("Enthält den Text").fill("handy-regel-gibt-es-nicht");
  await rule.getByLabel("Kategorie").selectOption({ label: "Handy-Kategorie" });
  await rule.getByLabel("Handy-Tag").check();
  await rule.getByRole("button", { name: "Treffer prüfen" }).click();
  await expect(rule.getByText("0 Buchungen passen")).toBeVisible();
  await rule.getByRole("button", { name: "Regel anlegen" }).click();
  await expect(status("Regel angelegt")).toBeVisible();

  await visit(page, "/einstellungen/benutzer");
  await page.getByRole("button", { name: "Benutzer anlegen" }).click();
  const user = page.getByRole("dialog", { name: "Benutzer anlegen" });
  await user.getByLabel("Benutzername").fill("handy.a11y");
  await user.getByLabel("Startpasswort").fill("handy-passwort-123");
  await user.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(page.getByRole("row").filter({ hasText: "handy.a11y" })).toBeVisible();

  await visit(page, "/einstellungen/ki");
  await page.getByRole("button", { name: "Anbieter hinzufügen" }).click();
  const add = page.getByRole("dialog", { name: "KI-Anbieter hinzufügen" });
  await add.getByLabel("Anbieter", { exact: true }).selectOption({ label: "Eigene Adresse" });
  await add.getByLabel("Name", { exact: true }).fill("Handy-KI");
  await add.getByLabel("Adresse", { exact: true }).fill(model.url);
  await expectDialogFits(page, add, "KI-Anbieter hinzufügen");
  await add.getByRole("button", { name: "Hinzufügen und testen" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("button", { name: "Aktionen für Handy-KI" }).click();
  await page.getByRole("menuitem", { name: "Löschen" }).click();
  await page
    .getByRole("dialog", { name: /Handy-KI/ })
    .getByRole("button", { name: "Löschen" })
    .click();
  await expect(page.getByRole("button", { name: "Aktionen für Handy-KI" })).toHaveCount(0);

  await visit(page, "/buchungen");
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const filter = page.getByRole("dialog", { name: "Buchungen filtern" });
  await filter.getByLabel("Zeitraum").selectOption({ label: "Eigener Zeitraum" });
  await filter.getByLabel("Von").fill("2026-01-01");
  await filter.getByLabel("Bis").fill("2026-03-31");
  await filter.getByLabel("Umbuchungen ausblenden").check();
  await filter.getByRole("button", { name: "Anwenden" }).click();
  await expect(page.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem")).toHaveCount(2);
  await expectNoHorizontalScroll(page, "Buchungen mit Filtern");

  await visit(page, "/");
  await page.getByLabel("Zeitraum", { exact: true }).selectOption("custom");
  const range = page.getByRole("dialog", { name: "Eigener Zeitraum" });
  await range.getByLabel("Von").fill("2026-01-01");
  await range.getByLabel("Bis").fill("2026-03-31");
  await range.getByRole("button", { name: "Übernehmen" }).click();
  await expect(range).toBeHidden();
  await expect(page.getByRole("button", { name: /^Eigenen Zeitraum ändern/ })).toBeVisible();
  await page.getByLabel("Zeitraum", { exact: true }).selectOption("this_month");

  await visit(page, "/vertraege");
  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const contract = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await contract.getByLabel("Name", { exact: true }).fill("Handy-Vertrag");
  await contract.getByLabel("Betrag in Euro").fill("9,99");
  await contract.getByLabel("Nächste Fälligkeit").fill(`${new Date().getFullYear() + 1}-01-15`);
  await contract.getByLabel("Empfänger enthält").fill("handy-vertrag-gibt-es-nicht");
  await contract.getByRole("button", { name: "Speichern" }).click();
  const saved = page.getByRole("dialog", { name: "Handy-Vertrag" });
  await expect(saved).toBeVisible();
  await expectDialogFits(page, saved, "Vertrag");
  await saved.getByRole("button", { name: "Löschen" }).click();
  await page
    .getByRole("dialog", { name: /Handy-Vertrag.*löschen/ })
    .getByRole("button", { name: "Löschen" })
    .click();
  await expect(saved).toBeHidden();

  await visit(page, "/konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).first().click();
  await page.getByRole("dialog", { name: "Konto hinzufügen" }).getByRole("button", { name: "Manuelles Konto" }).click();
  const manual = page.getByRole("dialog", { name: "Manuelles Konto anlegen" });
  await manual.getByLabel("Name", { exact: true }).fill("Handy-Kasse");
  await manual.getByLabel("Art").selectOption({ label: "Prepaid- oder Gutscheinkarte" });
  await expectDialogFits(page, manual, "Manuelles Konto");
  await manual.getByRole("button", { name: "Konto anlegen" }).click();
  await expect(manual).toBeHidden();
  // On a phone the "⋯" button opens the account's action sheet.
  const actions = page.getByRole("button", { name: "Aktionen für Handy-Kasse" });
  const sheet = page.getByRole("dialog", { name: "Handy-Kasse", exact: true });
  await actions.click();
  await sheet.getByRole("button", { name: "Saldo eintragen …" }).click();
  const balance = page.getByRole("dialog", { name: "Saldo von „Handy-Kasse“ eintragen" });
  await balance.getByLabel("Kontostand").fill("42,50");
  await expectDialogFits(page, balance, "Saldo eintragen");
  await balance.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".account-item").filter({ hasText: "Handy-Kasse" })).toContainText("42,50");
  await actions.click();
  await sheet.getByRole("button", { name: "CSV importieren …" }).click();
  const csv = page.getByRole("dialog", { name: "CSV in „Handy-Kasse“ importieren" });
  await csv.getByRole("button", { name: "Importieren" }).click();
  await expect(csv.getByText("Bitte eine CSV-Datei wählen.")).toBeVisible();
  await expect(csv.getByLabel("Datei")).toBeFocused();
  await csv
    .getByLabel("Datei")
    .setInputFiles({ name: "kasse.csv", mimeType: "text/csv", buffer: Buffer.from("Datum;Händler;Betrag\n05.11.2026;Bäckerei;-4,80\n") });
  await expect(csv.getByText("Vorschau: 1 Buchung erkannt")).toBeVisible();
  await expectDialogFits(page, csv, "CSV-Import");
  await csv.getByRole("button", { name: "Importieren" }).click();
  await expect(status(/Import fertig: 1 neu/)).toBeVisible();
  await actions.click();
  await sheet.getByRole("button", { name: "Löschen" }).click();
  await page
    .getByRole("dialog", { name: /Handy-Kasse/ })
    .getByRole("button", { name: /löschen/i })
    .click();
  await expect(actions).toHaveCount(0);

  // The settings made here are removed again, so later suites see the demo data unchanged.
  for (const [path, name] of [
    ["/einstellungen/regeln", "handy-regel-gibt-es-nicht"],
    ["/einstellungen/tags", "Handy-Tag"],
    ["/einstellungen/kategorien", "Handy-Kategorie"],
  ] as const) {
    await visit(page, path);
    const row = page
      .getByRole("row")
      .filter({ hasText: name })
      .or(page.getByRole("listitem").filter({ hasText: name }));
    const remove = row.getByRole("button", { name: /^Löschen/ });
    if ((await remove.count()) > 0) await remove.first().click();
    else {
      await page.getByRole("button", { name: `Aktionen für ${name}` }).click();
      await page.getByRole("menuitem", { name: "Löschen" }).click();
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /löschen/i })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.context().close();
  await model.close();
});
