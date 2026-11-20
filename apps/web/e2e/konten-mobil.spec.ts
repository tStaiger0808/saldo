import { createCipheriv, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const MEMBER = { username: "mobil.e2e", password: "mobil-passwort-123" };
// Same database and key as the server started by playwright.config.ts.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";
const ENCRYPTION_KEY = Buffer.from("e2e-key-0123456789abcdef01234567");
const DEPOT = "Trade Republic Depot";
const CARD = "DKB Visa Kreditkarte Reise";
const IBAN = "DE02100100100006820199";
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true };

test.describe.configure({ mode: "serial" });

/** As src/server/crypto.ts stores secrets: AES-256-GCM, base64(iv | tag | ciphertext). */
function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Two connected accounts with the long names that wrapped on phones: a depot "only fetched manually" with a new
 * booking and a daily change, and a credit card in the red.
 */
async function seedAccounts(): Promise<void> {
  await withSql(async (sql) => {
    const [owner] = await sql<{ id: string }[]>`select id from "user" where username = ${ADMIN.username}`;
    if (!owner) throw new Error("admin missing");
    const specs = [
      { connection: "Trade Republic", account: DEPOT, kind: "brokerage", skip: true, cents: 1_234_567, iban: IBAN },
      { connection: "Deutsche Kreditbank Berlin", account: CARD, kind: "credit_card", skip: false, cents: -123_456, iban: null },
    ];
    for (const spec of specs) {
      const [connection] = await sql<{ id: number }[]>`
        insert into bank_connections (name, owner_user_id, visibility, provider, bank, status, ciphertext, last_sync_at, skip_sync_all)
        values (${spec.connection}, ${owner.id}, 'household', 'enable_banking', ${spec.connection}, 'active', ${seal({})}, now(), ${spec.skip})
        returning id`;
      const [account] = await sql<{ id: number }[]>`
        insert into accounts (name, bank, kind, owner_user_id, visibility, color, balance_cents, balance_date, connection_id, remote_ref, iban)
        values (${spec.account}, ${spec.connection}, ${spec.kind}, ${owner.id}, 'household', '#0f766e', ${spec.cents}, ${isoDay(0)},
          ${connection?.id ?? null}, 'remote-1', ${spec.iban})
        returning id`;
      await sql`insert into transactions (account_id, external_id, source, booking_date, amount_cents, counterparty)
        values (${account?.id ?? 0}, ${`mobil:${spec.account}`}, 'enable_banking', ${isoDay(-1)}, -800, 'Bäckerei')`;
      if (spec.kind === "brokerage") {
        await sql`insert into account_balance_entries (account_id, date, balance_cents)
          values (${account?.id ?? 0}, ${isoDay(-1)}, ${spec.cents - 298}), (${account?.id ?? 0}, ${isoDay(0)}, ${spec.cents})`;
      }
    }
  });
}

/** Leaves the database as the other specs expect it. */
async function removeAccounts(): Promise<void> {
  await withSql(async (sql) => {
    await sql`delete from accounts where name in (${DEPOT}, ${CARD})`;
    await sql`delete from bank_connections where name in ('Trade Republic', 'Deutsche Kreditbank Berlin')`;
    await sql`delete from "user" where username = ${MEMBER.username}`;
  });
}

async function newSession(browser: Browser, who: { username: string; password: string }, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE", ...options });
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

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Modus").selectOption(mode);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Words of the visible text that the browser broke across lines; screen-reader-only text does not count. */
async function brokenWords(scope: Locator): Promise<string[]> {
  return scope.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const broken: string[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(".visually-hidden")) continue;
        for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
          if (lines.size > 1) broken.push(match[0]);
        }
      }
      return broken;
    }),
  );
}

