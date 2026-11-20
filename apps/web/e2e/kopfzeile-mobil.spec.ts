import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContextOptions, expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true };
const THEMES = ["leinen", "leinen-nacht", "tanne", "fjord", "holunder", "schiefer"] as const;

test.describe.configure({ mode: "serial" });

async function newSession(browser: Browser, options: BrowserContextOptions = PHONE) {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE", ...options });
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

async function setLook(page: Page, theme: string, mode: "hell" | "dunkel") {
  await visit(page, "/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption(theme);
  await page.getByLabel("Modus").selectOption(mode);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

/** Title and head buttons share one row, and the head stays as low as a title with its eyebrow. */
async function expectOneRowHead(page: Page, label: string, maxHeight = 110) {
  const head = page.locator(".page-head");
  await expect(head.locator(":scope > .actions"), label).toBeHidden();
  const [title, buttons, height, overflow] = await head.evaluate((el) => {
    const box = (selector: string) => {
      const rect = el.querySelector(selector)?.getBoundingClientRect();
      return rect ? { top: rect.top, bottom: rect.bottom } : null;
    };
    return [
      box("h1"),
      box(".page-head-compact"),
      el.getBoundingClientRect().height,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ] as const;
  });
  expect(overflow, `seitliches Scrollen auf ${label}`).toBeLessThanOrEqual(0);
  expect(height, `Kopfhöhe auf ${label}`).toBeLessThanOrEqual(maxHeight);
  if (title && buttons) {
    expect(buttons.top, `Knöpfe neben dem Titel auf ${label}`).toBeLessThan(title.bottom);
    expect(buttons.bottom, `Knöpfe neben dem Titel auf ${label}`).toBeGreaterThan(title.top);
  }
}

test("on a phone every page head is one row with an icon for the primary action and one ⋯ menu", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await newSession(browser);
  const detail = await (async () => {
    await visit(page, "/konten");
    return (await page.locator("a.account-row").first().getAttribute("href")) ?? "/konten";
  })();
  const heads: [string, string | null, boolean][] = [
    ["/", null, true],
    ["/konten", "Konto hinzufügen", true],
    [detail, null, true],
    ["/buchungen", null, true],
    ["/analyse", null, true],
    ["/vertraege", "Vertrag anlegen", false],
  ];
  for (const [path, primary, overflow] of heads) {
    await visit(page, path);
    await expectOneRowHead(page, path);
    const compact = page.locator(".page-head-compact");
    if (primary) await expect(compact.getByRole("button", { name: primary, exact: true })).toBeVisible();
    await expect(compact.getByRole("button", { name: /^(Weitere Aktionen|Aktionen für .+)$/ })).toHaveCount(overflow ? 1 : 0);
  }

  for (const theme of THEMES) {
    for (const mode of ["hell", "dunkel"] as const) {
      await setLook(page, theme, mode);
      for (const path of ["/konten", "/buchungen"]) {
        await visit(page, path);
        await expectOneRowHead(page, `${path} (${theme}, ${mode})`);
        await page.getByRole("button", { name: "Weitere Aktionen" }).click();
        await expect(page.getByRole("menu", { name: "Weitere Aktionen" })).toBeInViewport({ ratio: 1 });
        await expectNoAxeViolations(page, `${path} mit offenem Menü (${theme}, ${mode})`);
        await page.keyboard.press("Escape");
      }
    }
  }
  await setLook(page, "leinen", "hell");

  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/konten", "/buchungen", "/analyse", "/vertraege", detail]) {
    await visit(page, path);
    await expectOneRowHead(page, `${path} (320 px)`, Number.POSITIVE_INFINITY);
  }
  await page.context().close();
});

test("the ⋯ menu of the accounts page groups by bank and kind, syncs, and the + adds an account", async ({ browser }) => {
  const page = await newSession(browser);
  await visit(page, "/konten");
  const more = page.getByRole("button", { name: "Weitere Aktionen" });
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Weitere Aktionen" });
  const grouping = menu.getByRole("group", { name: "Gruppieren nach" });
  await expect(grouping.getByRole("menuitemradio")).toHaveText(["Gruppen", "Bank", "Art"]);
  await expect(grouping.getByRole("menuitemradio", { name: "Gruppen" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitem").or(menu.getByRole("menuitemradio")).first()).toBeFocused();
  await grouping.getByRole("menuitemradio", { name: "Bank" }).click();
  await expect(page).toHaveURL(/nach=bank/);
  await expect(more).toBeFocused();
  await more.click();
  await expect(grouping.getByRole("menuitemradio", { name: "Bank" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  const add = page.locator(".page-head-compact").getByRole("button", { name: "Konto hinzufügen" });
  const box = await add.boundingBox();
  expect(box && box.width <= 40 && box.height <= 40).toBe(true);
  await add.click();
  await expect(page.getByRole("dialog", { name: "Konto hinzufügen" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();

  // Group head on one line, with a frameless ⋯ that keeps a full target.
  const head = page.locator(".account-section-head").first();
  const lines = await head.evaluate((el) => {
    const tops = [...el.querySelectorAll(".section-title, .section-count, .account-section-total, .action-menu")].map((child) => {
      const rect = child.getBoundingClientRect();
      return Math.round(rect.top + rect.height / 2);
    });
    return Math.max(...tops) - Math.min(...tops);
  });
  expect(lines).toBeLessThanOrEqual(4);
  const groupMore = head.getByRole("button", { name: /^Aktionen für / });
  if ((await groupMore.count()) > 0) {
    expect(await groupMore.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(0, 0, 0, 0)");
    const size = await groupMore.boundingBox();
    expect(size && size.width >= 44 && size.height >= 44).toBe(true);
  }
  const fold = page.getByRole("region", { name: "Gesamtsaldo" }).locator(".fold-toggle");
  expect(await fold.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(0, 0, 0, 0)");
  await page.context().close();
});

test("the ⋯ menu of the bookings exports the CSV and asks before marking everything read; search and filter share a row", async ({
  browser,
}) => {
  const page = await newSession(browser);
  await visit(page, "/buchungen");
  const more = page.getByRole("button", { name: "Weitere Aktionen" });
  await more.click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "CSV exportieren" }).click()]);
  expect(download.suggestedFilename()).toBe("buchungen.csv");

  await more.click();
  await page.getByRole("menuitem", { name: "Alle als gelesen markieren" }).click();
  const confirm = page.getByRole("dialog", { name: /als gelesen markieren\?$/ });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(more).toBeFocused();

  const field = page.getByRole("searchbox", { name: "Suche" });
  const search = page.getByRole("button", { name: "Suchen", exact: true });
  const filter = page.getByRole("button", { name: /^Filtern/ });
  const boxes = await Promise.all([field, search, filter].map((l) => l.boundingBox()));
  const middles = boxes.map((b) => Math.round((b?.y ?? 0) + (b?.height ?? 0) / 2));
  expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2);
  await field.fill("REWE");
  await search.click();
  await expect(page).toHaveURL(/q=REWE/);
  await page.context().close();
});

test("on the desktop the page head keeps its labelled buttons and controls", async ({ browser }) => {
  const page = await newSession(browser, { viewport: { width: 1280, height: 800 } });
  await visit(page, "/buchungen");
  await expect(page.locator(".page-head-compact")).toBeHidden();
  await expect(page.getByRole("link", { name: "CSV exportieren" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Alle als gelesen markieren" })).toBeVisible();
  await visit(page, "/konten");
  await expect(page.getByRole("group", { name: "Gruppieren nach" }).getByRole("button", { name: "Gruppen" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Konto hinzufügen" })).toContainText("Konto hinzufügen");
  await visit(page, "/analyse");
  await expect(page.getByLabel("Zeitraum", { exact: true })).toHaveValue("last_6_months");
  await expect(page.locator(".page-head-summary")).toBeHidden();
  await page.context().close();
});
