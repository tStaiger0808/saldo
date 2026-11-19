import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { ConnectionMenu } from "../../../components/AccountActions.tsx";
import { BankBadge, connectionLogoUrl } from "../../../components/AccountBits.tsx";
import {
  AcceptField,
  type BankingSettings,
  type Connection,
  coveredText,
  type Provider,
  providerName,
  type UnofficialProvider,
  UnofficialWarning,
} from "../../../components/BankDialogs.tsx";
import { CopyButton } from "../../../components/Bits.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner, Status, type StatusTone, Tag } from "../../../components/Status.tsx";
import type { Translate } from "../../../i18n/index.ts";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { type Notice, useAction, useNotice } from "../../../lib/action.ts";
import type { Formatter } from "../../../lib/format.ts";
import { focusFirstInvalid, useFormErrors } from "../../../lib/forms.ts";
import {
  getBankConnectionsFn,
  getBankingSettingsFn,
  recheckEnableBankingFn,
  saveEnableBankingSettingsFn,
  saveFintsSettingsFn,
  setSyncScheduleFn,
  setUnofficialProviderFn,
} from "../../../server/functions/banking.ts";

export const Route = createFileRoute("/_app/einstellungen/bankverbindungen")({
  // Connections of everyone else live on the accounts page now; only the instance setup stays here.
  beforeLoad: ({ context }) => {
    if (context.user.role !== "superuser") throw redirect({ to: "/konten" });
  },
  loader: async () => {
    const [settings, connections] = await Promise.all([getBankingSettingsFn(), getBankConnectionsFn()]);
    return { settings, connections };
  },
  component: BankingSection,
});

function BankingSection() {
  const { settings, connections } = Route.useLoaderData();
  const { notice, setNotice, clear } = useNotice();
  const t = useT();
  const ready = (provider: Provider) => settings.available.includes(provider);

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <p className="muted measure">{t("banking.page.intro")}</p>
      <section className="card" aria-labelledby="eb-title">
        <ProviderHead id="eb-title" provider="enable_banking" ready={ready("enable_banking")} />
        <EnableBankingSettings settings={settings} onNotice={setNotice} />
      </section>
      <section className="card" aria-labelledby="fints-title">
        <ProviderHead id="fints-title" provider="fints" ready={ready("fints")} />
        <FintsSettings settings={settings} onNotice={setNotice} />
      </section>
      <section className="card" aria-labelledby="unofficial-title">
        <div className="card-head">
          <h2 id="unofficial-title">{t("banking.page.unofficialTitle")}</h2>
        </div>
        <p className="muted measure">{t("banking.page.unofficialIntro")}</p>
        <div className="stack">
          <UnofficialSettings provider="trade_republic" enabled={settings.unofficial.trade_republic} onNotice={setNotice} />
          <UnofficialSettings provider="givve" enabled={settings.unofficial.givve} onNotice={setNotice} />
        </div>
      </section>
      <section className="card" aria-labelledby="schedule-title">
        <div className="card-head">
          <h2 id="schedule-title">{t("banking.page.schedule.title")}</h2>
          <Status tone={settings.schedule.enabled ? "ok" : "neutral"} inline>
            {settings.schedule.enabled ? t("banking.page.schedule.statusOn") : t("banking.page.schedule.statusOff")}
          </Status>
        </div>
        <p className="muted measure">{t("banking.page.schedule.intro")}</p>
        <SyncScheduleSettings schedule={settings.schedule} timeZone={settings.serverTimeZone} onNotice={setNotice} />
      </section>
      <Connections connections={connections} schedule={settings.schedule} onNotice={setNotice} />
    </>
  );
}

function ProviderHead({ id, provider, ready }: { id: string; provider: Provider; ready: boolean }) {
  const t = useT();
  return (
    <>
      <div className="card-head">
        <h2 id={id}>{providerName(t, provider)}</h2>
        <Status tone={ready ? "ok" : "neutral"} inline>
          {ready ? t("banking.page.providerReady") : t("banking.page.providerOff")}
        </Status>
      </div>
      <p className="muted measure">{t(`banking.providers.${provider}.description`)}</p>
    </>
  );
}

