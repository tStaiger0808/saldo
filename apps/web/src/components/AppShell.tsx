import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n, useT } from "../i18n/react.tsx";
import { authClient } from "../lib/auth-client.ts";
import { useFocusRescue } from "../lib/focus.ts";
import type { Role } from "../lib/labels.ts";
import { forgetPushSubscription } from "../lib/push.ts";
import { adjacentTab, type ShortcutId } from "../lib/shortcuts.ts";
import { deletePushSubscriptionFn, getUnreadNotificationCountFn } from "../server/functions/notifications.ts";
import { AmountsToggle, useAmountsShortcut } from "./AmountsToggle.tsx";
import { Avatar } from "./Avatar.tsx";
import { useBankJobs } from "./BankJobs.tsx";
import { PaletteLauncher, useRecentPages } from "./CommandPalette.tsx";
import { isDialogOpen } from "./Dialog.tsx";
import { Icon, type IconName, LogoMark } from "./Icon.tsx";
import { ImpersonationBanner } from "./ImpersonationBanner.tsx";
import { NotificationsDialog } from "./NotificationsDialog.tsx";
import { Popover } from "./Popover.tsx";
import { openShortcuts, ShortcutsOverview, useShortcut, useShortcutHint } from "./Shortcuts.tsx";
import { TasksDialog, useTasks } from "./Tasks.tsx";

type User = { id: string; username: string; name: string; role: Role; avatar?: string | null; impersonation?: { expiresAt: string } };

const PHONE = "(max-width: 719px)";

function NavTip({ children }: { children: ReactNode }) {
  return (
    <span className="nav-tip" aria-hidden="true">
      {children}
    </span>
  );
}

function NavItem({
  to,
  icon,
  label,
  shortcut,
  badge,
  badgeSuffix,
  badgeTip,
  busyLabel,
}: {
  to: "/" | "/konten" | "/buchungen" | "/analyse" | "/vertraege";
  icon: IconName;
  label: string;
  shortcut: ShortcutId;
  badge?: number;
  /** Read after the count when "new" does not fit what the badge counts, with `badgeTip` as the tooltip. */
  badgeSuffix?: string;
  badgeTip?: string;
  /** Work in progress behind the page, e.g. a bank fetch: a turning icon, the text added to the link name. */
  busyLabel?: string;
}) {
  const { t, f } = useI18n();
  const navigate = useNavigate();
  const hint = useShortcutHint(shortcut);
  useShortcut(shortcut, () => void navigate({ to }));
  const tip = badge ? (badgeTip ?? t("shell.withNew", { label, count: badge })) : label;
  return (
    <Link
      to={to}
      className="nav-link"
      activeOptions={{ exact: to === "/", includeSearch: false }}
      aria-keyshortcuts={hint.aria}
      title={hint.title(label)}
    >
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {busyLabel && (
        <>
          <span className="nav-busy">
            <Icon name="sync" size={14} />
          </span>
          <span className="visually-hidden">, {busyLabel}</span>
        </>
      )}
      {badge ? (
        <span className="nav-badge">
          {badge > 99 ? "99+" : f.integer(badge)}
          <span className="visually-hidden">{badgeSuffix ?? t("shell.newSuffix")}</span>
        </span>
      ) : null}
      {(badge || busyLabel) && <NavTip>{busyLabel ? `${tip} · ${busyLabel}` : tip}</NavTip>}
    </Link>
  );
}

const UNREAD_POLL_MS = 60_000;

