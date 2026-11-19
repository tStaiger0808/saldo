import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { type FakeModel, startFakeModel } from "./fake-model.ts";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PROVIDER = "E2E Modell";
const TASK = "Neu kategorisieren · Alle Konten";

test.describe.configure({ mode: "serial" });

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

/** Holds every chat answer until the test releases it, so the task stays visibly running; it assigns no category. */
const held: (() => void)[] = [];
const releaseAll = () => {
  for (const answer of held.splice(0)) answer();
};

let page: Page;
let model: FakeModel;

test.beforeAll(async ({ browser }) => {
  model = await startFakeModel((_body, send) => {
    held.push(() => send({ choices: [{ message: { content: JSON.stringify({ zuordnungen: [] }) } }] }));
  });
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
  releaseAll();
  await page.context().close();
  await model.close();
});

test("the task panel opens from the top bar with its empty state", async () => {
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const button = nav.getByRole("button", { name: "Aufgaben", exact: true });
  await expect(button).toHaveAttribute("aria-busy", "false");
  await button.click();
  const panel = page.getByRole("dialog", { name: "Aufgaben" });
  await expect(panel.getByText("Gerade läuft nichts")).toBeVisible();
  await expectNoAxeViolations(page, "Aufgaben leer");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
});

test("an AI categorization runs in the background and shows its progress and result in the panel", async () => {
  await page.goto("/einstellungen/ki");
  await page.getByRole("button", { name: "Anbieter hinzufügen" }).click();
  const add = page.getByRole("dialog", { name: "KI-Anbieter hinzufügen" });
  await add.getByLabel("Anbieter", { exact: true }).selectOption({ label: "Eigene Adresse" });
  await add.getByLabel("Name", { exact: true }).fill(PROVIDER);
  await add.getByLabel("Adresse", { exact: true }).fill(model.url);
  await add.getByRole("button", { name: "Hinzufügen und testen" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("button", { name: `Aktionen für ${PROVIDER}` }).click();
  await page.getByRole("menuitem", { name: "Bearbeiten" }).click();
  const edit = page.getByRole("dialog", { name: "KI-Anbieter bearbeiten" });
  await edit.getByRole("textbox", { name: "Modell" }).fill("mock-model");
  await edit.getByRole("button", { name: "Speichern und testen" }).click();
  await expect(edit).toBeHidden();

  // Bookings without a category get their AI run from Buchungen ("Nur Buchungen ohne Kategorie", all bookings).
  await page.goto("/buchungen");
  await page.getByRole("button", { name: "Mit KI neu kategorisieren" }).click();
  const choose = page.getByRole("dialog", { name: "Neu kategorisieren" });
  await expect(choose.getByRole("radio", { name: "Nur Buchungen ohne Kategorie" })).toBeChecked();
  await choose.getByRole("radio", { name: "Alle Buchungen" }).check();
  await choose.getByRole("button", { name: "Weiter" }).click();
  await page
    .getByRole("dialog", { name: /Empfänger neu kategorisieren\?$/ })
    .getByRole("button", { name: "Neu kategorisieren" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Läuft im Hintergrund" })).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const button = nav.getByRole("button", { name: /^Aufgaben/ });
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toContainText("1 läuft");
  await expect(page.getByRole("button", { name: "Mit KI neu kategorisieren" })).toBeDisabled();
  await button.click();
  const panel = page.getByRole("dialog", { name: "Aufgaben" });
  const running = panel.getByRole("region", { name: "Laufen gerade" });
  await expect(running.getByText(TASK, { exact: true })).toBeVisible();
  await expect(running.getByText("Gestartet von admin")).toBeVisible();
  const progress = running.getByRole("progressbar", { name: TASK });
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await expect(progress).toHaveAttribute("aria-valuetext", /^Stapel 0 von \d+$/);
  await expect(running.getByRole("button", { name: /^Abbrechen\s?: Neu kategorisieren/ })).toBeVisible();
  await expectNoAxeViolations(page, "Aufgaben mit laufender Aufgabe (hell)");

  releaseAll();
  await expect.poll(() => held.length === 0).toBe(true);
  // Further batches, if the demo data needs more than one, are answered as they arrive.
  const answering = setInterval(releaseAll, 100);
  try {
    const finished = panel.getByRole("region", { name: "Zuletzt beendet" });
    await expect(finished.getByText(TASK, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(finished.getByText("Fertig", { exact: true })).toBeVisible();
    await expect(finished.getByText(/0 Empfänger neu zugeordnet/)).toBeVisible();
    // Every batch of the fake model reports 1,234 + 210 tokens; a superuser sees the total by default.
    await expect(finished.locator(".task-message")).toHaveText(/ · \d{1,3}(\.\d{3})* Tokens$/);
    await expect(page.getByRole("status").filter({ hasText: `${TASK}: Fertig` })).toBeAttached();
  } finally {
    clearInterval(answering);
  }
  await expect(button).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status").filter({ hasText: "Fertig: " })).toBeVisible();

  await setMode(page, "dunkel");
  await page.goto("/analyse");
  await page.waitForLoadState("networkidle");
  await nav.getByRole("button", { name: "Aufgaben", exact: true }).click();
  await expect(panel.getByText(TASK, { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "Aufgaben mit beendeter Aufgabe (dunkel)");
  await page.keyboard.press("Escape");
  await setMode(page, "hell");

  await page.getByRole("checkbox", { name: "KI-Details anzeigen (Tokens, Kontext)" }).uncheck();
  await nav.getByRole("button", { name: "Aufgaben", exact: true }).click();
  await expect(panel.getByText(/0 Empfänger neu zugeordnet/)).toBeVisible();
  await expect(panel.locator(".task-message").filter({ hasText: "Tokens" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "KI-Details anzeigen (Tokens, Kontext)" }).check();

  // On Buchungen the button starts with the period the list shows, or the last three months without one.
  const button12 = () => page.getByRole("button", { name: "Mit KI neu kategorisieren" });
  const scope = page.getByRole("dialog", { name: "Neu kategorisieren" });
  await page.goto("/buchungen");
  await button12().click();
  await expect(scope.getByRole("radio", { name: "Letzte 3 Monate" })).toBeChecked();
  for (const name of ["Letzte 30 Tage", "Alle Buchungen", "Eigener Zeitraum"])
    await expect(scope.getByRole("radio", { name })).toBeVisible();
  await scope.getByRole("button", { name: "Abbrechen" }).click();
  await page.goto("/buchungen?zeitraum=last_12_months");
  await button12().click();
  await expect(scope.getByRole("radio", { name: "Eigener Zeitraum" })).toBeChecked();
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const iso = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-01`;
  await expect(scope.getByLabel("Von", { exact: true })).toHaveValue(iso);
  await expectNoAxeViolations(page, "KI-Neukategorisierung auf Buchungen");
  await scope.getByRole("button", { name: "Abbrechen" }).click();

  // Leave no provider behind for the other specs.
  await page.goto("/einstellungen/ki");
  await page.getByRole("button", { name: `Aktionen für ${PROVIDER}` }).click();
  await page.getByRole("menuitem", { name: "Löschen" }).click();
  await page.getByRole("button", { name: "Anbieter löschen" }).click();
  await expect(page.getByText("Noch kein KI-Anbieter eingerichtet.")).toBeVisible();
  await page.goto("/buchungen");
  await expect(button12()).toHaveCount(0);
});
