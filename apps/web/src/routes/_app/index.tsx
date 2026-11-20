import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CardEditor } from "../../components/CardEditor.tsx";
import { CardContent, type Lookup } from "../../components/DashboardCards.tsx";
import { ConfirmDialog, FormDialog } from "../../components/Dialog.tsx";
import { Field } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { type PageChoice, PageHead } from "../../components/PageHead.tsx";
import { Banner, NoticeBanner } from "../../components/Status.tsx";
import { translator } from "../../i18n/index.ts";
import { useI18n, useT } from "../../i18n/react.tsx";
import { errorMessage, type Notice, useAction, useNotice } from "../../lib/action.ts";
import { type Card, cardKey, createCard, type Dashboard, loadCardData, normalizeDashboard } from "../../lib/cards.ts";
import { useFormErrors } from "../../lib/forms.ts";
import {
  DASHBOARD_PERIODS,
  type DashboardPeriod,
  type DashboardRange,
  type DateRange,
  isDashboardPeriod,
  resolveDashboardPeriod,
} from "../../lib/periods.ts";
import { isSuperuser } from "../../lib/roles.ts";
import { getAccounts } from "../../server/functions/accounts.ts";
import { getCategories, getTags } from "../../server/functions/catalog.ts";
import { deleteDashboardFn, getDashboards, saveDashboardFn, setDashboardPeriodFn } from "../../server/functions/dashboards.ts";

type OverviewSearch = { d?: number; zeitraum?: DashboardPeriod; von?: string; bis?: string };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const Route = createFileRoute("/_app/")({
  // `zeitraum` (with `von`/`bis` for a custom range) shows a period at once; the dashboard's stored one applies without it.
  validateSearch: (search: Record<string, unknown>): OverviewSearch => {
    const d = Number(search.d);
    const result: OverviewSearch = Number.isInteger(d) && d > 0 ? { d } : {};
    if (isDashboardPeriod(search.zeitraum)) result.zeitraum = search.zeitraum;
    for (const key of ["von", "bis"] as const) {
      const value = search[key];
      if (typeof value === "string" && ISO_DAY.test(value)) result[key] = value;
    }
    return result;
  },
  loaderDeps: ({ search }) => ({ d: search.d, zeitraum: search.zeitraum, von: search.von, bis: search.bis }),
  loader: async ({ context, deps }) => {
    const t = translator(context.session.locale);
    const [all, categories, tags, accounts] = await Promise.all([getDashboards(), getCategories(), getTags(), getAccounts()]);
    const dashboards = all.map(normalizeDashboard);
    const active = dashboards.find((d) => d.id === deps.d) ?? dashboards[0] ?? null;
    const period: DashboardPeriod = deps.zeitraum ?? active?.period ?? "this_month";
    const custom = deps.zeitraum ? { dateFrom: deps.von, dateTo: deps.bis } : { dateFrom: active?.periodFrom, dateTo: active?.periodTo };
    const range = resolveDashboardPeriod(period, custom);
    const loaded = active
      ? await Promise.all(
          active.cards.map(async (card) => {
            const key = cardKey(card, active.groupId, range);
            try {
              return { key, data: await loadCardData(card, active.groupId, range) };
            } catch (error) {
              return { key, error: errorMessage(error, t) };
            }
          }),
        )
      : [];
    const cardData = Object.fromEntries((active?.cards ?? []).map((card, i) => [card.id, loaded[i]]));
    return { dashboards, active, cardData, categories, tags, accounts, period, range };
  },
  component: OverviewPage,
});

const appRoute = getRouteApi("/_app");
const STARTER: Card["type"][] = ["summary", "recent_transactions", "category_breakdown", "monthly_trend"];
type Named = { id: number; name: string; color: string };

