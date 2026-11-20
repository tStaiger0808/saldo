import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { type AccountContext, AccountMenu } from "../../../components/AccountActions.tsx";
import {
  AccountBadge,
  AccountStatus,
  BankBadge,
  balanceAsOf,
  connectionLogoUrl,
  MaskedIban,
  SharingBadge,
  UnreadBadge,
} from "../../../components/AccountBits.tsx";
import { ActionMenu } from "../../../components/ActionMenu.tsx";
import { AddAccountDialog } from "../../../components/AddAccount.tsx";
import { BalanceTimeline } from "../../../components/BalanceTimeline.tsx";
import { type Connection, EditConnectionDialog, FinishAuthorizationDialog } from "../../../components/BankDialogs.tsx";
import { useBankJobs } from "../../../components/BankJobs.tsx";
import { Balance, Money } from "../../../components/Bits.tsx";
import { ConfirmDialog } from "../../../components/Dialog.tsx";
import { FoldBody, FoldToggle } from "../../../components/Fold.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { type PageAction, PageHead } from "../../../components/PageHead.tsx";
import { useShortcutHint } from "../../../components/Shortcuts.tsx";
import { Banner, NoticeBanner, Status, Tag } from "../../../components/Status.tsx";
import type { Translate } from "../../../i18n/index.ts";
import { useI18n } from "../../../i18n/react.tsx";
import { type Notice, useAction, useNotice } from "../../../lib/action.ts";
import { useLongPress } from "../../../lib/long-press.ts";
import { managesHousehold } from "../../../lib/roles.ts";
import { getAccountsOverviewFn, getBalanceTimelineFn } from "../../../server/functions/accounts.ts";
import {
  authorizeBankConnectionFn,
  deleteBankConnectionFn,
  discoverBankConnectionFn,
  getBankConnectionsFn,
  getBankingSettingsFn,
} from "../../../server/functions/banking.ts";
import type { AccountSummary, Grouping, Section } from "../../../server/modules/accounts/index.ts";

/** Search parameter values in German, as they show in the address bar. */
const GROUPINGS = { gruppen: "group", bank: "bank", art: "kind" } as const satisfies Record<string, Grouping>;
type GroupingParam = keyof typeof GROUPINGS;
const isGroupingParam = (value: unknown): value is GroupingParam => typeof value === "string" && Object.hasOwn(GROUPINGS, value);

/** `abruf`/`meldung` carry the outcome of a bank login back from /bank/callback, `auftrag` the sync it started. */
type Search = { nach?: GroupingParam; abruf?: "ok" | "hinweis" | "fehler"; meldung?: string; auftrag?: string };

const CALLBACK_TONES = { ok: "ok", hinweis: "warn", fehler: "danger" } as const satisfies Record<
  NonNullable<Search["abruf"]>,
  Notice["tone"]
>;

export const Route = createFileRoute("/_app/konten/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    nach: isGroupingParam(search.nach) ? search.nach : undefined,
    abruf: typeof search.abruf === "string" && Object.hasOwn(CALLBACK_TONES, search.abruf) ? (search.abruf as Search["abruf"]) : undefined,
    meldung: typeof search.meldung === "string" ? search.meldung.slice(0, 500) : undefined,
    auftrag: typeof search.auftrag === "string" && /^[\w-]{1,64}$/.test(search.auftrag) ? search.auftrag : undefined,
  }),
  loader: async () => {
    const [overview, timeline, connections, settings] = await Promise.all([
      getAccountsOverviewFn({ data: {} }),
      getBalanceTimelineFn({ data: {} }),
      getBankConnectionsFn(),
      getBankingSettingsFn(),
    ]);
    return { ...overview, timeline, connections, settings };
  },
  component: AccountsPage,
});

/** Everything the account menus need, shared by the rows. */
function useAccountContext(): (account: AccountSummary) => AccountContext {
  const { connections } = Route.useLoaderData();
  return (account) => ({ connection: connections.find((c) => c.id === account.connection?.id) });
}

const COLLAPSED_KEY = "fw-konten-zu";

/** Collapsed sections per browser; storage may be unavailable (private mode), then everything stays open. */
function useCollapsedSections(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      if (Array.isArray(stored)) setCollapsed(new Set(stored.filter((k): k is string => typeof k === "string")));
    } catch {
      // Unreadable storage: keep all sections open.
    }
  }, []);
  function toggle(key: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // The choice then lasts until the page is left.
      }
      return next;
    });
  }
  return [collapsed, toggle];
}

function sectionTitle(section: Section, t: Translate): string {
  switch (section.type) {
    case "kind":
      return t(`accounts.kindPlural.${section.name}`);
    case "manual":
      return t("accounts.manual");
    case "ungrouped":
      return t("accounts.ungrouped");
    default:
      return section.name;
  }
}

function AccountsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/konten/" });
  const { t } = useI18n();
  const [collapsed, toggle] = useCollapsedSections();
  const [adding, setAdding] = useState(false);
  const { notice, setNotice, clear } = useNotice();
  const admin = managesHousehold(user);
  const pending = data.connections.filter((c) => c.linkedAccounts.length === 0);
  const callback: Notice | null = search.abruf
    ? {
        tone: CALLBACK_TONES[search.abruf],
        text: search.meldung ?? (search.abruf === "fehler" ? t("banking.page.callbackFailed") : t("banking.page.callbackOk")),
      }
    : null;
  useFollowCallbackJob(search.auftrag, data.connections);
  const grouping: Grouping = search.nach ? GROUPINGS[search.nach] : "group";
  const sections = data.sections[grouping];
  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  const listedTwice = grouping === "group" && sections.reduce((n, s) => n + s.accountIds.length, 0) > data.accounts.length;
  const chartId = useId();
  const syncAll = useSyncAllAction();

  return (
    <>
      <PageHead
        eyebrow={t("common.allAccounts")}
        title={t("accounts.title")}
        choices={[
          data.accounts.length > 0 && {
            label: t("accounts.groupBy"),
            display: "segmented",
            value: search.nach ?? "gruppen",
            options: (Object.keys(GROUPINGS) as GroupingParam[]).map((param) => ({
              value: param,
              label: t(`accounts.grouping.${GROUPINGS[param]}`),
            })),
            onChange: (param) => navigate({ search: { nach: param as GroupingParam }, replace: true, resetScroll: false }),
          },
        ]}
        actions={[
          data.accounts.some((a) => a.connection?.canManage) && syncAll,
          { label: t("accounts.add.title"), icon: "plus", primary: true, onSelect: () => setAdding(true) },
        ]}
      />
      {callback && <NoticeBanner notice={callback} onClose={() => navigate({ search: { nach: search.nach }, replace: true })} />}
      <NoticeBanner notice={notice} onClose={clear} />
      {pending.length > 0 && <PendingConnections connections={pending} onNotice={setNotice} />}
      {data.accounts.length === 0 ? (
        <div className="card empty-card">
          <h2>{t("accounts.emptyTitle")}</h2>
          <p className="muted">{admin ? t("accounts.emptyAdmin") : t("accounts.emptyMember")}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} /> {t("accounts.add.title")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="card accounts-total" aria-labelledby="accounts-total-title">
            <div className="accounts-total-head">
              <h2 id="accounts-total-title" className="kpi-label">
                {t("accounts.total")}
              </h2>
              {data.timeline && <FoldToggle fold="konten-verlauf" controls={chartId} name={t("accounts.detail.history")} />}
            </div>
            <p className="accounts-total-value">
              <Balance cents={data.totalCents} unit />
            </p>
            <p className="muted small">
              {[
                t("accounts.count", { count: data.accounts.length }),
                data.withoutBalance > 0 && t("accounts.withoutBalance", { count: data.withoutBalance }),
                listedTwice && t("accounts.totalHint"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {data.timeline && (
              <BalanceTimeline
                title={t("timeline.totalTitle")}
                timeline={data.timeline}
                transfers="excluded"
                fold="konten-verlauf"
                bodyId={chartId}
              />
            )}
          </section>
          {sections.map((section) => (
            <AccountSection
              key={section.key}
              section={section}
              title={sectionTitle(section, t)}
              accounts={section.accountIds.flatMap((id) => byId.get(id) ?? [])}
              grouping={grouping}
              collapsed={collapsed.has(section.key)}
              onToggle={() => toggle(section.key)}
              admin={admin}
              onNotice={setNotice}
            />
          ))}
        </>
      )}
      {adding && (
        <AddAccountDialog settings={data.settings} onClose={() => setAdding(false)} onSaved={(text) => setNotice({ tone: "ok", text })} />
      )}
    </>
  );
}

/** Opens the job dialog for the sync the bank login started, once; the job id then leaves the address. */
function useFollowCallbackJob(jobId: string | undefined, connections: Connection[]) {
  const { follow } = useBankJobs();
  const navigate = useNavigate({ from: "/konten/" });
  const { t } = useI18n();
  const label = connections.find((c) => c.activeJobId === jobId)?.name ?? t("banking.connectionFallback");
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || followed.current === jobId) return;
    followed.current = jobId;
    void follow(jobId, label);
    void navigate({ search: (prev) => ({ ...prev, auftrag: undefined }), replace: true, resetScroll: false });
  }, [jobId, label, follow, navigate]);
}

