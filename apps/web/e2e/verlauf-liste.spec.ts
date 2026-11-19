import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";
/** Longer than the chart's settle delay, so a window that would be followed has been. */
const SETTLED_MS = 900;

test.describe.configure({ mode: "serial" });

let page: Page;
let detail = "";

async function expectNoAxeViolations(label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function openDetail(search = "") {
  await page.goto(`${detail}${search}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
  // Other specs may have saved a default filter for account lists; these tests need all bookings.
  const all = bookings().getByRole("group", { name: "Schnellfilter" }).getByRole("button", { name: /^Alle/ });
  if ((await all.getAttribute("aria-pressed")) !== "true") {
    await all.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await page.waitForLoadState("networkidle");
  }
}

const history = () => page.getByRole("region", { name: "Saldoverlauf" });
const bookings = () => page.getByRole("region", { name: "Buchungen", exact: true });
const marked = (list: Locator) => list.locator("tr[data-in-window]");
const period = () => history().locator(".timeline-period");

/** Pixels between the top of the list's scroll area and its first marked row; null without one. */
function markedOffset(list: Locator) {
  return list.evaluate((section) => {
    const wrap = section.querySelector(".table-wrap");
    const row = wrap?.querySelector("tr[data-in-window]");
    if (!wrap || !row) return null;
    return Math.abs(Math.round(row.getBoundingClientRect().top - wrap.getBoundingClientRect().top));
  });
}

const scrollTop = (list: Locator) => list.evaluate((section) => section.querySelector(".table-wrap")?.scrollTop ?? -1);

/** "17.08.2026" → "2026-08-17". */
const isoOf = (text: string) => {
  const [day, month, year] = text.trim().split(".");
  return `${year}-${month}-${day}`;
};

async function panEarlier() {
  const before = await period().textContent();
  await history().getByRole("button", { name: "früher" }).click();
  await expect(period()).not.toHaveText(before ?? "");
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
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
});

test("panning the chart earlier scrolls the booking list to the window's bookings and marks them", async () => {
  await openDetail();
  const list = bookings();
  await expect(list.locator("tr.booking-row").first()).toBeVisible();
  await expect(marked(list)).toHaveCount(0);

  await panEarlier();
  await expect(marked(list).first()).toBeVisible();
  await expect.poll(() => markedOffset(list)).toBe(0);
  expect(await scrollTop(list)).toBeGreaterThan(0);

  // Further back than the first page: the missing bookings are appended, then the list scrolls there.
  const loaded = () => list.locator("tr.booking-row").count();
  await panEarlier();
  await panEarlier();
  await expect.poll(loaded).toBeGreaterThan(50);
  await expect.poll(() => markedOffset(list)).toBe(0);
  await expectNoAxeViolations("booking list following the chart");
});

test("a custom period far back loads its bookings and puts the newest at the top", async () => {
  await openDetail();
  const list = bookings();
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const from = iso(330);
  const to = iso(300);

  await history().getByRole("button", { name: "Eigener" }).click();
  const form = page.getByRole("dialog", { name: "Eigener Zeitraum" });
  await form.getByLabel("Von").fill(from);
  await form.getByLabel("Bis").fill(to);
  await form.getByRole("button", { name: "Anzeigen" }).click();

  await expect(marked(list).first()).toBeVisible();
  await expect.poll(() => markedOffset(list)).toBe(0);
  const dates = (await marked(list).locator("td.booking-date").allTextContents()).map(isoOf);
  for (const date of dates) {
    expect(date >= from && date <= to, `${date} in ${from}…${to}`).toBe(true);
  }
  const before = await marked(list)
    .first()
    .evaluate((row) => row.previousElementSibling?.querySelector("td.booking-date")?.textContent);
  if (before) expect(isoOf(before) > to).toBe(true);
});

test("focus in the list keeps the list where it is", async () => {
  await openDetail();
  const list = bookings();
  const plot = history().getByRole("slider");
  const booking = list.locator(".booking-open").nth(3);
  await booking.focus();
  await plot.scrollIntoViewIfNeeded();
  const top = await scrollTop(list);
  const before = await period().textContent();

  // A horizontal wheel pans the chart without taking focus.
  const box = await plot.boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(-600, 0);
  await expect(period()).not.toHaveText(before ?? "");
  await page.waitForTimeout(SETTLED_MS);

  await expect(booking).toBeFocused();
  expect(await scrollTop(list)).toBe(top);
});

test("sorted by amount, the list does not follow the chart", async () => {
  await openDetail("?sortierung=betrag-ab");
  const list = bookings();
  await expect(list.getByRole("columnheader", { name: /Betrag/ })).toHaveAttribute("aria-sort", "descending");

  await panEarlier();
  await page.waitForTimeout(SETTLED_MS);
  await expect(marked(list)).toHaveCount(0);
  expect(await scrollTop(list)).toBe(0);
});