/** Every row of the accounts list: name and sub line on one line each, no part sticking out of its column. */
async function rowProblems(page: Page): Promise<string[]> {
  return page.locator("a.account-row").evaluateAll((rows) =>
    rows.flatMap((row) => {
      const problems: string[] = [];
      const label = row.querySelector(".account-name")?.textContent ?? "?";
      const box = row.getBoundingClientRect();
      const main = row.querySelector(".account-main")?.getBoundingClientRect();
      const figures = row.querySelector(".account-figures")?.getBoundingClientRect();
      if (row.scrollWidth > row.clientWidth) problems.push(`${label}: row overflows`);
      for (const selector of [".account-name", ".account-sub"]) {
        const element = row.querySelector(selector);
        if (!element) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (element.getBoundingClientRect().height > size * 1.9) problems.push(`${label}: ${selector} wraps`);
      }
      // Text inside these boxes may end in "…"; the boxes themselves must stay in their column.
      for (const child of row.querySelectorAll(".account-main > *, .account-sub > *, .account-figures > *")) {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || child.closest(".visually-hidden")) continue;
        if (rect.right > box.right + 1) problems.push(`${label}: ${child.className} leaves the row`);
        if (main && figures && child.closest(".account-main") && rect.right > figures.left + 1) {
          problems.push(`${label}: ${child.className || child.tagName} overlaps the amount`);
        }
      }
      if (main && figures && main.right > figures.left + 1) problems.push(`${label}: text runs into the amount`);
      return problems;
    }),
  );
}

/** A finger held on the element (or dragged upwards by `dragY` like a scroll), through the browser's own touch input. */
async function touchHold(page: Page, target: Locator, { ms = 700, dragY = 0 } = {}) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("target not visible");
  const x = box.x + box.width * 0.4;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; dragY > 0 && step <= 8; step++) {
    await page.waitForTimeout(20);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - (dragY * step) / 8 }] });
  }
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const depotRow = (page: Page) => page.locator("a.account-row").filter({ hasText: DEPOT });
const sheetOf = (page: Page) => page.getByRole("dialog", { name: DEPOT, exact: true });
const sheetActions = (page: Page) => sheetOf(page).locator(".sheet-action");

test.beforeAll(seedAccounts);
test.afterAll(removeAccounts);