/** Bell with the unread count; the count is refreshed every minute while the tab is visible. */
function NotificationBell({ unread: initial }: { unread: number }) {
  const [unread, setUnread] = useState(initial);
  const [open, setOpen] = useState(false);
  const fetchCount = useServerFn(getUnreadNotificationCountFn);
  const { t, f } = useI18n();
  const hint = useShortcutHint("notifications");
  useShortcut("notifications", () => setOpen(true));
  useEffect(() => setUnread(initial), [initial]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") fetchCount().then(setUnread, () => undefined);
    }, UNREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchCount]);
  const label = unread > 0 ? t("shell.notificationsUnread", { count: unread }) : t("shell.notifications");
  return (
    <>
      <button
        type="button"
        className="nav-link nav-icon-btn"
        aria-haspopup="dialog"
        aria-keyshortcuts={hint.aria}
        title={hint.title(label)}
        onClick={() => setOpen(true)}
      >
        <Icon name="bell" />
        <span className="nav-label">{t("shell.notifications")}</span>
        {unread > 0 && (
          <span className="nav-badge">
            {unread > 99 ? "99+" : f.integer(unread)}
            <span className="visually-hidden">{t("shell.unreadSuffix")}</span>
          </span>
        )}
        <NavTip>{label}</NavTip>
      </button>
      {open && <NotificationsDialog onClose={() => setOpen(false)} onUnread={setUnread} />}
    </>
  );
}

