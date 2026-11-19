import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown.ts";

describe("AI answer formatting", () => {
  it("splits paragraphs, headings, lists and code", () => {
    const text =
      "## Ergebnis\nDie größte Buchung:\n\n- **649,59 €** an Staiger\n- 330,00 €\n  (Nebenkosten)\n\n1. eins\n2. zwei\n\n```\nraw *x*\n```";
    expect(parseBlocks(text)).toEqual([
      { type: "h", text: "Ergebnis" },
      { type: "p", lines: ["Die größte Buchung:"] },
      { type: "ul", items: ["**649,59 €** an Staiger", "330,00 € (Nebenkosten)"] },
      { type: "ol", items: ["eins", "zwei"] },
      { type: "code", text: "raw *x*" },
    ]);
  });

  it("marks bold, italic and code but leaves underscores and HTML as text", () => {
    expect(parseInline("**„Ohne Kategorie“ mit 1.337,54 €** – *ca.* `x` IBAN_DE <b>")).toEqual([
      { type: "strong", text: "„Ohne Kategorie“ mit 1.337,54 €" },
      { type: "text", text: " – " },
      { type: "em", text: "ca." },
      { type: "text", text: " " },
      { type: "code", text: "x" },
      { type: "text", text: " IBAN_DE <b>" },
    ]);
  });
});
