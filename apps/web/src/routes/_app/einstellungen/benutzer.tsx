import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ActionMenu } from "../../../components/ActionMenu.tsx";
import { Avatar } from "../../../components/Avatar.tsx";
import { TableWrap } from "../../../components/Bits.tsx";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { CheckGroup, Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { LanguageField } from "../../../components/LanguageField.tsx";
import { Banner, NoticeBanner, Tag } from "../../../components/Status.tsx";
import { LOCALE_NAMES, type Locale } from "../../../i18n/index.ts";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { ROLES, type Role } from "../../../lib/labels.ts";
import { isSuperuser } from "../../../lib/roles.ts";
import { requireSection } from "../../../lib/settings.ts";
import { getGroups } from "../../../server/functions/accounts.ts";
import { startImpersonationFn } from "../../../server/functions/impersonation.ts";
import { createUserFn, deleteUserFn, getUsers, removeAvatarFn, resetPasswordFn, updateUserFn } from "../../../server/functions/users.ts";

export const Route = createFileRoute("/_app/einstellungen/benutzer")({
  beforeLoad: requireSection("benutzer"),
  loader: async () => {
    const [users, groups] = await Promise.all([getUsers(), getGroups()]);
    return { users, groups };
  },
  component: UsersSection,
});

type User = Awaited<ReturnType<typeof getUsers>>[number];
type Group = { id: number; name: string };

const USERNAME = /^[a-zA-Z0-9_.]{3,30}$/;

/** Superusers give every role; family admins only create members, so they see no choice. */
function RoleField({ value, onChange, superuser }: { value: Role; onChange: (role: Role) => void; superuser: boolean }) {
  const t = useT();
  if (!superuser) return null;
  return (
    <Field label={t("users.role")} hint={t("users.roleHint")}>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value as Role)}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`labels.role.${role}`)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Only superusers decide about AI; superusers themselves may always use it. */
function AiField({ value, onChange, role }: { value: boolean; onChange: (allowed: boolean) => void; role: Role }) {
  const t = useT();
  const hint = useId();
  if (role === "superuser") return <p className="muted">{t("users.aiAlways")}</p>;
  return (
    <div className="field">
      <label className="checkbox">
        <input type="checkbox" checked={value} aria-describedby={hint} onChange={(event) => onChange(event.target.checked)} />
        {t("users.aiAllowed")}
      </label>
      <span id={hint} className="field-hint">
        {t("users.aiAllowedHint")}
      </span>
    </div>
  );
}

function UserLanguageField({ value, onChange }: { value: Locale | null; onChange: (locale: Locale | null) => void }) {
  const t = useT();
  return <LanguageField value={value} onChange={onChange} hint={t("users.languageHint")} />;
}

