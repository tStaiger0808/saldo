import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";
// Euro amounts as the German formatter writes them, e.g. "1.234,56 €" or "−12,30 €".
const EURO = /\d[\d.]*,\d{2}\s?€/;

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

const toggle = (page: Page) => page.getByRole("button", { name: "Beträge ausblenden" });

/**
 * Every amount is a bar of one width in a neutral colour, unselectable, chart labels with values are gone, and the
 * accessibility tree names none of them.
 */
async function expectAmountsHidden(page: Page, label: string) {
  await expect(page.locator("html")).toHaveAttribute("data-amounts", "hidden");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  const money = page.locator(".money");
  expect(await money.count(), `Beträge auf ${label}`).toBeGreaterThan(0);
  const styles = await money.evaluateAll((elements) =>
    elements.map((e) => {
      const style = getComputedStyle(e);
      const box = e.getBoundingClientRect();
      return {
        svg: e instanceof SVGElement,
        display: style.display,
        color: style.color,
        select: style.userSelect,
        // Width per font size: the same for every amount, whatever its value.
        ems: e instanceof SVGElement ? 0 : Math.round((box.width / Number.parseFloat(style.fontSize)) * 100) / 100,
        mask: `${getComputedStyle(e, "::after").content}|${getComputedStyle(e, "::after").color}|${getComputedStyle(e, "::after").filter}`,
      };
    }),
  );
  for (const style of styles) {
    if (style.svg) {
      expect(style.display, `Achsenbeschriftung auf ${label}`).toBe("none");
      continue;
    }
    expect(style.color, label).toBe("rgba(0, 0, 0, 0)");
    expect(style.select, label).toBe("none");
    expect(style.ems, label).toBe(5);
    expect(style.mask, label).toMatch(/^"888,88"\|.+\|blur\(/);
  }
  expect(
    new Set(styles.filter((s) => !s.svg).map((s) => s.mask.replace(/blur\([^)]*\)/, "blur"))).size,
    `ein Platzhalter auf ${label}`,
  ).toBe(1);
  const tree = await page.locator("main").ariaSnapshot();
  expect(tree, `Barrierebaum auf ${label}`).not.toMatch(EURO);
  expect(tree).toContain("Betrag verborgen");
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

test("the eye in the top bar hides every amount, on later pages too, and after a reload", async () => {
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page)).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+H");
  expect(await page.locator("main").ariaSnapshot()).toMatch(EURO);

  await toggle(page).click();
  await expectAmountsHidden(page, "/konten");

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: /^Buchungen/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Buchungen" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectAmountsHidden(page, "/buchungen");

  await nav.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("svg text.money").first()).toBeAttached();
  await expectAmountsHidden(page, "/");

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expectAmountsHidden(page, "/ nach dem Neuladen");

  await page.goto("/konten");
  await page.getByRole("link", { name: new RegExp(ACCOUNT) }).click();
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectAmountsHidden(page, "Kontodetail");
});

test("the chart's table view and the analysis hide their amounts as well", async () => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const trend = page.getByRole("region", { name: "Einnahmen & Ausgaben" });
  await trend.getByRole("button", { name: "Tabelle" }).click();
  await expect(trend.getByRole("table")).toContainText("Betrag verborgen");
  await expectAmountsHidden(page, "Tabellenansicht");
  await page.goto("/analyse");
  await page.waitForLoadState("networkidle");
  await expectAmountsHidden(page, "/analyse");
});

test("Alt+Shift+H shows and hides the amounts again", async () => {
  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  const html = page.locator("html");
  await page.keyboard.press("Alt+Shift+KeyH");
  await expect(html).not.toHaveAttribute("data-amounts", "hidden");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".money").first()).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
  expect(await page.locator("main").ariaSnapshot()).toMatch(EURO);
  await page.keyboard.press("Alt+Shift+KeyH");
  await expectAmountsHidden(page, "/buchungen per Tastatur");
});

test("hidden amounts pass axe in light and dark mode", async () => {
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of ["/", "/konten", "/buchungen"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("data-amounts", "hidden");
      await expectNoAxeViolations(page, `${path} (${mode}, Beträge verborgen)`);
    }
  }
  await setMode(page, "hell");
});

test("hidden amounts of any size look alike and keep the layout on desktop and phone", async () => {
  const testInfo = test.info();
  for (const size of [
    { width: 1280, height: 900 },
    { width: 375, height: 740 },
  ]) {
    await page.setViewportSize(size);
    for (const path of ["/konten", "/buchungen", "/"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveAttribute("data-amounts", "hidden");
      await page.screenshot({ path: testInfo.outputPath(`${size.width}${path.replaceAll("/", "_")}-hidden.png`), fullPage: true });
      // Two amounts of different length in the same font draw the same bar.
      const masks = await page
        .locator(".data-table .money, .account-list .money")
        .evaluateAll((elements) =>
          elements.map((e) => ({ text: e.textContent ?? "", font: getComputedStyle(e).fontSize, width: e.getBoundingClientRect().width })),
        );
      for (const font of new Set(masks.map((m) => m.font))) {
        const group = masks.filter((m) => m.font === font);
        const lengths = new Set(group.map((m) => m.text.length));
        const widths = new Set(group.map((m) => Math.round(m.width * 10) / 10));
        if (lengths.size > 1) expect([...widths], `${path} bei ${size.width}px, Schrift ${font}`).toHaveLength(1);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await toggle(page).click();
      await expect(page.locator("html")).not.toHaveAttribute("data-amounts", "hidden");
      await page.screenshot({ path: testInfo.outputPath(`${size.width}${path.replaceAll("/", "_")}-shown.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await toggle(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-amounts", "hidden");
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await toggle(page).click();
});
