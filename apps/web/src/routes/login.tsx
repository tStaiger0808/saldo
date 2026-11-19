import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Field } from "../components/Field.tsx";
import { LogoMark } from "../components/Icon.tsx";
import { Banner } from "../components/Status.tsx";
import { useI18n } from "../i18n/react.tsx";
import { authClient } from "../lib/auth-client.ts";
import { useFormErrors } from "../lib/forms.ts";

export const Route = createFileRoute("/login")({
  beforeLoad: ({ context }) => {
    if (context.session.auth) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ username: string; password: string }>();

  const documentTitle = t("shell.pageTitle", { title: t("auth.title") });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    if (
      !check({
        username: username.trim() ? undefined : t("auth.usernameRequired"),
        password: password ? undefined : t("auth.passwordRequired"),
      })
    )
      return;
    setBusy(true);
    const { error } = await authClient.signIn.username({ username: username.trim(), password });
    setBusy(false);
    if (error) {
      setFailure(error.status === 429 ? t("auth.tooManyAttempts") : t("auth.wrongCredentials"));
      return;
    }
    await router.invalidate();
    await router.navigate({ to: "/" });
  }

  return (
    <main className="auth-page" id="inhalt">
      <form ref={form} className="card auth-card" noValidate onSubmit={submit} aria-labelledby="login-title">
        <div className="auth-brand">
          <span className="brand-mark">
            <LogoMark />
          </span>
          Saldo
        </div>
        <h1 id="login-title">{t("auth.title")}</h1>
        {failure && <Banner tone="danger">{failure}</Banner>}
        <Field label={t("auth.username")} error={errors.username}>
          {(control) => (
            <input
              {...control}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                clear("username");
              }}
            />
          )}
        </Field>
        <Field label={t("auth.password")} error={errors.password}>
          {(control) => (
            <input
              {...control}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clear("password");
              }}
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {busy ? t("auth.submitting") : t("auth.submit")}
          </button>
        </div>
      </form>
    </main>
  );
}
