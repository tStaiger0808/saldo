import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { type FakeModel, startFakeModel } from "./fake-model.ts";

const ADMIN = { username: "admin", password: "e2e-password-123" };
const PROVIDER = "E2E Chat";

test.describe.configure({ mode: "serial" });

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, `axe auf ${label}`).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function setMode(page: Page, mode: "hell" | "dunkel") {
  await page.goto("/persoenlich/darstellung");
  await page.getByLabel("Farbe").selectOption("tanne");
  await page.getByLabel("Modus").selectOption(mode);
}

type Body = { messages?: { role?: string; content?: string | null }[]; tools?: unknown[] };
type Shown = { filter: Record<string, unknown>; sort?: string };

const toolCall = (name: string, args: object) => ({
  choices: [
    { message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
  ],
});

/** The booking list the app sent as context before the question, if any. */
function shownList(body: Body): Shown | null {
  const context = body.messages?.find((m) => m.content?.includes("<buchungsliste>"))?.content ?? "";
  const json = context.split("<buchungsliste>\n")[1]?.split("\n</buchungsliste>")[0];
  return json ? (JSON.parse(json) as Shown) : null;
}

/** Answers to questions starting with "Dauert" wait here until the test lets them through. */
const held: (() => void)[] = [];

/**
 * Searches for "Wofür" questions, shows booking lists for "Zeig" questions and refines the list on screen for
 * follow-ups ("über 50 €", "September"); "Dauert" questions are held back; every other request gets a short text.
 */
function answer(request: Body, send: (answer: unknown) => void) {
  const last = request.messages?.at(-1);
  const tools = Array.isArray(request.tools);
  if (last?.role === "tool") {
    const result = JSON.parse(last.content ?? "{}") as { shown?: boolean; totals?: { count: number } };
    const text = result.shown
      ? `Ich habe **${result.totals?.count} Buchungen** gefunden.`
      : "Am meisten ging an die **Hausverwaltung Sonnenhalde**.";
    send({ choices: [{ message: { content: text } }] });
    return;
  }
  const question = last?.content ?? "";
  if (question.startsWith("Dauert")) {
    held.push(() => send({ choices: [{ message: { content: "Fertig nach einer Weile." } }] }));
    return;
  }
  const shown = shownList(request);
  if (tools && question.startsWith("Wofür")) send(toolCall("search_transactions", { query: "Hausverwaltung", limit: 20 }));
  else if (tools && question.startsWith("Zeig")) send(toolCall("show_bookings", { q: "Hausverwaltung", period: "last_12_months" }));
  else if (tools && shown && question.includes("über 50"))
    send(toolCall("show_bookings", { ...shown.filter, amountMinCents: 5_000, sort: "betrag-auf" }));
  else if (tools && shown && question.includes("September")) {
    const { period: _, ...rest } = shown.filter;
    send(toolCall("show_bookings", { ...rest, dateFrom: "2026-09-01", dateTo: "2026-09-30", sort: shown.sort }));
  } else send({ choices: [{ message: { content: "Gern geschehen." } }] });
}

let page: Page;
let model: FakeModel;
const requests: Body[] = [];

/** Another browser context with the admin's session; `init` runs before any page script, `phone` is a 375 px touch screen. */
async function signedInPage(browser: Browser, { init, phone = false }: { init?: string; phone?: boolean }) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    locale: "de-DE",
    storageState: await page.context().storageState(),
    ...(phone ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } : {}),
  });
  if (init) await context.addInitScript(init);
  return context.newPage();
}

const nav = (p: Page) => p.getByRole("navigation", { name: "Hauptnavigation" });

const chatDialog = (p: Page) => p.getByRole("dialog", { name: /^KI fragen · / });

async function openChat(p: Page) {
  await nav(p).getByRole("button", { name: "KI fragen" }).click();
  const chat = chatDialog(p);
  await expect(chat).toBeVisible();
  return chat;
}

/** Where the page is and how its content is laid out, to prove the chat changes none of it. */
const pageState = (p: Page) =>
  p.evaluate(() => {
    const main = document.querySelector("main")?.getBoundingClientRect();
    return { url: location.href, scrollY: Math.round(window.scrollY), left: main?.left, width: main?.width };
  });