function OverviewPage() {
  const { dashboards, active, cardData, categories, tags, accounts, period, range } = Route.useLoaderData();
  const { groups, user } = Route.useRouteContext();
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const { notice, setNotice, clear } = useNotice();
  const periodChoice = usePeriodChoice(active?.id ?? null, period, range, setNotice);
  const viewName = (active?.groupId != null && groups.find((g) => g.id === active.groupId)?.name) || t("common.allAccounts");
  const lookup: Lookup = {
    categories: new Map(categories.map((c) => [c.id, c])),
    accounts: new Map(accounts.map((a) => [a.id, a])),
  };

  return (
    <>
      <PageHead
        eyebrow={viewName}
        title={t("shell.overview")}
        choices={[!editing && periodChoice.choice]}
        actions={[
          !editing && { label: t("dashboard.newDashboard"), icon: "plus", onSelect: () => setCreating(true) },
          !editing && active && { label: t("common.edit"), icon: "edit", onSelect: () => setEditing(true) },
        ]}
      />
      {periodChoice.dialog}
      <NoticeBanner notice={notice} onClose={clear} />
      {dashboards.length > 1 && (
        <nav className="tabs" aria-label={t("dashboard.tabsLabel")}>
          {dashboards.map((d) => (
            <Link key={d.id} to="/" search={{ d: d.id }} className="tab" aria-current={d.id === active?.id ? "page" : undefined}>
              <span className="tab-label">{d.name}</span>
            </Link>
          ))}
        </nav>
      )}
      {active ? (
        <Board
          key={active.id}
          dashboard={active}
          range={range}
          cardData={cardData}
          lookup={lookup}
          categories={categories}
          tags={tags}
          groups={groups}
          editing={editing}
          onEditingChange={setEditing}
          onNotice={setNotice}
        />
      ) : (
        <div className="card empty-card">
          <h2>{t("dashboard.emptyTitle", { view: viewName })}</h2>
          {user.impersonation ? (
            <p className="muted">{t("dashboard.emptyTextViewing", { name: user.name || user.username })}</p>
          ) : (
            <>
              <p className="muted">{t("dashboard.emptyText")}</p>
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                {t("dashboard.create")}
              </button>
            </>
          )}
        </div>
      )}
      {creating && (
        <NewDashboardDialog
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={(name) => setNotice({ tone: "ok", text: t("dashboard.created", { name }) })}
        />
      )}
    </>
  );
}

/**
 * The dashboard's period: shown at once through the address, stored for the owner so it is there again next time. While
 * a superuser views as someone else nothing is stored, the period only applies to this view. Without a dashboard there
 * is nothing to choose.
 */
function usePeriodChoice(
  dashboardId: number | null,
  period: DashboardPeriod,
  range: DashboardRange,
  onNotice: (notice: Notice) => void,
): { choice: PageChoice | null; dialog: ReactNode } {
  const navigate = useNavigate();
  const { t, f } = useI18n();
  const { user } = appRoute.useRouteContext();
  const save = useAction(setDashboardPeriodFn, { invalidate: false });
  const [customOpen, setCustomOpen] = useState(false);

  async function apply(id: number, next: DashboardPeriod, dates?: DateRange) {
    // Stored alongside the navigation, so leaving the page right away does not lose the choice.
    const saved = user.impersonation
      ? null
      : save.run({ data: { id, period: next, dateFrom: dates?.dateFrom ?? null, dateTo: dates?.dateTo ?? null } });
    await navigate({ to: "/", search: { d: id, zeitraum: next, von: dates?.dateFrom, bis: dates?.dateTo }, replace: true });
    const result = await saved;
    if (result && !result.ok) onNotice({ tone: "warn", text: t("dashboard.period.notSaved", { reason: result.error }) });
  }

  if (dashboardId === null) return { choice: null, dialog: null };
  const customRange = f.dateRange(range.dateFrom, range.dateTo);
  return {
    choice: {
      label: t("dashboard.period.label"),
      display: "select",
      value: period,
      options: DASHBOARD_PERIODS.map((value) => ({
        value,
        label: value === "custom" ? t("dashboard.period.customOption") : t(`periods.${value}`),
      })),
      onChange: (value) => {
        const next = value as DashboardPeriod;
        if (next === "custom") setCustomOpen(true);
        else void apply(dashboardId, next);
      },
      summary: period === "custom" ? customRange : t(`periods.${period}`),
      extra: period === "custom" && (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t("dashboard.period.change", { range: customRange })}
          onClick={() => setCustomOpen(true)}
        >
          <Icon name="clock" size={16} /> {customRange}
        </button>
      ),
    },
    dialog: customOpen && (
      <CustomRangeDialog
        initial={range}
        onClose={() => setCustomOpen(false)}
        onApply={(dates) => {
          setCustomOpen(false);
          void apply(dashboardId, "custom", dates);
        }}
      />
    ),
  };
}

