import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const JANA = { username: "jana.e2e", password: "jana-passwort-123" };
const ON_JOINT = "Teilen Gemeinschaft";
const ON_GIRO = "Teilen Giro";
const VIEW = "Familie";

// Cleans up after itself: vertraege.spec.ts runs next and expects the "Alle" tab and no extra contracts.
test.describe.configure({ mode: "serial" });

/** A fresh browser context per person; playwright.config.ts raises SIGN_IN_LIMIT for the many sign-ins from one address. */
async function newSession(browser: Browser, who: { username: string; password: string }, width = 1280): Promise<Page> {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE", viewport: { width, height: 900 } });
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

async function expectNoPageScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `waagerechtes Scrollen auf ${label}`).toBeLessThanOrEqual(0);
}

const tabsOf = (page: Page) => page.getByRole("navigation", { name: "Ansichten der Verträge" });

/** Exactly one tab is current, and it is the named one. */
async function expectCurrent(page: Page, name: string) {
  const current = tabsOf(page).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(name);
}

const list = (page: Page) => page.getByRole("region", { name: "Alle Verträge" });

async function createContract(page: Page, name: string, account: string) {
  await page.getByRole("button", { name: "Vertrag anlegen" }).click();
  const form = page.getByRole("dialog", { name: "Neuer Vertrag" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Betrag in Euro").fill("12,00");
  await form.getByLabel("Nächste Fälligkeit").fill("2030-01-15");
  await form.getByLabel("Konto", { exact: true }).selectOption({ label: account });
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("dialog", { name })).toBeVisible();
  await page.keyboard.press("Escape");
}

async function deleteContract(page: Page, name: string) {
  await list(page).getByRole("button", { name, exact: true }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Löschen", exact: true }).click();
  await page
    .getByRole("dialog", { name: `Vertrag „${name}“ löschen?` })
    .getByRole("button", { name: "Vertrag löschen" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: `Vertrag „${name}“ gelöscht.` })).toBeVisible();
}

async function expectFieldsFit(dialog: Locator, width: number) {
  const fields = dialog.locator("input:not([type=hidden]), select, textarea");
  const count = await fields.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width, `Feld ${i}`).toBe(true);
  }
}

test("the owner renames “Alle”, shares a view with a member, and only one tab is ever current", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await admin.goto("/einstellungen/benutzer");
  await admin.getByRole("button", { name: "Benutzer anlegen" }).click();
  const user = admin.getByRole("dialog", { name: "Benutzer anlegen" });
  await user.getByLabel("Benutzername").fill(JANA.username);
  await user.getByLabel("Startpasswort").fill(JANA.password);
  await user.getByRole("checkbox", { name: "Gemeinschaftskonto", exact: true }).check();
  await user.getByRole("button", { name: "Benutzer anlegen" }).click();
  await expect(admin.getByRole("row").filter({ hasText: JANA.username })).toBeVisible();

  await admin.goto("/vertraege");
  await expectCurrent(admin, "Alle");
  await createContract(admin, ON_JOINT, "Comdirect Gemeinschaftskonto");
  await createContract(admin, ON_GIRO, "DKB Girokonto");

  await admin.getByRole("button", { name: "Ansicht bearbeiten" }).click();
  const all = admin.getByRole("dialog", { name: "Ansicht „Alle“ bearbeiten" });
  await expect(all.getByRole("button", { name: /löschen/ })).toHaveCount(0);
  await all.getByLabel("Name", { exact: true }).fill("Sämtliche");
  await all.getByRole("button", { name: "Speichern" }).click();
  await expect(all).toBeHidden();
  await expect(tabsOf(admin).getByRole("link", { name: "Sämtliche" })).toBeVisible();
  await expectCurrent(admin, "Sämtliche");

  await tabsOf(admin).getByRole("button", { name: "Ansicht hinzufügen" }).click();
  const dialog = admin.getByRole("dialog", { name: "Neue Ansicht" });
  await dialog.getByLabel("Name", { exact: true }).fill(VIEW);
  await dialog.getByRole("checkbox", { name: /Comdirect Gemeinschaftskonto/ }).check();
  await dialog.getByRole("checkbox", { name: /DKB Girokonto/ }).check();
  await expect(dialog.getByRole("radio", { name: "Nur ich" })).toBeChecked();
  await dialog.getByRole("radio", { name: "Bestimmte Personen" }).check();
  await dialog.getByRole("button", { name: "Ansicht anlegen" }).click();
  await expect(dialog.getByText("Mindestens eine Person wählen.")).toBeVisible();
  await dialog.getByRole("checkbox", { name: JANA.username }).check();
  await expect(dialog.getByText(`${JANA.username} sieht eines der gewählten Konten nicht.`)).toBeVisible();
  await expectNoAxeViolations(admin, "Ansicht teilen");
  await dialog.getByRole("button", { name: "Ansicht anlegen" }).click();
  await expect(dialog).toBeHidden();
  await expectCurrent(admin, VIEW);

  // Back and forth, exactly one tab stays marked, also with a contract open.
  await tabsOf(admin).getByRole("link", { name: "Sämtliche" }).click();
  await expectCurrent(admin, "Sämtliche");
  await tabsOf(admin).getByRole("link", { name: VIEW }).click();
  await expectCurrent(admin, VIEW);
  await list(admin).getByRole("button", { name: ON_GIRO, exact: true }).click();
  await expectCurrent(admin, VIEW);
  await admin.keyboard.press("Escape");
  await tabsOf(admin).getByRole("link", { name: "Sämtliche" }).click();
  await expectCurrent(admin, "Sämtliche");
  await admin.context().close();
});