/** The chat is a real modal: in the top layer, with the dimmed backdrop of the other dialogs. */
async function expectModal(p: Page) {
  const state = await p.evaluate(() => {
    const dialog = document.querySelector("dialog.chat-dialog");
    const backdrop = dialog && getComputedStyle(dialog, "::backdrop");
    return { modal: dialog?.matches(":modal"), background: backdrop?.backgroundColor, filter: backdrop?.backdropFilter };
  });
  expect(state).toEqual({ modal: true, background: "rgba(10, 15, 13, 0.62)", filter: "blur(2px)" });
}

/** The totals the chat shows for an answer's booking list, by label. */
async function chatTotal(chat: Locator, label: string) {
  return (await chat.locator(".chat-bookings-figures > div").filter({ hasText: label }).locator("dd").last().textContent())?.trim();
}

async function ask(chat: Locator, question: string) {
  await chat.getByRole("textbox", { name: "Frage" }).fill(question);
  await chat.getByRole("button", { name: "Senden" }).click();
}

test.beforeAll(async ({ browser }) => {
  model = await startFakeModel((body, send) => {
    requests.push(body as Body);
    answer(body as Body, send);
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
  // A held answer keeps its connection open, and the fake model only closes once none is left.
  for (const release of held.splice(0)) release();
  // Leave no provider behind for the other specs.
  await page.goto("/einstellungen/ki");
  const actions = page.getByRole("button", { name: `Aktionen für ${PROVIDER}` });
  if (await actions.isVisible()) {
    await actions.click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    await page.getByRole("button", { name: "Anbieter löschen" }).click();
    await expect(page.getByText("Noch kein KI-Anbieter eingerichtet.")).toBeVisible();
  }
  await page.context().close();
  await model.close();
});

test("the chat needs no attachments, shows what the AI looked up and passes axe in light and dark", async () => {
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

  for (const mode of ["hell", "dunkel"] as const) {
    await setMode(page, mode);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const chat = await openChat(page);
    await expectModal(page);
    await expect(chat.getByRole("textbox", { name: "Frage" })).toBeFocused();
    await expect(chat.getByText("die KI holt sich die nötigen Buchungen selbst")).toBeVisible();
    await expect(chat.getByRole("checkbox", { name: /anhängen/i })).toHaveCount(0);
    await expect(chat.getByRole("textbox", { name: "Frage" })).toHaveAccessibleDescription(/nie IBANs, Notizen oder Kontostände/);
    await expectNoAxeViolations(page, `KI fragen leer (${mode})`);

    await ask(chat, "Wofür geben wir am meisten aus?");
    await expect(chat.getByText("Hausverwaltung Sonnenhalde")).toBeVisible();
    const lookups = chat.getByText("Abgefragt: 1 Abfrage");
    await expect(lookups).toBeVisible();
    // A superuser sees the tokens by default: the search and the answer are two requests of the fake model.
    await expect(chat.locator(".chat-usage").last()).toHaveText(
      /^1\.234 Tokens Kontext · 420 Antwort · 2 Anfragen, zusammen 2\.888 Tokens · 3,9\s%\svon 32k Kontext$/,
    );
    await lookups.click();
    await expect(chat.getByRole("listitem").filter({ hasText: /^Buchungen \(\d+\)$/ })).toBeVisible();
    await expectNoAxeViolations(page, `KI fragen mit Antwort (${mode})`);
    await chat.getByRole("textbox", { name: "Frage" }).focus();
    await page.keyboard.press("Escape");
    await expect(chat).toBeHidden();
    await expect(nav(page).getByRole("button", { name: "KI fragen" })).toBeFocused();
  }
  await setMode(page, "hell");
});

test("opening keeps the page; a click outside closes while the AI answers, and reopening continues", async () => {
  await page.goto("/buchungen");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 400));
  const before = await pageState(page);
  const launcher = nav(page).getByRole("button", { name: "KI fragen" });
  await expect(launcher).toHaveAttribute("aria-haspopup", "dialog");
  const chat = await openChat(page);
  await expectModal(page);
  expect(await pageState(page)).toEqual(before);

  await ask(chat, "Dauert das lange?");
  await expect(chat.locator(".chat-live[role=status]")).toContainText("Die KI antwortet …");
  await expect(chat.locator(".chat-progress .icon")).toBeVisible();
  await expect(chat.getByRole("button", { name: "Senden" })).toBeDisabled();
  const elapsed = chat.locator(".chat-progress-time");
  await expect(elapsed).toHaveText(/^seit \d+ s$/, { timeout: 6_000 });
  await expect(elapsed).toBeVisible();
  await expect(elapsed).toHaveAttribute("aria-hidden", "true");
  await expectNoAxeViolations(page, "KI fragen antwortet");

  // The draft and the running answer survive a click on the dimmed page.
  await chat.getByRole("textbox", { name: "Frage" }).fill("Und danach?");
  const box = await chat.boundingBox();
  await page.mouse.click((box?.x ?? 400) / 2, 300);
  await expect(chat).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute("aria-busy", "true");
  expect(await pageState(page)).toEqual(before);
  held.shift()?.();
  await expect(launcher).toHaveAttribute("aria-busy", "false");
  // The answer came while the chat was closed: the button counts it until the chat is opened again.
  await expect(launcher.locator(".nav-badge")).toContainText("1");
  await expect(launcher).toHaveAccessibleName(/1 neue Antwort/);
  await expect(page.getByRole("status").filter({ hasText: "Die KI hat geantwortet." })).toBeAttached();

  await launcher.click();
  await expect(chat).toBeVisible();
  await expect(launcher.locator(".nav-badge")).toHaveCount(0);
  await expect(chat.getByText("Dauert das lange?")).toBeVisible();
  await expect(chat.getByText("Fertig nach einer Weile.")).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Frage" })).toHaveValue("Und danach?");
  await chat.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(chat).toBeHidden();
  await expect(launcher).toBeFocused();
  expect(await pageState(page)).toEqual(before);
});

