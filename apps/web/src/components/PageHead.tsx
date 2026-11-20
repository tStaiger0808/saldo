import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useT } from "../i18n/react.tsx";
import { ActionMenu, type ActionMenuEntry, type ActionMenuItem } from "./ActionMenu.tsx";
import { useBankJobsOptional } from "./BankJobs.tsx";
import { Field } from "./Field.tsx";
import { Icon, type IconName } from "./Icon.tsx";

/**
 * Something the page does. On phones only the primary action keeps a button of its own (just its icon); every other
 * one moves into the head's "⋯" menu.
 */
export type PageAction = {
  label: string;
  /** Different for every action of a head; it identifies the action while its label changes. */
  icon: IconName;
  /** The filled button; at most one per page, listed last. */
  primary?: boolean;
  /** A download link instead of a button. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** A request or run in progress; the icon turns. */
  busy?: boolean;
  title?: string;
  keyshortcuts?: string;
};

/** A choice of what the page shows: a segmented control or a select, and on phones radio items in "⋯". */
export type PageChoice = {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  display: "segmented" | "select";
  /** Shown after the eyebrow on phones, where the control itself is out of sight. */
  summary?: string;
  /** Next to the control, e.g. the button that changes a custom range. */
  extra?: ReactNode;
};

/** Menu items of the page's subject, in a "⋯" button named after it on every screen. */
export type PageMenu = { name: string; items: (ActionMenuItem | false | null | undefined)[] };

type Maybe<T> = T | false | null | undefined;

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
 * Sticky head of every page: title with the eyebrow (the view or period it shows), and the page's choices, actions and
 * menu on the right. Phones keep the head to one row: the primary action as an icon button and everything else in a
 * single "⋯" menu. `section` names the part of the page in the document title.
 */
export function PageHead({
  eyebrow,
  title,
  section,
  actions = [],
  choices = [],
  menu,
}: {
  eyebrow?: ReactNode;
  title: string;
  section?: string;
  actions?: Maybe<PageAction>[];
  choices?: Maybe<PageChoice>[];
  menu?: PageMenu;
}) {
  const t = useT();
  const head = useRef<HTMLElement>(null);
  const documentTitle = t("shell.pageTitle", { title: section ? `${section} – ${title}` : title });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
  useStickyHeight(head);
  useCondensed(head);
  const shownActions = actions.filter((a): a is PageAction => Boolean(a));
  const shownChoices = choices.filter((c): c is PageChoice => Boolean(c));
  const summaries = shownChoices.flatMap((c) => c.summary ?? []);
  const primary = shownActions.filter((a) => a.primary);
  const overflow: ActionMenuEntry[] = [
    ...shownActions.filter((a) => !a.primary).map(toMenuItem),
    ...shownChoices.map((c) => ({
      group: c.label,
      items: c.options.map((o) => ({ label: o.label, checked: o.value === c.value, onSelect: () => c.onChange(o.value) })),
    })),
    ...(menu?.items.filter((item): item is ActionMenuItem => Boolean(item)) ?? []),
  ];
  const menuLabel = menu ? t("common.actionsFor", { name: menu.name }) : t("common.moreActions");
  const wide = shownChoices.length + shownActions.length > 0 || Boolean(menu);
  return (
    <header ref={head} className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {(eyebrow || summaries.length > 0) && (
          <div className="eyebrow">
            {eyebrow}
            {summaries.length > 0 && (
              <span className="page-head-summary">
                {eyebrow ? " · " : ""}
                {summaries.join(" · ")}
              </span>
            )}
          </div>
        )}
      </div>
      {wide && (
        <div className="actions">
          {shownChoices.map((choice) => (
            <ChoiceControl key={choice.label} choice={choice} />
          ))}
          {shownActions.map((action) => (
            <ActionButton key={action.icon} action={action} />
          ))}
          {menu && <ActionMenu label={menuLabel} items={menu.items} />}
        </div>
      )}
      {(primary.length > 0 || overflow.length > 0) && (
        <div className="page-head-compact">
          {primary.map((action) => (
            <ActionButton key={action.icon} action={action} iconOnly />
          ))}
          {overflow.length > 0 && <ActionMenu label={menuLabel} items={overflow} />}
        </div>
      )}
      <SyncProgress />
    </header>
  );
}

function toMenuItem(action: PageAction): ActionMenuItem {
  const { href, onSelect } = action;
  return {
    label: action.label,
    disabled: action.disabled,
    onSelect: href ? () => window.location.assign(href) : (onSelect ?? (() => {})),
  };
}

function ActionButton({ action, iconOnly = false }: { action: PageAction; iconOnly?: boolean }) {
  const className = ["btn", action.primary && "btn-primary", iconOnly && "btn-icon"].filter(Boolean).join(" ");
  const content = (
    <>
      <Icon name={action.icon} size={18} />
      {iconOnly ? <span className="visually-hidden">{action.label}</span> : ` ${action.label}`}
    </>
  );
  const title = action.title ?? (iconOnly ? action.label : undefined);
  if (action.href) {
    return (
      <a className={className} href={action.href} download title={title} aria-keyshortcuts={action.keyshortcuts}>
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={action.disabled}
      aria-busy={action.busy || undefined}
      title={title}
      aria-keyshortcuts={action.keyshortcuts}
      onClick={action.onSelect}
    >
      {content}
    </button>
  );
}

function ChoiceControl({ choice }: { choice: PageChoice }) {
  const control =
    choice.display === "segmented" ? (
      // biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset
      <div className="segmented" role="group" aria-label={choice.label}>
        {choice.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === choice.value}
            onClick={() => choice.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    ) : (
      <Field label={choice.label} className="field-inline">
        {(props) => (
          <select {...props} value={choice.value} onChange={(event) => choice.onChange(event.target.value)}>
            {choice.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  if (!choice.extra) return control;
  return (
    <div className="page-choice">
      {control}
      {choice.extra}
    </div>
  );
}

/** A thin running bar under the head while any bank sync runs; the start and end are announced by BankJobsProvider. */
function SyncProgress() {
  const t = useT();
  const jobs = useBankJobsOptional();
  if (!jobs?.running) return null;
  return <div className="sync-progress" role="progressbar" aria-label={t("banking.sync.running")} />;
}
