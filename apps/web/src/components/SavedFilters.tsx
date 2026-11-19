import { useState } from "react";
import { useT } from "../i18n/react.tsx";
import { useAction } from "../lib/action.ts";
import { type BookingFilter, bookingFilterQuery, sameFilter } from "../lib/booking-filter.ts";
import { useFormErrors } from "../lib/forms.ts";
import { createSavedFilterFn, deleteSavedFilterFn, updateSavedFilterFn } from "../server/functions/saved-filters.ts";
import type { SavedFilter } from "../server/modules/saved-filters/index.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

type Scope = "transactions" | "account";

/** One-click buttons for the saved filters, plus saving the current filters and managing the saved ones. */
export function SavedFilters({
  scope,
  saved,
  current,
  onApply,
}: {
  scope: Scope;
  saved: SavedFilter[];
  current: BookingFilter;
  onApply: (filter: BookingFilter) => void;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<"save" | "manage" | null>(null);
  // Saving makes sense only for a filter that is set and not saved yet.
  const savable = bookingFilterQuery(current) !== "" && !saved.some((s) => sameFilter(s.filter, current));
  if (saved.length === 0 && !savable && dialog === null) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset
    <div className="saved-filters" role="group" aria-label={t("savedFilters.label")}>
      {saved.map((s) => (
        <button
          key={s.id}
          type="button"
          className="saved-filter"
          aria-pressed={sameFilter(s.filter, current)}
          onClick={() => onApply(s.filter)}
        >
          {s.name}
          {s.isDefault && <span className="saved-filter-default">{t("savedFilters.defaultMark")}</span>}
        </button>
      ))}
      {savable && (
        <button type="button" className="btn btn-sm btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("save")}>
          <Icon name="plus" size={16} /> {t("savedFilters.save")}
        </button>
      )}
      {saved.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("manage")}>
          <Icon name="edit" size={16} /> {t("savedFilters.manage")}
        </button>
      )}
      {dialog === "save" && <SaveDialog scope={scope} saved={saved} current={current} onClose={() => setDialog(null)} />}
      {dialog === "manage" && <ManageDialog saved={saved} current={current} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SaveDialog({
  scope,
  saved,
  current,
  onClose,
}: {
  scope: Scope;
  saved: SavedFilter[];
  current: BookingFilter;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const create = useAction(createSavedFilterFn);

  async function submit() {
    const trimmed = name.trim();
    const error = !trimmed
      ? t("savedFilters.errors.nameRequired")
      : saved.some((s) => s.name === trimmed)
        ? t("savedFilters.errors.nameTaken", { name: trimmed })
        : undefined;
    if (!check({ name: error })) return;
    const result = await create.run({ data: { scope, name: trimmed, filter: current, isDefault } });
    if (result.ok) onClose();
  }

  return (
    <FormDialog
      title={t("savedFilters.saveTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.busy} aria-busy={create.busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      {create.error && <Banner tone="danger">{create.error}</Banner>}
      <Field label={t("common.fields.name")} hint={t("savedFilters.nameHint")} error={errors.name}>
        {(control) => (
          <input
            {...control}
            value={name}
            maxLength={60}
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
          />
        )}
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        {t("savedFilters.useAsDefault")}
      </label>
    </FormDialog>
  );
}

function ManageDialog({ saved, current, onClose }: { saved: SavedFilter[]; current: BookingFilter; onClose: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  return (
    <FormDialog
      title={t("savedFilters.manageTitle")}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {status && <Banner tone={status.tone}>{status.text}</Banner>}
      {saved.length === 0 ? (
        <p className="empty">{t("savedFilters.empty")}</p>
      ) : (
        <ul className="list saved-filter-list">
          {saved.map((s) => (
            <ManageRow key={s.id} filter={s} current={current} onStatus={setStatus} />
          ))}
        </ul>
      )}
    </FormDialog>
  );
}

function ManageRow({
  filter,
  current,
  onStatus,
}: {
  filter: SavedFilter;
  current: BookingFilter;
  onStatus: (status: { tone: "ok" | "danger"; text: string }) => void;
}) {
  const t = useT();
  const [name, setName] = useState(filter.name);
  const update = useAction(updateSavedFilterFn);
  const remove = useAction(deleteSavedFilterFn);
  const busy = update.busy || remove.busy;

  async function change(patch: { name?: string; filter?: BookingFilter; isDefault?: boolean }, done: string) {
    const result = await update.run({ data: { id: filter.id, ...patch } });
    onStatus(result.ok ? { tone: "ok", text: done } : { tone: "danger", text: result.error });
  }

  async function rename() {
    const trimmed = name.trim();
    if (!trimmed) return onStatus({ tone: "danger", text: t("savedFilters.errors.nameRequired") });
    if (trimmed !== filter.name) await change({ name: trimmed }, t("savedFilters.renamed", { name: trimmed }));
  }

  async function destroy() {
    const result = await remove.run({ data: { id: filter.id } });
    onStatus(result.ok ? { tone: "ok", text: t("savedFilters.deleted", { name: filter.name }) } : { tone: "danger", text: result.error });
  }

  return (
    <li className="list-row">
      <span className="list-main saved-filter-edit">
        <Field label={t("savedFilters.nameOf", { name: filter.name })} hideLabel>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void rename();
                }
              }}
            />
          )}
        </Field>
        {filter.isDefault && <span className="list-sub">{t("savedFilters.isDefault")}</span>}
      </span>
      <span className="actions list-actions">
        <button type="button" className="btn btn-sm" disabled={busy || name.trim() === filter.name} onClick={rename}>
          {t("savedFilters.rename")}
          <span className="visually-hidden">: {filter.name}</span>
        </button>
        <ActionMenu
          name={filter.name}
          items={[
            {
              label: t("savedFilters.overwrite"),
              disabled: busy || sameFilter(filter.filter, current),
              onSelect: () => change({ filter: current }, t("savedFilters.overwritten", { name: filter.name })),
            },
            {
              label: t("savedFilters.useAsDefault"),
              checked: filter.isDefault,
              disabled: busy,
              onSelect: () =>
                change(
                  { isDefault: !filter.isDefault },
                  filter.isDefault
                    ? t("savedFilters.defaultOff", { name: filter.name })
                    : t("savedFilters.defaultOn", { name: filter.name }),
                ),
            },
            { label: t("common.delete"), danger: true, disabled: busy, onSelect: destroy },
          ]}
        />
      </span>
    </li>
  );
}
