import { Fragment, type ReactNode } from "react";
import { parseBlocks, parseInline } from "../lib/markdown.ts";
import { MaskedText } from "./Bits.tsx";

function Inline({ text }: { text: string }): ReactNode {
  return parseInline(text).map((part, i) => {
    const content = <MaskedText text={part.text} />;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
    if (part.type === "strong") return <strong key={i}>{content}</strong>;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
    if (part.type === "em") return <em key={i}>{content}</em>;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
    if (part.type === "code") return <code key={i}>{part.text}</code>;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
    return <Fragment key={i}>{content}</Fragment>;
  });
}

/** Renders an AI answer's Markdown as plain React elements; headings become bold paragraphs so they stay out of the page outline. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((block, i) => {
        const key = `${block.type}-${i}`;
        if (block.type === "h")
          return (
            <p key={key} className="md-h">
              <strong>
                <Inline text={block.text} />
              </strong>
            </p>
          );
        if (block.type === "code") return <pre key={key}>{block.text}</pre>;
        if (block.type !== "p") {
          const List = block.type;
          return (
            <List key={key}>
              {block.items.map((item, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: list items of one immutable answer
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={key}>
            {block.lines.map((line, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one immutable paragraph
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