test("show_bookings shows totals in the chat; its link opens the list and follow-ups refine the list on screen", async () => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const chat = await openChat(page);
  await ask(chat, "Zeig mir die Zahlungen an die Hausverwaltung");
  await expect(chat.getByText(/^Ich habe \d+ Buchungen gefunden\.$/)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const count = await chatTotal(chat, "Anzahl");
  await expect(chat.getByText(`Ich habe ${count} Buchungen gefunden.`)).toBeVisible();
  const links = chat.getByRole("link", { name: "In Buchungen anzeigen" });
  await expect(links).toHaveCount(1);
  await expectNoAxeViolations(page, "KI fragen mit Buchungssummen");

  await links.click();
  await expect(chat).toBeHidden();
  await expect(page).toHaveURL(/\/buchungen\?.*q=Hausverwaltung/);
  await expect(page).toHaveURL(/zeitraum=last_12_months/);
  const chips = page.getByRole("list", { name: "Aktive Filter" }).getByRole("listitem");
  await expect(chips).toHaveText(["Zeitraum: Letzte 12 Monate", "Suche: „Hausverwaltung“"]);
  const totals = page.getByRole("region", { name: "Summen aller gefilterten Buchungen" });
  await expect(totals.locator(".totals-figure").filter({ hasText: "Anzahl" }).locator("dd")).toHaveText(count ?? "");

  // On the bookings page the list on screen goes along, and the chat refines it without leaving the page.
  const listUrl = page.url();
  await openChat(page);
  await expectNoAxeViolations(page, "KI fragen über Buchungen");
  await ask(chat, "Davon nur über 50 €");
  await expect(links).toHaveCount(2);
  expect(shownList(requests.at(-2) ?? {})).toEqual({ filter: { q: "Hausverwaltung", period: "last_12_months" }, names: {} });
  expect(page.url()).toBe(listUrl);
  await links.last().click();
  await expect(chat).toBeHidden();
  await expect(page).toHaveURL(/betragAb=50/);
  await expect(page).toHaveURL(/sortierung=betrag-auf/);
  await expect(chips).toHaveText(["Betrag: ab 50,00 €", "Zeitraum: Letzte 12 Monate", "Suche: „Hausverwaltung“"]);

  await openChat(page);
  await ask(chat, "Und im September?");
  await expect(links).toHaveCount(3);
  await links.last().click();
  await expect(page).toHaveURL(/von=2026-09-01&bis=2026-09-30/);
  await expect(chips).toHaveText(["Betrag: ab 50,00 €", "Zeitraum: 01.09.2026 – 30.09.2026", "Suche: „Hausverwaltung“"]);

  // The link under an earlier answer shows that list again.
  await openChat(page);
  await links.first().click();
  await expect(chat).toBeHidden();
  await expect(page).not.toHaveURL(/betragAb/);
  await expect(chips).toHaveText(["Zeitraum: Letzte 12 Monate", "Suche: „Hausverwaltung“"]);
});

