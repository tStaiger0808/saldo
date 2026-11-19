import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Avatar } from "../../../components/Avatar.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner } from "../../../components/Status.tsx";
import { useT } from "../../../i18n/react.tsx";
import { errorMessage, type Notice, useAction } from "../../../lib/action.ts";
import { CHAT_RETENTION_DAYS, type ChatRetentionDays } from "../../../lib/chat.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { getChatRetentionFn, setChatRetentionFn } from "../../../server/functions/ai.ts";
import { setOwnNameFn } from "../../../server/functions/session.ts";
import { removeAvatarFn } from "../../../server/functions/users.ts";

export const Route = createFileRoute("/_app/persoenlich/daten")({
  loader: async () => ({ chatRetention: await getChatRetentionFn().catch(() => null) }),
  component: PersonalDataSection,
});

const appRoute = getRouteApi("/_app");
const FOREVER = "unbegrenzt";
const AVATAR_TYPES = "image/png,image/jpeg,image/webp";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Upload, replace and remove the own picture; while viewing as someone else it is only shown. */
function AvatarForm({ userId, name, avatar, readOnly }: { userId: string; name: string; avatar: string | null; readOnly: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();
  const [message, setMessage] = useState<Notice | null>(null);
  const remove = useAction(removeAvatarFn);

  async function upload(file: File) {
    setMessage(null);
    setFileError(undefined);
    if (file.size > MAX_AVATAR_BYTES) {
      setFileError(t("personal.avatar.errors.tooLarge"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/avatars/${encodeURIComponent(userId)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? t("common.genericError"));
      await router.invalidate();
      setMessage({ tone: "ok", text: t("personal.avatar.saved") });
    } catch (error) {
      setFileError(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function drop() {
    setMessage(null);
    setFileError(undefined);
    const result = await remove.run({ data: { userId } });
    setMessage(result.ok ? { tone: "ok", text: t("personal.avatar.removed") } : { tone: "danger", text: result.error });
  }

  return (
    <section className="card" aria-labelledby="avatar-title" style={{ maxWidth: 520 }}>
      <h2 id="avatar-title">{t("personal.avatar.title")}</h2>
      {message && (
        <Banner tone={message.tone} onClose={() => setMessage(null)}>
          {message.text}
        </Banner>
      )}
      <div className="avatar-field">
        <Avatar name={name} src={avatar} className="avatar avatar-lg" />
        {!avatar && <p className="muted">{t("personal.avatar.none")}</p>}
      </div>
      {!readOnly && (
        <>
          <Field label={t("personal.avatar.choose")} hideLabel hint={t("personal.avatar.hint")} error={fileError} announceError>
            {(control) => (
              <div className="file-picker">
                <input
                  {...control}
                  type="file"
                  className="visually-hidden"
                  accept={AVATAR_TYPES}
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(file);
                  }}
                />
                <label htmlFor={control.id} className="btn" aria-busy={busy}>
                  <Icon name="upload" size={18} />{" "}
                  {busy ? t("personal.avatar.uploading") : avatar ? t("personal.avatar.chooseOther") : t("personal.avatar.choose")}
                </label>
              </div>
            )}
          </Field>
          {avatar && (
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={remove.busy}
                aria-busy={remove.busy}
                aria-label={t("personal.avatar.removeLabel")}
                onClick={drop}
              >
                <Icon name="trash" size={18} /> {t("personal.avatar.remove")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** How long saved AI chats are kept; the daily job deletes older ones. */
function ChatRetentionForm({ days }: { days: number | null }) {
  const t = useT();
  const [choice, setChoice] = useState(days === null ? FOREVER : String(days));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setBusy(true);
    try {
      const value = choice === FOREVER ? null : (Number(choice) as ChatRetentionDays);
      await setChatRetentionFn({ data: { days: value } });
      setResult({ ok: true, text: t("personal.chat.saved") });
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" noValidate onSubmit={submit} aria-labelledby="chat-retention-title" style={{ maxWidth: 520 }}>
      <h2 id="chat-retention-title">{t("personal.chat.title")}</h2>
      {result && <Banner tone={result.ok ? "ok" : "danger"}>{result.text}</Banner>}
      <Field label={t("personal.chat.retention")} hint={t("personal.chat.retentionHint")}>
        {(control) => (
          <select {...control} value={choice} onChange={(event) => setChoice(event.target.value)}>
            {CHAT_RETENTION_DAYS.map((d) => (
              <option key={d} value={String(d)}>
                {t("personal.chat.days", { count: d })}
              </option>
            ))}
            <option value={FOREVER}>{t("personal.chat.forever")}</option>
          </select>
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

function PersonalDataSection() {
  const { user, groups } = Route.useRouteContext();
  const { chatRetention } = Route.useLoaderData();
  const { aiAllowed } = appRoute.useLoaderData();
  const router = useRouter();
  const t = useT();
  const [name, setName] = useState(user.name || user.username);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    const trimmed = name.trim();
    if (!check({ name: trimmed ? (trimmed.length > 64 ? t("personal.data.nameTooLong") : undefined) : t("personal.data.nameRequired") }))
      return;
    setBusy(true);
    try {
      await setOwnNameFn({ data: { name: trimmed } });
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error, t) });
      return;
    } finally {
      setBusy(false);
    }
    setResult({ ok: true, text: t("personal.data.nameSaved") });
    await router.invalidate();
  }

  return (
    <div className="stack">
      <AvatarForm userId={user.id} name={user.name || user.username} avatar={user.avatar} readOnly={Boolean(user.impersonation)} />
      <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="data-title" style={{ maxWidth: 520 }}>
        <h2 id="data-title">{t("personal.data.title")}</h2>
        {result && <Banner tone={result.ok ? "ok" : "danger"}>{result.text}</Banner>}
        <Field label={t("personal.data.displayName")} hint={t("personal.data.displayNameHint")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={64}
              autoComplete="name"
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("common.fields.username")} hint={t("personal.data.usernameHint")}>
          {(control) => <input {...control} className="mono" value={user.username} readOnly />}
        </Field>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {t("common.save")}
          </button>
        </div>
      </form>
      <section className="card" aria-labelledby="access-title" style={{ maxWidth: 520 }}>
        <h2 id="access-title">{t("personal.data.accessTitle")}</h2>
        <dl className="facts">
          <dt>{t("common.fields.role")}</dt>
          <dd>{t(`labels.role.${user.role}`)}</dd>
          <dt>{t("common.fields.groups")}</dt>
          <dd>
            {user.role === "superuser"
              ? t("personal.data.allAccountsSuperuser")
              : user.role === "familyAdmin"
                ? t("personal.data.allAccountsFamilyAdmin")
                : groups.length > 0
                  ? groups.map((g) => g.name).join(", ")
                  : t("personal.data.noGroups")}
          </dd>
        </dl>
      </section>
      {aiAllowed && chatRetention && !user.impersonation && <ChatRetentionForm days={chatRetention.days} />}
    </div>
  );
}
