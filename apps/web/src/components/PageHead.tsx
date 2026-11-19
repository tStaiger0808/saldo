import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useT } from "../i18n/react.tsx";
import { useBankJobsOptional } from "./BankJobs.tsx";

/** Keeps `--page-head-h` at the head's height, so content scrolled to (focus, anchors) stops below the sticky head. */
function useStickyHeight(head: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = head.current;
    if (!node) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty("--page-head-h", `${node.offsetHeight}px`));
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--page-head-h");
    };
  }, [head]);
}

const CONDENSE_AT = 48;
const EXPAND_AT = 8;

/**
 * Shrinks the head to one line once the page is scrolled, so more of the content stays visible. The two thresholds keep
 * it from flickering at the edge, and a page only slightly taller than the window never condenses: the smaller head
 * would make it fit and expand it again.
 */
function useCondensed(head: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = head.current;
    if (!node) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      const condensed = node.hasAttribute("data-condensed");
      if (!condensed && y > CONDENSE_AT && room > CONDENSE_AT + node.offsetHeight) node.setAttribute("data-condensed", "");
      else if (condensed && y < EXPAND_AT) node.removeAttribute("data-condensed");
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [head]);
}

/**
 * Sticky head of every page: title with the eyebrow (the view or period it shows), and the page actions on the right (primary action last). `section` names
 * the part of the page in the document title.
 */
export function PageHead({
  eyebrow,
  title,
  section,
  actions,
}: {
  eyebrow?: ReactNode;
  title: string;
  section?: string;
  actions?: ReactNode;
}) {
  const t = useT();
  const head = useRef<HTMLElement>(null);
  const documentTitle = t("shell.pageTitle", { title: section ? `${section} – ${title}` : title });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
  useStickyHeight(head);
  useCondensed(head);
  return (
    <header ref={head} className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
      <SyncProgress />
    </header>
  );
}

/** A thin running bar under the head while any bank sync runs; the start and end are announced by BankJobsProvider. */
function SyncProgress() {
  const t = useT();
  const jobs = useBankJobsOptional();
  if (!jobs?.running) return null;
  return <div className="sync-progress" role="progressbar" aria-label={t("banking.sync.running")} />;
}