test("the member sees the shared view read-only with only her accounts, hides it and shows it again", async ({ browser }) => {
  const jana = await newSession(browser, JANA);
  await jana.goto("/vertraege");
  // Her own "Alle" keeps its name; the owner's choice is only his.
  await expectCurrent(jana, "Alle");
  const tab = tabsOf(jana).getByRole("link", { name: `${VIEW}, geteilt von ${ADMIN.username}` });
  await tab.click();
  await expectCurrent(jana, VIEW);
  await expect(jana.getByText(`Geteilt von ${ADMIN.username} – nur ansehen`)).toBeVisible();
  await expect(list(jana).getByRole("button", { name: ON_JOINT, exact: true })).toBeVisible();
  await expect(jana.getByText(ON_GIRO)).toHaveCount(0);
  await expect(jana.getByRole("button", { name: "Ansicht bearbeiten" })).toHaveCount(0);

  await jana.getByRole("button", { name: "Ansicht ausblenden" }).click();
  await expect(jana.getByRole("status").filter({ hasText: `Ansicht „${VIEW}“ ausgeblendet.` })).toBeVisible();
  await expect(tab).toHaveCount(0);
  await expectCurrent(jana, "Alle");
  await jana.getByRole("button", { name: "Ansicht bearbeiten" }).click();
  const all = jana.getByRole("dialog", { name: "Ansicht „Alle“ bearbeiten" });
  await all.getByRole("checkbox", { name: new RegExp(VIEW) }).check();
  await all.getByRole("button", { name: "Speichern" }).click();
  await expect(all).toBeHidden();
  await expect(tab).toBeVisible();

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(jana, mode);
    await jana.goto("/vertraege");
    await tab.click();
    await expectCurrent(jana, VIEW);
    await expectNoAxeViolations(jana, `geteilte Ansicht (${mode})`);
  }
  await jana.setViewportSize({ width: 375, height: 800 });
  await jana.goto("/vertraege");
  await tab.click();
  await expect(list(jana).getByRole("button", { name: ON_JOINT, exact: true })).toBeVisible();
  await expectNoPageScroll(jana, "geteilte Ansicht 375 px");
  await setMode(jana, "hell");
  await jana.context().close();
});

test("on a phone the sharing dialog shows who it is shared with and every field fits", async ({ browser }) => {
  const admin = await newSession(browser, ADMIN, 375);
  await admin.goto("/vertraege");
  await tabsOf(admin).getByRole("link", { name: VIEW }).click();
  await expectCurrent(admin, VIEW);
  await admin.getByRole("button", { name: "Ansicht bearbeiten" }).click();
  const edit = admin.getByRole("dialog", { name: `Ansicht „${VIEW}“ bearbeiten` });
  await expect(edit.getByRole("radio", { name: "Bestimmte Personen" })).toBeChecked();
  await expect(edit.getByRole("checkbox", { name: JANA.username })).toBeChecked();
  await expectFieldsFit(edit, 375);
  await expectNoPageScroll(admin, "Ansicht teilen 375 px");
  await admin.context().close();
});

/** Removes what the tests above may have left, however far they got. */
test.afterAll(async ({ browser }) => {
  const admin = await newSession(browser, ADMIN);
  await admin.goto("/vertraege");
  const view = tabsOf(admin).getByRole("link", { name: VIEW });
  if ((await view.count()) > 0) {
    await view.click();
    await expectCurrent(admin, VIEW);
    await admin.getByRole("button", { name: "Ansicht bearbeiten" }).click();
    await admin
      .getByRole("dialog", { name: `Ansicht „${VIEW}“ bearbeiten` })
      .getByRole("button", { name: "Ansicht löschen" })
      .click();
    await admin
      .getByRole("dialog", { name: `Ansicht „${VIEW}“ löschen?` })
      .getByRole("button", { name: "Ansicht löschen" })
      .click();
    await expect(admin.getByRole("status").filter({ hasText: `Ansicht „${VIEW}“ gelöscht.` })).toBeVisible();
  }
  await expectCurrent(admin, "");
  if ((await tabsOf(admin).getByRole("link", { name: "Alle", exact: true }).count()) === 0) {
    await admin.getByRole("button", { name: "Ansicht bearbeiten" }).click();
    const all = admin.getByRole("dialog", { name: /^Ansicht „.*“ bearbeiten$/ });
    await all.getByLabel("Name", { exact: true }).fill("");
    await all.getByRole("button", { name: "Speichern" }).click();
    await expect(all).toBeHidden();
  }
  await expectCurrent(admin, "Alle");
  for (const name of [ON_JOINT, ON_GIRO])
    if ((await list(admin).getByRole("button", { name, exact: true }).count()) > 0) await deleteContract(admin, name);
  await admin.context().close();
});
