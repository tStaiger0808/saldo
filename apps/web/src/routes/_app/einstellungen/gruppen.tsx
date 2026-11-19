import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { CheckGroup, Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner } from "../../../components/Status.tsx";
import { useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { requireSection } from "../../../lib/settings.ts";
import { deleteGroupFn, getAccounts, getGroups, saveGroupFn } from "../../../server/functions/accounts.ts";

export const Route = createFileRoute("/_app/einstellungen/gruppen")({
  beforeLoad: requireSection("gruppen"),
  loader: async () => {
    const [groups, accounts] = await Promise.all([getGroups(), getAccounts()]);
    // Someone else's private account is theirs to share; it is not offered here.
    const groupable = accounts.filter((a) => (a.sharing.visibility === "household" ? a.canManage : a.canShare));
    return { groups, accounts, groupable };
  },
  component: GroupsSection,
});

type Group = Awaited<ReturnType<typeof getGroups>>[number];

function GroupsSection() {
  const { groups, accounts, groupable } = Route.useLoaderData();
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const remove = useAction(deleteGroupFn);
  const t = useT();
  const names = new Map(accounts.map((a) => [a.id, a.name]));

  async function destroy(group: Group) {
    const result = await remove.run({ data: { id: group.id } });
    setNotice(
      result.ok ? { tone: "ok", text: t("settings.groups.deleted", { name: group.name }) } : { tone: "danger", text: result.error },
    );
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card" aria-labelledby="groups-title">
        <div className="card-head">
          <h2 id="groups-title">{t("common.fields.groups")}</h2>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" size={18} /> {t("settings.groups.create")}
            </button>
          </div>
        </div>
        <p className="muted measure">{t("settings.groups.intro")}</p>
        {groups.length === 0 ? (
          <p className="empty">{t("settings.groups.empty")}</p>
        ) : (
          <ul className="list">
            {groups.map((g) => (
              <li key={g.id}>
                <span className="list-main">
                  <span className="list-title">{g.name}</span>
                  <span className="list-sub">
                    {g.accountIds.length === 0
                      ? t("settings.groups.noAccounts")
                      : g.accountIds.map((id) => names.get(id) ?? "?").join(", ")}
                  </span>
                </span>
                <span className="actions">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(g)}>
                    {t("common.edit")}
                    <span className="visually-hidden">: {g.name}</span>
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(g)}>
                    {t("common.delete")}
                    <span className="visually-hidden">: {g.name}</span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <GroupDialog
          group={editing === "new" ? null : editing}
          accounts={groupable}
          onClose={() => setEditing(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("settings.groups.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("settings.groups.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("settings.groups.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

function GroupDialog({
  group,
  accounts,
  onClose,
  onSaved,
}: {
  group: Group | null;
  accounts: { id: number; name: string }[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [accountIds, setAccountIds] = useState<number[]>(group?.accountIds ?? []);
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const save = useAction(saveGroupFn);
  const t = useT();

  async function submit() {
    if (!check({ name: name.trim() ? undefined : t("settings.nameRequired") })) return;
    const result = await save.run({ data: { id: group?.id, name: name.trim(), accountIds } });
    if (!result.ok) return;
    onSaved(t(group ? "settings.groups.saved" : "settings.groups.created", { name: name.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={group ? t("settings.groups.editTitle") : t("settings.groups.create")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {group ? t("common.save") : t("settings.groups.create")}
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
      <CheckGroup
        legend={t("settings.groups.accountsLegend")}
        hint={t("settings.groups.accountsHint", { count: accountIds.length })}
        options={accounts.map((a) => ({ id: a.id, label: a.name }))}
        value={accountIds}
        onChange={setAccountIds}
        empty={t("settings.groups.noAccountsYet")}
      />
    </FormDialog>
  );
}