/** Running background work: the count as badge, a turning icon while anything runs, the list in a drawer. */
function TasksNav() {
  const { running } = useTasks();
  const [open, setOpen] = useState(false);
  const { t, f } = useI18n();
  const count = running.length;
  const label = count > 0 ? t("tasks.titleRunning", { count }) : t("tasks.title");
  const hint = useShortcutHint("tasks");
  useShortcut("tasks", () => setOpen(true));
  return (
    <>
      <button
        type="button"
        className="nav-link nav-icon-btn"
        aria-haspopup="dialog"
        aria-busy={count > 0}
        aria-keyshortcuts={hint.aria}
        title={hint.title(label)}
        onClick={() => setOpen(true)}
      >
        <Icon name={count > 0 ? "loader" : "tasks"} />
        <span className="nav-label">{t("tasks.title")}</span>
        {count > 0 && (
          <span className="nav-badge">
            {count > 99 ? "99+" : f.integer(count)}
            <span className="visually-hidden">{t("tasks.runningSuffix", { count })}</span>
          </span>
        )}
        <NavTip>{label}</NavTip>
      </button>
      {open && <TasksDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * "Konten abrufen" for viewers who may fetch: the icon turns while any bank job runs, and the button stays focusable
 * but does nothing until that has finished.
 */
function SyncNav() {
  const { t } = useI18n();
  const { syncAll, syncing, running } = useBankJobs();
  const busy = syncing || running;
  const hint = useShortcutHint("sync");
  const sync = () => {
    if (!busy) void syncAll();
  };
  useShortcut("sync", sync);
  const label = t("shell.syncAccounts");
  const title = hint.title(label);
  return (
    <button
      type="button"
      className="nav-link nav-icon-btn nav-sync"
      aria-busy={busy}
      aria-disabled={busy || undefined}
      aria-keyshortcuts={hint.aria}
      title={title}
      onClick={sync}
    >
      <Icon name="sync" />
      <span className="nav-label">{label}</span>
      <NavTip>{busy ? `${title} · ${t("shell.syncRunning")}` : title}</NavTip>
    </button>
  );
}

/** Esc hides the tooltip of the icon button under pointer or focus until both move on (WCAG 1.4.13). */
function useTipEscape() {
  useEffect(() => {
    const root = document.documentElement;
    const hide = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.querySelector(".nav-link:is(:hover, :focus-visible) > .nav-tip")) return;
      root.dataset.navTip = "off";
    };
    const show = () => delete root.dataset.navTip;
    window.addEventListener("keydown", hide, true);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerover", show);
    return () => {
      window.removeEventListener("keydown", hide, true);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerover", show);
    };
  }, []);
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

/** "Next tab" and "previous tab" walk the top-bar tabs like clicks on them, wrapping around at either end. */
function useTabCycle() {
  const router = useRouter();
  const go = (step: 1 | -1) => void router.navigate({ to: adjacentTab(router.state.location.pathname, step) });
  useShortcut("next-tab", () => go(1));
  useShortcut("prev-tab", () => go(-1));
}

export function AppShell({
  user,
  unread,
  notificationsUnread,
  contractsDue = 0,
  canSync = false,
  extraNav,
  children,
}: {
  user: User;
  unread: number;
  notificationsUnread: number;
  /** Contracts due soon whose due date the user has not marked as seen. */
  contractsDue?: number;
  /** "Konten abrufen" in the bar: the viewer manages connections to fetch and is not viewing as someone else. */
  canSync?: boolean;
  extraNav?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const firstPath = useRef(pathname);
  const scrolled = useScrolled();
  const bankJobs = useBankJobs();
  useTipEscape();
  useAmountsShortcut();
  useTabCycle();
  useFocusRescue(main);
  useRecentPages(pathname);

  // After a page change focus starts at the content, not on the clicked link; filters (search params only) keep it.
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    setMenuOpen(false);
    const active = document.activeElement;
    if (main.current?.contains(active)) return;
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || isDialogOpen()) return;
      setMenuOpen(false);
      toggle.current?.focus();
    }
    const phone = window.matchMedia(PHONE);
    const closeOnWide = () => !phone.matches && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    phone.addEventListener("change", closeOnWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      phone.removeEventListener("change", closeOnWide);
    };
  }, [menuOpen]);

  return (
    <div className="shell" data-scrolled={scrolled || undefined}>
      <a href="#inhalt" className="skip-link">
        {t("shell.skipToContent")}
      </a>
      <header className="topbar">
        <nav className={menuOpen ? "nav open" : "nav"} aria-label={t("shell.mainNav")}>
          <Link to="/" className="brand">
            <span className="brand-mark">
              <LogoMark />
            </span>
            <span className="brand-name">Saldo</span>
          </Link>
          <button
            ref={toggle}
            type="button"
            className="nav-toggle"
            aria-expanded={menuOpen}
            aria-controls="hauptmenue"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name={menuOpen ? "close" : "menu"} /> <span className="nav-toggle-label">{t("shell.menu")}</span>
          </button>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: closes the phone menu after a link inside was used */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: links and buttons are activated by keyboard as clicks, too */}
          <div className="nav-body" id="hauptmenue" onClick={(event) => (event.target as HTMLElement).closest("a") && setMenuOpen(false)}>
            <div className="nav-tabs">
              <NavItem to="/" icon="overview" label={t("shell.overview")} shortcut="go-overview" />
              <NavItem
                to="/konten"
                icon="wallet"
                label={t("accounts.title")}
                shortcut="go-accounts"
                busyLabel={bankJobs.running ? t("shell.syncRunning") : undefined}
              />
              <NavItem to="/buchungen" icon="list" label={t("shell.transactions")} shortcut="go-transactions" badge={unread} />
              <NavItem to="/analyse" icon="chart" label={t("shell.analysis")} shortcut="go-analysis" />
              <NavItem
                to="/vertraege"
                icon="contract"
                label={t("shell.contracts")}
                shortcut="go-contracts"
                badge={contractsDue}
                badgeSuffix={t("shell.dueSuffix")}
                badgeTip={t("shell.contractsDue", { label: t("shell.contracts"), count: contractsDue })}
              />
            </div>
            <div className="nav-tools">
              <PaletteLauncher role={user.role} tip={(label) => <NavTip>{label}</NavTip>} />
              {canSync && <SyncNav />}
              <TasksNav />
              <NotificationBell unread={notificationsUnread} />
              {extraNav}
            </div>
          </div>
          <AmountsToggle className="nav-link nav-icon-btn nav-amounts" tip={(label) => <NavTip>{label}</NavTip>} />
          <UserMenu user={user} pathname={pathname} />
        </nav>
      </header>
      <ShortcutsOverview />
      <main className="main" id="inhalt" ref={main} tabIndex={-1}>
        {user.impersonation && (
          <ImpersonationBanner
            name={user.name || user.username}
            avatar={user.avatar}
            role={user.role}
            expiresAt={user.impersonation.expiresAt}
          />
        )}
        {children}
      </main>
    </div>
  );
}

