import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Avatar } from "../../components/Avatar.tsx";
import { Amount, MaskedText, TableWrap } from "../../components/Bits.tsx";
import {
  ContractDetail,
  type ContractFields,
  ContractForm,
  type ContractItem,
  ContractStatus,
  DueStatus,
  intervalLabel,
  signedCents,
} from "../../components/Contracts.tsx";
import { ConfirmDialog, FormDialog } from "../../components/Dialog.tsx";
import { CheckGroup, Field } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PageHead } from "../../components/PageHead.tsx";
import { Banner, NoticeBanner, Tag } from "../../components/Status.tsx";
import { translator } from "../../i18n/index.ts";
import { useI18n, useT } from "../../i18n/react.tsx";
import { errorMessage, type Notice, useAction, useNotice } from "../../lib/action.ts";
import {
  CONTRACT_LIST_MODES,
  CONTRACT_SORTS,
  CONTRACT_VIEW_SHARING,
  type ContractPreferences,
  type ContractSort,
  type ContractViewSharing,
  DUE_SOON_WINDOWS,
  type DueSoonWindow,
} from "../../lib/contract-preferences.ts";
import { useFormErrors } from "../../lib/forms.ts";
import { managesHousehold } from "../../lib/roles.ts";
import { getAccounts } from "../../server/functions/accounts.ts";
import { getCategories } from "../../server/functions/catalog.ts";
import {
  acceptSuggestionFn,
  deleteContractViewFn,
  dismissSuggestionFn,
  getContractDraftFn,
  getContractFn,
  getContractSuggestionsFn,
  getContractsFn,
  getContractViewShareCoverageFn,
  getContractViewsFn,
  hideContractViewFn,
  markDueSeenFn,
  restoreSuggestionFn,
  saveContractPreferencesFn,
  saveContractViewFn,
} from "../../server/functions/contracts.ts";
import { getPeopleFn } from "../../server/functions/users.ts";

type ContractsSearch = { vertrag?: number; neu?: number; ansicht?: number };
type Loaded<T> = { value: T } | { error: string } | null;

const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const Route = createFileRoute("/_app/vertraege")({
  // `vertrag` opens a contract, `neu` the form prefilled from a booking, `ansicht` one of the person's views or one shared with them.
  validateSearch: (search: Record<string, unknown>): ContractsSearch => {
    const result: ContractsSearch = {};
    const vertrag = positive(search.vertrag);
    const neu = positive(search.neu);
    const ansicht = positive(search.ansicht);
    if (vertrag) result.vertrag = vertrag;
    if (neu) result.neu = neu;
    if (ansicht) result.ansicht = ansicht;
    return result;
  },
  loaderDeps: ({ search }) => ({ vertrag: search.vertrag, neu: search.neu, ansicht: search.ansicht }),
  loader: async ({ context, deps }) => {
    const t = translator(context.session.locale);
    const views = await getContractViewsFn();
    const view = views.find((v) => v.id === deps.ansicht) ?? null;
    const viewId = view?.id ?? null;
    const settle = <T,>(promise: Promise<T>): Promise<Loaded<T>> =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error: errorMessage(error, t) }),
      );
    const [overview, suggestions, accounts, categories, detail, draft] = await Promise.all([
      getContractsFn({ data: { viewId } }),
      getContractSuggestionsFn({ data: { viewId } }).catch(() => ({ open: [], dismissed: [] })),
      getAccounts(),
      getCategories(),
      deps.vertrag ? settle(getContractFn({ data: { id: deps.vertrag } })) : null,
      deps.neu ? settle(getContractDraftFn({ data: { transactionId: deps.neu } })) : null,
    ]);
    return { ...overview, views, view, suggestions, accounts, categories, detail, draft };
  },
  component: ContractsPage,
});

type Editing = { id?: number; initial: Partial<ContractFields> | null; note?: string };
type LoaderData = ReturnType<typeof Route.useLoaderData>;
type ViewTab = LoaderData["views"][number];
type AccountOption = LoaderData["accounts"][number];

function fieldsOf(c: ContractItem): Partial<ContractFields> {
  return {
    name: c.name,
    direction: c.direction,
    amountCents: c.amountCents,
    variable: c.variable,
    interval: c.interval,
    intervalMonths: c.intervalMonths,
    // The next open due date; saving it makes it the new anchor.
    nextDue: c.state.nextDue ?? c.anchor,
    accountId: c.accountId,
    categoryId: c.categoryId,
    visibility: c.visibility,
    matchPayee: c.matchPayee,
    matchPurpose: c.matchPurpose,
    tolerancePercent: c.tolerancePercent,
    startDate: c.startDate,
    endDate: c.endDate,
    notes: c.notes,
  };
}

function ContractsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/vertraege" });
  const { user } = Route.useRouteContext();
  const { view } = data;
  const { t, f } = useI18n();
  const { notice, setNotice, clear } = useNotice();
  const [editing, setEditing] = useState<Editing | null>(null);
  const readOnly = Boolean(user.impersonation);
  const keep: ContractsSearch = view ? { ansicht: view.id } : {};
  const draft = search.neu && data.draft && "value" in data.draft ? data.draft.value : null;
  const draftError = search.neu && data.draft && "error" in data.draft ? data.draft.error : null;
  const detail = search.vertrag && data.detail && "value" in data.detail ? data.detail.value : null;
  const detailError = search.vertrag && data.detail && "error" in data.detail ? data.detail.error : null;
  const form: Editing | null =
    editing ?? (draft ? { initial: draft.contract, note: t("contracts.form.fromBooking", { date: f.date(draft.bookingDate) }) } : null);
  const open = (id: number) => navigate({ search: { ...keep, vertrag: id } });

  const closeForm = () => {
    setEditing(null);
    if (search.neu) void navigate({ search: keep, replace: true });
  };

  return (
    <>
      <PageHead
        eyebrow={view?.name ?? data.preferences.allViewName ?? t("contracts.views.all")}
        title={t("contracts.title")}
        actions={[{ label: t("contracts.create"), icon: "plus", primary: true, onSelect: () => setEditing({ initial: null }) }]}
      />
      <NoticeBanner notice={notice} onClose={clear} />
      {draftError && <Banner tone="danger">{draftError}</Banner>}
      {detailError && <Banner tone="danger">{detailError}</Banner>}
      <div className="contract-page">
        <ViewTabs
          views={data.views}
          active={view}
          allName={data.preferences.allViewName}
          accounts={data.accounts}
          readOnly={readOnly}
          onNotice={setNotice}
        />
        <Upcoming
          items={data.upcoming}
          unseen={data.unseenDue}
          days={data.preferences.dueSoonDays}
          readOnly={readOnly}
          onNotice={setNotice}
          onOpen={open}
        />
        <Totals totals={data.totals} actual={data.actual} />
        <div className="contract-columns">
          <ContractList items={data.items} preferences={data.preferences} readOnly={readOnly} onOpen={open} />
          <Suggestions
            open={data.suggestions.open}
            dismissed={data.suggestions.dismissed}
            viewId={view?.id ?? null}
            onNotice={setNotice}
            onOpen={open}
          />
        </div>
      </div>
      {form && (
        <ContractForm
          key={form.id ?? (search.neu ? `neu-${search.neu}` : "new")}
          initial={form.initial}
          contractId={form.id}
          accounts={data.accounts}
          categories={data.categories}
          householdAdmin={managesHousehold(user)}
          note={form.note}
          onClose={closeForm}
          onSaved={(id, name) => {
            setNotice({ tone: "ok", text: t(form.id === undefined ? "contracts.form.created" : "contracts.form.saved", { name }) });
            setEditing(null);
            void navigate({ search: { ...keep, vertrag: id }, replace: Boolean(search.neu) });
          }}
        />
      )}
      {detail && !form && (
        <ContractDetail
          key={detail.contract.id}
          data={detail}
          readOnly={readOnly}
          onClose={() => navigate({ search: keep })}
          onEdit={() => setEditing({ id: detail.contract.id, initial: fieldsOf(detail.contract) })}
          onDeleted={(name) => {
            setNotice({ tone: "ok", text: t("contracts.detail.deleted", { name }) });
            void navigate({ search: keep, replace: true });
          }}
        />
      )}
    </>
  );
}

/**
 * "All", the person's own views and those shared with them as tabs; "+" adds a view, "Edit view" changes "All" or an
 * own view, a shared one can only be hidden. The current tab comes from the loaded view: the router's own match takes
 * search params as a subset, under which "All" would stay current in every view.
 */
