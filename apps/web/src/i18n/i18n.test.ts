import { describe, expect, expectTypeOf, it } from "vitest";
import { formatter } from "../lib/format.ts";
import { formatMessage, LOCALES, MESSAGES, type MessageKey, matchAcceptLanguage, msg, resolveLocale, t, translate } from "./index.ts";

type Tree = { [key: string]: string | Tree };

function leaves(node: Tree, prefix = ""): Map<string, string | Tree> {
  const out = new Map<string, string | Tree>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" || "other" in value) out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (value: string | Tree) =>
  [...new Set([...(typeof value === "string" ? [value] : Object.values(value)).join(" ").matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

const source = leaves(MESSAGES.de as unknown as Tree);

describe("locale resolution", () => {
  it("picks the best supported language by quality", () => {
    expect(matchAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7")).toBe("fr");
    expect(matchAcceptLanguage("es-ES,es;q=0.9,it;q=0.5,en;q=0.6")).toBe("en");
    expect(matchAcceptLanguage("en-US;q=0.2, it-IT")).toBe("it");
    expect(matchAcceptLanguage("es, pt;q=0.8, *;q=0.1")).toBeNull();
    expect(matchAcceptLanguage("de;q=0, en;q=0.1")).toBe("en");
    expect(matchAcceptLanguage(undefined)).toBeNull();
  });

  it("prefers the user's choice, then the browser, then German", () => {
    expect(resolveLocale("it", "en-GB")).toBe("it");
    expect(resolveLocale(null, "en-GB,en;q=0.9")).toBe("en");
    expect(resolveLocale(null, "ja-JP")).toBe("de");
    expect(resolveLocale(undefined, null)).toBe("de");
  });
});

describe("translate", () => {
  it("interpolates variables and formats numbers in the locale", () => {
    expect(t("de", "shell.notificationsUnread", { count: 1234 })).toBe("Benachrichtigungen (1.234 ungelesen)");
    expect(t("en", "shell.notificationsUnread", { count: 1234 })).toBe("Notifications (1,234 unread)");
    expect(t("en", "users.editTitle", { username: "lena" })).toBe("Edit lena");
  });

  it("chooses plural forms with Intl.PluralRules", () => {
    const de = { one: "{count} Buchung", other: "{count} Buchungen" };
    const fr = { one: "{count} opération", other: "{count} opérations" };
    expect(formatMessage("de", de, { count: 1 })).toBe("1 Buchung");
    expect(formatMessage("de", de, { count: 0 })).toBe("0 Buchungen");
    expect(formatMessage("de", de, { count: 2000 })).toBe("2.000 Buchungen");
    // French treats 0 and 1 as singular.
    expect(formatMessage("fr", fr, { count: 0 })).toBe("0 opération");
    expect(formatMessage("fr", fr, { count: 1.5 })).toBe("1,5 opération");
    expect(formatMessage("en", { zero: "Nothing", one: "One", other: "{count}" }, { count: 0 })).toBe("Nothing");
  });

  it("renders nested translatable variables in the same language", () => {
    const inner = msg("users.errors.lastSuperuser");
    expect(translate("en", "shell.signOutFailedWith", { reason: inner })).toBe("Signing out failed: There must be at least one superuser");
  });

  it("falls back to German, then to the key", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
  });

  it("types keys and variables", () => {
    expectTypeOf(t).parameter(1).toEqualTypeOf<MessageKey>();
    // @ts-expect-error unknown key
    t("de", "shell.nope");
    // @ts-expect-error missing variable
    t("de", "users.editTitle");
  });
});

describe("messages", () => {
  for (const locale of LOCALES.filter((l) => l !== "de")) {
    it(`${locale} has every key with the same placeholders`, () => {
      const target = leaves(MESSAGES[locale] as unknown as Tree);
      expect([...target.keys()].sort()).toEqual([...source.keys()].sort());
      for (const [key, value] of source) {
        const other = target.get(key);
        expect(typeof other, key).toBe(typeof value);
        expect(placeholders(other ?? ""), key).toEqual(placeholders(value));
      }
    });
  }

  it("has no empty messages", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(MESSAGES[locale] as unknown as Tree)) {
        for (const text of typeof value === "string" ? [value] : Object.values(value))
          expect(String(text).trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("uses French spacing before high punctuation and inside guillemets", () => {
    for (const [key, value] of leaves(MESSAGES.fr as unknown as Tree)) {
      for (const text of typeof value === "string" ? [value] : (Object.values(value) as string[])) {
        // A URL or placeholder may contain ":" or "?" without a space; only flag text that has a space instead of a no-break one.
        expect(text, key).not.toMatch(/ [;:!?»]/);
        expect(text, key).not.toMatch(/« /);
        expect(text, key).not.toMatch(/[^\s  (]«|«[^ ]|[^ ]»/);
      }
    }
  });
});

describe("formatter", () => {
  it("formats money and dates per locale", () => {
    expect(formatter("de").euro(123456)).toBe("1.234,56 €");
    expect(formatter("en").euro(123456)).toBe("€1,234.56");
    expect(formatter("fr").euro(123456)).toBe("1 234,56 €");
    expect(formatter("it").euro(123456)).toBe("1234,56 €");
    expect(formatter("de").date("2026-11-16")).toBe("16.11.2026");
    expect(formatter("en").date("2026-11-16")).toBe("16/11/2026");
    expect(formatter("de").signed(-500)).toBe("−5,00 €");
    expect(formatter("fr").monthLong("2026-03")).toBe("mars 2026");
  });
});
