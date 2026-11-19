import { spawnSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PASSPHRASE = "korrekt pferd batterie heftklammer";

test.describe.configure({ mode: "serial" });
test.skip(
  !["pg_dump", "pg_restore", "rclone"].every((tool) => spawnSync(tool, ["--version"]).status === 0),
  "needs pg_dump, pg_restore and rclone on the PATH",
);

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

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Benutzername").fill(ADMIN.username);
  await page.getByLabel("Passwort").fill(ADMIN.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
}

async function openBackup(page: Page) {
  await page.goto("/einstellungen/sicherung");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 2, name: "Sicherung" })).toBeVisible();
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "de-DE" });
  page = await context.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.context().close();
});

test("a superuser sets the passphrase, adds the local folder and backs up now", async () => {
  await page.goto("/einstellungen");
  await page
    .getByRole("navigation", { name: "Bereiche der Einstellungen" })
    .getByRole("link", { name: /Sicherung/ })
    .click();
  await expect(page).toHaveURL(/\/einstellungen\/sicherung$/);
  await expect(page.getByText("Noch keine Passphrase")).toBeVisible();
  await expectNoAxeViolations(page, "Sicherung (hell, leer)");

  await page.getByRole("button", { name: "Passphrase festlegen" }).click();
  const passphrase = page.getByRole("dialog", { name: "Passphrase für Sicherungen" });
  await passphrase.getByLabel("Neue Passphrase").fill("kurz");
  await passphrase.getByRole("button", { name: "Speichern" }).click();
  await expect(passphrase.getByText("Mindestens 12 Zeichen eingeben.")).toBeVisible();
  await passphrase.getByLabel("Neue Passphrase").fill(PASSPHRASE);
  await expect(passphrase.getByText(/Stärke: (gut|stark)/)).toBeVisible();
  await passphrase.getByLabel("Passphrase wiederholen").fill(PASSPHRASE);
  await expectNoAxeViolations(page, "Passphrase-Dialog");
  await passphrase.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Passphrase gespeichert.")).toBeVisible();
  await expect(page.getByText(/Festgelegt/)).toBeVisible();

  await page.getByRole("button", { name: "Ziel hinzufügen" }).click();
  const target = page.getByRole("dialog", { name: "Ziel hinzufügen" });
  await expect(target.getByLabel("Art")).toHaveValue("local");
  await target.getByLabel("Name").fill("Lokaler Ordner");
  await target.getByLabel("Unterordner").fill("e2e");
  await target.getByLabel("Art").selectOption("sftp");
  await expect(target.getByLabel("Port")).toHaveValue("22");
  await expectNoAxeViolations(page, "Ziel-Dialog (SFTP)");
  await target.getByLabel("Art").selectOption("local");
  await target.getByRole("button", { name: "Speichern und testen" }).click();
  await expect(page.getByText(/Verbindung funktioniert/)).toBeVisible();
  const targets = page.getByRole("region", { name: "Ziele" });
  await expect(targets.getByText("Lokaler Ordner", { exact: true })).toBeVisible();

  const schedule = page.getByRole("form", { name: "Zeitplan" });
  await schedule.getByRole("checkbox", { name: /Lokaler Ordner/ }).check();
  await schedule.getByLabel("Häufigkeit").selectOption("daily");
  await schedule.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Zeitplan gespeichert.")).toBeVisible();
  await expect(schedule.getByText(/Nächste Sicherung/)).toBeVisible();

  await schedule.getByRole("button", { name: "Jetzt sichern" }).click();
  await expect(page.getByText(/Die Sicherung läuft im Hintergrund/)).toBeVisible();
  const history = page.getByRole("region", { name: "Verlauf" });
  await expect(history.getByText("Erfolgreich").first()).toBeVisible({ timeout: 60_000 });
  await expect(history.getByText("Lokaler Ordner: gespeichert")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("button", { name: /^Aufgaben/ }).click();
  const tasks = page.getByRole("dialog", { name: "Aufgaben" });
  await expect(tasks.getByText("Sicherung", { exact: true })).toBeVisible();
  await expect(tasks.getByText(/auf 1 Ziel gespeichert/)).toBeVisible();
  await page.keyboard.press("Escape");

  const archives = page.getByRole("region", { name: "Archive" });
  await archives.getByRole("button", { name: "Archive laden" }).click();
  await expect(archives.getByText("1 Archiv auf Lokaler Ordner")).toBeVisible();
  const row = archives.getByRole("row").filter({ hasText: ".saldo-backup" });
  await expect(row.getByRole("link", { name: /Herunterladen/ })).toHaveAttribute("href", /\/api\/backup\/download\?target=\d+&name=saldo-/);
  await expectNoAxeViolations(page, "Sicherung (hell, mit Archiv)");
});

test("an archive is checked, confirmed with the word and restored, then everyone signs in again", async () => {
  const archives = page.getByRole("region", { name: "Archive" });
  const row = archives.getByRole("row").filter({ hasText: ".saldo-backup" }).first();
  await row.getByRole("button", { name: /Wiederherstellen/ }).click();
  const check = page.getByRole("dialog", { name: /prüfen/ });
  await check.getByLabel("Passphrase des Archivs").fill("eine ganz falsche passphrase");
  await check.getByRole("button", { name: "Entschlüsseln und prüfen" }).click();
  await expect(check.getByText(/Die Passphrase passt nicht zu diesem Archiv/)).toBeVisible();
  await check.getByLabel("Passphrase des Archivs").fill(PASSPHRASE);
  await check.getByRole("button", { name: "Entschlüsseln und prüfen" }).click();
  const preview = page.getByRole("region", { name: /Inhalt von/ });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText(/Buchungen/)).toBeVisible();
  await expect(preview.getByText("Gleicher Datenbankstand wie diese Version von Saldo.")).toBeVisible();
  await expectNoAxeViolations(page, "Wiederherstellen (Vorschau)");

  await preview.getByRole("button", { name: "Wiederherstellen …" }).click();
  const confirm = page.getByRole("dialog", { name: "Alle Daten durch dieses Archiv ersetzen?" });
  await confirm.getByLabel(/Zur Bestätigung WIEDERHERSTELLEN eingeben/).fill("ja");
  await confirm.getByRole("button", { name: "Daten ersetzen" }).click();
  await expect(confirm.getByText("Das Bestätigungswort stimmt nicht")).toBeVisible();
  await expectNoAxeViolations(page, "Bestätigung der Wiederherstellung");
  await confirm.getByLabel(/Zur Bestätigung WIEDERHERSTELLEN eingeben/).fill("WIEDERHERSTELLEN");
  await confirm.getByRole("button", { name: "Daten ersetzen" }).click();
  const restore = page.getByRole("region", { name: "Wiederherstellen" });
  await expect(restore.getByText(/Die Wiederherstellung läuft/)).toBeVisible();
  await expect(restore.getByText("Die Wiederherstellung ist abgeschlossen. Bitte melde dich neu an.")).toBeVisible({ timeout: 90_000 });
  await restore.getByRole("link", { name: "Zur Anmeldung" }).click();

  await signIn(page);
  await page.goto("/einstellungen/protokoll");
  await expect(page.getByRole("row").filter({ hasText: "Sicherung wiederhergestellt" }).first()).toBeVisible();
  await openBackup(page);
  const history = page.getByRole("region", { name: "Verlauf" });
  await expect(history.getByText("Vor Wiederherstellung")).toBeVisible();
  await expect(page.getByText(/Festgelegt/)).toBeVisible();
});

