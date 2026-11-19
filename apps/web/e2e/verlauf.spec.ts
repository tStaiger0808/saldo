import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const ACCOUNT = "DKB Girokonto";

test.describe.configure({ mode: "serial" });

let page: Page;
let detail = "";

async function expectNoAxeViolations(label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setMode(mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption("tanne");
  await page.getByLabel("Modus").selectOption(mode);
}

async function openDetail() {
  await page.goto(detail);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: ACCOUNT })).toBeVisible();
}

const history = () => page.getByRole("region", { name: "Saldoverlauf" });
const chart = (region: Locator) => region.getByRole("slider");
const period = (region: Locator) => region.locator(".timeline-period");
const sums = (region: Locator) => region.locator(".timeline-sums");

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    locale: "de-DE",
  });
  page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
  await page.goto("/konten");
  detail = (await page.getByRole("link", { name: new RegExp(ACCOUNT) }).getAttribute("href")) ?? "";
});

test.afterAll(async () => {
  await page.context().close();
});

test("dragging the balance chart pans back in time and the header sums follow", async () => {
  await openDetail();
  const region = history();
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "true");
  await expect(region.getByRole("button", { name: "später" })).toHaveAttribute("aria-disabled", "true");
  const before = { period: await period(region).textContent(), sums: await sums(region).textContent() };

  const box = await chart(region).boundingBox();
  if (!box) throw new Error("no chart");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 5 });
  await page.mouse.up();

  await expect(period(region)).not.toHaveText(before.period ?? "");
  await expect(sums(region)).not.toHaveText(before.sums ?? "");
  await expect(region.getByRole("button", { name: "später" })).not.toHaveAttribute("aria-disabled", "true");
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "false");
  await expect(region.getByRole("status")).toContainText(/Saldo von .* auf .*, Eingänge .*, Ausgänge/);
});

test("buttons, presets and keys pan and zoom the window", async () => {
  await openDetail();
  const region = history();
  const plot = chart(region);
  const year = String(new Date().getFullYear());

  await region.getByRole("button", { name: "1 Jahr" }).click();
  await expect(region.getByRole("button", { name: "1 Jahr" })).toHaveAttribute("aria-pressed", "true");
  await expect(period(region)).toContainText(String(Number(year) - 1));
  const yearView = await plot.getAttribute("aria-valuetext");

  await region.getByRole("button", { name: "Hineinzoomen" }).click();
  await expect(plot).not.toHaveAttribute("aria-valuetext", yearView ?? "");
  await expect(region.getByRole("button", { name: "1 Jahr" })).toHaveAttribute("aria-pressed", "false");
  await region.getByRole("button", { name: "Herauszoomen" }).click();
  await expect(plot).toHaveAttribute("aria-valuetext", yearView ?? "");

  await region.getByRole("button", { name: "3 Monate" }).click();
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "true");
  const recent = (await plot.getAttribute("aria-valuetext")) ?? "";
  await region.getByRole("button", { name: "früher" }).click();
  await expect(plot).not.toHaveAttribute("aria-valuetext", recent);
  await region.getByRole("button", { name: "später" }).click();
  await expect(plot).toHaveAttribute("aria-valuetext", recent);

  await plot.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(plot).not.toHaveAttribute("aria-valuetext", recent);
  await page.keyboard.press("End");
  await expect(plot).toHaveAttribute("aria-valuetext", recent);
  await page.keyboard.press("+");
  await expect(plot).not.toHaveAttribute("aria-valuetext", recent);
  await page.keyboard.press("-");
  await expect(plot).toHaveAttribute("aria-valuetext", recent);
  await page.keyboard.press("Home");
  await expect(region.getByRole("button", { name: "früher" })).toHaveAttribute("aria-disabled", "true");

  // Zoomed out completely, the "−" button has nothing left to do.
  await region.getByRole("button", { name: "Gesamter Verlauf" }).click();
  await expect(region.getByRole("button", { name: "Herauszoomen" })).toHaveAttribute("aria-disabled", "true");
});

