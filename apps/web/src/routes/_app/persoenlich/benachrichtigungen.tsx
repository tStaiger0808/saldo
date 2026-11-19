import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useEffect, useState } from "react";
import { Field } from "../../../components/Field.tsx";
import { Banner, NoticeBanner, Status, type StatusTone } from "../../../components/Status.tsx";
import type { MessageKey } from "../../../i18n/index.ts";
import { INTL_LOCALES, type Locale } from "../../../i18n/locales.ts";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { errorMessage, useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { currentPushSubscription } from "../../../lib/push.ts";
import {
  deletePushSubscriptionFn,
  getNotificationSettingsFn,
  saveContactEmailFn,
  saveNotificationPreferencesFn,
  savePushSubscriptionFn,
  sendTestNotificationFn,
} from "../../../server/functions/notifications.ts";

export const Route = createFileRoute("/_app/persoenlich/benachrichtigungen")({
  loader: () => getNotificationSettingsFn(),
  component: NotificationsSection,
});

type Settings = Awaited<ReturnType<typeof getNotificationSettingsFn>>;
type Preference = Settings["preferences"][number];
type Kind = Preference["kind"];
type Unit = "euro" | "percent" | "count" | "days";

type ThresholdLabel = Extract<MessageKey, `personal.events.kind.${string}.threshold`>;

const THRESHOLDS: Partial<Record<Kind, { label: ThresholdLabel; unit: Unit }>> = {
  large_expense: { label: "personal.events.kind.large_expense.threshold", unit: "euro" },
  low_balance: { label: "personal.events.kind.low_balance.threshold", unit: "euro" },
  price_change: { label: "personal.events.kind.price_change.threshold", unit: "percent" },
  uncategorized: { label: "personal.events.kind.uncategorized.threshold", unit: "count" },
  bank_problem: { label: "personal.events.kind.bank_problem.threshold", unit: "days" },
  contract_upcoming: { label: "personal.events.kind.contract_upcoming.threshold", unit: "days" },
};

/** Euro amounts in the reader's notation without grouping, so the text parses back as typed. */
const toText = (value: number | null, unit: Unit | undefined, locale: Locale) =>
  value === null
    ? ""
    : unit === "euro"
      ? new Intl.NumberFormat(INTL_LOCALES[locale], { maximumFractionDigits: 2, useGrouping: false }).format(value / 100)
      : String(value);

function parseThreshold(text: string, unit: Unit): number | null {
  const clean = text.trim().replace(/\s/g, "");
  if (unit === "euro") {
    if (!/^-?\d+([.,]\d{1,2})?$/.test(clean)) return null;
    return Math.round(Number(clean.replace(",", ".")) * 100);
  }
  return /^\d+$/.test(clean) ? Number(clean) : null;
}

function NotificationsSection() {
  const settings = Route.useLoaderData();
  const { notice, setNotice, clear } = useNotice();
  return (
    <div className="stack">
      <NoticeBanner notice={notice} onClose={clear} />
      <ContactEmail settings={settings} onSaved={(text) => setNotice({ tone: "ok", text })} />
      <PushDevice settings={settings} />
      <Events settings={settings} onSaved={(text) => setNotice({ tone: "ok", text })} />
      <TestNotification />
    </div>
  );
}

function ContactEmail({ settings, onSaved }: { settings: Settings; onSaved: (text: string) => void }) {
  const t = useT();
  const [email, setEmail] = useState(settings.notifyEmail ?? "");
  const { form, errors, check, clear } = useFormErrors<{ email: string }>();
  const save = useAction(saveContactEmailFn);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!check({ email: value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? t("personal.contact.invalid") : undefined })) return;
    const result = await save.run({ data: { notifyEmail: value } });
    if (result.ok) onSaved(value ? t("personal.contact.savedTo", { email: value }) : t("personal.contact.removed"));
  }

  return (
    <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="contact-title">
      <h2 id="contact-title">{t("personal.contact.title")}</h2>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      {!settings.mailReady && <Banner tone="info">{t("personal.contact.notSetUp")}</Banner>}
      <Field label={t("personal.contact.label")} hint={t("personal.contact.hint")} error={errors.email}>
        {(control) => (
          <input
            {...control}
            type="email"
            value={email}
            maxLength={255}
            autoComplete="email"
            spellCheck={false}
            onChange={(event) => {
              setEmail(event.target.value);
              clear("email");
            }}
          />
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

type PushState = "checking" | "insecure" | "unsupported" | "denied" | "off" | "on";

const PUSH_TONE: Record<PushState, StatusTone> = {
  checking: "neutral",
  insecure: "warn",
  unsupported: "warn",
  denied: "danger",
  off: "neutral",
  on: "ok",
};

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function PushDevice({ settings }: { settings: Settings }) {
  const router = useRouter();
  const save = useServerFn(savePushSubscriptionFn);
  const remove = useServerFn(deletePushSubscriptionFn);
  const t = useT();
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.isSecureContext) return setState("insecure");
    if (!settings.pushPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    currentPushSubscription().then(
      (subscription) => setState(subscription ? "on" : "off"),
      () => setState("off"),
    );
  }, [settings.pushPublicKey]);

  async function enable() {
    const publicKey = settings.pushPublicKey;
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        if (permission !== "denied") setError(t("personal.push.noPermission"));
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      const json = subscription.toJSON();
      await save({ data: { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } } });
      setState("on");
      await router.invalidate();
    } catch (e) {
      setError(t("personal.push.setupFailed", { reason: errorMessage(e, t) }));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const subscription = await currentPushSubscription();
      if (subscription) {
        await remove({ data: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
      setState("off");
      await router.invalidate();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="push-title">
      <h2 id="push-title">{t("personal.push.title")}</h2>
      <p>
        <Status tone={PUSH_TONE[state]} inline emphasis={state === "denied" ? "notice" : undefined}>
          {t(`personal.push.state.${state}`)}
        </Status>
      </p>
      {error && <Banner tone="danger">{error}</Banner>}
      {state === "insecure" && <p className="muted measure">{t("personal.push.insecureText")}</p>}
      {state === "unsupported" && <p className="muted measure">{t("personal.push.unsupportedText")}</p>}
      {state === "denied" && <p className="muted measure">{t("personal.push.deniedText")}</p>}
      {(state === "off" || state === "on") && (
        <p className="muted measure">{t("personal.push.devices", { count: settings.pushDevices })}</p>
      )}
      <div className="actions">
        {state === "on" ? (
          <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={disable}>
            {t("personal.push.disable")}
          </button>
        ) : (
          (state === "off" || state === "checking") && (
            <button type="button" className="btn btn-primary" disabled={busy || state === "checking"} aria-busy={busy} onClick={enable}>
              {t("personal.push.enable")}
            </button>
          )
        )}
      </div>
    </section>
  );
}

type Draft = Preference & { text: string };

function Events({ settings, onSaved }: { settings: Settings; onSaved: (text: string) => void }) {
  const { t, locale } = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    settings.preferences.map((p) => ({ ...p, text: toText(p.threshold, THRESHOLDS[p.kind]?.unit, locale) })),
  );
  const { form, errors, check, clear } = useFormErrors<Partial<Record<Kind, string>>>();
  const save = useAction(saveNotificationPreferencesFn);

  const update = (kind: Kind, patch: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.kind === kind ? { ...d, ...patch } : d)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Partial<Record<Kind, string>> = {};
    const preferences = drafts.map(({ text, ...p }) => {
      const unit = THRESHOLDS[p.kind]?.unit;
      if (!unit) return { ...p, threshold: null };
      const threshold = parseThreshold(text, unit);
      if (threshold === null) problems[p.kind] = unit === "euro" ? t("personal.events.amountFormat") : t("personal.events.wholeNumber");
      return { ...p, threshold };
    });
    if (!check(problems)) return;
    const result = await save.run({ data: { preferences } });
    if (result.ok) onSaved(t("personal.events.saved"));
  }

  return (
    <form ref={form} className="card" noValidate onSubmit={submit} aria-labelledby="events-title">
      <h2 id="events-title">{t("personal.events.title")}</h2>
      <p className="muted measure">{t("personal.events.intro")}</p>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <div className="event-list">
        {drafts.map((d) => {
          const threshold = THRESHOLDS[d.kind];
          return (
            <fieldset key={d.kind} className="event-row" aria-describedby={`event-${d.kind}-hint`}>
              <legend>{t(`personal.events.kind.${d.kind}.label`)}</legend>
              <span id={`event-${d.kind}-hint`} className="field-hint">
                {t(`personal.events.kind.${d.kind}.hint`)}
              </span>
              <div className="checks">
                <label className="checkbox">
                  <input type="checkbox" checked={d.enabled} onChange={(event) => update(d.kind, { enabled: event.target.checked })} />
                  {t("personal.events.notify")}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={d.push}
                    disabled={!d.enabled}
                    onChange={(event) => update(d.kind, { push: event.target.checked })}
                  />
                  {t("personal.events.alsoPush")}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={d.email}
                    disabled={!d.enabled}
                    onChange={(event) => update(d.kind, { email: event.target.checked })}
                  />
                  {t("personal.events.alsoEmail")}
                </label>
              </div>
              {threshold && (
                <Field label={t(threshold.label)} error={errors[d.kind]} className="event-threshold">
                  {(control) => (
                    <input
                      {...control}
                      inputMode={threshold.unit === "euro" ? "decimal" : "numeric"}
                      value={d.text}
                      onChange={(event) => {
                        update(d.kind, { text: event.target.value });
                        clear(d.kind);
                      }}
                    />
                  )}
                </Field>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

function TestNotification() {
  const send = useAction(sendTestNotificationFn, { invalidate: false });
  const router = useRouter();
  const t = useT();
  const [result, setResult] = useState<{ push: string; email: string } | null>(null);

  async function run() {
    setResult(null);
    const sent = await send.run();
    if (!sent.ok) return;
    setResult(sent.value);
    await router.invalidate();
  }

  return (
    <section className="card" aria-labelledby="test-title">
      <h2 id="test-title">{t("personal.test.title")}</h2>
      <p className="muted measure">{t("personal.test.intro")}</p>
      {send.error && <Banner tone="danger">{send.error}</Banner>}
      {result && (
        <Banner tone="ok">
          {t("personal.test.saved")} {result.push} {result.email}
        </Banner>
      )}
      <div className="actions">
        <button type="button" className="btn" disabled={send.busy} aria-busy={send.busy} onClick={run}>
          {t("personal.test.send")}
        </button>
      </div>
    </section>
  );
}