test("on a phone every account row keeps its texts on one line", async ({ browser }) => {
  const page = await newSession(browser, ADMIN, PHONE);
  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    for (const path of ["/konten", "/konten?nach=bank", "/konten?nach=art"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectNoHorizontalScroll(page);
      expect(await rowProblems(page), path).toEqual([]);
      expect(await brokenWords(page.locator(".account-row, .account-section-head, .page-head")), path).toEqual([]);
      await expectNoAxeViolations(page, `${path} (${mode}, 375 px)`);
    }
    const row = depotRow(page);
    await expect(row.locator(".account-name")).toHaveText(DEPOT);
    await expect(row).toContainText("nur manuell");
    await expect(row).toContainText("1 neu");
    await expect(row.locator(".account-figures")).toContainText("+2,98 €");

    await page.goto("/konten");
    await row.tap();
    await expect(page.getByRole("heading", { level: 1, name: DEPOT })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
    expect(await brokenWords(page.locator(".page-head, .account-hero")), "Kontoseite").toEqual([]);
    await expectNoAxeViolations(page, `Kontoseite (${mode}, 375 px)`);
  }
  await setMode(page, "hell");

  // 320 px with the WCAG 1.4.12 text spacing: the clipped texts must not widen the page either.
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({
    content: "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }",
  });
  await expectNoHorizontalScroll(page);
  expect(await rowProblems(page), "320 px").toEqual([]);
  await page.context().close();
});

test("a long press opens the account's actions as a sheet; Esc and a tap outside close it, focus returns to the row", async ({
  browser,
}) => {
  const page = await newSession(browser, ADMIN, PHONE);
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const row = depotRow(page);
  expect(await row.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  await page.evaluate(() => {
    document.addEventListener("contextmenu", (event) => {
      (window as unknown as { nativeMenus: boolean[] }).nativeMenus.push(!event.defaultPrevented);
    });
    (window as unknown as { nativeMenus: boolean[] }).nativeMenus = [];
  });

  await touchHold(page, row);
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/konten$/);
  await expect(sheetActions(page)).toHaveText([
    "Abrufen",
    "Als gelesen markieren",
    "Als CSV exportieren",
    "Umbenennen …",
    "IBAN kopieren",
    "In Buchungen öffnen",
    "Kontodetails",
    "Freigabe erneuern",
    "Nur manuell abrufen",
    "Art ändern …",
    "Gruppen und Teilen …",
    "Verbindung trennen …",
  ]);
  await expect(sheet.getByRole("button", { name: "Nur manuell abrufen" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as unknown as { nativeMenus: boolean[] }).nativeMenus)).not.toContain(true);
  const box = await sheet.boundingBox();
  expect(box && Math.round(box.y + box.height)).toBe(740);
  for (const mode of ["hell", "dunkel"] as const) {
    await page.evaluate(
      (m) => {
        document.documentElement.dataset.mode = m;
      },
      mode === "hell" ? "light" : "dark",
    );
    await expectNoAxeViolations(page, `Kontoaktionen (${mode}, 375 px)`);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(row).toBeFocused();

  await touchHold(page, row);
  await expect(sheet).toBeVisible();
  await page.touchscreen.tap(187, 10);
  await expect(sheet).toBeHidden();
  await expect(row).toBeFocused();
  await expect(page).toHaveURL(/\/konten$/);

  // A scroll gesture over the row neither opens the sheet nor the account.
  await touchHold(page, row, { dragY: 60, ms: 700 });
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/konten$/);

  // An action that opens a dialog hands focus back to the row when that dialog closes.
  await touchHold(page, row);
  await sheetActions(page).filter({ hasText: "Umbenennen" }).click();
  const edit = page.getByRole("dialog", { name: `${DEPOT} bearbeiten` });
  await expect(edit).toBeVisible();
  await expect(sheet).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  await expect(row).toBeFocused();

  // The "⋯" button opens the same sheet from the keyboard.
  const more = page.getByRole("button", { name: `Aktionen für ${DEPOT}` });
  await expect(more).toHaveAttribute("aria-haspopup", "dialog");
  const size = await more.boundingBox();
  expect(size && size.width >= 44 && size.height >= 44).toBe(true);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();

  await row.tap();
  await expect(page.getByRole("heading", { level: 1, name: DEPOT })).toBeVisible();
  await page.context().close();
});

test("the sheet copies the IBAN, exports the bookings, marks them read and opens the account's pages", async ({ browser }) => {
  const page = await newSession(browser, ADMIN, { ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const row = depotRow(page);

  await touchHold(page, row);
  await sheetActions(page).filter({ hasText: "IBAN kopieren" }).click();
  await expect(page.getByRole("status").filter({ hasText: `IBAN von „${DEPOT}“ kopiert.` })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(IBAN);

  await touchHold(page, row);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sheetActions(page).filter({ hasText: "Als CSV exportieren" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("buchungen.csv");
  expect(download.url()).toMatch(/\/api\/transactions\/export\.csv\?account=\d+$/);

  await touchHold(page, row);
  await sheetActions(page).filter({ hasText: "In Buchungen öffnen" }).click();
  await expect(page).toHaveURL(/\/buchungen\?konto=\d+/);
  await page.goto("/konten");
  await touchHold(page, depotRow(page));
  await sheetActions(page).filter({ hasText: "Kontodetails" }).click();
  await expect(page.getByRole("heading", { level: 1, name: DEPOT })).toBeVisible();
  await page.context().close();
});

test("a member sees only the actions she may take, and so does a superuser viewing Saldo as her", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await admin.goto("/einstellungen/benutzer");
  await admin.getByRole("button", { name: "Benutzer anlegen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Benutzer anlegen" });
  await dialog.getByLabel("Benutzername").fill(MEMBER.username);
  await dialog.getByLabel("Startpasswort").fill(MEMBER.password);
  await dialog.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(admin.getByRole("row").filter({ hasText: MEMBER.username })).toBeVisible();
  await withSql(async (sql) => {
    await sql`insert into account_shares (account_id, user_id)
      select a.id, u.id from accounts a, "user" u where a.name = ${DEPOT} and u.username = ${MEMBER.username}`;
  });

  const member = await newSession(browser, MEMBER, PHONE);
  await member.goto("/konten");
  await member.waitForLoadState("networkidle");
  await touchHold(member, depotRow(member));
  await expect(sheetActions(member)).toHaveText([
    "Als gelesen markieren",
    "Als CSV exportieren",
    "IBAN kopieren",
    "In Buchungen öffnen",
    "Kontodetails",
  ]);
  await sheetActions(member).filter({ hasText: "Als gelesen markieren" }).click();
  await expect(
    member.getByRole("status").filter({ hasText: `Die neuen Buchungen von „${DEPOT}“ sind als gelesen markiert.` }),
  ).toBeVisible();
  await expect(depotRow(member)).not.toContainText("1 neu");
  await touchHold(member, depotRow(member));
  await expect(sheetActions(member)).toHaveText(["Als CSV exportieren", "IBAN kopieren", "In Buchungen öffnen", "Kontodetails"]);
  await member.context().close();

  await withSql(async (sql) => {
    await sql`update transactions set is_unread = true where external_id = ${`mobil:${DEPOT}`}`;
  });
  await admin.getByRole("button", { name: `Aktionen für ${MEMBER.username}` }).click();
  await admin.getByRole("menuitem", { name: `Als ${MEMBER.username} ansehen` }).click();
  await expect(admin.getByRole("region", { name: "Ansicht als andere Person" })).toBeVisible();
  await admin.setViewportSize({ width: 375, height: 740 });
  await admin.goto("/konten");
  await admin.waitForLoadState("networkidle");
  await admin.getByRole("button", { name: `Aktionen für ${DEPOT}` }).click();
  await expect(sheetActions(admin)).toHaveText(["Als CSV exportieren", "IBAN kopieren", "In Buchungen öffnen", "Kontodetails"]);
  await admin.keyboard.press("Escape");
  await admin.getByRole("region", { name: "Ansicht als andere Person" }).getByRole("button", { name: "Ansehen beenden" }).click();
  await expect(admin).toHaveURL(/\/einstellungen\/benutzer$/);
  await admin.context().close();
});

test("on the desktop the row has no separate sync button: fetching stays first in its unchanged ⋯ menu", async ({ browser }) => {
  const page = await newSession(browser, ADMIN, { viewport: { width: 1280, height: 900 } });
  await page.goto("/konten");
  await page.waitForLoadState("networkidle");
  const item = page.locator(".account-item").filter({ hasText: DEPOT });
  await expect(item.getByRole("button")).toHaveCount(1);
  await expect(item.getByRole("button", { name: /Abrufen/ })).toHaveCount(0);
  await item.getByRole("button", { name: `Aktionen für ${DEPOT}` }).click();
  const menu = page.getByRole("menu", { name: `Aktionen für ${DEPOT}` });
  await expect(menu.getByRole("menuitem").or(menu.getByRole("menuitemcheckbox"))).toHaveText([
    "Abrufen",
    "Freigabe erneuern",
    "Nur manuell abrufen",
    "Umbenennen …",
    "Art ändern …",
    "Gruppen und Teilen …",
    "Verbindung trennen …",
  ]);
  await page.keyboard.press("Escape");
  await expect(item.getByRole("button", { name: `Aktionen für ${DEPOT}` })).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.context().close();
});
