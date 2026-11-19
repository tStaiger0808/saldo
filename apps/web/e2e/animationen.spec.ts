import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "no-preference", locale: "de-DE", viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

/**
 * Records, for the first `selector` element added to the page, whether it is leaving, inert and the page free of a
 * modal, and the box of what is leaving (offsets ignore the animation's transform).
 */
async function watchExit(selector: string) {
  await page.evaluate((selector) => {
    const seen: { exiting: boolean; inert: boolean; modal: boolean; box: number[] }[] = [];
    (window as unknown as { exitSeen: typeof seen }).exitSeen = seen;
    new MutationObserver((records) => {
      const added = records.flatMap((record) => [...record.addedNodes]).find((node) => node instanceof Element && node.matches(selector));
      if (!(added instanceof Element) || seen.length > 0) return;
      seen.push({
        exiting: added.matches("[data-exiting]") || added.querySelector("[data-exiting]") !== null,
        inert: added.hasAttribute("inert") && added.getAttribute("aria-hidden") === "true",
        modal: document.querySelector("dialog:modal") !== null,
        box: box(added.matches("[data-exiting]") ? added : added.querySelector("[data-exiting]")),
      });
    }).observe(document.body, { childList: true, subtree: true });
    function box(element: Element | null) {
      return element instanceof HTMLElement ? [element.offsetLeft, element.offsetTop, element.offsetWidth, element.offsetHeight] : [];
    }
  }, selector);
}

const boxOf = (selector: string) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector) as HTMLElement;
    return [element.offsetLeft, element.offsetTop, element.offsetWidth, element.offsetHeight];
  }, selector);

const exitSeen = () => page.evaluate(() => (window as unknown as { exitSeen: unknown[] }).exitSeen);

test("a dialog closed by the page fades out without blocking it, then goes away and focus is back on its button", async () => {
  await page.goto("/einstellungen/benutzer");
  const trigger = page.getByRole("button", { name: "Benutzer anlegen" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Benutzer anlegen" });
  await expect(dialog).toBeVisible();

  const box = await boxOf("dialog[open]");
  await watchExit(".dialog-exit");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(exitSeen).toEqual([{ exiting: true, inert: true, modal: false, box }]);
  await expect(page.locator(".dialog-exit")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("a closing menu leaves the same way and gives focus back to its button", async () => {
  await page.goto("/einstellungen/benutzer");
  const button = page.getByRole("button", { name: `Aktionen für ${ADMIN.username}` });
  await button.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  const box = await boxOf(".action-menu-list");
  await watchExit(".action-menu-list");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect.poll(exitSeen).toEqual([{ exiting: true, inert: true, modal: false, box }]);
  await expect(page.locator(".action-menu-list")).toHaveCount(0);
  await expect(button).toBeFocused();
});