test("on a phone the chat is a sheet over the dimmed page that fits 375 px", async ({ browser }) => {
  const phone = await signedInPage(browser, { phone: true });
  await phone.goto("/");
  await phone.waitForLoadState("networkidle");
  await phone.getByRole("button", { name: "Menü" }).click();
  const chat = await openChat(phone);
  await expectModal(phone);
  const sheet = await chat.boundingBox();
  expect(sheet?.x).toBe(0);
  expect(sheet?.width).toBe(375);
  expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBe(812);
  await expectNoHorizontalScroll(phone);
  await expectNoAxeViolations(phone, "KI-Sheet 375 px");
  await ask(chat, "Zeig mir die Zahlungen an die Hausverwaltung");
  await expect(chat.getByText(/^Ich habe \d+ Buchungen gefunden\.$/)).toBeVisible();
  await expect(phone).toHaveURL(/\/$/);
  for (const name of ["Verlauf", "Schließen", "Diktieren", "Senden", "In Buchungen anzeigen"]) {
    const box = await chat.getByRole(name === "In Buchungen anzeigen" ? "link" : "button", { name, exact: true }).boundingBox();
    expect(box?.width, name).toBeGreaterThanOrEqual(44);
    expect(box?.height, name).toBeGreaterThanOrEqual(44);
  }
  await expectNoHorizontalScroll(phone);
  await expectNoAxeViolations(phone, "KI-Sheet 375 px mit Antwort");
  await chat.getByRole("link", { name: "In Buchungen anzeigen" }).click();
  await expect(chat).toBeHidden();
  await expect(phone).toHaveURL(/\/buchungen\?/);
  await expect(phone.getByRole("button", { name: "Menü" })).toHaveAttribute("aria-expanded", "false");
  await expect(phone.getByRole("region", { name: "Summen aller gefilterten Buchungen" })).toBeVisible();
  await expectNoHorizontalScroll(phone);
  await phone.context().close();
});

