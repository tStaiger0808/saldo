import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PROVIDER = "E2E Tag-Modell";
const AI_TAG = "Auswärts Essen";
const OWN_TAG = "Essen gehen";

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

/** An OpenAI-compatible stand-in: it files "Gasthof Hirsch" under a category with a tag that does not exist yet. */
function mockModel() {
  return createServer((request, response) => {
    const send = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url?.endsWith("/models")) return send({ data: [{ id: "mock-model" }] });
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const items = JSON.parse(body.messages.at(-1)?.content.split("Buchungen:\n")[1] ?? "[]") as { id: number; name: string }[];
      const zuordnungen = items.map((i) =>
        i.name === "Gasthof Hirsch"
          ? { id: i.id, kategorie: "Restaurant & Café", tags: [AI_TAG] }
          : { id: i.id, kategorie: null, tags: [] },
      );
      send({ choices: [{ message: { content: JSON.stringify({ zuordnungen }) } }] });
    });
  });
}

let page: Page;
let model: Server;

test.beforeAll(async ({ browser }) => {
  model = mockModel();
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
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
  await new Promise<void>((resolve) => model.close(() => resolve()));
});

test("the AI tag settings nest under 'KI vergibt Tags' and pass axe in light and dark", async () => {
  const address = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  await page.goto("/einstellungen/ki");
  await page.getByRole("button", { name: "Anbieter hinzufügen" }).click();
  const add = page.getByRole("dialog", { name: "KI-Anbieter hinzufügen" });
  await add.getByLabel("Anbieter", { exact: true }).selectOption({ label: "Eigene Adresse" });
  await add.getByLabel("Name", { exact: true }).fill(PROVIDER);
  await add.getByLabel("Adresse", { exact: true }).fill(address);
  await add.getByRole("button", { name: "Hinzufügen und testen" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("button", { name: `Aktionen für ${PROVIDER}` }).click();
  await page.getByRole("menuitem", { name: "Bearbeiten" }).click();
  const edit = page.getByRole("dialog", { name: "KI-Anbieter bearbeiten" });
  await edit.getByRole("textbox", { name: "Modell" }).fill("mock-model");
  await edit.getByRole("button", { name: "Speichern und testen" }).click();
  await expect(edit).toBeHidden();

  const section = page.getByRole("region", { name: "Tags durch die KI" });
  const assign = section.getByRole("checkbox", { name: "KI vergibt Tags" });
  const create = section.getByRole("checkbox", { name: "KI darf neue Tags anlegen" });
  const limit = section.getByLabel("Höchstens neue Tags pro Lauf");
  await expect(assign).not.toBeChecked();
  await expect(create).toBeDisabled();
  await expect(limit).toBeDisabled();
  await expectNoAxeViolations(page, "KI-Einstellungen (hell)");

  // Both boxes show the saved setting, so they turn on once the server has stored it.
  await assign.click();
  await expect(page.getByRole("status").filter({ hasText: "Einstellungen für Tags durch die KI gespeichert." })).toBeVisible();
  await expect(assign).toBeChecked();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(create).toBeChecked();
  await expect(limit).toBeEnabled();
  await limit.selectOption("3");
  await expect(limit).toHaveValue("3");

  await setMode(page, "dunkel");
  await page.goto("/einstellungen/ki");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("region", { name: "Tags durch die KI" }).getByRole("checkbox", { name: "KI vergibt Tags" })).toBeChecked();
  await expectNoAxeViolations(page, "KI-Einstellungen (dunkel)");
  await setMode(page, "hell");
});

test("a categorization creates a tag marked 'von KI', which the tags page filters and merges, passing axe in light and dark", async () => {
  await page.goto("/buchungen");
  await page.getByRole("button", { name: "Mit KI neu kategorisieren" }).click();
  const choose = page.getByRole("dialog", { name: "Neu kategorisieren" });
  await choose.getByRole("radio", { name: "Nur Buchungen ohne Kategorie" }).check();
  await choose.getByRole("radio", { name: "Alle Buchungen" }).check();
  await choose.getByRole("button", { name: "Weiter" }).click();
  await page
    .getByRole("dialog", { name: /Empfänger neu kategorisieren\?$/ })
    .getByRole("button", { name: "Neu kategorisieren" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Läuft im Hintergrund" })).toBeVisible();

  const row = page.getByRole("listitem").filter({ hasText: AI_TAG });
  await expect(async () => {
    await page.goto("/einstellungen/tags");
    await expect(row).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row.getByText("von KI", { exact: true })).toHaveCount(0);
  await expect(row).toContainText(/\d+ Buchung/);

  await page.getByRole("button", { name: "Tag anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Tag anlegen" });
  await dialog.getByLabel("Name").fill(OWN_TAG);
  await dialog.getByRole("button", { name: "Tag anlegen" }).click();
  const own = page.getByRole("listitem").filter({ hasText: OWN_TAG });
  await expect(own).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Nur von der KI angelegte" })).toHaveCount(0);
  await expectNoAxeViolations(page, "Tags (hell)");

  const openMerge = async () => {
    await page.getByRole("button", { name: `Aktionen für ${AI_TAG}` }).click();
    await page.getByRole("menuitem", { name: "Zusammenführen" }).click();
    const merge = page.getByRole("dialog", { name: `Tag „${AI_TAG}“ zusammenführen` });
    await expect(merge).toBeVisible();
    return merge;
  };
  let merge = await openMerge();
  await merge.getByRole("button", { name: "Zusammenführen" }).click();
  await expect(merge.getByText("Bitte einen Tag wählen.")).toBeVisible();
  await expect(merge.getByLabel("Zusammenführen mit")).toBeFocused();
  await expectNoAxeViolations(page, "Zusammenführen (hell)");
  await page.keyboard.press("Escape");
  await expect(merge).toBeHidden();

  await setMode(page, "dunkel");
  await page.goto("/einstellungen/tags");
  await page.waitForLoadState("networkidle");
  await expect(row).toBeVisible();
  await expectNoAxeViolations(page, "Tags (dunkel)");
  merge = await openMerge();
  await expectNoAxeViolations(page, "Zusammenführen (dunkel)");

  await merge.getByLabel("Zusammenführen mit").selectOption({ label: OWN_TAG });
  await merge.getByRole("button", { name: "Zusammenführen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${AI_TAG}“ mit „${OWN_TAG}“ zusammengeführt.` })).toBeVisible();
  await expect(row).toBeHidden();
  await expect(own).toContainText(/[1-9]\d* Buchung/);
  await setMode(page, "hell");
});
