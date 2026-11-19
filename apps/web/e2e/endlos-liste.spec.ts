import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";
const NOTE = "Endlos-Liste geprüft";
// Same database as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";

test.describe.configure({ mode: "serial" });

let page: Page;
let detail = "";

async function sql<T>(run: (db: postgres.Sql) => Promise<T>): Promise<T> {
  const db = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

async function expectNoAxeViolations(label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function expectNoHorizontalScroll(label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `seitliches Scrollen auf ${label}`).toBeLessThanOrEqual(0);
}

async function setMode(mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption("tanne");
  await page.getByLabel("Modus").selectOption(mode);
}

const card = () => page.locator("section.bookings-card");
const rows = (list: Locator = card()) => list.locator("tr.booking-row");
const listEnd = (list: Locator = card()) => list.locator(".list-end");
const rowTexts = (list: Locator = card()) => rows(list).evaluateAll((all) => all.map((row) => row.textContent ?? ""));
const totalOf = async () => Number(((await card().getByRole("heading", { level: 2 }).textContent()) ?? "").replace(/\D/g, ""));
const accountList = () => page.getByRole("region", { name: "Buchungen", exact: true });
const history = () => page.getByRole("region", { name: "Saldoverlauf" });

/** "17.08.2026" → "2026-08-17". */
const isoOf = (text: string) => {
  const [day, month, year] = text.trim().split(".");
  return `${year}-${month}-${day}`;
};

async function openBookings(search = "") {
  await page.goto(`/buchungen${search}`);
  await page.waitForLoadState("networkidle");
  await expect(rows().first()).toBeVisible();
}

/** Scrolls the page until the list's end comes into view and waits for the next chunk. */
async function scrollToEnd(list: Locator = card()) {
  const before = await rows(list).count();
  await listEnd(list).scrollIntoViewIfNeeded();
  await expect.poll(() => rows(list).count()).toBeGreaterThan(before);
}

async function openAccount() {
  await page.goto(detail);
  await page.waitForLoadState("networkidle");
  const all = accountList().getByRole("group", { name: "Schnellfilter" }).getByRole("button", { name: /^Alle/ });
  if ((await all.getAttribute("aria-pressed")) !== "true") {
    await all.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await page.waitForLoadState("networkidle");
  }
  await expect(rows(accountList())).toHaveCount(50);
}

test.beforeAll(async ({ browser }) => {
  // A default filter saved by another spec would narrow what these tests scroll through.
  await sql((db) => db`delete from saved_filters`);
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE", viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await page.goto("/konten");
  detail = ((await page.getByRole("link", { name: new RegExp(ACCOUNT) }).getAttribute("href")) ?? "").split("?")[0] ?? "";
});

test.afterAll(async () => {
  await page.context().close();
  await sql((db) => db`update transactions set note = '' where note = ${NOTE}`);
});

test("reaching the end of the bookings loads the next chunk by itself, after the loaded rows", async () => {
  await openBookings();
  expect(await totalOf()).toBeGreaterThan(100);
  await expect(rows()).toHaveCount(50);
  await expect(listEnd()).toHaveText(/^50 von [\d.]+ Buchungen\s*Mehr laden/);
  const first = await rowTexts();

  await scrollToEnd();
  await expect(rows()).toHaveCount(100);
  await expect(listEnd().getByRole("status")).toHaveText("50 weitere Buchungen geladen");
  await expect(listEnd()).toContainText(/^100 von [\d.]+ Buchungen/);
  expect((await rowTexts()).slice(0, 50)).toEqual(first);
  await expect(page).not.toHaveURL(/seite=/);
});

test("scrolled to the end, every matching booking is there once, newest first, and the list says so", async () => {
  await openBookings("?richtung=ein");
  const total = await totalOf();
  while ((await rows().count()) < total) await scrollToEnd();
  await expect(rows()).toHaveCount(total);
  await expect(listEnd()).toHaveText(/^Alle [\d.]+ Buchungen geladen$/);
  await expect(listEnd().getByRole("button", { name: "Mehr laden" })).toHaveCount(0);
  const dates = (await rows().locator("td.booking-date").allTextContents()).map(isoOf);
  expect(dates).toEqual([...dates].sort().reverse());
});

test("'Mehr laden' from the keyboard loads the next chunk and puts focus on its first new row", async () => {
  await openBookings();
  const more = listEnd().getByRole("button", { name: "Mehr laden" });
  await more.focus();
  // With focus on the button the list waits for it instead of loading on its own.
  await page.waitForTimeout(400);
  await expect(rows()).toHaveCount(50);
  await page.keyboard.press("Enter");
  await expect(rows()).toHaveCount(100);
  await expect(rows().nth(50).locator(".booking-open")).toBeFocused();
  await expect(listEnd().getByRole("status")).toHaveText("50 weitere Buchungen geladen");
});

test("a new order or quick filter starts over with the first chunk at the top of the list", async () => {
  await openBookings();
  await scrollToEnd();
  await expect(rows()).toHaveCount(100);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await card()
    .getByRole("columnheader", { name: /^Betrag/ })
    .getByRole("button")
    .evaluate((button: HTMLElement) => button.click());
  await expect(page).toHaveURL(/sortierung=betrag-ab/);
  await expect(rows()).toHaveCount(50);
  await expect(rows().first()).toBeInViewport();

  await scrollToEnd();
  await card()
    .getByRole("group", { name: "Schnellfilter" })
    .getByRole("button", { name: /^Ohne Kategorie/ })
    .click();
  await expect(page).toHaveURL(/ohneKategorie=true/);
  await expect.poll(() => rows().count()).toBeLessThanOrEqual(50);
});

test("saving a booking keeps the loaded rows and the list where it was", async () => {
  await openBookings();
  await scrollToEnd();
  await expect(rows()).toHaveCount(100);
  const row = rows().nth(80);
  await row.scrollIntoViewIfNeeded();
  const before = (await row.boundingBox())?.y ?? Number.NaN;
  const texts = await rowTexts();

  await row.locator(".booking-open").click();
  const drawer = page.getByRole("dialog", { name: "Buchung bearbeiten" });
  await drawer.getByLabel("Notiz").fill(NOTE);
  await drawer.getByRole("button", { name: "Speichern" }).click();
  await expect(drawer).toBeHidden();
  await expect(rows().nth(80)).toContainText(`Notiz: ${NOTE}`);
  await expect(rows()).toHaveCount(100);
  const after = await rowTexts();
  expect(after.filter((text, i) => text !== texts[i])).toHaveLength(1);
  expect(Math.abs(((await rows().nth(80).boundingBox())?.y ?? Number.NaN) - before)).toBeLessThan(4);
});

test("the account's bookings grow inside their own scroll area and still follow the chart", async () => {
  await openAccount();
  const list = accountList();
  const pageTop = await page.evaluate(() => window.scrollY);
  await list.locator(".table-wrap").evaluate((wrap) => {
    wrap.scrollTop = wrap.scrollHeight;
  });
  await expect(rows(list)).toHaveCount(100);
  await expect(list.getByRole("status")).toHaveText("50 weitere Buchungen geladen");
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);

  await list.locator(".table-wrap").evaluate((wrap) => {
    wrap.scrollTop = 0;
  });
  const period = history().locator(".timeline-period");
  const shown = await period.textContent();
  await history().getByRole("button", { name: "früher" }).click();
  await expect(period).not.toHaveText(shown ?? "");
  const marked = list.locator("tr[data-in-window]");
  await expect(marked.first()).toBeVisible();
  await expect
    .poll(() =>
      list.evaluate((section) => {
        const wrap = section.querySelector(".table-wrap");
        const first = wrap?.querySelector("tr[data-in-window]");
        return wrap && first ? Math.abs(Math.round(first.getBoundingClientRect().top - wrap.getBoundingClientRect().top)) : null;
      }),
    )
    .toBe(0);
  expect(await rows(list).count()).toBeGreaterThanOrEqual(100);
});

test("the growing lists pass axe in light and dark mode and fit 375 px", async () => {
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(mode);
    await openBookings();
    await scrollToEnd();
    await expectNoAxeViolations(`/buchungen nach dem Nachladen (${mode})`);
    await openAccount();
    await listEnd(accountList()).getByRole("button", { name: "Mehr laden" }).click();
    await expect(rows(accountList())).not.toHaveCount(50);
    await expectNoAxeViolations(`Kontobuchungen nach dem Nachladen (${mode})`);
  }
  await setMode("hell");
  await page.setViewportSize({ width: 375, height: 740 });
  await openBookings();
  await scrollToEnd();
  await expectNoHorizontalScroll("/buchungen nach dem Nachladen");
  await openAccount();
  await expectNoHorizontalScroll("Kontodetail");
  await page.setViewportSize({ width: 1280, height: 720 });
});