function UsersSection() {
  const { users, groups } = Route.useLoaderData();
  const { user: me } = Route.useRouteContext();
  const superuser = isSuperuser(me);
  const { t, f } = useI18n();
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "edit" | "password"; user: User } | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const remove = useAction(deleteUserFn);
  const impersonate = useAction(startImpersonationFn, { invalidate: false });
  const removeAvatar = useAction(removeAvatarFn);
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  async function viewAs(user: User) {
    const result = await impersonate.run({ data: { userId: user.id } });
    // A full load, so nothing fetched for one's own view is shown as the other person's.
    if (result.ok) window.location.assign("/");
    else setNotice({ tone: "danger", text: result.error });
  }

  async function dropAvatar(user: User) {
    const result = await removeAvatar.run({ data: { userId: user.id } });
    setNotice(
      result.ok ? { tone: "ok", text: t("users.avatarRemoved", { username: user.username }) } : { tone: "danger", text: result.error },
    );
  }

  async function destroy(user: User) {
    const result = await remove.run({ data: { id: user.id } });
    setNotice(result.ok ? { tone: "ok", text: t("users.deleted", { username: user.username }) } : { tone: "danger", text: result.error });
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card card-flush" aria-labelledby="users-title">
        <div className="card-head">
          <h2 id="users-title">{t("users.title")}</h2>
          {!superuser && <p className="muted small">{t("users.membersOnly")}</p>}
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "new" })}>
              <Icon name="plus" size={18} /> {t("users.create")}
            </button>
          </div>
        </div>
        <TableWrap>
          <table className="data-table responsive">
            <thead>
              <tr>
                <th scope="col">{t("users.column.user")}</th>
                <th scope="col">{t("users.column.groups")}</th>
                <th scope="col">{t("users.column.language")}</th>
                <th scope="col" className="row-actions">
                  <span className="visually-hidden">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="span">
                    <span className="user-cell">
                      <Avatar name={u.username} src={u.avatar} decorative />
                      <span className="cell-main">
                        <span className="cell-title row">
                          {u.username}
                          <Tag>{t(`labels.role.${u.role}`)}</Tag>
                          {u.role !== "superuser" && u.aiAllowed && <Tag>{t("users.aiTag")}</Tag>}
                          {u.id === me.id && <Tag>{t("users.you")}</Tag>}
                        </span>
                        <span className="cell-sub">{t("users.since", { date: f.date(u.createdAt) })}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    {u.role !== "member" ? (
                      <span className="muted">{t("users.allAccounts")}</span>
                    ) : u.groupIds.length === 0 ? (
                      <span className="muted">{t("users.noGroups")}</span>
                    ) : (
                      u.groupIds.map((id) => groupNames.get(id)).join(", ")
                    )}
                  </td>
                  <td>
                    <span className="cell-main">
                      {u.locale ? (
                        <span lang={u.locale}>{LOCALE_NAMES[u.locale]}</span>
                      ) : (
                        <span className="muted">{t("language.automatic")}</span>
                      )}
                      <span className="cell-sub cell-label" aria-hidden="true">
                        {t("users.column.language")}
                      </span>
                    </span>
                  </td>
                  <td className="row-actions">
                    <span className="actions">
                      <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: "edit", user: u })}>
                        {t("common.edit")}
                        <span className="visually-hidden">: {u.username}</span>
                      </button>
                      <ActionMenu
                        name={u.username}
                        items={[
                          { label: t("users.resetPassword"), onSelect: () => setDialog({ kind: "password", user: u }) },
                          superuser &&
                            u.role !== "superuser" &&
                            u.id !== me.id && { label: t("impersonation.start", { name: u.username }), onSelect: () => viewAs(u) },
                          superuser && u.avatar !== null && { label: t("users.removeAvatar"), onSelect: () => dropAvatar(u) },
                          u.id !== me.id && { label: t("common.delete"), danger: true, onSelect: () => setDeleting(u) },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>
      {dialog?.kind === "new" && (
        <CreateDialog
          groups={groups}
          superuser={superuser}
          onClose={() => setDialog(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditDialog
          user={dialog.user}
          groups={groups}
          superuser={superuser}
          onClose={() => setDialog(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      {dialog?.kind === "password" && (
        <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={(text) => setNotice({ tone: "ok", text })} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("users.deleteTitle", { username: deleting?.username ?? "" })}
        confirmLabel={t("users.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("users.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

function Footer({ busy, label, onClose }: { busy: boolean; label: string; onClose: () => void }) {
  const t = useT();
  return (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t("common.cancel")}
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
        {label}
      </button>
    </>
  );
}

function CreateDialog({
  groups,
  superuser,
  onClose,
  onSaved,
}: {
  groups: Group[];
  superuser: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [locale, setLocale] = useState<Locale | null>(null);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [aiAllowed, setAiAllowed] = useState(false);
  const { form, errors, check, clear } = useFormErrors<{ username: string; password: string }>();
  const save = useAction(createUserFn);
  const t = useT();

  async function submit() {
    if (
      !check({
        username: USERNAME.test(username.trim()) ? undefined : t("users.usernameInvalid"),
        password: password.length >= 12 ? undefined : t("users.passwordTooShort"),
      })
    )
      return;
    const result = await save.run({
      data: {
        username: username.trim(),
        password,
        role,
        locale,
        groupIds: role === "member" ? groupIds : [],
        ...(superuser ? { aiAllowed } : {}),
      },
    });
    if (!result.ok) return;
    onSaved(t("users.created", { username: username.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={t("users.create")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={save.busy} label={t("users.create")} onClose={onClose} />}
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <Field label={t("common.fields.username")} hint={t("users.usernameHint")} error={errors.username}>
        {(control) => (
          <input
            {...control}
            value={username}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            onChange={(event) => {
              setUsername(event.target.value);
              clear("username");
            }}
          />
        )}
      </Field>
      <Field label={t("users.initialPassword")} hint={t("users.initialPasswordHint")} error={errors.password}>
        {(control) => (
          <input
            {...control}
            type="password"
            value={password}
            autoComplete="new-password"
            required
            onChange={(event) => {
              setPassword(event.target.value);
              clear("password");
            }}
          />
        )}
      </Field>
      <RoleField value={role} onChange={setRole} superuser={superuser} />
      {superuser && <AiField value={aiAllowed} onChange={setAiAllowed} role={role} />}
      <UserLanguageField value={locale} onChange={setLocale} />
      {role === "member" && (
        <CheckGroup
          legend={t("users.column.groups")}
          hint={t("users.groupsHint")}
          options={groups.map((g) => ({ id: g.id, label: g.name }))}
          value={groupIds}
          onChange={setGroupIds}
          empty={t("users.noGroupsYet")}
        />
      )}
    </FormDialog>
  );
}

function EditDialog({
  user,
  groups,
  superuser,
  onClose,
  onSaved,
}: {
  user: User;
  groups: Group[];
  superuser: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [role, setRole] = useState<Role>(user.role);
  const [aiAllowed, setAiAllowed] = useState(user.aiAllowed);
  const [groupIds, setGroupIds] = useState<number[]>(user.groupIds);
  const [locale, setLocale] = useState<Locale | null>(user.locale);
  const save = useAction(updateUserFn);
  const t = useT();

  async function submit() {
    const result = await save.run({
      data: { id: user.id, groupIds, locale, ...(superuser ? { role, aiAllowed: role === "superuser" || aiAllowed } : {}) },
    });
    if (!result.ok) return;
    onSaved(t("users.saved", { username: user.username }));
    onClose();
  }

  return (
    <FormDialog
      title={t("users.editTitle", { username: user.username })}
      onClose={onClose}
      onSubmit={submit}
      footer={<Footer busy={save.busy} label={t("common.save")} onClose={onClose} />}
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <RoleField value={role} onChange={setRole} superuser={superuser} />
      {superuser && <AiField value={aiAllowed} onChange={setAiAllowed} role={role} />}
      <UserLanguageField value={locale} onChange={setLocale} />
      {role === "member" ? (
        <CheckGroup
          legend={t("users.column.groups")}
          hint={t("users.groupsHint")}
          options={groups.map((g) => ({ id: g.id, label: g.name }))}
          value={groupIds}
          onChange={setGroupIds}
          empty={t("users.noGroupsYet")}
        />
      ) : (
        <p className="muted">{t("users.adminsSeeAll")}</p>
      )}
    </FormDialog>
  );
}

function PasswordDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: (text: string) => void }) {
  const [password, setPassword] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ password: string }>();
  const save = useAction(resetPasswordFn);
  const t = useT();

  async function submit() {
    if (!check({ password: password.length >= 12 ? undefined : t("users.passwordTooShort") })) return;
    const result = await save.run({ data: { id: user.id, password } });
    if (!result.ok) return;
    onSaved(t("users.passwordReset", { username: user.username }));
    onClose();
  }

  return (
    <FormDialog
      title={t("users.passwordTitle", { username: user.username })}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={save.busy} label={t("users.resetPassword")} onClose={onClose} />}
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <p className="muted">{t("users.passwordText")}</p>
      <Field label={t("users.newPassword")} hint={t("users.passwordTooShort")} error={errors.password}>
        {(control) => (
          <input
            {...control}
            type="password"
            value={password}
            autoComplete="new-password"
            required
            onChange={(event) => {
              setPassword(event.target.value);
              clear("password");
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
