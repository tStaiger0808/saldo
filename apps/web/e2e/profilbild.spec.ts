import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
// A 4×2 PNG, so the round crop has something to cut off.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAFklEQVR4nGOQz4/5D8LPKjTAmAFdAAAemRG57AshoAAAAABJRU5ErkJggg==",
  "base64",
);

test.describe.configure({ mode: "serial" });

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Modus").selectOption(mode);
}

async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
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

const avatarButton = () => page.getByRole("button", { name: "Benutzerkonto" });
const initial = () => avatarButton().locator(".nav-avatar");
const card = () => page.getByRole("region", { name: "Profilbild" });
const picker = () => card().locator('input[type="file"]');
const ownRow = () => page.getByRole("row").filter({ has: page.getByText("du", { exact: true }) });

test("Profilbild hochladen zeigt es in der Leiste und in der Benutzerliste, Entfernen bringt den Anfangsbuchstaben zurück", async () => {
  await page.goto("/persoenlich/daten");
  await page.waitForLoadState("networkidle");
  await expect(initial()).toHaveText("A");
  await expect(card().getByText("Noch kein Profilbild")).toBeVisible();
  await expect(card().getByText("Bild auswählen", { exact: true }).last()).toBeVisible();

  await picker().setInputFiles({ name: "notiz.png", mimeType: "image/png", buffer: Buffer.from("kein Bild") });
  await expect(card().getByRole("alert")).toHaveText("Nur PNG-, JPEG- oder WebP-Bilder.");
  await expect(avatarButton().locator("img")).toHaveCount(0);

  await picker().setInputFiles({ name: "ich.png", mimeType: "image/png", buffer: PNG });
  await expect(card().getByRole("status").filter({ hasText: "Profilbild gespeichert." })).toBeVisible();
  await expectLoaded(card().getByRole("img", { name: "admin" }));
  const barImage = avatarButton().locator("img");
  await expectLoaded(barImage);
  await expect(barImage).toHaveAttribute("alt", "");
  await expect(barImage).toHaveAttribute("src", /^\/api\/avatars\/[^?]+\?v=\d+$/);
  const fit = await barImage.evaluate((img) => {
    const box = img.getBoundingClientRect();
    return { objectFit: getComputedStyle(img).objectFit, square: Math.round(box.width) === Math.round(box.height) };
  });
  expect(fit).toEqual({ objectFit: "cover", square: true });

  const response = await page.request.get((await barImage.getAttribute("src")) ?? "");
  expect(response.headers()).toMatchObject({
    "content-type": "image/png",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
  });

  await avatarButton().click();
  await expectLoaded(page.locator(".user-menu-who img"));
  await page.keyboard.press("Escape");

  await expectNoAxeViolations(page, "Persönliche Daten mit Profilbild (hell)");
  await page.goto("/einstellungen/benutzer");
  await page.waitForLoadState("networkidle");
  await expectLoaded(ownRow().locator(".user-cell img"));
  await expectNoAxeViolations(page, "Benutzerliste mit Profilbild (hell)");

  await setMode(page, "dunkel");
  await page.goto("/persoenlich/daten");
  await page.waitForLoadState("networkidle");
  await expectNoAxeViolations(page, "Persönliche Daten mit Profilbild (dunkel)");
  await page.goto("/einstellungen/benutzer");
  await page.waitForLoadState("networkidle");
  await expectNoAxeViolations(page, "Benutzerliste mit Profilbild (dunkel)");
  await setMode(page, "hell");

  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/persoenlich/daten");
  await page.waitForLoadState("networkidle");
  await expectLoaded(avatarButton().locator("img"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "waagerechtes Scrollen bei 375 px").toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, "Persönliche Daten mit Profilbild (375 px)");
  await page.setViewportSize({ width: 1280, height: 720 });

  await card().getByRole("button", { name: "Profilbild entfernen" }).click();
  await expect(card().getByRole("status").filter({ hasText: "Profilbild entfernt." })).toBeVisible();
  await expect(avatarButton().locator("img")).toHaveCount(0);
  await expect(initial()).toHaveText("A");
  await expect(card().getByRole("img", { name: "admin" })).toHaveText("A");
  await page.goto("/einstellungen/benutzer");
  await expect(ownRow().locator(".user-cell")).toBeVisible();
  await expect(ownRow().locator(".user-cell img")).toHaveCount(0);
});