function CustomRangeDialog({
  initial,
  onClose,
  onApply,
}: {
  initial: DateRange;
  onClose: () => void;
  onApply: (range: DateRange) => void;
}) {
  const t = useT();
  const [from, setFrom] = useState(initial.dateFrom);
  const [to, setTo] = useState(initial.dateTo);
  const { form, errors, check, clear } = useFormErrors<{ from: string; to: string }>();

  function submit() {
    const missing = t("dashboard.period.bothDates");
    if (
      !check({
        from: ISO_DAY.test(from) ? undefined : missing,
        to: !ISO_DAY.test(to) ? missing : from > to ? t("dashboard.period.order") : undefined,
      })
    )
      return;
    onApply({ dateFrom: from, dateTo: to });
  }

  return (
    <FormDialog
      title={t("dashboard.period.customTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {t("common.apply")}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t("dashboard.period.from")} error={errors.from}>
          {(control) => (
            <input
              {...control}
              type="date"
              required
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                clear("from");
              }}
            />
          )}
        </Field>
        <Field label={t("dashboard.period.to")} error={errors.to}>
          {(control) => (
            <input
              {...control}
              type="date"
              required
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                clear("to");
              }}
            />
          )}
        </Field>
      </div>
    </FormDialog>
  );
}

function NewDashboardDialog({
  groups,
  onClose,
  onCreated,
}: {
  groups: { id: number; name: string }[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const navigate = useNavigate();
  const t = useT();
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const save = useAction(saveDashboardFn, { invalidate: false });

  async function submit() {
    if (!check({ name: name.trim() ? undefined : t("dashboard.nameRequired") })) return;
    const target = group ? Number(group) : null;
    const result = await save.run({ data: { name: name.trim(), groupId: target, cards: STARTER.map((type) => createCard(type, t)) } });
    if (!result.ok) return;
    onClose();
    onCreated(name.trim());
    await navigate({ to: "/", search: { d: result.value } });
  }

  return (
    <FormDialog
      title={t("dashboard.newDashboard")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {t("dashboard.create")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <Field label={t("common.fields.name")} error={errors.name}>
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
      <Field label={t("common.fields.accounts")} hint={t("dashboard.accountsHint")}>
        {(control) => (
          <select {...control} value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="">{t("common.allAccounts")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </FormDialog>
  );
}

type Draft = { name: string; groupId: number | null; cards: Card[] };
type Loaded = Parameters<typeof CardContent>[0]["initial"];

function draftOf(dashboard: Dashboard): Draft {
  return { name: dashboard.name, groupId: dashboard.groupId, cards: structuredClone(dashboard.cards) };
}

function CardTools({
  card,
  index,
  count,
  onMove,
  onEdit,
  onRemove,
}: {
  card: Card;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { title } = card;
  return (
    <div className="card-tools">
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        data-move="-1"
        disabled={index === 0}
        aria-label={t("dashboard.moveForward", { title })}
        onClick={() => onMove(-1)}
      >
        <Icon name="up" size={16} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        data-move="1"
        disabled={index === count - 1}
        aria-label={t("dashboard.moveBack", { title })}
        onClick={() => onMove(1)}
      >
        <Icon name="down" size={16} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t("dashboard.editCard", { title })} onClick={onEdit}>
        <Icon name="edit" size={16} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t("dashboard.removeCard", { title })} onClick={onRemove}>
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
}

function Board({
  dashboard,
  range,
  cardData,
  lookup,
  categories,
  tags,
  groups,
  editing,
  onEditingChange,
  onNotice,
}: {
  dashboard: Dashboard;
  range: DashboardRange;
  cardData: Record<string, Loaded>;
  lookup: Lookup;
  categories: Named[];
  tags: Named[];
  groups: { id: number; name: string }[];
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onNotice: (notice: Notice) => void;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const t = useT();
  const { aiReady } = appRoute.useLoaderData();
  const { user } = appRoute.useRouteContext();
  const [draft, setDraft] = useState<Draft>(() => draftOf(dashboard));
  const [editor, setEditor] = useState<{ cardId: string | null } | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "discard" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<{ cardId: string; direction: -1 | 1 } | null>(null);
  const editBar = useRef<HTMLElement>(null);
  const save = useAction(saveDashboardFn, { invalidate: false });
  const remove = useAction(deleteDashboardFn, { invalidate: false });
  const cards = editing ? draft.cards : dashboard.cards;
  const viewGroup = editing ? draft.groupId : dashboard.groupId;
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(draftOf(dashboard));

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh draft each time editing starts, not on every reload
  useEffect(() => {
    if (!editing) return;
    setDraft(draftOf(dashboard));
    setAnnouncement(t("dashboard.editModeOn"));
    editBar.current?.querySelector("input")?.focus();
  }, [editing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: after a move the card is re-rendered; then focus follows it
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const root = document.querySelector(`[data-card="${CSS.escape(target.cardId)}"]`);
    const button =
      root?.querySelector<HTMLButtonElement>(`[data-move="${target.direction}"]:not(:disabled)`) ??
      root?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)");
    button?.focus();
  }, [draft.cards]);

  function stop(message: string) {
    onEditingChange(false);
    setAnnouncement(message);
  }

  function move(cardId: string, direction: -1 | 1) {
    const index = draft.cards.findIndex((c) => c.id === cardId);
    const card = draft.cards[index];
    const target = index + direction;
    if (!card || target < 0 || target >= draft.cards.length) return;
    const next = [...draft.cards];
    next.splice(index, 1);
    next.splice(target, 0, card);
    pendingFocus.current = { cardId, direction };
    setDraft({ ...draft, cards: next });
    setAnnouncement(t("dashboard.movedTo", { title: card.title, position: target + 1, total: next.length }));
  }

  function removeCard(cardId: string) {
    const card = draft.cards.find((c) => c.id === cardId);
    setDraft({ ...draft, cards: draft.cards.filter((c) => c.id !== cardId) });
    setAnnouncement(t("dashboard.removed", { title: card?.title ?? t("dashboard.cardFallback") }));
    editBar.current?.querySelector<HTMLButtonElement>("[data-add]")?.focus();
  }

  function saveCard(card: Card) {
    const exists = draft.cards.some((c) => c.id === card.id);
    setDraft({ ...draft, cards: exists ? draft.cards.map((c) => (c.id === card.id ? card : c)) : [...draft.cards, card] });
    setAnnouncement(t(exists ? "dashboard.changed" : "dashboard.added", { title: card.title }));
    setEditor(null);
  }

  async function submit() {
    const name = draft.name.trim() || dashboard.name;
    const result = await save.run({ data: { id: dashboard.id, name, groupId: draft.groupId, cards: draft.cards } });
    if (!result.ok) return;
    stop(t("dashboard.editModeOff"));
    onNotice({ tone: "ok", text: t("dashboard.saved") });
    await router.invalidate();
  }

  async function destroy() {
    const result = await remove.run({ data: { id: dashboard.id } });
    if (!result.ok) {
      onNotice({ tone: "danger", text: result.error });
      return;
    }
    onEditingChange(false);
    onNotice({ tone: "ok", text: t("dashboard.deleted", { name: dashboard.name }) });
    await navigate({ to: "/", search: {} });
    await router.invalidate();
  }

  const editingCard = editor?.cardId ? draft.cards.find((c) => c.id === editor.cardId) : null;

  return (
    <>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {editing && (
        <section ref={editBar} className="card edit-bar" aria-label={t("dashboard.editBar")}>
          {save.error && <Banner tone="danger">{save.error}</Banner>}
          <div className="form-grid">
            <Field label={t("dashboard.nameField")}>
              {(control) => (
                <input
                  {...control}
                  value={draft.name}
                  maxLength={64}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("common.fields.accounts")}>
              {(control) => (
                <select
                  {...control}
                  value={draft.groupId ?? ""}
                  onChange={(event) => setDraft({ ...draft, groupId: event.target.value ? Number(event.target.value) : null })}
                >
                  <option value="">{t("common.allAccounts")}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-danger" onClick={() => setConfirm("delete")}>
              <Icon name="trash" size={18} /> {t("dashboard.delete")}
            </button>
            <button type="button" className="btn" data-add onClick={() => setEditor({ cardId: null })}>
              <Icon name="plus" size={18} /> {t("dashboard.addCard")}
            </button>
            <button type="button" className="btn" onClick={() => (dirty ? setConfirm("discard") : stop(t("dashboard.editModeOff")))}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy} onClick={submit}>
              {t("common.save")}
            </button>
          </div>
        </section>
      )}
      {cards.length === 0 ? (
        <div className="card empty-card">
          <p className="muted">{t("dashboard.noCards")}</p>
          {!editing && (
            <button type="button" className="btn" onClick={() => onEditingChange(true)}>
              {t("dashboard.addCards")}
            </button>
          )}
        </div>
      ) : (
        <div className="board">
          {cards.map((card, index) => (
            <section
              key={card.id}
              className="card"
              data-width={card.width}
              data-card={card.id}
              data-editing={editing || undefined}
              aria-labelledby={`card-${card.id}`}
            >
              <div className="card-head">
                <h2 id={`card-${card.id}`}>{card.title || t(`dashboard.cards.${card.type}.label`)}</h2>
                {editing && (
                  <CardTools
                    card={card}
                    index={index}
                    count={cards.length}
                    onMove={(direction) => move(card.id, direction)}
                    onEdit={() => setEditor({ cardId: card.id })}
                    onRemove={() => removeCard(card.id)}
                  />
                )}
              </div>
              <CardContent card={card} groupId={viewGroup} range={range} initial={cardData[card.id]} lookup={lookup} />
            </section>
          ))}
        </div>
      )}
      {editor && (editor.cardId === null || editingCard) && (
        <CardEditor
          card={editingCard ?? null}
          categories={categories}
          tags={tags}
          aiAvailable={aiReady}
          admin={isSuperuser(user)}
          onSave={saveCard}
          onClose={() => setEditor(null)}
        />
      )}
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("dashboard.confirmDelete", { name: dashboard.name })}
        confirmLabel={t("dashboard.delete")}
        danger
        onConfirm={destroy}
        onClose={() => setConfirm(null)}
      >
        <p>{t("dashboard.confirmDeleteText", { count: dashboard.cards.length })}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "discard"}
        title={t("dashboard.discardTitle")}
        confirmLabel={t("dashboard.discard")}
        danger
        onConfirm={() => stop(t("dashboard.discarded"))}
        onClose={() => setConfirm(null)}
      >
        <p>{t("dashboard.discardText")}</p>
      </ConfirmDialog>
    </>
  );
}
