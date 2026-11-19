import { type FormEvent, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { authClient } from "../lib/auth-client.ts";
import { useFormErrors } from "../lib/forms.ts";
import { Field } from "./Field.tsx";
import { Banner } from "./Status.tsx";

type Errors = { current: string; next: string; repeat: string };

export function PasswordForm() {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { form, errors, check, clear } = useFormErrors<Errors>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    if (
      !check({
        current: current ? undefined : t("personal.password.currentRequired"),
        next: next.length >= 12 ? (next === current ? t("personal.password.mustDiffer") : undefined) : t("personal.password.minLength"),
        repeat: repeat === next ? undefined : t("personal.password.repeatMismatch"),
      })
    )
      return;
    setBusy(true);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (error) {
      setResult({
        ok: false,
        text: error.status === 400 || error.status === 401 ? t("personal.password.currentWrong") : t("personal.password.failed"),
      });
      return;
    }
    setCurrent("");
    setNext("");
    setRepeat("");
    setResult({ ok: true, text: t("personal.password.changed") });
  }

  const input =
    (value: string, set: (v: string) => void, key: keyof Errors, autoComplete: string) =>
    (control: Parameters<Parameters<typeof Field>[0]["children"]>[0]) => (
      <input
        {...control}
        type="password"
        value={value}
        autoComplete={autoComplete}
        required
        onChange={(event) => {
          set(event.target.value);
          clear(key);
        }}
      />
    );

  return (
    <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="pw-title" style={{ maxWidth: 520 }}>
      <h2 id="pw-title">{t("personal.password.title")}</h2>
      {result && <Banner tone={result.ok ? "ok" : "danger"}>{result.text}</Banner>}
      <Field label={t("personal.password.current")} error={errors.current}>
        {input(current, setCurrent, "current", "current-password")}
      </Field>
      <Field label={t("personal.password.next")} hint={t("personal.password.minLength")} error={errors.next}>
        {input(next, setNext, "next", "new-password")}
      </Field>
      <Field label={t("personal.password.repeat")} error={errors.repeat}>
        {input(repeat, setRepeat, "repeat", "new-password")}
      </Field>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {t("personal.password.submit")}
        </button>
      </div>
    </form>
  );
}
