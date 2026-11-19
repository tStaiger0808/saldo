/** The small Markdown subset AI answers use. Everything stays text: no HTML, no links, nothing is executed. */
export type MdBlock =
  | { type: "p"; lines: string[] }
  | { type: "h"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; text: string };

export type MdInline = { type: "text" | "strong" | "em" | "code"; text: string };

const FENCE = /^\s*```/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line);

export function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "h", text: heading[1] ?? "" });
      i += 1;
      continue;
    }
    const marker = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (marker) {
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const item = marker.exec(current);
        if (item) items.push(item[1] ?? "");
        // An indented line without a marker continues the previous item.
        else if (/^\s{2,}\S/.test(current) && items.length > 0) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        i += 1;
      }
      blocks.push({ type: marker === BULLET ? "ul" : "ol", items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock(lines[i] ?? "")) paragraph.push((lines[i++] ?? "").trim());
    blocks.push({ type: "p", lines: paragraph });
  }
  return blocks;
}

// Underscores are left alone: they appear in references and IDs far more often than as emphasis.
const INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+`|\*[^*\s][^*\n]*?\*)/;

export function parseInline(text: string): MdInline[] {
  return text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return { type: "strong", text: part.slice(2, -2) };
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return { type: "code", text: part.slice(1, -1) };
      if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return { type: "em", text: part.slice(1, -1) };
      return { type: "text", text: part };
    });
}