function pendingStatus(c: Connection, t: Translate): { tone: "danger" | "warn"; text: string } {
  if (c.status === "error") return { tone: "danger", text: t("common.fields.error") };
  if (c.status === "no_accounts") return { tone: "warn", text: t("banking.page.status.noAccountsReleased") };
  if (c.status === "needs_reauth") return { tone: "warn", text: t("banking.page.status.reloginNeeded") };
  if (c.status === "new") {
    return {
      tone: "warn",
      text: c.provider === "enable_banking" ? t("banking.page.status.authorizationMissing") : t("banking.page.status.notChecked"),
    };
  }
  return { tone: "warn", text: t("banking.page.status.noAccounts") };
}

/** Connections whose bank login is not finished yet, or that delivered no account: the place to continue or remove them. */
function PendingConnections({ connections, onNotice }: { connections: Connection[]; onNotice: (notice: Notice) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [finishing, setFinishing] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const { track } = useBankJobs();
  const authorize = useAction(authorizeBankConnectionFn, { invalidate: false });
  const discover = useAction(discoverBankConnectionFn);
  const remove = useAction(deleteBankConnectionFn);
  const error = authorize.error ?? discover.error ?? remove.error;

  async function renew(c: Connection) {
    const result = await authorize.run({ data: { id: c.id } });
    if (result.ok) window.location.assign(result.value.url);
  }

  async function check(c: Connection) {
    const result = await discover.run({ data: { id: c.id } });
    if (result.ok) track([{ job: result.value, label: c.name }]);
  }

  async function destroy(c: Connection) {
    const result = await remove.run({ data: { id: c.id, keepAccounts: true } });
    if (result.ok) onNotice({ tone: "ok", text: t("banking.page.deleted", { name: c.name }) });
  }

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h2 id={`${id}-title`}>{t("accounts.pending.title")}</h2>
        <FoldToggle fold="konten-angefangen" controls={`${id}-body`} name={t("accounts.pending.title")} />
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      <FoldBody fold="konten-angefangen" id={`${id}-body`} className="fold-body">
        <p className="muted small">{t("accounts.pending.intro")}</p>
        <ul className="list">
          {connections.map((c) => (
            <li key={c.id} className="list-row">
              <BankBadge label={"bankName" in c.target ? c.target.bankName || c.name : c.name} logo={connectionLogoUrl(c)} />
              <span className="list-main">
                <span className="list-title">
                  {c.name}
                  <Status tone={pendingStatus(c, t).tone} inline detail={c.lastError || undefined}>
                    {pendingStatus(c, t).text}
                  </Status>
                </span>
                {c.status === "no_accounts" && <span className="list-sub">{t("banking.authorizedNoAccounts", { name: c.name })}</span>}
                {c.owner && <span className="list-sub">{t("accounts.sharing.sharedBy", { owner: c.owner })}</span>}
              </span>
              <span className="actions list-actions">
                {c.provider === "enable_banking" ? (
                  <button type="button" className="btn btn-sm btn-primary" disabled={authorize.busy} onClick={() => renew(c)}>
                    {c.status === "new" ? t("accounts.pending.continue") : t("accounts.actions.renew")}
                    <span className="visually-hidden">: {c.name}</span>
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm btn-primary" disabled={discover.busy} onClick={() => check(c)}>
                    {t("accounts.actions.check")}
                    <span className="visually-hidden">: {c.name}</span>
                  </button>
                )}
                <ActionMenu
                  name={c.name}
                  items={[
                    c.provider === "enable_banking" && { label: t("banking.page.pasteRedirect"), onSelect: () => setFinishing(true) },
                    c.provider !== "enable_banking" && { label: t("accounts.actions.access"), onSelect: () => setEditing(c) },
                    { label: t("common.delete"), danger: true, onSelect: () => setDeleting(c) },
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      </FoldBody>
      {finishing && <FinishAuthorizationDialog onClose={() => setFinishing(false)} onDone={onNotice} />}
      {editing && (
        <EditConnectionDialog connection={editing} onClose={() => setEditing(null)} onSaved={(text) => onNotice({ tone: "ok", text })} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("banking.page.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("banking.page.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("accounts.pending.deleteText")}</p>
      </ConfirmDialog>
    </section>
  );
}

function AccountSection({
  section,
  title,
  accounts,
  grouping,
  collapsed,
  onToggle,
  admin,
  onNotice,
}: {
  section: Section;
  title: string;
  accounts: AccountSummary[];
  grouping: Grouping;
  collapsed: boolean;
  onToggle: () => void;
  admin: boolean;
  onNotice: (notice: Notice) => void;
}) {
  const { t } = useI18n();
  const contextOf = useAccountContext();
  const id = useId();
  const navigate = useNavigate();
  const manage =
    section.type === "group" || section.type === "ungrouped"
      ? { label: t("accounts.manageGroups"), to: "/einstellungen/gruppen" as const }
      : null;
  return (
    <section className="card card-flush account-section" aria-labelledby={`${id}-title`}>
      <div className="account-section-head">
        <h2>
          <button type="button" className="section-toggle" aria-expanded={!collapsed} aria-controls={`${id}-list`} onClick={onToggle}>
            <span id={`${id}-title`} className="section-title">
              {title}
            </span>
            <span className="section-count">
              <Icon name="chevron-right" size={16} />
              {t("accounts.count", { count: accounts.length })}
            </span>
          </button>
        </h2>
        <span className="account-section-total num">
          <span className="visually-hidden">{t("accounts.sectionTotal", { name: title })}: </span>
          <Balance cents={section.subtotalCents} />
        </span>
        {admin && manage && <ActionMenu name={title} items={[{ label: manage.label, onSelect: () => navigate({ to: manage.to }) }]} />}
      </div>
      <ul id={`${id}-list`} className="account-list collapsible" hidden={collapsed}>
        {accounts.map((a) => (
          <AccountItem key={a.id} account={a} context={contextOf(a)} grouping={grouping} onNotice={onNotice} />
        ))}
      </ul>
    </section>
  );
}

/** One account: the row opens it, a long press on it or the "⋯" button opens its actions. */
function AccountItem({
  account,
  context,
  grouping,
  onNotice,
}: {
  account: AccountSummary;
  context: AccountContext;
  grouping: Grouping;
  onNotice: (notice: Notice) => void;
}) {
  const [sheet, setSheet] = useState(false);
  return (
    <li className="account-item">
      <AccountRow account={account} grouping={grouping} onLongPress={() => setSheet(true)} />
      <AccountMenu
        account={account}
        context={context}
        onNotice={onNotice}
        sheet={{ open: sheet, onOpen: () => setSheet(true), onClose: () => setSheet(false) }}
      />
    </li>
  );
}

function AccountRow({ account: a, grouping, onLongPress }: { account: AccountSummary; grouping: Grouping; onLongPress: () => void }) {
  const { t, f } = useI18n();
  const asOf = balanceAsOf(a, t, f, { compact: true });
  // The row takes focus first, so the sheet hands it back there when it closes.
  const press = useLongPress<HTMLAnchorElement>((row) => {
    row.focus({ preventScroll: true });
    onLongPress();
  });
  return (
    <Link to="/konten/$accountId" params={{ accountId: String(a.id) }} className="account-row" {...press}>
      <AccountBadge account={a} />
      <span className="account-main">
        <span className="account-name">{a.name}</span>
        <span className="account-sub">
          <UnreadBadge count={a.unreadCount} />
          <span className="account-sub-text">
            {grouping === "bank" ? t(`labels.accountKind.${a.kind}`) : a.bankName}
            {a.ibanLast4 && (
              <>
                {" · "}
                <MaskedIban last4={a.ibanLast4} />
              </>
            )}
          </span>
          <SharingBadge sharing={a.sharing} />
          {a.connection?.skipSyncAll && <Tag>{t("banking.manualOnly")}</Tag>}
        </span>
        {a.connection?.attention && <AccountStatus connection={a.connection} />}
      </span>
      <span className="account-figures">
        <Balance cents={a.balanceCents} />
        {a.change && <ValueChange change={a.change} />}
        {asOf && <span className="account-asof">{asOf}</span>}
      </span>
    </Link>
  );
}

/** A depot's value against its previous daily entry; phones show only the amount, screen readers hear the date too. */
function ValueChange({ change }: { change: NonNullable<AccountSummary["change"]> }) {
  const { t, f } = useI18n();
  const tone = change.cents > 0 ? "delta delta-good" : change.cents < 0 ? "delta delta-bad" : "delta";
  return (
    <span className={tone}>
      <Money>{change.cents === 0 ? f.euro(0) : f.signed(change.cents)}</Money>
      <span className="delta-since"> {t("accounts.changeSince", { date: f.date(change.since) })}</span>
    </span>
  );
}

/** Fetches every connection the viewer manages, like "Konten abrufen" in the navigation. */
function useSyncAllAction(): PageAction {
  const { t } = useI18n();
  const { syncAll, syncing, running } = useBankJobs();
  const hint = useShortcutHint("sync");
  return {
    label: syncing ? t("shell.syncStarting") : t("shell.syncAccounts"),
    icon: "sync",
    onSelect: syncAll,
    disabled: syncing,
    busy: syncing || running,
    keyshortcuts: hint.aria,
    title: hint.title(t("shell.syncAccounts")),
  };
}