function ViewTabs({
  views,
  active,
  allName,
  accounts,
  readOnly,
  onNotice,
}: {
  views: ViewTab[];
  active: ViewTab | null;
  allName: string | null;
  accounts: AccountOption[];
  readOnly: boolean;
  onNotice: (notice: Notice) => void;
}) {
  const t = useT();
  const navigate = useNavigate({ from: "/vertraege" });
  const [dialog, setDialog] = useState<"new" | "edit" | "all" | null>(null);
  const hide = useAction(hideContractViewFn, { invalidate: false });
  const allLabel = allName ?? t("contracts.views.all");
  const shown = views.filter((v) => !v.hidden || v.id === active?.id);
  const sharedHint = (v: ViewTab): string | null => {
    if (v.sharedBy !== null) return t("contracts.views.sharedBy", { name: v.sharedBy });
    return v.sharing && v.sharing.scope !== "private" ? t("contracts.views.sharedByMe") : null;
  };

  async function hideActive() {
    if (!active) return;
    const result = await hide.run({ data: { id: active.id, hidden: true } });
    if (!result.ok) {
      onNotice({ tone: "danger", text: result.error });
      return;
    }
    onNotice({ tone: "ok", text: t("contracts.views.hiddenNotice", { name: active.name, all: allLabel }) });
    await navigate({ search: {} });
  }

  return (
    <div className="contract-views">
      <nav className="tabs" aria-label={t("contracts.views.tabsLabel")}>
        <Link to="/vertraege" search={{}} activeOptions={{ exact: true }} className="tab" aria-current={active ? undefined : "page"}>
          {allLabel}
        </Link>
        {shown.map((v) => (
          <Link
            key={v.id}
            to="/vertraege"
            search={{ ansicht: v.id }}
            activeOptions={{ exact: true }}
            className="tab"
            aria-current={v.id === active?.id ? "page" : undefined}
            aria-label={sharedHint(v) ? `${v.name}, ${sharedHint(v)}` : undefined}
          >
            {v.name}
            {sharedHint(v) && (
              <span className="tab-shared" title={sharedHint(v) ?? undefined}>
                <Icon name="users" size={14} />
              </span>
            )}
          </Link>
        ))}
        {!readOnly && (
          <button type="button" className="tab tab-add" title={t("contracts.views.add")} onClick={() => setDialog("new")}>
            <Icon name="plus" size={18} />
            <span className="visually-hidden">{t("contracts.views.add")}</span>
          </button>
        )}
      </nav>
      {active?.sharedBy != null ? (
        <div className="contract-view-shared">
          <Avatar name={active.sharedBy} src={active.sharedByAvatar} decorative className="avatar avatar-sm" />
          <span className="muted small">{t("contracts.views.sharedNote", { name: active.sharedBy })}</span>
          {!readOnly && (
            <button type="button" className="btn btn-sm" disabled={hide.busy} aria-busy={hide.busy} onClick={hideActive}>
              <Icon name="eye" size={16} /> {t("contracts.views.hide")}
            </button>
          )}
        </div>
      ) : (
        !readOnly && (
          <button type="button" className="btn btn-sm" onClick={() => setDialog(active ? "edit" : "all")}>
            <Icon name="edit" size={16} /> {t("contracts.views.edit")}
          </button>
        )
      )}
      {(dialog === "new" || dialog === "edit") && (
        <ViewDialog view={dialog === "edit" ? active : null} accounts={accounts} onClose={() => setDialog(null)} onNotice={onNotice} />
      )}
      {dialog === "all" && (
        <AllViewDialog
          name={allName}
          shared={views.filter((v) => v.sharedBy !== null)}
          onClose={() => setDialog(null)}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

/** The person's name for "All" (empty for the default) and which views shared with them appear as tabs. */
function AllViewDialog({
  name: stored,
  shared,
  onClose,
  onNotice,
}: {
  name: string | null;
  shared: ViewTab[];
  onClose: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const t = useT();
  const router = useRouter();
  const fallback = t("contracts.views.all");
  const [name, setName] = useState(stored ?? "");
  const [shownIds, setShownIds] = useState<number[]>(shared.filter((v) => !v.hidden).map((v) => v.id));
  const save = useAction(saveContractPreferencesFn, { invalidate: false });
  const hide = useAction(hideContractViewFn, { invalidate: false });
  const busy = save.busy || hide.busy;

  async function submit() {
    const saved = await save.run({ data: { allViewName: name.trim() } });
    if (!saved.ok) return;
    for (const v of shared) {
      const hidden = !shownIds.includes(v.id);
      if (hidden === v.hidden) continue;
      if (!(await hide.run({ data: { id: v.id, hidden } })).ok) return;
    }
    await router.invalidate();
    onClose();
    onNotice({ tone: "ok", text: t("contracts.views.saved", { name: name.trim() || fallback }) });
  }

  return (
    <FormDialog
      title={t("contracts.views.editTitle", { name: stored ?? fallback })}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      {(save.error || hide.error) && <Banner tone="danger">{save.error ?? hide.error}</Banner>}
      <p className="muted">{t("contracts.views.allIntro")}</p>
      <Field label={t("contracts.views.name")} hint={t("contracts.views.allNameHint", { name: fallback })}>
        {(control) => (
          <input {...control} value={name} maxLength={64} placeholder={fallback} onChange={(event) => setName(event.target.value)} />
        )}
      </Field>
      {shared.length > 0 && (
        <CheckGroup
          layout="list"
          legend={t("contracts.views.sharedTabs")}
          hint={t("contracts.views.sharedTabsHint")}
          options={shared.map((v) => ({ id: v.id, label: v.name, detail: t("contracts.views.sharedBy", { name: v.sharedBy ?? "" }) }))}
          value={shownIds}
          onChange={setShownIds}
        />
      )}
    </FormDialog>
  );
}

type Person = { id: string; username: string };
type Coverage = Awaited<ReturnType<typeof getContractViewShareCoverageFn>>;

function ViewDialog({
  view,
  accounts,
  onClose,
  onNotice,
}: {
  view: ViewTab | null;
  accounts: AccountOption[];
  onClose: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const t = useT();
  const navigate = useNavigate({ from: "/vertraege" });
  const shareName = useId();
  const [name, setName] = useState(view?.name ?? "");
  const [accountIds, setAccountIds] = useState<number[]>(view?.accountIds ?? []);
  const [sharing, setSharing] = useState<ContractViewSharing>(view?.sharing?.scope ?? "private");
  const [shareWith, setShareWith] = useState<string[]>(view?.sharing?.userIds ?? []);
  const [people, setPeople] = useState<Person[]>([]);
  const [coverage, setCoverage] = useState<Coverage>([]);
  const [confirm, setConfirm] = useState(false);
  const { form, errors, check, clear } = useFormErrors<{ name: string; accounts: string; people: string }>();
  const save = useAction(saveContractViewFn, { invalidate: false });
  const remove = useAction(deleteContractViewFn, { invalidate: false });
  const loadPeople = useServerFn(getPeopleFn);
  const loadCoverage = useServerFn(getContractViewShareCoverageFn);

  useEffect(() => {
    let live = true;
    loadPeople().then(
      (list) => live && setPeople(list),
      () => live && setPeople([]),
    );
    return () => {
      live = false;
    };
  }, [loadPeople]);

  useEffect(() => {
    let live = true;
    if (sharing === "private" || accountIds.length === 0) {
      setCoverage([]);
      return;
    }
    loadCoverage({ data: { accountIds } }).then(
      (list) => live && setCoverage(list),
      () => live && setCoverage([]),
    );
    return () => {
      live = false;
    };
  }, [sharing, accountIds, loadCoverage]);

  const missing = coverage.filter((c) => sharing === "household" || shareWith.includes(c.userId));

  async function submit() {
    const ok = check({
      name: name.trim() ? undefined : t("contracts.form.required"),
      accounts: accountIds.length > 0 ? undefined : t("contracts.views.accountsRequired"),
      people: sharing !== "people" || shareWith.length > 0 ? undefined : t("contracts.views.peopleRequired"),
    });
    if (!ok) return;
    const result = await save.run({
      data: { id: view?.id, view: { name: name.trim(), accountIds, sharing, shareWith: sharing === "people" ? shareWith : [] } },
    });
    if (!result.ok) return;
    onClose();
    onNotice({ tone: "ok", text: t(view ? "contracts.views.saved" : "contracts.views.created", { name: name.trim() }) });
    await navigate({ search: { ansicht: result.value } });
  }

  async function destroy() {
    if (!view) return;
    const result = await remove.run({ data: { id: view.id } });
    if (!result.ok) return;
    onClose();
    onNotice({ tone: "ok", text: t("contracts.views.deleted", { name: view.name }) });
    await navigate({ search: {} });
  }

  return (
    <FormDialog
      title={view ? t("contracts.views.editTitle", { name: view.name }) : t("contracts.views.newTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          {view && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
              {t("contracts.views.delete")}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {view ? t("common.save") : t("contracts.views.create")}
          </button>
        </>
      }
    >
      {(save.error || remove.error) && <Banner tone="danger">{save.error ?? remove.error}</Banner>}
      <Field label={t("contracts.views.name")} error={errors.name}>
        {(control) => (
          <input
            {...control}
            value={name}
            maxLength={64}
            required
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
          />
        )}
      </Field>
      <CheckGroup
        layout="list"
        legend={t("contracts.views.accounts")}
        hint={t("contracts.views.accountsHint")}
        options={accounts.map((a) => ({
          id: a.id,
          label: (
            <>
              {a.name}
              {a.visibility === "private" && <Tag>{t("labels.visibility.private")}</Tag>}
            </>
          ),
          detail: a.bankName && a.bankName !== a.name ? a.bankName : undefined,
        }))}
        value={accountIds}
        onChange={(next) => {
          setAccountIds(next);
          clear("accounts");
        }}
        empty={t("contracts.views.noAccounts")}
      />
      {errors.accounts && (
        <p className="field-error" role="alert">
          {errors.accounts}
        </p>
      )}
      <fieldset className="field">
        <legend>{t("contracts.views.share")}</legend>
        {CONTRACT_VIEW_SHARING.map((scope) => (
          <label key={scope} className="checkbox">
            <input
              type="radio"
              name={shareName}
              value={scope}
              checked={sharing === scope}
              onChange={() => {
                setSharing(scope);
                clear("people");
              }}
            />
            {t(`contracts.views.sharing.${scope}`)}
          </label>
        ))}
        <span className="field-hint">{t("contracts.views.shareHint")}</span>
      </fieldset>
      {sharing === "people" && (
        <CheckGroup
          layout="list"
          legend={t("contracts.views.people")}
          options={people.map((p) => ({ id: p.id, label: p.username }))}
          value={shareWith}
          onChange={(next) => {
            setShareWith(next);
            clear("people");
          }}
          empty={t("contracts.views.noPeople")}
        />
      )}
      {errors.people && (
        <p className="field-error" role="alert">
          {errors.people}
        </p>
      )}
      <div aria-live="polite">
        {missing.length > 0 && (
          <ul className="contract-view-coverage">
            {missing.map((c) => (
              <li key={c.userId}>
                <Icon name="info" size={16} /> {t("contracts.views.coverage", { name: c.name, count: c.hiddenCount })}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title={t("contracts.views.confirmDelete", { name: view?.name ?? "" })}
        confirmLabel={t("contracts.views.delete")}
        danger
        onConfirm={destroy}
        onClose={() => setConfirm(false)}
      >
        <p>{t("contracts.views.confirmDeleteText")}</p>
      </ConfirmDialog>
    </FormDialog>
  );
}

type Overview = Awaited<ReturnType<typeof getContractsFn>>;

/** What stays free each month, large and in its colour, with the income and expenses it comes from beside each other. */
function Totals({ totals, actual }: { totals: Overview["totals"]; actual: Overview["actual"] }) {
  const { t, f } = useI18n();
  const figures = [
    { key: "free", label: t("contracts.totals.free"), cents: totals.bufferCents, actual: f.signed(actual.bufferCents) },
    { key: "income", label: t("contracts.totals.income"), cents: totals.incomeCents, actual: f.euro(actual.incomeCents) },
    { key: "expenses", label: t("contracts.totals.expenses"), cents: -totals.expensesCents, actual: f.euro(actual.expensesCents) },
  ];
  return (
    <section className="card" aria-labelledby="contract-totals">
      <div className="card-head">
        <h2 id="contract-totals">{t("contracts.totals.title")}</h2>
        <span className="muted small">{t("contracts.totals.count", { count: totals.count })}</span>
      </div>
      <dl className="contract-totals">
        {figures.map((figure) => (
          <div key={figure.key} className={`contract-total contract-total-${figure.key}`}>
            <dt>{figure.label}</dt>
            <dd className="contract-total-value">
              <Amount cents={figure.cents} unit />
            </dd>
            <dd className="contract-total-meta">
              <MaskedText text={t("contracts.totals.actual", { amount: figure.actual })} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="card-foot">{t("contracts.totals.foot", { from: f.date(actual.dateFrom), to: f.date(actual.dateTo) })}</p>
    </section>
  );
}

/**
 * What is due within the person's chosen number of days, soonest first; new due dates can be marked as read. The same
 * window marks contracts in the list and counts them in the navigation.
 */
function Upcoming({
  items,
  unseen,
  days,
  readOnly,
  onNotice,
  onOpen,
}: {
  items: ContractItem[];
  unseen: number;
  days: DueSoonWindow;
  readOnly: boolean;
  onNotice: (notice: Notice) => void;
  onOpen: (id: number) => void;
}) {
  const { t, f } = useI18n();
  const mark = useAction(markDueSeenFn);
  const save = useAction(saveContractPreferencesFn);
  const [pending, setPending] = useState<DueSoonWindow | null>(null);
  const soon = items.length > 0;

  async function markSeen() {
    const result = await mark.run();
    onNotice(result.ok ? { tone: "ok", text: t("contracts.upcoming.markedSeen") } : { tone: "danger", text: result.error });
  }

  async function choose(next: DueSoonWindow) {
    setPending(next);
    const result = await save.run({ data: { dueSoonDays: next } });
    setPending(null);
    if (!result.ok) onNotice({ tone: "danger", text: result.error });
  }

  return (
    <section
      className={soon ? "card contract-upcoming contract-upcoming-soon" : "card contract-upcoming"}
      aria-labelledby="contract-upcoming"
    >
      <div className="card-head">
        <h2 id="contract-upcoming">{t("contracts.upcoming.title")}</h2>
        {readOnly ? (
          <span className="muted small">{t("contracts.upcoming.hint", { count: days })}</span>
        ) : (
          <Field label={t("contracts.upcoming.windowLabel")} className="field-inline">
            {(control) => (
              <select
                {...control}
                value={pending ?? days}
                aria-busy={save.busy}
                onChange={(event) => void choose(Number(event.target.value) as DueSoonWindow)}
              >
                {DUE_SOON_WINDOWS.map((n) => (
                  <option key={n} value={n}>
                    {t("contracts.upcoming.hint", { count: n })}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {unseen > 0 && !readOnly && (
          <div className="actions">
            <span className="small">{t("contracts.upcoming.unseen", { count: unseen })}</span>
            <button type="button" className="btn btn-sm" disabled={mark.busy} aria-busy={mark.busy} onClick={markSeen}>
              {t("contracts.upcoming.markSeen")}
            </button>
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted">{t("contracts.upcoming.empty", { count: days })}</p>
      ) : (
        <ul className="list">
          {items.map((c) => (
            <li key={c.id} className="contract-due-soon">
              <span className="list-main">
                <button type="button" className="row-button" onClick={() => onOpen(c.id)}>
                  {c.name}
                </button>
                <span className="list-sub">
                  {f.date(c.state.nextDue)} · {intervalLabel(t, c)}
                </span>
                <DueStatus days={c.dueInDays} />
              </span>
              <span className="num">
                <Amount cents={signedCents(c, c.state.expectedCents)} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Suggestion = Awaited<ReturnType<typeof getContractSuggestionsFn>>["open"][number];

/** Shown in the card; all of them, and the ignored ones, open in a dialog so a long history does not push the page down. */
const SUGGESTIONS_SHOWN = 8;

function SuggestionFacts({ s }: { s: Suggestion }) {
  const { t, f } = useI18n();
  const sign = (cents: number) => (s.direction === "income" ? cents : -cents);
  return (
    <span className="list-sub">
      {s.variable ? (
        <>
          <MaskedText text={t("contracts.suggestions.latest", { amount: f.signed(sign(s.latestAmountCents)) })} /> ·{" "}
          <MaskedText text={t("contracts.suggestions.variableRange", { min: f.euro(s.minAmountCents), max: f.euro(s.maxAmountCents) })} />
        </>
      ) : (
        <Amount cents={sign(s.typicalAmountCents)} />
      )}{" "}
      · {intervalLabel(t, { interval: s.schedule.interval, intervalMonths: s.schedule.intervalMonths ?? null })} ·{" "}
      {t("contracts.suggestions.seen", { count: s.months })} · {f.date(s.lastDate)}
      {s.category && ` · ${s.category}`}
    </span>
  );
}

type SuggestionActions = {
  busy: boolean;
  take: (s: Suggestion) => void;
  drop: (s: Suggestion) => void;
  bringBack: (s: Suggestion) => void;
};

function SuggestionRows({ items, actions }: { items: Suggestion[]; actions: SuggestionActions }) {
  const t = useT();
  return (
    <ul className="list">
      {items.map((s) => (
        <li key={`${s.direction}:${s.key}`} className="list-row">
          <span className="list-main">
            <span className="list-title">
              {s.counterparty} {s.variable && <Tag>{t("contracts.list.variable")}</Tag>}
            </span>
            <SuggestionFacts s={s} />
          </span>
          <span className="actions list-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={actions.busy}
              aria-label={t("contracts.suggestions.dismissLabel", { name: s.counterparty })}
              onClick={() => actions.drop(s)}
            >
              {t("contracts.suggestions.dismiss")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={actions.busy}
              aria-label={t("contracts.suggestions.acceptLabel", { name: s.counterparty })}
              onClick={() => actions.take(s)}
            >
              {t("contracts.suggestions.accept")}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DismissedRows({ items, actions }: { items: Suggestion[]; actions: SuggestionActions }) {
  const t = useT();
  return (
    <ul className="list">
      {items.map((s) => (
        <li key={`${s.direction}:${s.key}`} className="list-row">
          <span className="list-main">
            <span className="list-title">{s.counterparty}</span>
            <SuggestionFacts s={s} />
          </span>
          <span className="actions list-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={actions.busy}
              aria-label={t("contracts.suggestions.restoreLabel", { name: s.counterparty })}
              onClick={() => actions.bringBack(s)}
            >
              {t("contracts.suggestions.restore")}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Every open suggestion and, below, the ignored ones; opened at the ignored ones, focus starts on their heading. */
function SuggestionsDialog({
  open,
  dismissed,
  actions,
  feedback,
  start,
  onClose,
}: {
  open: Suggestion[];
  dismissed: Suggestion[];
  actions: SuggestionActions;
  feedback: ReactNode;
  start: "all" | "dismissed";
  onClose: () => void;
}) {
  const t = useT();
  const dismissedHeading = useRef<HTMLHeadingElement>(null);
  const dismissedId = useId();
  useEffect(() => {
    if (start === "dismissed") dismissedHeading.current?.focus();
  }, [start]);
  return (
    <FormDialog
      title={t("contracts.suggestions.allTitle")}
      variant="wide"
      dismissible
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {feedback}
      {open.length === 0 ? <p className="muted">{t("contracts.suggestions.empty")}</p> : <SuggestionRows items={open} actions={actions} />}
      {dismissed.length > 0 && (
        <section className="contract-dismissed" aria-labelledby={dismissedId}>
          <h3 id={dismissedId} ref={dismissedHeading} tabIndex={-1}>
            {t("contracts.suggestions.dismissedTitle")}
          </h3>
          <DismissedRows items={dismissed} actions={actions} />
        </section>
      )}
    </FormDialog>
  );
}

function Suggestions({
  open,
  dismissed,
  viewId,
  onNotice,
  onOpen,
}: {
  open: Suggestion[];
  dismissed: Suggestion[];
  viewId: number | null;
  onNotice: (notice: Notice) => void;
  onOpen: (id: number) => void;
}) {
  const t = useT();
  const accept = useAction(acceptSuggestionFn);
  const dismiss = useAction(dismissSuggestionFn);
  const restore = useAction(restoreSuggestionFn);
  const [dialog, setDialog] = useState<"all" | "dismissed" | null>(null);
  const [undo, setUndo] = useState<Suggestion | null>(null);
  const [message, setMessage] = useState<Notice | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = accept.busy || dismiss.busy || restore.busy;
  const hidden = open.length - SUGGESTIONS_SHOWN;

  // The button that opened the dialog is gone once the list got short enough; focus then lands on the card.
  function closeDialog() {
    setDialog(null);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) heading.current?.focus();
    });
  }

  async function take(s: Suggestion) {
    const result = await accept.run({ data: { viewId, key: s.key, direction: s.direction } });
    if (!result.ok) {
      setUndo(null);
      return setMessage({ tone: "danger", text: result.error });
    }
    closeDialog();
    onNotice({ tone: "ok", text: t("contracts.suggestions.accepted", { name: s.counterparty }) });
    onOpen(result.value);
  }

  async function drop(s: Suggestion) {
    const result = await dismiss.run({ data: { key: s.key, direction: s.direction } });
    setUndo(result.ok ? s : null);
    setMessage(
      result.ok
        ? { tone: "ok", text: t("contracts.suggestions.dismissed", { name: s.counterparty }) }
        : { tone: "danger", text: result.error },
    );
  }

  async function bringBack(s: Suggestion) {
    const result = await restore.run({ data: { key: s.key, direction: s.direction } });
    setUndo(null);
    setMessage(
      result.ok
        ? { tone: "ok", text: t("contracts.suggestions.restored", { name: s.counterparty }) }
        : { tone: "danger", text: result.error },
    );
  }

  const actions: SuggestionActions = { busy, take, drop, bringBack };
  const feedback = message && (
    <Banner
      tone={message.tone}
      onClose={() => {
        setMessage(null);
        setUndo(null);
      }}
    >
      <span className="contract-undo">
        {message.text}
        {undo && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            aria-label={t("contracts.suggestions.undoLabel", { name: undo.counterparty })}
            onClick={() => bringBack(undo)}
          >
            {t("contracts.suggestions.undo")}
          </button>
        )}
      </span>
    </Banner>
  );

  return (
    <section className="card" aria-labelledby="contract-suggestions">
      <div className="card-head">
        <h2 id="contract-suggestions" ref={heading} tabIndex={-1}>
          {t("contracts.suggestions.title")}
        </h2>
      </div>
      <p className="muted small">{t("contracts.suggestions.hint")}</p>
      <p className="muted small">{t("contracts.suggestions.yearlyHint")}</p>
      {!dialog && feedback}
      {open.length === 0 ? (
        <p className="muted">{t("contracts.suggestions.empty")}</p>
      ) : (
        <SuggestionRows items={open.slice(0, SUGGESTIONS_SHOWN)} actions={actions} />
      )}
      {(hidden > 0 || dismissed.length > 0) && (
        <div className="contract-suggestion-tools">
          {hidden > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("all")}>
              {t("contracts.suggestions.showAll", { count: hidden })}
            </button>
          )}
          {dismissed.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("dismissed")}>
              {t("contracts.suggestions.showDismissed", { count: dismissed.length })}
            </button>
          )}
        </div>
      )}
      {dialog && (
        <SuggestionsDialog open={open} dismissed={dismissed} actions={actions} feedback={feedback} start={dialog} onClose={closeDialog} />
      )}
    </section>
  );
}

type Group = { key: string; title: string; items: ContractItem[] };

function sortContracts(items: ContractItem[], sort: ContractSort): ContractItem[] {
  const byName = (a: ContractItem, b: ContractItem) => a.name.localeCompare(b.name) || a.id - b.id;
  const compare: Record<ContractSort, (a: ContractItem, b: ContractItem) => number> = {
    name: byName,
    // Income first, then expenses; within each the largest monthly amount on top.
    monthly: (a, b) =>
      Number(b.direction === "income") - Number(a.direction === "income") ||
      Math.abs(b.state.monthlyCents) - Math.abs(a.state.monthlyCents) ||
      byName(a, b),
    // Without a next due date (ended) last.
    next_due: (a, b) => (a.state.nextDue ?? "9999-12-31").localeCompare(b.state.nextDue ?? "9999-12-31") || byName(a, b),
  };
  return [...items].sort(compare[sort]);
}

function groupByCategory(items: ContractItem[], none: string): Group[] {
  const groups = new Map<string, Group>();
  for (const c of items) {
    const key = c.categoryId === null ? "none" : String(c.categoryId);
    const group = groups.get(key) ?? { key, title: c.categoryName ?? none, items: [] };
    group.items.push(c);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.title.localeCompare(b.title)));
}

/** One line per contract, income and expenses mixed in the chosen order; the totals card above holds the sums. */
function ContractLines({ items, onOpen }: { items: ContractItem[]; onOpen: (id: number) => void }) {
  const t = useT();
  return (
    <ul className="contract-lines">
      {items.map((c) => (
        <li key={c.id} className={c.dueInDays !== null ? "contract-line contract-due-soon" : "contract-line"}>
          <span className="contract-line-mark" aria-hidden="true">
            {[...c.name.trim()][0]?.toLocaleUpperCase() ?? "·"}
          </span>
          <span className="contract-line-main">
            <button type="button" className="row-button contract-line-name" onClick={() => onOpen(c.id)}>
              {c.name}
            </button>
            <span className="contract-line-sub">
              <span className="contract-line-label">
                {[c.categoryName ?? t("contracts.list.noCategory"), c.variable && t("contracts.list.variable")].filter(Boolean).join(" · ")}
              </span>
              <DueStatus days={c.dueInDays} />
              {c.state.status !== "active" && <ContractStatus contract={c} />}
            </span>
          </span>
          <span className="contract-line-figure">
            <Amount cents={signedCents(c, c.state.expectedCents)} />
            <span className="contract-line-label">{intervalLabel(t, c)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The contracts in category groups or as one list; layout and sorting are remembered for the person.
 * While viewing as someone else they only change on screen.
 */
function ContractList({
  items,
  preferences,
  readOnly,
  onOpen,
}: {
  items: ContractItem[];
  preferences: ContractPreferences;
  readOnly: boolean;
  onOpen: (id: number) => void;
}) {
  const { t, f } = useI18n();
  const [mode, setMode] = useState(preferences.listMode);
  const [sort, setSort] = useState(preferences.sort);
  const save = useAction(saveContractPreferencesFn, { invalidate: false });
  const headingId = useId();
  const groupId = useId();

  // Cached route data may show older choices first; the fresh ones follow once loaded.
  useEffect(() => setMode(preferences.listMode), [preferences.listMode]);
  useEffect(() => setSort(preferences.sort), [preferences.sort]);

  function remember(changes: Partial<Pick<ContractPreferences, "listMode" | "sort">>) {
    if (changes.listMode) setMode(changes.listMode);
    if (changes.sort) setSort(changes.sort);
    // A layout that is not saved still applies on screen, so a failed save is not worth an error.
    if (!readOnly) void save.run({ data: changes });
  }

  const sorted = sortContracts(items, sort);
  return (
    <section className="card" aria-labelledby={headingId}>
      <div className="card-head">
        <h2 id={headingId}>{t("contracts.list.title")}</h2>
        {items.length > 0 && (
          <div className="contract-list-tools">
            {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset */}
            <div className="segmented" role="group" aria-label={t("contracts.list.mode")}>
              {CONTRACT_LIST_MODES.map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => remember({ listMode: m })}>
                  {t(`contracts.list.modes.${m}`)}
                </button>
              ))}
            </div>
            <Field label={t("contracts.list.sortBy")} className="field-inline">
              {(control) => (
                <select {...control} value={sort} onChange={(event) => remember({ sort: event.target.value as ContractSort })}>
                  {CONTRACT_SORTS.map((s) => (
                    <option key={s} value={s}>
                      {t(`contracts.list.sorts.${s}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
      </div>
      {items.length === 0 && <p className="empty">{t("contracts.list.empty")}</p>}
      {items.length > 0 && mode === "list" && <ContractLines items={sorted} onOpen={onOpen} />}
      {items.length > 0 &&
        mode === "category" &&
        groupByCategory(sorted, t("contracts.list.noCategory")).map((group) => {
          const monthly = group.items
            .filter((c) => c.state.status !== "ended")
            .reduce((sum, c) => sum + signedCents(c, c.state.monthlyCents), 0);
          const titleId = `${groupId}-${group.key}`;
          return (
            <div key={group.key} className="contract-group">
              <h3 id={titleId}>{group.title}</h3>
              <TableWrap>
                <table className="data-table responsive" aria-labelledby={titleId}>
                  <thead>
                    <tr>
                      <th scope="col">{t("common.fields.name")}</th>
                      <th scope="col">{t("contracts.list.status")}</th>
                      <th scope="col" className="num">
                        {t("contracts.list.amount")}
                      </th>
                      <th scope="col" className="num">
                        {t("contracts.list.perMonth")}
                      </th>
                      <th scope="col" className="num">
                        {t("contracts.list.nextDue")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((c) => (
                      <tr
                        key={c.id}
                        className={c.dueInDays !== null ? "contract-due-soon" : undefined}
                        style={{ "--row-accent": c.direction === "income" ? "var(--s3)" : "var(--s2)" } as CSSProperties}
                      >
                        <td className="span">
                          <span className="cell-main">
                            <button type="button" className="row-button" onClick={() => onOpen(c.id)}>
                              {c.name}
                            </button>
                            {(c.accountName || c.variable) && (
                              <span className="cell-sub">
                                {[c.accountName, c.variable && t("contracts.list.variable")].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </span>
                        </td>
                        <td>
                          <ContractStatus contract={c} />
                        </td>
                        <td className="num">
                          <span className="cell-main">
                            <Amount cents={signedCents(c, c.state.expectedCents)} />
                            <span className="cell-sub">{intervalLabel(t, c)}</span>
                          </span>
                        </td>
                        <td className="num">
                          <span className="cell-main">
                            <Amount cents={signedCents(c, c.state.monthlyCents)} />
                            <span className="cell-sub cell-label" aria-hidden="true">
                              {t("contracts.list.perMonth")}
                            </span>
                          </span>
                        </td>
                        <td className="num">
                          <span className="cell-main">
                            {f.date(c.state.nextDue)}
                            <DueStatus days={c.dueInDays} />
                            <span className="cell-sub cell-label" aria-hidden="true">
                              {t("contracts.list.nextDue")}
                            </span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>{t("contracts.list.groupTotal")}</td>
                      <td className="num">
                        <Amount cents={monthly} />
                      </td>
                      <td data-hide-mobile />
                    </tr>
                  </tfoot>
                </table>
              </TableWrap>
            </div>
          );
        })}
    </section>
  );
}
