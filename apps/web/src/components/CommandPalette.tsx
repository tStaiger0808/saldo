import { useNavigate, useRouter } from "@tanstack/react-router";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { MessageKey } from "../i18n/index.ts";
import { useI18n } from "../i18n/react.tsx";
import { useAmountsHidden } from "../lib/amounts.ts";
import { filterToSearch } from "../lib/booking-filter.ts";
import type { Role } from "../lib/labels.ts";
import { ibanEndsWith, matches, parseAmountQuery, readRecent, rememberRecent } from "../lib/palette.ts";
import { PERSONAL_SECTIONS, sectionsFor } from "../lib/settings.ts";
import { matchShortcut, SHORTCUTS, type ShortcutId } from "../lib/shortcuts.ts";
import { getAccounts } from "../server/functions/accounts.ts";
import { getCategories, getTags } from "../server/functions/catalog.ts";
import { getContractsFn } from "../server/functions/contracts.ts";
import { getSavedFiltersFn } from "../server/functions/saved-filters.ts";
import { getTransactions } from "../server/functions/transactions.ts";
import { Amount, Balance, Money } from "./Bits.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { runShortcut, SHORTCUT_LABELS, useAvailableShortcuts, useKeyText, useShortcut, useShortcutHint } from "./Shortcuts.tsx";
import type { TransactionItem } from "./TransactionDrawer.tsx";

type Accounts = Awaited<ReturnType<typeof getAccounts>>;
type Data = {
  accounts: Accounts;
  contracts: Awaited<ReturnType<typeof getContractsFn>>["items"];
  categories: Awaited<ReturnType<typeof getCategories>>;
  tags: Awaited<ReturnType<typeof getTags>>;
  filters: Awaited<ReturnType<typeof getSavedFiltersFn>>;
};

type Entry = {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  trail?: ReactNode;
  /** The account's colour as a bar at the start of the option. */
  color?: string;
  keys?: string | null;
  run: () => void;
};
type Section = { id: string; title: string; entries: Entry[] };

const MAX_PER_GROUP = 5;
const BOOKING_DELAY_MS = 200;

const MAIN_PAGES = [
  { id: "go-overview", to: "/", label: "shell.overview", icon: "overview" },
  { id: "go-accounts", to: "/konten", label: "accounts.title", icon: "wallet" },
  { id: "go-transactions", to: "/buchungen", label: "shell.transactions", icon: "list" },
  { id: "go-analysis", to: "/analyse", label: "shell.analysis", icon: "chart" },
  { id: "go-contracts", to: "/vertraege", label: "shell.contracts", icon: "contract" },
  { id: "go-settings", to: "/einstellungen", label: "shell.settings", icon: "settings" },
] as const satisfies readonly { id: ShortcutId; to: string; label: MessageKey; icon: IconName }[];

const ACTION_ICONS: Partial<Record<ShortcutId, IconName>> = {
  sync: "sync",
  chat: "chat",
  tasks: "tasks",
  notifications: "bell",
  help: "keyboard",
  search: "search",
  filter: "filter",
  "next-tab": "chevron-right",
  "prev-tab": "chevron-left",
};

const PAGE_SHORTCUTS = new Set<ShortcutId>(MAIN_PAGES.map((p) => p.id));

/** Remembers the pages the person opens for the palette's "recently opened". */
export function useRecentPages(pathname: string) {
  useEffect(() => rememberRecent(pathname), [pathname]);
}

