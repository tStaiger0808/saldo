import { useState } from "react";
import { useT } from "../i18n/react.tsx";
import { useAction, useNotice } from "../lib/action.ts";
import { isHexColor, useFormErrors } from "../lib/forms.ts";
import { CATEGORY_KINDS, type CategoryKind } from "../lib/labels.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { ConfirmDialog, FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner, NoticeBanner } from "./Status.tsx";

type Item = { id: number; name: string; color: string; kind?: CategoryKind };
type Input = { id?: number; name: string; color: string; kind?: CategoryKind };
// biome-ignore lint/suspicious/noExplicitAny: the save/delete server functions of categories and tags differ in input type
type ServerFn = (...args: any[]) => Promise<any>;
/** Selects the texts under `settings.categories` or `settings.tags`; both have the same keys. */
type Catalog = "categories" | "tags";

/** Categories and tags share their editing: a list with colour, a dialog with name (and kind), delete with confirmation. */
export function CatalogSection({
  catalog,
  items,
  admin,
  saveFn,
  deleteFn,
}: {
  catalog: Catalog;
  items: Item[];
  admin: boolean;
  saveFn: ServerFn;
  deleteFn: ServerFn;
}) {
  const t = useT();
  const withKind = catalog === "categories";
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const remove = useAction(deleteFn);

  async function destroy(item: Item) {
    const result = await remove.run({ data: { id: item.id } });
    setNotice(
      result.ok ? { tone: "ok", text: t(`settings.${catalog}.deleted`, { name: item.name }) } : { tone: "danger", text: result.error },
    );
  }

  const groups: [string, Item[]][] = withKind
    ? CATEGORY_KINDS.map((kind) => [t(`labels.categoryKind.${kind}`), items.filter((i) => i.kind === kind)])
    : [[t(`settings.${catalog}.title`), items]];

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card" aria-labelledby="catalog-title">
        <div className="card-head">
          <h2 id="catalog-title">{t(`settings.${catalog}.title`)}</h2>
          {admin && (
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                <Icon name="plus" size={18} /> <span className="btn-label">{t(`settings.${catalog}.create`)}</span>
              </button>
            </div>
          )}
        </div>
        {!admin && <p className="muted">{t(`settings.${catalog}.adminOnly`)}</p>}
        {items.length === 0 && <p className="empty">{t(`settings.${catalog}.empty`)}</p>}
        {groups.map(([label, list]) =>
          list.length === 0 ? null : (
            <div key={label} className="stack-sm">
              {withKind && <h3>{label}</h3>}
              <ul className="list">
                {list.map((item) => (
                  <li key={item.id}>
                    <span className="list-title">
                      <span className="swatch" style={{ background: item.color }} aria-hidden="true" />
                      {item.name}
                    </span>
                    {admin && (
                      <ActionMenu
                        name={item.name}
                        items={[
                          { label: t("common.edit"), onSelect: () => setEditing(item) },
                          { label: t("common.delete"), danger: true, onSelect: () => setDeleting(item) },
                        ]}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </section>
      {editing && (
        <ItemDialog
          item={editing === "new" ? null : editing}
          catalog={catalog}
          saveFn={saveFn}
          onClose={() => setEditing(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t(`settings.${catalog}.deleteTitle`, { name: deleting?.name ?? "" })}
        confirmLabel={t(`settings.${catalog}.deleteConfirm`)}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t(`settings.${catalog}.deleteText`)}</p>
      </ConfirmDialog>
    </>
  );
}

/** Name and colour (and for categories the kind) of a new or existing item. */
export function ItemDialog({
  item,
  catalog,
  saveFn,
  onClose,
  onSaved,
}: {
  item: Item | null;
  catalog: Catalog;
  saveFn: ServerFn;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const t = useT();
  const withKind = catalog === "categories";
  const [name, setName] = useState(item?.name ?? "");
  const [color, setColor] = useState(item?.color ?? "#3fa284");
  const [kind, setKind] = useState<CategoryKind>(item?.kind ?? "expense");
  const { form, errors, check, clear } = useFormErrors<{ name: string; color: string }>();
  const save = useAction(saveFn);

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("settings.nameRequired"),
        color: isHexColor(color) ? undefined : t("settings.colorInvalid"),
      })
    )
      return;
    const data: Input = { id: item?.id, name: name.trim(), color };
    if (withKind) data.kind = kind;
    const result = await save.run({ data });
    if (!result.ok) return;
    onSaved(t(item ? `settings.${catalog}.saved` : `settings.${catalog}.created`, { name: name.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={t(item ? `settings.${catalog}.editTitle` : `settings.${catalog}.create`)}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {item ? t("common.save") : t(`settings.${catalog}.create`)}
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
      <div className="form-grid">
        {withKind && (
          <Field label={t("common.fields.kind")} hint={t("settings.categories.kindHint")}>
            {(control) => (
              <select {...control} value={kind} onChange={(event) => setKind(event.target.value as CategoryKind)}>
                {CATEGORY_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`labels.categoryKind.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t("common.fields.color")} error={errors.color}>
          {(control) => (
            <input
              {...control}
              type="color"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
                clear("color");
              }}
            />
          )}
        </Field>
      </div>
    </FormDialog>
  );
}