test("a custom period shows exactly the picked dates and the info button explains the gestures", async () => {
  await openDetail();
  const region = history();
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const short = (value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}.`;
  const from = iso(75);
  const to = iso(40);

  const custom = region.getByRole("button", { name: "Eigener" });
  await expect(custom).toHaveAttribute("aria-expanded", "false");
  await custom.click();
  const form = page.getByRole("dialog", { name: "Eigener Zeitraum" });
  await expect(form.getByLabel("Von")).toBeFocused();
  await expectNoAxeViolations("custom period popover");
  await form.getByLabel("Von").fill(to);
  await form.getByLabel("Bis").fill(from);
  await form.getByRole("button", { name: "Anzeigen" }).click();
  await expect(form.getByRole("alert")).toHaveText("Das Enddatum darf nicht vor dem Startdatum liegen.");
  await form.getByLabel("Von").fill(from);
  await form.getByLabel("Bis").fill(to);
  await form.getByRole("button", { name: "Anzeigen" }).click();
  await expect(form).toBeHidden();
  await expect(custom).toBeFocused();
  await expect(period(region)).toContainText(short(from));
  await expect(period(region)).toContainText(short(to));
  await expect(custom).toHaveAttribute("data-active", "true");
  await expect(region.getByRole("button", { name: "Zurück", exact: true })).not.toHaveAttribute("aria-disabled", "true");

  const info = region.getByRole("button", { name: "Bedienung des Diagramms" });
  await info.click();
  const help = page.getByRole("dialog", { name: "Bedienung des Diagramms" });
  await expect(help).toContainText("Zeitraum markieren");
  await expect(help).toContainText("Übersichtsleiste");
  await expectNoAxeViolations("chart help popover");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(info).toBeFocused();

  await region.getByRole("button", { name: "3 Monate" }).click();
  await expect(custom).not.toHaveAttribute("data-active", "true");
});

test("the accounts overview pans and zooms the total of the view with the wheel", async () => {
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const region = page.getByRole("region", { name: "Gesamtsaldo" });
  const plot = region.getByRole("slider", { name: "Verlauf des Gesamtsaldos" });
  await expect(plot).toBeVisible();
  await expect(region).toContainText("Ohne Umbuchungen zwischen diesen Konten");
  const start = await plot.getAttribute("aria-valuetext");

  const box = await plot.boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect(plot).not.toHaveAttribute("aria-valuetext", start ?? "");
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "false");

  await region.getByRole("button", { name: "3 Monate" }).click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Shift");
  await expect(plot).not.toHaveAttribute("aria-valuetext", start ?? "");
  await expect(region.getByRole("button", { name: "später" })).not.toHaveAttribute("aria-disabled", "true");
});

const badge = (region: Locator) => region.locator(".timeline-badge");
const backButton = (region: Locator) => region.getByRole("button", { name: "Zurück", exact: true });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

test("the arrows are icon buttons with names and tooltips, Zurück starts disabled", async () => {
  await openDetail();
  const region = history();
  for (const [name, title] of [
    ["früher", "Früheren Zeitraum zeigen"],
    ["später", "Späteren Zeitraum zeigen"],
  ] as const) {
    const button = region.getByRole("button", { name, exact: true });
    await expect(button).toHaveAttribute("title", title);
    await expect(button.locator("svg")).toHaveCount(1);
    expect((await box(button)).width).toBeLessThan(48);
  }
  await expect(region.getByRole("button", { name: "später", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(region.getByRole("button", { name: "früher", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await expect(backButton(region)).toHaveAttribute("aria-disabled", "true");
  await expect(backButton(region).locator("svg")).toHaveCount(1);
});

test("Shift-dragging the chart selects a range live and zooms to it; Zurück and a double-click go back", async () => {
  await openDetail();
  const region = history();
  const plot = chart(region);
  const initial = (await plot.getAttribute("aria-valuetext")) ?? "";
  const b = await box(plot);
  const y = b.y + b.height / 2;

  const select = async (from: number, to: number) => {
    await page.keyboard.down("Shift");
    await page.mouse.move(b.x + b.width * from, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * ((from + to) / 2), y, { steps: 4 });
    await page.mouse.move(b.x + b.width * to, y, { steps: 4 });
  };
  const release = async () => {
    await page.mouse.up();
    await page.keyboard.up("Shift");
  };

  await select(0.4, 0.75);
  await expect(badge(region)).toHaveText("Auswahl");
  await expect(region.locator(".timeline-selection")).toBeVisible();
  await expect(region.locator(".timeline-draft")).toBeVisible();
  await expect(sums(region)).toContainText("Eingänge");
  await expect(region.getByRole("status")).toContainText(/Auswahl .*: Eingänge .*, Ausgänge/);
  const selected = ((await period(region).textContent()) ?? "").replace("Auswahl", "");
  await release();
  await expect(badge(region)).toHaveCount(0);
  await expect(period(region)).toHaveText(selected);
  await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "false");
  await expect(region.getByRole("status")).toContainText(/Saldo von .* auf .*, Eingänge/);

  await expect(backButton(region)).not.toHaveAttribute("aria-disabled", "true");
  await backButton(region).click();
  await expect(plot).toHaveAttribute("aria-valuetext", initial);
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "true");
  await expect(backButton(region)).toHaveAttribute("aria-disabled", "true");

  // Escape cancels a selection in progress.
  await select(0.3, 0.6);
  await expect(badge(region)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(badge(region)).toHaveCount(0);
  await release();
  await expect(plot).toHaveAttribute("aria-valuetext", initial);
  await expect(backButton(region)).toHaveAttribute("aria-disabled", "true");

  await select(0.2, 0.5);
  await release();
  await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
  await plot.dblclick({ position: { x: b.width / 2, y: b.height / 2 } });
  await expect(plot).toHaveAttribute("aria-valuetext", initial);
});

test("Shift and the arrow keys select a range, Enter zooms to it and the presets clear the history", async () => {
  await openDetail();
  const region = history();
  const plot = chart(region);
  const initial = (await plot.getAttribute("aria-valuetext")) ?? "";

  await plot.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(badge(region)).toBeVisible();
  await expect(region.getByRole("status")).toContainText(/Auswahl .*: Eingänge/);
  await page.keyboard.press("Escape");
  await expect(badge(region)).toHaveCount(0);
  await expect(plot).toHaveAttribute("aria-valuetext", initial);

  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(badge(region)).toHaveCount(0);
  await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
  await expect(backButton(region)).not.toHaveAttribute("aria-disabled", "true");
  // The selection grew from the right edge, so the window still ends today.
  await expect(region.getByRole("button", { name: "später", exact: true })).toHaveAttribute("aria-disabled", "true");

  await region.getByRole("button", { name: "1 Jahr" }).click();
  await expect(backButton(region)).toHaveAttribute("aria-disabled", "true");
});

test("the overview's handles resize the window and dragging beside it draws a new one", async () => {
  await openDetail();
  const region = history();
  const plot = chart(region);
  const strip = region.locator(".timeline-scrubber");
  const thumb = region.locator(".timeline-thumb");
  const initial = (await plot.getAttribute("aria-valuetext")) ?? "";
  await expect(region.locator(".timeline-handle")).toHaveCount(2);
  await expect(region.locator(".timeline-handle-from")).toBeVisible();
  await expect(region.locator(".timeline-handle-to")).toBeVisible();

  const before = await box(thumb);
  const y = before.y + before.height / 2;
  await page.mouse.move(before.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(before.x - 40, y, { steps: 4 });
  await page.mouse.move(before.x - 80, y, { steps: 4 });
  await page.mouse.up();
  const widened = await box(thumb);
  expect(widened.width).toBeGreaterThan(before.width + 60);
  expect(Math.abs(widened.x + widened.width - (before.x + before.width))).toBeLessThan(2);
  await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
  await expect(region.getByRole("button", { name: "3 Monate" })).toHaveAttribute("aria-pressed", "false");

  await backButton(region).click();
  await expect(plot).toHaveAttribute("aria-valuetext", initial);

  const s = await box(strip);
  await page.mouse.move(s.x + s.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width * 0.2, y, { steps: 4 });
  await page.mouse.move(s.x + s.width * 0.3, y, { steps: 4 });
  await expect(region.locator(".timeline-draft")).toBeVisible();
  await expect(badge(region)).toBeVisible();
  await page.mouse.up();
  await expect(badge(region)).toHaveCount(0);
  await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
  await expect.poll(async () => Math.abs((await box(thumb)).x - (s.x + s.width * 0.1))).toBeLessThan(6);
  await expect.poll(async () => Math.abs((await box(thumb)).width - s.width * 0.2)).toBeLessThan(6);
  await expect(backButton(region)).not.toHaveAttribute("aria-disabled", "true");
});

test("on a touch screen a long press selects a range, a swipe still pans and a double tap goes back", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 740 },
    reducedMotion: "reduce",
    locale: "de-DE",
    storageState: await page.context().storageState(),
  });
  const touchPage = await context.newPage();
  try {
    await touchPage.goto(detail);
    await touchPage.waitForLoadState("networkidle");
    const region = touchPage.getByRole("region", { name: "Saldoverlauf" });
    const plot = chart(region);
    await expect(plot).toBeVisible();
    await plot.scrollIntoViewIfNeeded();
    const initial = (await plot.getAttribute("aria-valuetext")) ?? "";
    expect((await box(region.locator(".timeline-scrubber"))).height).toBeGreaterThanOrEqual(44);
    for (const name of ["früher", "Zurück"]) {
      const button = await box(region.getByRole("button", { name, exact: true }));
      expect(Math.min(button.width, button.height)).toBeGreaterThanOrEqual(44);
    }

    const cdp = await context.newCDPSession(touchPage);
    const b = await box(plot);
    const y = b.y + b.height / 2;
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const drag = async (from: number, to: number) => {
      for (let i = 1; i <= 6; i++) await touch("touchMove", b.x + b.width * (from + ((to - from) * i) / 6));
    };

    await touch("touchStart", b.x + b.width * 0.3);
    await drag(0.3, 0.8);
    await touch("touchEnd");
    await expect(plot).not.toHaveAttribute("aria-valuetext", initial);
    await expect(badge(region)).toHaveCount(0);
    await expect(backButton(region)).toHaveAttribute("aria-disabled", "true");
    const panned = (await plot.getAttribute("aria-valuetext")) ?? "";

    await touch("touchStart", b.x + b.width * 0.75);
    await touchPage.waitForTimeout(600);
    await expect(badge(region)).toBeVisible();
    await expect(region.locator(".timeline-press-cue")).toBeVisible();
    await drag(0.75, 0.35);
    await expect(region.locator(".timeline-selection")).toBeVisible();
    await touch("touchEnd");
    await expect(badge(region)).toHaveCount(0);
    await expect(plot).not.toHaveAttribute("aria-valuetext", panned);
    await expect(backButton(region)).not.toHaveAttribute("aria-disabled", "true");

    await touchPage.touchscreen.tap(b.x + b.width / 2, y);
    await touchPage.touchscreen.tap(b.x + b.width / 2, y);
    await expect(plot).toHaveAttribute("aria-valuetext", panned);
    const overflow = await touchPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("the timelines pass axe in light and dark mode and fit a phone screen", async () => {
  const shot = (name: string) => test.info().outputPath(name);
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(mode);
    for (const path of ["/konten", detail]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("slider").first()).toBeVisible();
      await expectNoAxeViolations(`${path} (${mode})`);
      await page.screenshot({ path: shot(`${path === detail ? "konto" : "konten"}-${mode}-1280.png`), fullPage: true });
    }
    const plot = chart(history());
    await plot.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(badge(history())).toBeVisible();
    await expectNoAxeViolations(`${detail} Auswahl (${mode})`);
    await page.keyboard.press("Escape");
  }
  await setMode("hell");
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of ["/konten", detail]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("slider").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: shot(`${path === detail ? "konto" : "konten"}-hell-375.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});