/** Off by default; enabling takes the confirmed warning, and the provider is then offered to everyone who connects a bank. */
function UnofficialSettings({
  provider,
  enabled,
  onNotice,
}: {
  provider: UnofficialProvider;
  enabled: boolean;
  onNotice: (n: Notice) => void;
}) {
  const t = useT();
  const id = useId();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const save = useAction(setUnofficialProviderFn);
  const name = providerName(t, provider);

  async function apply(next: boolean) {
    if (next && !accepted) {
      setError(t("banking.unofficial.acceptRequired"));
      return;
    }
    const result = await save.run({ data: { provider, enabled: next, acknowledged: next } });
    if (!result.ok) return;
    setAccepted(false);
    onNotice({ tone: "ok", text: next ? t("banking.page.unofficialOn", { name }) : t("banking.page.unofficialOff", { name }) });
  }

  return (
    <section className="stack-sm" aria-labelledby={`${id}-title`}>
      <div className="row-between">
        <h3 id={`${id}-title`}>{name}</h3>
        <Status tone={enabled ? "warn" : "neutral"} inline>
          {enabled ? t("banking.page.providerReady") : t("banking.page.providerOff")}
        </Status>
      </div>
      <p className="muted measure">{t(`banking.providers.${provider}.description`)}</p>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      {enabled ? (
        <div className="actions">
          <button type="button" className="btn" disabled={save.busy} aria-busy={save.busy} onClick={() => apply(false)}>
            {t("banking.page.disable", { name })}
          </button>
        </div>
      ) : (
        <>
          <UnofficialWarning provider={provider} />
          <AcceptField
            checked={accepted}
            error={error}
            onChange={(value) => {
              setAccepted(value);
              setError(undefined);
            }}
          />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy} onClick={() => apply(true)}>
              {t("banking.page.enable", { name })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function FintsSettings({ settings, onNotice }: { settings: BankingSettings; onNotice: (n: Notice) => void }) {
  const [productId, setProductId] = useState(settings.fints.productId ?? "");
  const [version, setVersion] = useState(settings.fints.productVersion ?? "");
  const { form, errors, check, clear } = useFormErrors<{ productId: string; version: string }>();
  const save = useAction(saveFintsSettingsFn);
  const t = useT();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !check({
        productId: /^[A-Za-z0-9]{1,25}$/.test(productId.trim()) ? undefined : t("banking.page.productIdFormat"),
        version: /^[A-Za-z0-9.]*$/.test(version.trim()) ? undefined : t("banking.page.productVersionFormat"),
      })
    )
      return;
    const result = await save.run({ data: { productId: productId.trim(), productVersion: version.trim() } });
    if (result.ok) onNotice({ tone: "ok", text: t("banking.page.productIdSaved") });
  }

  return (
    <form ref={form} className="stack" noValidate onSubmit={submit}>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <Field label={t("banking.page.productIdLabel")} hint={t("banking.page.productIdHint")} error={errors.productId}>
        {(control) => (
          <input
            {...control}
            className="mono"
            value={productId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setProductId(event.target.value);
              clear("productId");
            }}
          />
        )}
      </Field>
      <Field label={t("banking.page.productVersionLabel")} hint={t("banking.page.productVersionHint")} error={errors.version}>
        {(control) => (
          <input
            {...control}
            className="mono"
            value={version}
            placeholder="1.0"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setVersion(event.target.value);
              clear("version");
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

const CHECK_TONES: Record<"ok" | "inactive" | "invalid", StatusTone> = { ok: "ok", inactive: "warn", invalid: "danger" };

function EnableBankingSettings({ settings, onNotice }: { settings: BankingSettings; onNotice: (n: Notice) => void }) {
  const redirectId = useId();
  const [appId, setAppId] = useState(settings.enableBanking.appId ?? "");
  const [key, setKey] = useState("");
  const [fileError, setFileError] = useState<string | undefined>();
  const [keyInput, setKeyInput] = useState<"text" | "file">("text");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ appId: string; key: string }>();
  const save = useAction(saveEnableBankingSettingsFn);
  const recheck = useAction(recheckEnableBankingFn);
  const { t, f } = useI18n();
  const result = settings.enableBanking.check;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !check({
        appId: appId.trim() ? undefined : t("banking.page.appIdRequired"),
        key: key.trim() || settings.enableBanking.keySet ? undefined : t("banking.page.keyRequired"),
      })
    )
      return;
    const saved = await save.run({ data: { appId: appId.trim(), privateKey: key.trim() || undefined } });
    if (!saved.ok) return;
    setKey("");
    setKeyFile(null);
    onNotice({ tone: saved.value.status === "ok" ? "ok" : "warn", text: saved.value.message });
  }

  return (
    <div className="stack">
      <div className="field">
        <label className="field-label" htmlFor={redirectId}>
          {t("banking.page.redirectUrl")}
        </label>
        <div className="copy-field">
          <input id={redirectId} className="mono" readOnly value={settings.redirectUrl} aria-describedby={`${redirectId}-hint`} />
          <CopyButton text={settings.redirectUrl} label={t("banking.page.copyAddress")} />
        </div>
        <span id={`${redirectId}-hint`} className="field-hint">
          {t("banking.page.redirectHint")}
        </span>
      </div>
      <form ref={form} className="stack" noValidate onSubmit={submit}>
        {save.error && <Banner tone="danger">{save.error}</Banner>}
        <Field label={t("banking.page.appId")} error={errors.appId}>
          {(control) => (
            <input
              {...control}
              className="mono"
              value={appId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setAppId(event.target.value);
                clear("appId");
              }}
            />
          )}
        </Field>
        <fieldset className="field">
          <legend className="field-label">{t("banking.page.privateKey")}</legend>
          <div className="segmented">
            <button type="button" aria-pressed={keyInput === "text"} onClick={() => setKeyInput("text")}>
              {t("banking.page.pasteText")}
            </button>
            <button type="button" aria-pressed={keyInput === "file"} onClick={() => setKeyInput("file")}>
              {t("banking.page.uploadFile")}
            </button>
          </div>
          {keyInput === "text" ? (
            <Field
              label={t("banking.page.keyAsText")}
              hideLabel
              hint={settings.enableBanking.keySet ? t("banking.page.keyStoredText") : t("banking.page.keyTextHint")}
              error={errors.key}
            >
              {(control) => (
                <textarea
                  {...control}
                  className="mono"
                  value={key}
                  spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  onChange={(event) => {
                    setKey(event.target.value);
                    setKeyFile(null);
                    clear("key");
                  }}
                />
              )}
            </Field>
          ) : (
            <Field
              label={t("banking.page.keyFile")}
              hideLabel
              hint={keyFile ? undefined : settings.enableBanking.keySet ? t("banking.page.keyStoredFile") : t("banking.page.keyFileHint")}
              error={fileError ?? errors.key}
            >
              {(control) => (
                <div className="file-picker">
                  <input
                    {...control}
                    type="file"
                    className="visually-hidden"
                    accept=".pem,.key,application/x-pem-file,text/plain"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      setFileError(undefined);
                      if (!file) return;
                      // A PEM private key is a few kilobytes; anything far larger is the wrong file.
                      if (file.size > 16_384) {
                        setFileError(t("banking.page.fileTooLarge"));
                        return;
                      }
                      const text = (await file.text()).trim();
                      if (!text.includes("PRIVATE KEY")) {
                        setFileError(t("banking.page.fileNoKey"));
                        return;
                      }
                      setKey(text);
                      setKeyFile(file.name);
                      clear("key");
                    }}
                  />
                  <label htmlFor={control.id} className="btn">
                    <Icon name="upload" size={18} /> {keyFile ? t("banking.page.chooseOtherFile") : t("banking.page.chooseFile")}
                  </label>
                  <span className={keyFile ? "mono" : "muted"}>{keyFile ?? t("banking.page.noFile")}</span>
                </div>
              )}
            </Field>
          )}
        </fieldset>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {t("banking.page.saveAndCheck")}
          </button>
        </div>
      </form>
      {result && (
        <section className="stack-sm" aria-labelledby="check-title">
          <div className="row-between">
            <h3 id="check-title">{t("banking.page.checkTitle")}</h3>
            <button type="button" className="btn btn-sm" disabled={recheck.busy} aria-busy={recheck.busy} onClick={() => recheck.run()}>
              <Icon name="sync" size={16} /> {t("banking.page.recheck")}
            </button>
          </div>
          {recheck.error && <Banner tone="danger">{recheck.error}</Banner>}
          <Status
            tone={CHECK_TONES[result.status]}
            emphasis={result.status === "ok" ? undefined : "notice"}
            inline
            detail={t("banking.page.checkedAt", { date: f.dateTime(result.checkedAt) })}
          >
            {t(`banking.page.checkStatus.${result.status}`)}
          </Status>
          <p>{result.message}</p>
          <dl className="facts">
            <dt>{t("banking.page.app")}</dt>
            <dd>{result.appName ?? "–"}</dd>
            <dt>{t("banking.page.environment")}</dt>
            <dd>{result.environment ?? "–"}</dd>
            <dt>{t("banking.page.redirectUrl")}</dt>
            <dd>{result.redirectRegistered ? t("banking.page.registered") : t("banking.page.notRegistered")}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}

function connectionStatus(c: Connection, t: Translate, f: Formatter): { tone: StatusTone; text: string; detail?: string } {
  if (c.activeJobId) return { tone: "info", text: t("banking.page.status.syncRunning") };
  if (c.status === "error") return { tone: "danger", text: t("common.fields.error"), detail: c.lastError || undefined };
  if (c.status === "no_accounts") {
    return { tone: "warn", text: t("banking.page.status.noAccountsReleased"), detail: t("banking.authorizedNoAccounts", { name: c.name }) };
  }
  if (c.status === "new") {
    return {
      tone: "warn",
      text: c.provider === "enable_banking" ? t("banking.page.status.authorizationMissing") : t("banking.page.status.notChecked"),
    };
  }
  if (c.status === "needs_reauth") return { tone: "warn", text: t("banking.page.status.reloginNeeded"), detail: c.lastError || undefined };
  if (c.consentValidUntil && new Date(c.consentValidUntil) < new Date())
    return {
      tone: "warn",
      text: t("banking.page.status.consentExpired"),
      detail: t("banking.page.status.since", { date: f.date(c.consentValidUntil) }),
    };
  if (c.linkedAccounts.length === 0) return { tone: "warn", text: t("banking.page.status.noAccounts") };
  return {
    tone: "ok",
    text: t("common.fields.active"),
    detail: c.lastSyncAt ? t("banking.page.status.lastSync", { date: f.dateTime(c.lastSyncAt) }) : t("banking.page.status.neverSynced"),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One schedule for every connection, in the server's timezone; unattended runs stop where a person would be needed. */
function SyncScheduleSettings({
  schedule,
  timeZone,
  onNotice,
}: {
  schedule: BankingSettings["schedule"];
  timeZone: string;
  onNotice: (n: Notice) => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [times, setTimes] = useState<string[]>(schedule.times.length > 0 ? schedule.times : ["07:00"]);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [listError, setListError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const save = useAction(setSyncScheduleFn);
  const t = useT();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Record<number, string> = {};
    times.forEach((time, i) => {
      if (!TIME.test(time)) problems[i] = t("banking.page.schedule.timeFormat");
    });
    setErrors(problems);
    setListError(enabled && times.length === 0 ? t("banking.page.schedule.timeRequired") : null);
    if (Object.keys(problems).length > 0 || (enabled && times.length === 0)) {
      focusFirstInvalid(form);
      return;
    }
    const result = await save.run({ data: { enabled, times } });
    if (!result.ok) return;
    onNotice({
      tone: "ok",
      text: result.value.enabled ? t("banking.page.schedule.on", { times: result.value.times.join(", ") }) : t("banking.page.schedule.off"),
    });
  }

  return (
    <form ref={form} className="stack" noValidate onSubmit={submit}>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("banking.page.schedule.daily")}
      </label>
      <fieldset className="field" disabled={!enabled}>
        <legend>{t("banking.page.schedule.times")}</legend>
        <ul className="list schedule-times">
          {times.map((time, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
            <li key={index}>
              <Field
                label={t("banking.page.schedule.time", { number: index + 1 })}
                hideLabel
                error={errors[index]}
                className="field-inline"
              >
                {(control) => (
                  <input
                    {...control}
                    type="time"
                    value={time}
                    required
                    onChange={(event) => {
                      const value = event.target.value;
                      setTimes((all) => all.map((time, i) => (i === index ? value : time)));
                      setErrors(({ [index]: _, ...rest }) => rest);
                    }}
                  />
                )}
              </Field>
              <button type="button" className="btn btn-sm" onClick={() => setTimes((all) => all.filter((_, i) => i !== index))}>
                {t("common.remove")}
                <span className="visually-hidden">
                  {t("banking.nameSuffix", { name: t("banking.page.schedule.time", { number: index + 1 }) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {listError && (
          <span className="field-error" role="alert">
            {listError}
          </span>
        )}
        <div>
          <button type="button" className="btn btn-sm" disabled={times.length >= 12} onClick={() => setTimes((all) => [...all, "12:00"])}>
            {t("banking.page.schedule.add")}
          </button>
        </div>
        <span className="field-hint">{t("banking.page.schedule.serverTime", { zone: timeZone })}</span>
      </fieldset>
      <ul className="muted small warning-list">
        <li>{t("banking.page.schedule.fintsNote")}</li>
        <li>{t("banking.page.schedule.ebNote")}</li>
        <li>{t("banking.page.schedule.unofficialNote")}</li>
      </ul>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

/** The superuser's overview of every connection, with the same actions as the accounts page. */
function Connections({
  connections,
  schedule,
  onNotice,
}: {
  connections: Connection[];
  schedule: BankingSettings["schedule"];
  onNotice: (notice: Notice) => void;
}) {
  const { t, f } = useI18n();
  return (
    <section className="card" aria-labelledby="connections-title">
      <div className="card-head">
        <h2 id="connections-title">{t("banking.page.overviewTitle")}</h2>
      </div>
      <p className="muted small">{t("banking.page.overviewIntro")}</p>
      {connections.length === 0 ? (
        <p className="empty">{t("banking.page.empty")}</p>
      ) : (
        <ul className="list">
          {connections.map((c) => {
            const look = connectionStatus(c, t, f);
            const facts = [
              providerName(t, c.provider),
              t(`labels.visibility.${c.visibility}`),
              c.owner && t("banking.page.ownedBy", { owner: c.owner }),
              c.consentValidUntil && t("banking.page.consentUntil", { date: f.date(c.consentValidUntil) }),
              schedule.enabled && !c.skipSyncAll && t("banking.page.scheduledAt", { times: schedule.times.join(", ") }),
            ].filter(Boolean);
            return (
              <li key={c.id} className="list-row">
                <BankBadge label={"bankName" in c.target ? c.target.bankName || c.name : c.name} logo={connectionLogoUrl(c)} />
                <span className="list-main">
                  <span className="list-title">
                    {c.name}
                    <Status
                      tone={look.tone}
                      emphasis={look.tone === "danger" ? "urgent" : look.tone === "warn" ? "notice" : undefined}
                      inline
                      detail={look.detail}
                    >
                      {look.text}
                    </Status>
                    {c.skipSyncAll && <Tag>{t("banking.manualOnly")}</Tag>}
                  </span>
                  <span className="list-sub">{facts.join(" · ")}</span>
                  {c.linkedAccounts.length > 0 ? (
                    <span className="list-sub">
                      {c.linkedAccounts.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ", "}
                          <Link to="/konten/$accountId" params={{ accountId: String(a.id) }}>
                            {a.name}
                          </Link>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="list-sub">{t("banking.page.noAccountsLinked")}</span>
                  )}
                  {c.remoteAccounts
                    .filter((r) => r.coveredBy && !c.linkedAccounts.some((a) => a.remoteRef === r.ref))
                    .map((r) => (
                      <span key={r.ref} className="list-sub">
                        {coveredText(t, r)}
                      </span>
                    ))}
                </span>
                <span className="list-actions">
                  <ConnectionMenu connection={c} onNotice={onNotice} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