test("the history lists saved chats to reopen, continue, rename and delete", async () => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const chat = await openChat(page);
  const history = chat.getByRole("button", { name: "Verlauf" });
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "true");
  const items = chat.locator(".chat-history-item");
  const open = (title: string) => items.getByRole("button", { name: new RegExp(`^${title}`) });
  await expect(items).toHaveCount(5);
  await expect(open("Dauert das lange")).toHaveCount(1);
  await expect(open("Zeig mir die Zahlungen an die Hausverwaltung")).toHaveCount(2);
  await expect(open("Wofür geben wir am meisten aus")).toHaveCount(2);
  await expect(chat.getByText("Gespräche werden 90 Tage nach der letzten Frage gelöscht.")).toBeVisible();
  await expectNoAxeViolations(page, "KI-Verlauf");

  // Newest first: the second "Zeig mir" chat is the one with the follow-ups; reopened, it shows every message.
  await open("Zeig mir die Zahlungen an die Hausverwaltung").nth(1).click();
  await expect(chat.getByRole("textbox", { name: "Frage" })).toBeFocused();
  await expect(chat.getByText("Davon nur über 50 €")).toBeVisible();
  await expect(chat.getByText("Und im September?")).toBeVisible();
  await expect(chat.getByRole("link", { name: "In Buchungen anzeigen" })).toHaveCount(3);
  await expect(chat.getByText("Abgefragt: 1 Abfrage")).toHaveCount(3);
  await expect(chat.locator(".chat-usage")).toHaveCount(3);
  await expect(chat.locator(".chat-usage").first()).toContainText("2 Anfragen, zusammen 2.888 Tokens");

  const before = requests.length;
  await ask(chat, "Danke!");
  await expect(chat.getByText("Gern geschehen.")).toBeVisible();
  const sent = (requests[before]?.messages ?? []).map((m) => m.content);
  expect(sent).toContain("Zeig mir die Zahlungen an die Hausverwaltung");
  expect(sent).toContain("Und im September?");
  expect(sent.at(-1)).toBe("Danke!");

  // The continued chat is now the newest.
  await history.click();
  await items
    .first()
    .getByRole("button", { name: /^Aktionen für Zeig mir/ })
    .click();
  await page.getByRole("menuitem", { name: "Umbenennen" }).click();
  await chat.getByRole("textbox", { name: "Titel" }).fill("Hausverwaltung");
  await chat.getByRole("button", { name: "Speichern" }).click();
  await expect(open("Hausverwaltung")).toHaveCount(1);

  await items.getByRole("button", { name: "Aktionen für Hausverwaltung" }).click();
  await page.getByRole("menuitem", { name: "Löschen" }).click();
  await page.getByRole("dialog", { name: "Gespräch „Hausverwaltung“ löschen?" }).getByRole("button", { name: "Gespräch löschen" }).click();
  await expect(chat.getByText("„Hausverwaltung“ gelöscht.")).toBeVisible();
  await expect(items).toHaveCount(4);

  await chat.getByRole("button", { name: "Gesamten Verlauf löschen" }).click();
  await page.getByRole("dialog", { name: "Alle 4 Gespräche löschen?" }).getByRole("button", { name: "Gesamten Verlauf löschen" }).click();
  await expect(chat.getByText("Noch keine gespeicherten Gespräche.")).toBeVisible();
  await chat.getByRole("button", { name: "Schließen", exact: true }).click();
});

test("the AI details under an answer can be turned off and on again in Darstellung", async () => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  let chat = await openChat(page);
  await ask(chat, "Danke!");
  await expect(chat.getByText("Gern geschehen.")).toBeVisible();
  await expect(chat.locator(".chat-usage")).toHaveText(/^1\.234 Tokens Kontext · 210 Antwort · 3,9\s%\svon 32k Kontext$/);
  await page.keyboard.press("Escape");

  await page.goto("/persoenlich/darstellung");
  const setting = page.getByRole("checkbox", { name: "KI-Details anzeigen (Tokens, Kontext)" });
  await expect(setting).toBeChecked();
  await expect(setting).toHaveAccessibleDescription(/Gilt nur in diesem Browser/);
  await setting.uncheck();
  await expectNoAxeViolations(page, "Darstellung mit KI-Details");

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  chat = await openChat(page);
  await ask(chat, "Danke!");
  await expect(chat.getByText("Gern geschehen.")).toBeVisible();
  await expect(chat.locator(".chat-usage")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/persoenlich/darstellung");
  await page.getByRole("checkbox", { name: "KI-Details anzeigen (Tokens, Kontext)" }).check();
});

/** A stand-in for the browser's speech recognition; `window.speech` says things and fails on demand. */
const FAKE_SPEECH = `
(() => {
  const state = { current: null };
  class FakeRecognition {
    constructor() { this.results = []; }
    start() { state.current = this; }
    stop() { const self = this; setTimeout(() => { if (state.current === self) state.current = null; self.onend && self.onend(); }, 10); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.speech = {
    say(text, isFinal) {
      const r = state.current;
      if (!r) throw new Error("not recording");
      const last = r.results[r.results.length - 1];
      if (last && !last.isFinal) r.results.pop();
      r.results.push({ isFinal, 0: { transcript: text }, length: 1 });
      r.onresult && r.onresult({ results: r.results });
    },
    fail(error) {
      const r = state.current;
      state.current = null;
      r.onerror && r.onerror({ error });
      r.onend && r.onend();
    },
  };
})();
`;

