import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useEffect, useState } from "react";
import { MaskedText, TableWrap } from "../../../components/Bits.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, Status } from "../../../components/Status.tsx";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { errorMessage } from "../../../lib/action.ts";
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditOutcome,
  type AuditSearch,
  auditCsvUrl,
  auditFilters,
  describeAudit,
  parseAuditSearch,
} from "../../../lib/audit.ts";
import { requireSection } from "../../../lib/settings.ts";
import { getAuditEventsFn } from "../../../server/functions/audit.ts";
import { getUsers } from "../../../server/functions/users.ts";

const PAGE_SIZE = 50;

export const Route = createFileRoute("/_app/einstellungen/protokoll")({
  beforeLoad: requireSection("protokoll"),
  validateSearch: (search: Record<string, unknown>) => parseAuditSearch(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [page, users] = await Promise.all([getAuditEventsFn({ data: { ...auditFilters(deps), limit: PAGE_SIZE } }), getUsers()]);
    return { page, users: users.map((u) => ({ id: u.id, username: u.username })) };
  },
  component: AuditSection,
});

type Page = Awaited<ReturnType<typeof getAuditEventsFn>>;
type AuditItem = Page["items"][number];

function FilterBar({ search, users }: { search: AuditSearch; users: { id: string; username: string }[] }) {
  const navigate = useNavigate({ from: "/einstellungen/protokoll" });
  const t = useT();
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  const set = (patch: Partial<AuditSearch>) =>
    navigate({ search: (prev: AuditSearch) => ({ ...prev, ...patch }), replace: true, resetScroll: false });
  const active = Object.values(search).some((value) => value !== undefined);

  function submit(event: FormEvent) {
    event.preventDefault();
    set({ q: q.trim() || undefined });
  }

  return (
    <search className="card">
      <form className="filters" onSubmit={submit} aria-label={t("audit.filterLabel")}>
        <Field label={t("audit.search")}>
          {(control) => (
            <input
              {...control}
              type="search"
              value={q}
              maxLength={100}
              placeholder={t("audit.searchPlaceholder")}
              onChange={(event) => setQ(event.target.value)}
            />
          )}
        </Field>
        <Field label={t("audit.user")}>
          {(control) => (
            <select {...control} value={search.benutzer ?? ""} onChange={(event) => set({ benutzer: event.target.value || undefined })}>
              <option value="">{t("audit.allUsers")}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("audit.category")}>
          {(control) => (
            <select
              {...control}
              value={search.bereich ?? ""}
              onChange={(event) => set({ bereich: (event.target.value || undefined) as AuditCategory | undefined })}
            >
              <option value="">{t("audit.allCategories")}</option>
              {AUDIT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`audit.categories.${category}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("audit.outcome")}>
          {(control) => (
            <select
              {...control}
              value={search.ergebnis ?? ""}
              onChange={(event) => set({ ergebnis: (event.target.value || undefined) as AuditOutcome | undefined })}
            >
              <option value="">{t("audit.allOutcomes")}</option>
              <option value="ok">{t("audit.outcomes.ok")}</option>
              <option value="failed">{t("audit.outcomes.failed")}</option>
            </select>
          )}
        </Field>
        <Field label={t("audit.from")}>
          {(control) => (
            <input {...control} type="date" value={search.von ?? ""} onChange={(event) => set({ von: event.target.value || undefined })} />
          )}
        </Field>
        <Field label={t("audit.to")}>
          {(control) => (
            <input {...control} type="date" value={search.bis ?? ""} onChange={(event) => set({ bis: event.target.value || undefined })} />
          )}
        </Field>
        <div className="actions filters-actions">
          {active && (
            <Link to="/einstellungen/protokoll" search={{}} className="btn btn-ghost">
              {t("audit.reset")}
            </Link>
          )}
          <button type="submit" className="btn">
            <Icon name="search" size={18} /> {t("common.search")}
          </button>
        </div>
      </form>
    </search>
  );
}

function AuditRow({ item }: { item: AuditItem }) {
  const { t, f, locale } = useI18n();
  const who = item.username ?? (item.category === "auth" ? t("audit.unknownUser") : t("audit.system"));
  return (
    <tr>
      <td>
        <time dateTime={item.at}>{f.dateTime(item.at)}</time>
      </td>
      <td className={item.username ? undefined : "muted"}>{who}</td>
      <td className="span">
        <span className="cell-title">
          <MaskedText text={describeAudit(t, f, locale, item)} />
        </span>
      </td>
      <td>
        <Status tone={item.outcome === "ok" ? "ok" : "danger"}>{t(`audit.outcomes.${item.outcome}`)}</Status>
      </td>
      <td className={item.ip ? undefined : "muted"}>{item.ip ?? "–"}</td>
    </tr>
  );
}

function AuditSection() {
  const { page: first, users } = Route.useLoaderData();
  const search = Route.useSearch();
  const t = useT();
  const fetchPage = useServerFn(getAuditEventsFn);
  const [items, setItems] = useState(first.items);
  const [nextBefore, setNextBefore] = useState(first.nextBefore);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(first.items);
    setNextBefore(first.nextBefore);
    setError(null);
  }, [first]);

  async function loadMore() {
    if (nextBefore === null) return;
    setBusy(true);
    setError(null);
    try {
      const more = await fetchPage({ data: { ...auditFilters(search), before: nextBefore, limit: PAGE_SIZE } });
      setItems((current) => [...current, ...more.items]);
      setNextBefore(more.nextBefore);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card" aria-labelledby="audit-title">
        <div className="row-between">
          <h2 id="audit-title">{t("audit.title")}</h2>
          <a className="btn btn-sm" href={auditCsvUrl(search)} download>
            <Icon name="download" size={16} /> {t("audit.exportCsv")}
          </a>
        </div>
        <p className="muted measure">{t("audit.intro", { days: first.retentionDays })}</p>
      </section>
      <FilterBar search={search} users={users} />
      <section className="card card-flush" aria-labelledby="audit-list-title">
        <div className="card-head">
          <h2 id="audit-list-title">{t("audit.listTitle")}</h2>
        </div>
        {items.length === 0 ? (
          <p className="empty">{t("audit.empty")}</p>
        ) : (
          <TableWrap>
            <table className="data-table responsive">
              <thead>
                <tr>
                  <th scope="col">{t("audit.time")}</th>
                  <th scope="col">{t("audit.user")}</th>
                  <th scope="col">{t("audit.action")}</th>
                  <th scope="col">{t("audit.outcome")}</th>
                  <th scope="col">{t("audit.ip")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <AuditRow key={item.id} item={item} />
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {items.length > 0 && (
          <div className="pager">
            <span role="status">{t("audit.loaded", { count: items.length })}</span>
            {nextBefore !== null && (
              <button type="button" className="btn btn-sm" onClick={loadMore} disabled={busy} aria-busy={busy}>
                {t("audit.loadMore")}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
