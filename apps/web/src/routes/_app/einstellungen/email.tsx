import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Field } from "../../../components/Field.tsx";
import { Banner, NoticeBanner } from "../../../components/Status.tsx";
import { useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { requireSection } from "../../../lib/settings.ts";
import { getMailSettingsFn, saveMailSettingsFn, sendTestMailFn } from "../../../server/functions/notifications.ts";

export const Route = createFileRoute("/_app/einstellungen/email")({
  beforeLoad: requireSection("email"),
  loader: () => getMailSettingsFn(),
  component: MailSection,
});

type Security = "none" | "starttls" | "tls";

/** Default port per mode; labels live under `settings.email.security`. */
const SECURITY: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = { host: string; port: string; fromAddress: string };

function MailSection() {
  const stored = Route.useLoaderData();
  const t = useT();
  const { notice, setNotice, clear } = useNotice();
  const [host, setHost] = useState(stored?.host ?? "");
  const [port, setPort] = useState(String(stored?.port ?? 587));
  const [security, setSecurity] = useState<Security>(stored?.security ?? "starttls");
  const [username, setUsername] = useState(stored?.username ?? "");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState(stored?.fromAddress ?? "");
  const [fromName, setFromName] = useState(stored?.fromName ?? "Saldo");
  const { form, errors, check, clear: clearError } = useFormErrors<Errors>();
  const save = useAction(saveMailSettingsFn);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const portNumber = Number(port);
    if (
      !check({
        host: host.trim() ? undefined : t("settings.email.hostRequired"),
        port: Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 ? undefined : t("settings.email.portRange"),
        fromAddress: EMAIL.test(fromAddress.trim()) ? undefined : t("settings.email.fromInvalid"),
      })
    )
      return;
    const result = await save.run({
      data: {
        host: host.trim(),
        port: portNumber,
        security,
        username: username.trim(),
        password: password || undefined,
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim(),
      },
    });
    if (!result.ok) return;
    setPassword("");
    setNotice({ tone: "ok", text: t("settings.email.saved") });
  }

  const field = <K extends keyof Errors>(key: K, set: (value: string) => void) => ({
    onChange: (event: { target: { value: string } }) => {
      set(event.target.value);
      clearError(key);
    },
  });

  return (
    <div className="stack">
      <NoticeBanner notice={notice} onClose={clear} />
      <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="smtp-title">
        <h2 id="smtp-title">{t("settings.email.smtpTitle")}</h2>
        <p className="muted measure">{t("settings.email.intro")}</p>
        {save.error && <Banner tone="danger">{save.error}</Banner>}
        <div className="form-grid">
          <Field label={t("settings.email.server")} hint={t("settings.email.serverHint")} error={errors.host}>
            {(control) => (
              <input {...control} className="mono" value={host} autoComplete="off" spellCheck={false} {...field("host", setHost)} />
            )}
          </Field>
          <Field label={t("settings.email.port")} error={errors.port}>
            {(control) => <input {...control} inputMode="numeric" value={port} {...field("port", setPort)} />}
          </Field>
          <Field label={t("settings.email.encryption")}>
            {(control) => (
              <select
                {...control}
                value={security}
                onChange={(event) => {
                  const next = event.target.value as Security;
                  if (Number(port) === SECURITY[security]) setPort(String(SECURITY[next]));
                  setSecurity(next);
                }}
              >
                {(Object.keys(SECURITY) as Security[]).map((key) => (
                  <option key={key} value={key}>
                    {t(`settings.email.security.${key}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t("common.fields.username")} hint={t("settings.email.usernameHint")}>
            {(control) => (
              <input
                {...control}
                value={username}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t("common.fields.password")}
            hint={stored?.passwordSet ? t("settings.email.passwordStored") : t("settings.email.passwordEncrypted")}
          >
            {(control) => (
              <input
                {...control}
                type="password"
                value={password}
                autoComplete="new-password"
                disabled={!username.trim()}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Field label={t("settings.email.fromAddress")} error={errors.fromAddress}>
            {(control) => (
              <input
                {...control}
                type="email"
                value={fromAddress}
                autoComplete="off"
                spellCheck={false}
                {...field("fromAddress", setFromAddress)}
              />
            )}
          </Field>
          <Field label={t("settings.email.fromName")}>
            {(control) => <input {...control} value={fromName} maxLength={100} onChange={(event) => setFromName(event.target.value)} />}
          </Field>
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {t("common.save")}
          </button>
        </div>
      </form>
      <TestMail configured={stored !== null} />
    </div>
  );
}

function TestMail({ configured }: { configured: boolean }) {
  const [to, setTo] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ to: string }>();
  const send = useAction(sendTestMailFn, { invalidate: false });
  const t = useT();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    if (!check({ to: EMAIL.test(to.trim()) ? undefined : t("settings.email.toInvalid") })) return;
    const sent = await send.run({ data: { to: to.trim() } });
    if (sent.ok) setResult(sent.value);
  }

  return (
    <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="testmail-title">
      <h2 id="testmail-title">{t("settings.email.testTitle")}</h2>
      <p className="muted measure">{t("settings.email.testIntro")}</p>
      {send.error && <Banner tone="danger">{send.error}</Banner>}
      {result && <Banner tone={result.ok ? "ok" : "danger"}>{result.message}</Banner>}
      <Field label={t("settings.email.recipient")} error={errors.to}>
        {(control) => (
          <input
            {...control}
            type="email"
            value={to}
            autoComplete="email"
            spellCheck={false}
            onChange={(event) => {
              setTo(event.target.value);
              clear("to");
            }}
          />
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="btn" disabled={!configured || send.busy} aria-busy={send.busy}>
          {t("settings.email.send")}
        </button>
      </div>
      {!configured && <p className="muted small">{t("settings.email.saveFirst")}</p>}
    </form>
  );
}
