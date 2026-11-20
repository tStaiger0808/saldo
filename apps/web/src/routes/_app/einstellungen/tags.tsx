import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActionMenu } from "../../../components/ActionMenu.tsx";
import { ItemDialog } from "../../../components/CatalogSection.tsx";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner } from "../../../components/Status.tsx";
import { useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { managesHousehold } from "../../../lib/roles.ts";
import { requireSection } from "../../../lib/settings.ts";
import { deleteTagFn, getTagOverview, mergeTagFn, saveTagFn } from "../../../server/functions/catalog.ts";

export const Route = createFileRoute("/_app/einstellungen/tags")({
  beforeLoad: requireSection("tags"),
  loader: () => getTagOverview(),
  component: TagsSection,
});

type TagRow = Awaited<ReturnType<typeof getTagOverview>>[number];

/** Tags with their origin and use, so tags the AI created can be reviewed: renamed, merged into another one or deleted. */
function TagsSection() {
  const tags = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const admin = managesHousehold(user);
  const t = useT();
  const [editing, setEditing] = useState<TagRow | "new" | null>(null);
  const [merging, setMerging] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState<TagRow | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const remove = useAction(deleteTagFn);

  async function destroy(tag: TagRow) {
    const result = await remove.run({ data: { id: tag.id } });
    setNotice(result.ok ? { tone: "ok", text: t("settings.tags.deleted", { name: tag.name }) } : { tone: "danger", text: result.error });
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card" aria-labelledby="tags-title">
        <div className="card-head">
          <h2 id="tags-title">{t("settings.tags.title")}</h2>
          {admin && (
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                <Icon name="plus" size={18} /> {t("settings.tags.create")}
              </button>
            </div>
          )}
        </div>
        <p className="muted measure">{t("settings.tags.intro")}</p>
        {!admin && <p className="muted">{t("settings.tags.adminOnly")}</p>}
        {tags.length === 0 ? (
          <p className="empty">{t("settings.tags.empty")}</p>
        ) : (
          <ul className="list">
            {tags.map((tag) => (
              <li key={tag.id} className="list-row">
                <span className="list-main">
                  <span className="list-title">
                    <span className="swatch" style={{ background: tag.color }} aria-hidden="true" />
                    {tag.name}
                  </span>
                  <span className="list-sub">{t("settings.tags.bookings", { count: tag.bookings })}</span>
                </span>
                {admin && (
                  <span className="actions">
                    <ActionMenu
                      name={tag.name}
                      items={[
                        { label: t("settings.tags.rename"), onSelect: () => setEditing(tag) },
                        tags.length > 1 && { label: t("settings.tags.merge"), onSelect: () => setMerging(tag) },
                        { label: t("common.delete"), danger: true, onSelect: () => setDeleting(tag) },
                      ]}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <ItemDialog
          item={editing === "new" ? null : editing}
          catalog="tags"
          saveFn={saveTagFn}
          onClose={() => setEditing(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      {merging && (
        <MergeDialog
          tag={merging}
          others={tags.filter((other) => other.id !== merging.id)}
          onClose={() => setMerging(null)}
          onMerged={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("settings.tags.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("settings.tags.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("settings.tags.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

function MergeDialog({
  tag,
  others,
  onClose,
  onMerged,
}: {
  tag: TagRow;
  others: TagRow[];
  onClose: () => void;
  onMerged: (text: string) => void;
}) {
  const t = useT();
  const [intoId, setIntoId] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ into: string }>();
  const merge = useAction(mergeTagFn);

  async function submit() {
    if (!check({ into: intoId ? undefined : t("settings.tags.mergeChoose") })) return;
    const into = others.find((other) => String(other.id) === intoId);
    const result = await merge.run({ data: { id: tag.id, intoId: Number(intoId) } });
    if (!result.ok) return;
    onMerged(t("settings.tags.merged", { name: tag.name, into: into?.name ?? "" }));
    onClose();
  }

  return (
    <FormDialog
      title={t("settings.tags.mergeTitle", { name: tag.name })}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={merge.busy} aria-busy={merge.busy}>
            {t("settings.tags.merge")}
          </button>
        </>
      }
    >
      {merge.error && <Banner tone="danger">{merge.error}</Banner>}
      <Field label={t("settings.tags.mergeInto")} hint={t("settings.tags.mergeHint", { name: tag.name })} error={errors.into}>
        {(control) => (
          <select
            {...control}
            value={intoId}
            onChange={(event) => {
              setIntoId(event.target.value);
              clear("into");
            }}
          >
            <option value="">{t("settings.tags.mergePlaceholder")}</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </FormDialog>
  );
}
