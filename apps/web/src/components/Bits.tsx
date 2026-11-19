import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { useFormat, useT } from "../i18n/react.tsx";
import { maskAmounts, splitAmounts, useAmountsHidden } from "../lib/amounts.ts";
import { Icon } from "./Icon.tsx";

/** Copies text; the result is announced and shown in the button for a moment. */
export function CopyButton({ text, label, className = "btn" }: { text: string; label?: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(null), 2000);
  }
  return (
    <button type="button" className={className} onClick={copy}>
      <Icon name={copied === "ok" ? "check" : "copy"} size={18} />
      <span aria-live="polite">
        {copied === "ok" ? t("common.copied") : copied === "fail" ? t("common.copyFailed") : (label ?? t("common.copy"))}
      </span>
    </button>
  );
}

/** Internal transfers stay out of the view's totals; external ones count like a payment ("Übertrag an …"). */
export function TransferBadge({ kind, label }: { kind: "internal" | "external" | null; label: string | null }) {
  const t = useT();
  if (!kind) return null;
  if (kind === "external") return <span className="transfer transfer-out">{label ?? t("common.transfer")}</span>;
  return <span className="transfer">{t("common.internalTransfer")}</span>;
}

/** Who set a booking's category: the person, the AI or a rule; the visible word is short, the read text says what it is. */
export function CategoryOrigin({ source }: { source: "manual" | "ai" | "rule" | null }) {
  const t = useT();
  if (!source) return null;
  return (
    <span className="muted small">
      <span className="visually-hidden">{t("transactions.categoryOrigin")} </span>
      {t(`labels.categorySource.${source}`)}
    </span>
  );
}

export function NewMark() {
  const t = useT();
  return <span className="new-mark">{t("common.newMark")}</span>;
}

const CURRENCY_SIGN = /[^\d\s\u00a0\u202f.,'’+\-−]+/u;

/** The amount with its currency sign in a smaller, quieter span, as key figures show it. */
function WithUnit({ text }: { text: string }) {
  const sign = CURRENCY_SIGN.exec(text);
  if (!sign) return text;
  return (
    <>
      {text.slice(0, sign.index)}
      <span className="figure-unit">{sign[0]}</span>
      {text.slice(sign.index + sign[0].length)}
    </>
  );
}

/**
 * A formatted money amount. While amounts are hidden it shows as a bar of fixed width (CSS on `.money`), cannot be
 * selected, and screen readers hear a placeholder instead. `unit` sets the currency sign smaller, for key figures.
 */
export function Money({ children, className, unit = false }: { children: string; className?: string; unit?: boolean }) {
  const t = useT();
  const hidden = useAmountsHidden();
  return (
    <span className={className}>
      <span className="money" aria-hidden={hidden || undefined}>
        {unit ? <WithUnit text={children} /> : children}
      </span>
      {hidden && <span className="visually-hidden">{t("common.amountHidden")}</span>}
    </span>
  );
}

/** Free text such as a notification or an AI answer, with the money amounts in it hidden like `Money`. */
export function MaskedText({ text }: { text: string }): ReactNode {
  return splitAmounts(text).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
    part.money ? <Money key={i}>{part.text}</Money> : <Fragment key={i}>{part.text}</Fragment>,
  );
}

/** For text that can only be a string (`aria-label`): replaces the amounts in it while amounts are hidden. */
export function useMaskAmounts(): (text: string) => string {
  const t = useT();
  const hidden = useAmountsHidden();
  return (text) => (hidden ? maskAmounts(text, t("common.amountHidden")) : text);
}

/** The colour class of a money flow: green coming in, red going out, none for zero. The sign is always in the text too. */
export function amountTone(cents: number): string {
  return cents > 0 ? "amount amount-in" : cents < 0 ? "amount amount-out" : "amount";
}

/** A money flow (booking, sum, monthly figure) with its sign and its colour. */
export function Amount({ cents, currency, unit = false }: { cents: number; currency?: string; unit?: boolean }) {
  const f = useFormat();
  return (
    <Money className={amountTone(cents)} unit={unit}>
      {f.signed(cents, currency)}
    </Money>
  );
}

/** An account balance is a state, not a flow: neutral without a plus sign, red with a real minus when negative. */
export function Balance({ cents, unit = false }: { cents: number | null; unit?: boolean }) {
  const f = useFormat();
  if (cents === null) return <span className="amount">–</span>;
  return (
    <Money className={cents < 0 ? "amount amount-out" : "amount"} unit={unit}>
      {cents < 0 ? f.signed(cents) : f.euro(cents)}
    </Money>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}

/** The table's caption, its labelling element or the heading of the section around it. */
function tableName(wrap: HTMLElement): string | undefined {
  const table = wrap.querySelector("table");
  const labelledBy = table?.getAttribute("aria-labelledby");
  const source =
    table?.querySelector("caption") ??
    (labelledBy ? document.getElementById(labelledBy) : null) ??
    wrap.parentElement?.closest("section")?.querySelector("h2, h3");
  return source?.textContent?.trim() || undefined;
}

/**
 * Holds a table that may be wider than the screen. While it scrolls sideways it is a named region in the tab order,
 * so it can be scrolled with the keyboard (WCAG 2.1.1); otherwise it adds no tab stop.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  const wrap = useRef<HTMLElement>(null);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    const check = () => setName(node.scrollWidth > node.clientWidth + 1 ? (tableName(node) ?? "") : null);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return (
    <section ref={wrap} className="table-wrap" tabIndex={name === null ? undefined : 0} aria-label={name || undefined}>
      {children}
    </section>
  );
}