test("a downloaded archive uploads again, is checked and can be discarded", async () => {
  await openBackup(page);
  const archives = page.getByRole("region", { name: "Archive" });
  await archives.getByRole("button", { name: "Archive laden" }).click();
  const href = await archives
    .getByRole("link", { name: /Herunterladen/ })
    .first()
    .getAttribute("href");
  const download = await page.request.get(href ?? "");
  expect(download.status()).toBe(200);
  const bytes = await download.body();
  expect(bytes.subarray(0, 8).toString("ascii")).toBe("SALDOBAK");

  const restore = page.getByRole("region", { name: "Wiederherstellen" });
  await restore.getByRole("button", { name: "Hochladen und prüfen" }).click();
  await expect(restore.getByText("Bitte eine Datei wählen.")).toBeVisible();
  await restore
    .getByLabel("Archiv-Datei")
    .setInputFiles({ name: "kopie.saldo-backup", mimeType: "application/octet-stream", buffer: bytes });
  await restore.getByRole("button", { name: "Hochladen und prüfen" }).click();
  const check = page.getByRole("dialog", { name: "Archiv „kopie.saldo-backup“ prüfen" });
  await check.getByLabel("Passphrase des Archivs").fill(PASSPHRASE);
  await check.getByRole("button", { name: "Entschlüsseln und prüfen" }).click();
  const preview = page.getByRole("region", { name: "Inhalt von „kopie.saldo-backup“" });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await preview.getByRole("button", { name: "Verwerfen" }).click();
  await expect(preview).toBeHidden();

  await restore
    .getByLabel("Archiv-Datei")
    .setInputFiles({ name: "notiz.txt", mimeType: "text/plain", buffer: Buffer.from("keine Sicherung") });
  await restore.getByRole("button", { name: "Hochladen und prüfen" }).click();
  await expect(restore.getByText(/Das ist keine Sicherung von Saldo/)).toBeVisible();
});

test("the backup page passes axe in dark mode and fits 375 px", async () => {
  await setMode(page, "dunkel");
  await openBackup(page);
  await expectNoAxeViolations(page, "Sicherung (dunkel)");
  await page.getByRole("button", { name: "Ziel hinzufügen" }).click();
  await expectNoAxeViolations(page, "Ziel-Dialog (dunkel)");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 375, height: 800 });
  await openBackup(page);
  await page.getByRole("region", { name: "Archive" }).getByRole("button", { name: "Archive laden" }).click();
  await expect(page.getByRole("region", { name: "Archive" }).getByRole("row").filter({ hasText: ".saldo-backup" }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoAxeViolations(page, "Sicherung (dunkel, 375 px)");
  await page.setViewportSize({ width: 1280, height: 720 });
  await setMode(page, "hell");
});