type Speech = { speech: { say(text: string, isFinal: boolean): void; fail(error: string): void } };

test("dictation is hidden without speech recognition and works by tap, held pointer and held Space", async ({ browser }) => {
  const without = await signedInPage(browser, { init: "delete window.SpeechRecognition; delete window.webkitSpeechRecognition;" });
  await without.goto("/");
  await without.waitForLoadState("networkidle");
  const plain = await openChat(without);
  await expect(plain.getByRole("textbox", { name: "Frage" })).toBeVisible();
  await expect(plain.getByRole("button", { name: "Diktieren" })).toHaveCount(0);
  await expect(plain.locator(".chat-composer").getByRole("button", { name: "Senden" })).toBeVisible();
  await without.context().close();

  const p = await signedInPage(browser, { init: FAKE_SPEECH });
  await p.goto("/");
  await p.waitForLoadState("networkidle");
  const chat = await openChat(p);
  const mic = chat.getByRole("button", { name: "Diktieren" });
  const field = chat.getByRole("textbox", { name: "Frage" });
  const say = (text: string, isFinal: boolean) =>
    p.evaluate(([t, f]) => (window as unknown as Speech).speech.say(t, f), [text, isFinal] as const);
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toHaveAccessibleDescription(/Gedrückt halten zum Sprechen/);
  // Mic and send sit inside the question field, as icons with names.
  await expect(chat.locator(".chat-composer").getByRole("button", { name: "Diktieren" })).toBeVisible();
  await expect(chat.locator(".chat-composer").getByRole("button", { name: "Senden" })).toBeVisible();
  await expect(chat.getByRole("checkbox")).toHaveCount(0);

  // The first use explains where the audio goes and records nothing yet.
  await mic.click();
  await expect(chat.getByText("Dabei kann der Hersteller des Browsers die Aufnahme auf seinen Servern verarbeiten")).toBeVisible();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await chat.getByRole("button", { name: "Verstanden" }).click();
  await expect(mic).toBeFocused();
  await expectNoAxeViolations(p, "Diktieren bereit");

  // A tap records until the next tap; interim words appear live and stay editable.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(chat.getByRole("status").filter({ hasText: "Aufnahme läuft" })).toBeVisible();
  await say("Wofür geben", false);
  await expect(field).toHaveValue("Wofür geben");
  await say("Wofür geben wir am meisten aus", true);
  await expectNoAxeViolations(p, "Diktieren läuft");
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(chat.getByRole("status").filter({ hasText: "Aufnahme beendet" })).toBeVisible();
  await expect(field).toHaveValue("Wofür geben wir am meisten aus");
  await expect(field).toBeEditable();

  // Push-to-talk: a press held longer than a tap stops on release.
  const box = await mic.boundingBox();
  await p.mouse.move((box?.x ?? 0) + 10, (box?.y ?? 0) + 10);
  await p.mouse.down();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await p.waitForTimeout(500);
  await say("im Oktober", true);
  await p.mouse.up();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(field).toHaveValue("Wofür geben wir am meisten aus im Oktober");

  // Space held while the button is focused works the same.
  await mic.focus();
  await p.keyboard.down("Space");
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await p.waitForTimeout(500);
  await say("bitte", true);
  await p.keyboard.up("Space");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(field).toHaveValue("Wofür geben wir am meisten aus im Oktober bitte");

  // A denied microphone says so clearly.
  await mic.click();
  await p.evaluate(() => (window as unknown as Speech).speech.fail("not-allowed"));
  await expect(chat.getByRole("alert")).toHaveText(/Kein Zugriff auf das Mikrofon/);
  await expect(mic).toHaveAttribute("aria-pressed", "false");

  // Without interim results the words arrive once at the end; nothing is sent until the person sends it.
  await field.fill("");
  await mic.click();
  await say("Danke", true);
  await mic.click();
  await expect(field).toHaveValue("Danke");
  await expect(chat.getByText("Gern geschehen.")).toHaveCount(0);
  await chat.locator(".chat-composer").getByRole("button", { name: "Senden" }).click();
  await expect(chat.getByText("Gern geschehen.")).toBeVisible();
  await p.context().close();
});
