import { describe, expect, it } from "vitest";
import { translator } from "../i18n/index.ts";
import { auditCsvUrl, describeAudit, parseAuditSearch } from "./audit.ts";
import { formatter } from "./format.ts";

const line = (locale: "de" | "en", action: string, details: Record<string, string | number | boolean | null | string[]>) =>
  describeAudit(translator(locale), formatter(locale), locale, { action, details });

describe("audit texts", () => {
  it("reads an event as action and key details", () => {
    expect(
      line("de", "ai.analysis", {
        provider: "OpenAI",
        model: "gpt-5-nano",
        inputTokens: 1200,
        outputTokens: 34,
        costMicro: 74,
        currency: "USD",
      }),
    ).toBe("KI-Analyse · OpenAI · gpt-5-nano · 1.234 Tokens · ≈ 0,0001\u00a0$");
    expect(line("en", "auth.signIn", { attemptedUsername: "lena" })).toBe("Sign-in · User name “lena”");
    expect(line("de", "users.updated", { name: "Lena", role: "admin", groups: [] })).toBe(
      "Benutzer geändert · Lena · Rolle: Super-User · Keine Gruppen",
    );
    expect(line("de", "bank.syncFinished", { name: "DKB", trigger: "scheduled", reason: "banking.job.cancelled" })).toMatch(
      /^Abruf beendet · DKB · Geplant · /,
    );
    expect(line("de", "bank.connectionUpdated", { name: "ING", changed: ["pin", "unknown"] })).toBe(
      "Bankverbindung geändert · ING · Geändert: PIN",
    );
    expect(line("de", "ai.categorize", { provider: "OpenAI", tagsCreated: 2 })).toBe("KI-Kategorisierung · OpenAI · 2 neue Tags");
    expect(line("de", "ai.categorize", { provider: "OpenAI", tagsCreated: 0 })).toBe("KI-Kategorisierung · OpenAI");
    expect(line("en", "settings.aiSettingsChanged", { assignTags: true, createTags: false, maxNewTags: 5 })).toBe(
      "AI settings changed · AI assigns tags: on · AI creates tags: off · At most 5 new tags per run",
    );
    expect(line("de", "something.else", {})).toBe("something.else");
  });

  it("keeps only valid filters in the address and the CSV link", () => {
    const search = parseAuditSearch({ bereich: "ai", ergebnis: "nope", von: "2026-11-01", bis: "11/30/2026", q: "  nano ", benutzer: "" });
    expect(search).toEqual({ bereich: "ai", von: "2026-11-01", q: "nano" });
    expect(auditCsvUrl(search)).toBe("/api/audit/export.csv?category=ai&from=2026-11-01&q=nano");
    expect(auditCsvUrl({})).toBe("/api/audit/export.csv");
  });
});