/** The round avatar at the end of the bar: personal settings, settings, the shortcuts and signing out. */
function UserMenu({ user, pathname }: { user: User; pathname: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const t = useT();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const removePush = useServerFn(deletePushSubscriptionFn);
  const settingsHint = useShortcutHint("go-settings");
  const helpHint = useShortcutHint("help");
  useShortcut("go-settings", () => void navigate({ to: "/einstellungen" }));
  const name = user.name || user.username;

  async function signOut() {
    setSignOutError(null);
    await forgetPushSubscription(removePush);
    const { error } = await authClient.signOut();
    if (error) {
      setSignOutError(error.message ? t("shell.signOutFailedWith", { reason: error.message }) : t("shell.signOutFailed"));
      return;
    }
    await router.invalidate();
    await router.navigate({ to: "/login" });
  }

  return (
    <div className="nav-user">
      <Popover
        label={t("shell.userMenu")}
        className="nav-avatar-btn"
        active={pathname.startsWith("/einstellungen") || pathname.startsWith("/persoenlich")}
        trigger={
          <>
            <Avatar name={name} src={user.avatar} decorative className="nav-avatar" />
            <span className="visually-hidden">{t("shell.userMenu")}</span>
          </>
        }
      >
        {(close) => (
          <div className="user-menu">
            <p className="user-menu-who">
              <Avatar name={name} src={user.avatar} decorative />
              <span className="user-menu-name">{name}</span>
              <span className="user-menu-role">{t(`labels.role.${user.role}`)}</span>
            </p>
            <Link to="/persoenlich" className="user-menu-item" onClick={close}>
              <Icon name="user" size={18} /> {t("shell.personalSettings")}
            </Link>
            <Link
              to="/einstellungen"
              className="user-menu-item"
              aria-keyshortcuts={settingsHint.aria}
              title={settingsHint.title(t("shell.settings"))}
              onClick={close}
            >
              <Icon name="settings" size={18} /> {t("shell.settings")}
            </Link>
            {/* Closing first puts focus back on the avatar, so the overview returns it there. */}
            <button
              type="button"
              className="user-menu-item"
              aria-haspopup="dialog"
              aria-keyshortcuts={helpHint.aria}
              title={helpHint.title(t("shortcuts.title"))}
              onClick={() => {
                close();
                openShortcuts();
              }}
            >
              <Icon name="keyboard" size={18} /> {t("shortcuts.title")}
            </button>
            <button type="button" className="user-menu-item" onClick={signOut}>
              <Icon name="logout" size={18} /> {t("shell.signOut")}
            </button>
            {signOutError && (
              <p className="nav-error" role="alert">
                {signOutError}
              </p>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** Shell-level action in the bar (chat). While `busy`, its icon turns and `busyLabel` is announced. */
export function NavAction({
  icon,
  label,
  onClick,
  disabled = false,
  busy = false,
  busyLabel,
  opensDialog = false,
  shortcut,
  badge = 0,
  badgeSuffix,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  opensDialog?: boolean;
  /** A count beside the label, e.g. answers that arrived while the dialog was closed. */
  badge?: number;
  badgeSuffix?: string;
  /** Runs `onClick`; shown in the tooltip and `aria-keyshortcuts`. */
  shortcut: ShortcutId;
}) {
  const status = busy ? busyLabel : undefined;
  const hint = useShortcutHint(shortcut);
  useShortcut(shortcut, onClick, !disabled);
  return (
    <button
      type="button"
      className="nav-link"
      title={hint.title(label)}
      aria-keyshortcuts={hint.aria}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      aria-haspopup={opensDialog ? "dialog" : undefined}
    >
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {status && <span className="visually-hidden">, {status}</span>}
      {badge > 0 && (
        <span className="nav-badge">
          {badge > 99 ? "99+" : badge}
          {badgeSuffix && <span className="visually-hidden">{badgeSuffix}</span>}
        </span>
      )}
      <NavTip>{status ? `${label} · ${status}` : label}</NavTip>
    </button>
  );
}