/** "Suchen oder springen …" in the top bar; it opens the palette, so do its keys (Ctrl+K or ⌘K by default). */
export function PaletteLauncher({ role, tip }: { role: Role; tip: (label: string) => ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const keys = useKeyText().comboOf("palette");
  const hint = useShortcutHint("palette");
  useShortcut("palette", () => setOpen(true));
  return (
    <>
      <button
        type="button"
        className="nav-link nav-search"
        aria-haspopup="dialog"
        aria-keyshortcuts={hint.aria}
        onClick={() => setOpen(true)}
      >
        <Icon name="search" size={18} />
        <span className="nav-label">{t("shell.jump")}</span>
        {keys && (
          <span className="nav-kbd" aria-hidden="true">
            {keys}
          </span>
        )}
        {tip(hint.title(t("palette.title")))}
      </button>
      {open && <CommandPalette role={role} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Accounts, contracts, categories, tags and saved filters, loaded once each time the palette opens. */
function usePaletteData(): Data | null {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      getAccounts().catch((): Accounts => []),
      getContractsFn({ data: {} }).then(
        (r) => r.items,
        (): Data["contracts"] => [],
      ),
      getCategories().catch((): Data["categories"] => []),
      getTags().catch((): Data["tags"] => []),
      getSavedFiltersFn({ data: { scope: "transactions" } }).catch((): Data["filters"] => []),
    ]).then(([accounts, contracts, categories, tags, filters]) => {
      if (live) setData({ accounts, contracts, categories, tags, filters });
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** Bookings for the query from the server search, a moment after typing stops; answers to older queries are dropped. */
function useBookingSearch(query: string): { items: TransactionItem[]; pending: boolean } {
  const q = query.trim();
  const [result, setResult] = useState<{ q: string; items: TransactionItem[] }>({ q: "", items: [] });
  const latest = useRef(0);
  useEffect(() => {
    const request = ++latest.current;
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      const cents = parseAmountQuery(q);
      const filter = cents === null ? { q } : { absMinCents: cents, absMaxCents: cents };
      getTransactions({ data: { ...filter, limit: MAX_PER_GROUP } }).then(
        ({ items }) => request === latest.current && setResult({ q, items }),
        () => request === latest.current && setResult({ q, items: [] }),
      );
    }, BOOKING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [q]);
  if (q.length < 2) return { items: [], pending: false };
  return result.q === q ? { items: result.items, pending: false } : { items: [], pending: true };
}

/**
 * Spotlight-like search over pages, settings, accounts, bookings, contracts, categories, tags, saved filters and the
 * shortcuts' actions. A combobox with a grouped listbox: focus stays in the field, ↑/↓ move the active option, Enter
 * runs it. Only actions the person may use right now are offered, so nothing here writes while viewing as someone else.
 */
function CommandPalette({ role, onClose }: { role: Role; onClose: () => void }) {
  const { t, f } = useI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const data = usePaletteData();
  const bookings = useBookingSearch(query);
  const shortcuts = useAvailableShortcuts();
  const amountsHidden = useAmountsHidden();
  const keyText = useKeyText();
  const [recent] = useState(() => readRecent().filter((path) => path !== router.state.location.pathname));
  const listId = useId();
  const inputId = useId();
  const hintId = useId();
  const q = query.trim();

  // The palette closes first, so focus is back on its trigger before a page, a field or another dialog takes it.
  const later = (action: () => void) => () => {
    onClose();
    setTimeout(action);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `later` only closes over onClose, fixed while the palette is open.
  const sections = useMemo((): Section[] => {
    const accountNames = new Map((data?.accounts ?? []).map((a) => [a.id, a.name]));
    const pages: Entry[] = [
      ...MAIN_PAGES.map((p) => ({
        key: p.to,
        icon: p.icon,
        label: t(p.label),
        keys: keyText.comboOf(p.id),
        run: later(() => void navigate({ to: p.to })),
      })),
      ...sectionsFor(role).map((s) => ({
        key: s.to,
        icon: "settings" as const,
        label: t(`sections.settings.${s.slug}.label`),
        detail: `${t("sections.settings.title")} · ${t(`sections.settings.${s.slug}.hint`)}`,
        run: later(() => void navigate({ to: s.to })),
      })),
      ...PERSONAL_SECTIONS.map((s) => ({
        key: s.to,
        icon: "user" as const,
        label: t(`sections.personal.${s.slug}.label`),
        detail: `${t("sections.personal.title")} · ${t(`sections.personal.${s.slug}.hint`)}`,
        run: later(() => void navigate({ to: s.to })),
      })),
    ];
    const actions: Entry[] = SHORTCUTS.filter((s) => !PAGE_SHORTCUTS.has(s.id) && s.id !== "palette" && shortcuts.has(s.id)).map((s) => ({
      key: s.id,
      icon: s.id === "amounts" ? (amountsHidden ? "eye" : "eye-off") : (ACTION_ICONS[s.id] ?? "more"),
      label: s.id === "amounts" && amountsHidden ? t("palette.showAmounts") : t(SHORTCUT_LABELS[s.id]),
      keys: keyText.comboOf(s.id),
      run: later(() => runShortcut(s.id)),
    }));

    if (!q) {
      const recentEntries = recent.flatMap((path): Entry[] => {
        const page = pages.find((p) => p.key === path);
        const account = /^\/konten\/(\d+)$/.exec(path);
        const name = account ? accountNames.get(Number(account[1])) : undefined;
        if (page) return [{ ...page, key: `recent:${path}`, keys: null }];
        if (name) return [{ key: `recent:${path}`, icon: "wallet", label: name, run: later(() => void router.navigate({ href: path })) }];
        return [];
      });
      return [
        { id: "recent", title: t("palette.groups.recent"), entries: recentEntries.slice(0, MAX_PER_GROUP) },
        { id: "navigation", title: t("palette.groups.navigation"), entries: pages.slice(0, MAIN_PAGES.length) },
        { id: "actions", title: t("palette.groups.actions"), entries: actions },
      ].filter((s) => s.entries.length > 0);
    }

    const top = <T,>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).slice(0, MAX_PER_GROUP);
    const result: Section[] = [
      { id: "actions", title: t("palette.groups.actions"), entries: top(actions, (a) => matches(q, a.label)) },
      { id: "pages", title: t("palette.groups.pages"), entries: top(pages, (p) => matches(q, p.label, p.detail)) },
      {
        id: "accounts",
        title: t("palette.groups.accounts"),
        entries: top(data?.accounts ?? [], (a) => matches(q, a.name, a.bank) || ibanEndsWith(a.iban, q)).map((a) => ({
          key: `account:${a.id}`,
          icon: "wallet",
          label: a.name,
          detail: [a.bank, a.iban && t("palette.ibanEnd", { digits: a.iban.replace(/\s/g, "").slice(-4) })].filter(Boolean).join(" · "),
          trail: a.balanceCents === null ? undefined : <Balance cents={a.balanceCents} />,
          color: a.color,
          run: later(() => void navigate({ to: "/konten/$accountId", params: { accountId: String(a.id) } })),
        })),
      },
      {
        id: "bookings",
        title: t("palette.groups.bookings"),
        entries: bookings.items.map((b) => {
          const text = (b.counterparty || b.purpose).slice(0, 100);
          return {
            key: `booking:${b.id}`,
            icon: "list",
            label: b.counterparty || b.purpose || t("shortcuts.none"),
            detail: [f.date(b.bookingDate), accountNames.get(b.accountId), b.counterparty && b.purpose].filter(Boolean).join(" · "),
            trail: <Amount cents={b.amountCents} currency={b.currency} />,
            run: later(
              () =>
                void navigate({
                  to: "/buchungen",
                  search: { ...(text ? { q: text } : {}), von: b.bookingDate, bis: b.bookingDate },
                }),
            ),
          };
        }),
      },
      {
        id: "contracts",
        title: t("palette.groups.contracts"),
        entries: top(data?.contracts ?? [], (c) => matches(q, c.name, c.accountName, c.categoryName, c.matchPayee)).map((c) => ({
          key: `contract:${c.id}`,
          icon: "contract",
          label: c.name,
          detail: [c.accountName, c.categoryName].filter(Boolean).join(" · "),
          trail: <Money>{f.euro(c.amountCents)}</Money>,
          run: later(() => void navigate({ to: "/vertraege", search: { vertrag: c.id } })),
        })),
      },
      {
        id: "categories",
        title: t("palette.groups.categories"),
        entries: top(data?.categories ?? [], (c) => matches(q, c.name)).map((c) => ({
          key: `category:${c.id}`,
          icon: "folder",
          label: c.name,
          detail: t("palette.showBookings"),
          run: later(() => void navigate({ to: "/buchungen", search: { kategorie: c.id } })),
        })),
      },
      {
        id: "tags",
        title: t("palette.groups.tags"),
        entries: top(data?.tags ?? [], (tag) => matches(q, tag.name)).map((tag) => ({
          key: `tag:${tag.id}`,
          icon: "tag",
          label: tag.name,
          detail: t("palette.showBookings"),
          run: later(() => void navigate({ to: "/buchungen", search: { tag: tag.id } })),
        })),
      },
      {
        id: "filters",
        title: t("palette.groups.filters"),
        entries: top(data?.filters ?? [], (s) => matches(q, s.name)).map((s) => ({
          key: `filter:${s.id}`,
          icon: "filter",
          label: s.name,
          detail: t("palette.showBookings"),
          run: later(() => void navigate({ to: "/buchungen", search: filterToSearch(s.filter) })),
        })),
      },
    ];
    return result.filter((s) => s.entries.length > 0);
  }, [q, data, bookings.items, shortcuts, amountsHidden, keyText, recent, role, t, f, navigate, router]);

  const entries = sections.flatMap((s) => s.entries);
  const current = Math.min(active, entries.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [current, listId]);

  const loading = Boolean(q) && (data === null || bookings.pending);
  const announcement =
    !q || loading ? "" : entries.length > 0 ? t("palette.results", { count: entries.length }) : t("palette.none", { query: q });

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = entries.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (last < 0) return;
      setActive(event.key === "ArrowDown" ? (current >= last ? 0 : current + 1) : current <= 0 ? last : current - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      entries[current]?.run();
    } else if (matchShortcut(event.nativeEvent, keyText.keyboard.bindings, false) === "palette") {
      event.preventDefault();
      onClose();
    }
  }

  let index = -1;
  return (
    <FormDialog
      title={t("palette.title")}
      onClose={onClose}
      dismissible
      className="palette-dialog"
      footer={
        <p className="palette-keys" id={hintId}>
          {t("palette.hint")}
        </p>
      }
    >
      <div className="palette">
        <div className="palette-field">
          <Icon name="search" size={18} />
          <label htmlFor={inputId} className="visually-hidden">
            {t("palette.label")}
          </label>
          <input
            id={inputId}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-describedby={hintId}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            spellCheck={false}
            enterKeyHint="go"
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {/* Pressing an option must not move focus out of the field. */}
        <div
          id={listId}
          role="listbox"
          aria-label={t("palette.title")}
          className="palette-list"
          hidden={entries.length === 0}
          onMouseDown={(event) => event.preventDefault()}
        >
          {sections.map((section) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox has no native element.
            <div key={section.id} role="group" aria-label={section.title} className="palette-group">
              <div className="palette-group-label" aria-hidden="true">
                {section.title}
              </div>
              {section.entries.map((entry) => {
                index += 1;
                const i = index;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: chosen from the keyboard through the field (aria-activedescendant), focus stays there.
                  <div
                    key={entry.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    className="palette-option"
                    style={entry.color ? ({ "--row-accent": entry.color } as CSSProperties) : undefined}
                    onClick={entry.run}
                    onMouseMove={() => i !== current && setActive(i)}
                  >
                    <Icon name={entry.icon} size={16} />
                    <span className="palette-option-text">
                      <span className="palette-option-label">{entry.label}</span>
                      {entry.detail && <span className="palette-option-sub">{entry.detail}</span>}
                    </span>
                    {entry.trail && <span className="palette-option-trail">{entry.trail}</span>}
                    {entry.keys && <kbd>{entry.keys}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {loading && <p className="palette-empty">{t("palette.searching")}</p>}
        {!loading && q && entries.length === 0 && <p className="palette-empty">{t("palette.none", { query: q })}</p>}
        <span className="visually-hidden" aria-live="polite">
          {announcement}
        </span>
      </div>
    </FormDialog>
  );
}
