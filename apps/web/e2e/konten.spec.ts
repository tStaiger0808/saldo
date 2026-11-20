import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";

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
  await login(page);
});

test.afterAll(async () => {
  await page.context().close();
});

test("the accounts overview lists the accounts by group, bank and kind", async () => {
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: "Konten", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Konten" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Gesamtsaldo" })).toContainText("5 Konten");
  const mine = page.getByRole("region", { name: "Meine Konten" });
  await expect(mine.locator("a.account-row")).toHaveCount(4);
  await expect(mine.getByRole("link", { name: new RegExp(ACCOUNT) })).toContainText("IBAN endet auf 2051");

  const grouping = page.getByRole("group", { name: "Gruppieren nach" });
  await grouping.getByRole("button", { name: "Art" }).click();
  await expect(page).toHaveURL(/nach=art/);
  await expect(grouping.getByRole("button", { name: "Art" })).toHaveAttribute("aria-pressed", "true");
  const checking = page.getByRole("region", { name: "Girokonten" });
  await expect(checking.locator("a.account-row")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Kreditkarten" })).toContainText("−");

  const toggle = checking.getByRole("button", { name: "2 Konten" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(checking.getByRole("link")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Girokonten" }).getByRole("button", { name: "2 Konten" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("region", { name: "Girokonten" }).getByRole("button", { name: "2 Konten" }).click();
});

test("a click anywhere on a group header folds the group, while its total and ⋯ menu do not", async () => {
  await page.goto("/konten");
  const mine = page.getByRole("region", { name: "Meine Konten" });
  const head = mine.locator(".account-section-head");
  const toggle = head.getByRole("button", { name: /^Meine Konten \d+ Konten$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("aria-controls", (await mine.getByRole("list").getAttribute("id")) ?? "");
  await expect(mine.locator("a.account-row")).toHaveCount(4);

  const box = (await head.boundingBox()) ?? { width: 0, height: 0 };
  await head.click({ position: { x: box.width / 2, y: box.height - 4 } });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(mine.getByRole("link")).toHaveCount(0);
  await head.click({ position: { x: 6, y: 6 } });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const right = async (locator: ReturnType<Page["locator"]>) => {
    const b = (await locator.boundingBox()) ?? { x: 0, width: 0 };
    return Math.round(b.x + b.width);
  };
  const firstRow = mine.locator(".account-item").first();
  expect(await right(firstRow.getByRole("button", { name: /^Aktionen für / }))).toBe(
    await right(head.getByRole("button", { name: "Aktionen für Meine Konten" })),
  );
  expect(await right(firstRow.locator(".account-row .amount").first())).toBe(await right(head.locator(".account-section-total .amount")));

  await head.locator(".account-section-total").click();
  await head.getByRole("button", { name: "Aktionen für Meine Konten" }).click();
  await expect(page.getByRole("menuitem", { name: "Gruppen verwalten" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(mine.locator("a.account-row")).toHaveCount(4);
});

/** Folds the chart of `card` and checks that only the chart and its controls go, not the figures above it. */
async function foldChart(card: ReturnType<Page["getByRole"]>) {
  const toggle = card.getByRole("button", { name: "Saldoverlauf einklappen" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const body = page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
  await expect(body.getByRole("slider")).toBeVisible();
  await toggle.click();
  await expectChartFolded(card);
}

async function expectChartFolded(card: ReturnType<Page["getByRole"]>) {
  const toggle = card.getByRole("button", { name: "Saldoverlauf ausklappen" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByRole("slider")).toBeHidden();
  await expect(card.getByRole("group", { name: "Zeitraum" })).toBeHidden();
  await expect(card.locator(".timeline-period")).toBeVisible();
  await expect(card.getByText("Eingänge")).toBeVisible();
  await expect(card.getByText("Ausgänge")).toBeVisible();
}

async function unfoldChart(card: ReturnType<Page["getByRole"]>) {
  await card.getByRole("button", { name: "Saldoverlauf ausklappen" }).click();
  await expect(card.getByRole("button", { name: "Saldoverlauf einklappen" })).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("slider")).toBeVisible();
}

/** The page as the server sends it, with only the inline head script running: what shows before hydration. */
async function beforeHydration(path: string, check: (preview: Page) => Promise<void>) {
  const preview = await page.context().newPage();
  await preview.route(/\.m?js(\?.*)?$/, (route) => route.abort());
  await preview.goto(path);
  await check(preview);
  await preview.close();
}

test("the balance chart folds on the overview and on account pages, each remembered across reloads", async () => {
  await page.goto("/konten");
  const total = page.getByRole("region", { name: "Gesamtsaldo" });
  await foldChart(total);
  await expect(total).toContainText("5 Konten");
  await expect(total.locator(".accounts-total-value")).toBeVisible();
  await page.reload();
  await expectChartFolded(total);
  await total.getByRole("heading", { name: "Gesamtsaldo" }).click({ force: true, delay: 200 });
  await expect(total.getByRole("button", { name: "Saldoverlauf einklappen" })).toHaveAttribute("aria-expanded", "true");
  await total.getByRole("heading", { name: "Gesamtsaldo" }).click({ force: true, delay: 200 });
  await expectChartFolded(total);
  await beforeHydration("/konten", async (preview) => {
    await expect(preview.locator(".accounts-total .timeline-period")).toBeVisible();
    await expect(preview.locator(".accounts-total .timeline-body")).toBeHidden();
  });

  await page.getByRole("link", { name: new RegExp(ACCOUNT) }).click();
  const history = page.getByRole("region", { name: "Saldoverlauf" });
  await expect(history.getByRole("button", { name: "Saldoverlauf einklappen" })).toBeVisible();
  await foldChart(history);
  await page.reload();
  await expectChartFolded(history);
  await history.getByRole("heading", { name: "Saldoverlauf" }).click({ force: true, delay: 200 });
  await expect(history.getByRole("button", { name: "Saldoverlauf einklappen" })).toHaveAttribute("aria-expanded", "true");
  await history.getByRole("heading", { name: "Saldoverlauf" }).click({ force: true, delay: 200 });
  await expectChartFolded(history);
  const detail = page.url();
  await beforeHydration(detail, async (preview) => {
    await expect(preview.locator(".timeline-period")).toBeVisible();
    await expect(preview.locator(".timeline-body")).toBeHidden();
  });

  await page.goto("/konten");
  await expectChartFolded(total);
  // Earlier specs may list it in two groups.
  await page
    .getByRole("link", { name: /^ING Extra-Konto/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "ING Extra-Konto" })).toBeVisible();
  await expectChartFolded(page.getByRole("region", { name: "Saldoverlauf" }));

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of ["/konten", detail]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectNoAxeViolations(page, `${path} mit eingeklapptem Verlauf (${mode})`);
    }
  }
  await setMode(page, "hell");
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of ["/konten", detail]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto(detail);
  await unfoldChart(page.getByRole("region", { name: "Saldoverlauf" }));
  await page.goto("/konten");
  await expectChartFolded(total);
  await unfoldChart(total);
  await page.reload();
  await expect(total.getByRole("button", { name: "Saldoverlauf einklappen" })).toHaveAttribute("aria-expanded", "true");
});

test("with motion on, a held click on a section title still folds it", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "no-preference", locale: "de-DE" });
  const moving = await context.newPage();
  await login(moving);
  await moving.goto("/konten");
  await moving.waitForLoadState("networkidle");
  const total = moving.getByRole("region", { name: "Gesamtsaldo" });
  const toggle = total.locator(".fold-toggle");
  const before = await toggle.getAttribute("aria-expanded");
  await total.getByRole("heading", { name: "Gesamtsaldo" }).click({ force: true, delay: 250 });
  await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "");
  await total.getByRole("heading", { name: "Gesamtsaldo" }).click({ force: true, delay: 250 });
  await expect(toggle).toHaveAttribute("aria-expanded", before ?? "");
  await context.close();
});

test("an account opens its detail page with balance, chart and the bookings table with totals", async () => {
  await page.goto("/konten");
  await page.getByRole("link", { name: new RegExp(ACCOUNT) }).click();
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  await expect(page.getByText("DE02 1203 0000 0000 2020 51")).toBeVisible();
  const history = page.getByRole("region", { name: "Saldoverlauf" });
  await expect(history.getByRole("slider")).toBeVisible();
  await expect(history.getByRole("button", { name: "Tabelle" })).toHaveCount(0);

  const bookings = page.getByRole("region", { name: "Buchungen", exact: true });
  // With new bookings the row link opens them only (?neu=true); this test wants all of them.
  await bookings.getByRole("group", { name: "Schnellfilter" }).getByRole("button", { name: /^Alle/ }).click();
  await expect(page).not.toHaveURL(/neu=true/);
  await expect(bookings.getByRole("columnheader")).toHaveText([/^Datum/, "Gegenpartei · Verwendungszweck", /^Betrag/, "Kategorie"]);
  const totals = bookings.getByRole("region", { name: "Summen aller gefilterten Buchungen" });
  await expect(totals).toContainText(/Anzahl\s*\d+/);
  await expect(bookings.getByText(/^50 von \d+ Buchungen$/)).toBeVisible();
  await bookings.getByRole("button", { name: "Mehr laden" }).click();
  await expect(bookings.getByRole("status")).toHaveText("50 weitere Buchungen geladen");
  await expect(bookings.getByText(/^50 von/)).toHaveCount(0);

  await bookings.getByLabel("Suche", { exact: true }).fill("haushalt");
  await bookings.getByRole("button", { name: "Suchen" }).click();
  await expect(page).toHaveURL(/q=haushalt/);
  await expect(bookings.getByRole("button", { name: /Spotify/ })).toHaveCount(0);
  await expect(bookings.getByRole("row").filter({ hasText: "Beitrag Haushalt" }).first()).toContainText("Umbuchung");
  await expect(totals).toContainText("nicht eingerechnet");
  await bookings.getByLabel("Suche", { exact: true }).fill("SPOTIFY");
  await bookings.getByRole("button", { name: "Suchen" }).click();
  await bookings
    .getByRole("button", { name: /Spotify AB/ })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "Buchung bearbeiten" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await expect(page.getByRole("link", { name: "In Buchungen öffnen" })).toHaveAttribute("href", /\/buchungen\?konto=\d+/);
});

test("an unknown account is a 404", async () => {
  await page.goto("/konten/999999");
  await expect(page.getByRole("heading", { level: 1, name: "Seite nicht gefunden" })).toBeVisible();
});

test("scrolling condenses the page head to one line and back", async () => {
  await page.goto("/konten");
  await page.getByRole("link", { name: new RegExp(ACCOUNT) }).click();
  const head = page.locator(".page-head");
  await expect(head).not.toHaveAttribute("data-condensed");
  // The page must be fully laid out before scrolling: a short page never condenses.
  await expect(page.getByRole("region", { name: "Buchungen", exact: true }).locator("tbody tr").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const tall = await head.evaluate((e) => e.getBoundingClientRect().height);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(head).toHaveAttribute("data-condensed", "");
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  await expect(head.getByRole("link", { name: /Alle Konten/ })).toBeVisible();
  expect(await head.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(tall);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(head).not.toHaveAttribute("data-condensed");

  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const left = (selector: string) => head.locator(selector).evaluate((e) => e.getBoundingClientRect().left);
  // On top, themes either stack the eyebrow above the title or set it after it; scrolled, the title always leads.
  expect(await left(".page-title > h1")).toBeLessThanOrEqual(await left(".page-title > .eyebrow"));
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(head).toHaveAttribute("data-condensed", "");
  expect(await left(".page-title > h1")).toBeLessThan(await left(".page-title > .eyebrow"));
  await page.evaluate(() => window.scrollTo(0, 0));
});

test("the accounts pages are keyboard reachable", async () => {
  await page.goto("/konten");
  await page.locator("main").focus();
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.classList.contains("account-row") ?? false);
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Konten");
  const booking = page.locator(".booking-open").first();
  await booking.focus();
  await expect(booking).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Buchung bearbeiten" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(booking).toBeFocused();
});

test("the accounts pages pass axe in light and dark mode and fit a phone screen", async () => {
  await page.goto("/konten");
  const detail = (await page.getByRole("link", { name: new RegExp(ACCOUNT) }).getAttribute("href")) ?? "";
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of ["/konten", "/konten?nach=bank", detail]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1")).toBeVisible();
      await expectNoAxeViolations(page, `${path} (${mode})`);
    }
  }
  await setMode(page, "hell");
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of ["/konten", detail]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
  }
  await page.mouse.wheel(0, 1200);
  await expect(page.getByRole("region", { name: "Summen aller gefilterten Buchungen" })).toBeInViewport();
});
