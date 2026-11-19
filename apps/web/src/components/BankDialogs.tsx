import { useServerFn } from "@tanstack/react-start";
import { useEffect, useId, useMemo, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useT } from "../i18n/react.tsx";
import { errorMessage, type Notice, useAction } from "../lib/action.ts";
import { useFormErrors } from "../lib/forms.ts";
import type { Visibility } from "../lib/labels.ts";
import {
  completeBankAuthorizationFn,
  createBankConnectionFn,
  type getBankConnectionsFn,
  type getBankingSettingsFn,
  getEnableBankingBanksFn,
  updateBankConnectionFn,
} from "../server/functions/banking.ts";
import { BankBadge, bankLogoUrl } from "./AccountBits.tsx";
import { useBankJobs } from "./BankJobs.tsx";
import { Combobox } from "./Combobox.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

export type Connection = Awaited<ReturnType<typeof getBankConnectionsFn>>[number];
export type BankingSettings = Awaited<ReturnType<typeof getBankingSettingsFn>>;
export type Provider = BankingSettings["available"][number];
export type UnofficialProvider = keyof BankingSettings["unofficial"];

export function providerName(t: Translate, provider: Provider): string {
  return t(`banking.providers.${provider}.name`);
}

/** The risks of an unofficial connection, shown before it is enabled and before each login. */
export function UnofficialWarning({ provider }: { provider: UnofficialProvider }) {
  const t = useT();
  return (
    <div className="banner banner-warn" role="note">
      <Icon name="alert" />
      <div className="banner-body stack-sm">
        <strong>{t("banking.unofficial.warningTitle", { name: providerName(t, provider) })}</strong>
        <ul className="warning-list">
          <li>{t(`banking.unofficial.${provider}.terms`)}</li>
          <li>{t("banking.unofficial.lock")}</li>
          <li>{t(`banking.unofficial.${provider}.stored`)}</li>
          <li>{t("banking.unofficial.breaks")}</li>
          <li>{t("banking.unofficial.readOnly")}</li>
        </ul>
      </div>
    </div>
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

type FintsErrors = { name: string; blz: string; server: string; login: string; pin: string };

/** FinTS: the connection is checked right away; the job dialog opens for TAN or app approval. */
/** `visibility` is the choice of a household admin; members always connect a private bank. */
export function AddFintsDialog({
  settings,
  visibility,
  onClose,
}: {
  settings: BankingSettings;
  visibility?: Visibility;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(settings.fintsPresets[0]?.key ?? "");
  const [blz, setBlz] = useState("");
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [pin, setPin] = useState("");
  const { form, errors, check, clear } = useFormErrors<FintsErrors>();
  const create = useAction(createBankConnectionFn);
  const { track } = useBankJobs();
  const t = useT();
  const custom = preset === "";
  const chosen = settings.fintsPresets.find((p) => p.key === preset);

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("banking.dialogs.nameRequired"),
        blz: custom && !/^\d{8}$/.test(blz.trim()) ? t("banking.dialogs.blzFormat") : undefined,
        server: custom && !server.trim().startsWith("https://") ? t("banking.dialogs.serverHttps") : undefined,
        login: login.trim() ? undefined : t("banking.dialogs.loginRequired"),
        pin: pin ? undefined : t("banking.dialogs.pinRequired"),
      })
    )
      return;
    const result = await create.run({
      data: {
        name: name.trim(),
        visibility,
        fints: {
          ...(custom ? { blz: blz.trim(), server: server.trim() } : { preset }),
          login: login.trim(),
          customerId: customerId.trim() || undefined,
          pin,
        },
      },
    });
    if (!result.ok) return;
    setPin("");
    onClose();
    if (result.value.job) track([{ job: result.value.job, label: result.value.connection.name }]);
  }

  return (
    <FormDialog
      title={t("banking.dialogs.fintsTitle")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={create.busy} label={t("banking.dialogs.connectAndCheck")} onClose={onClose} />}
    >
      {create.error && <Banner tone="danger">{create.error}</Banner>}
      <p className="muted">{t("banking.dialogs.fintsIntro")}</p>
      <div className="form-grid">
        <Field label={t("common.fields.name")} hint={t("banking.dialogs.nameHint")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("common.fields.bank")} hint={chosen && !chosen.confirmed ? t("banking.dialogs.presetUnconfirmed") : undefined}>
          {(control) => (
            <select {...control} value={preset} onChange={(event) => setPreset(event.target.value)}>
              {settings.fintsPresets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
              <option value="">{t("banking.dialogs.otherBank")}</option>
            </select>
          )}
        </Field>
        {custom && (
          <>
            <Field label={t("banking.dialogs.blz")} error={errors.blz}>
              {(control) => (
                <input
                  {...control}
                  className="mono"
                  inputMode="numeric"
                  value={blz}
                  maxLength={8}
                  onChange={(event) => {
                    setBlz(event.target.value);
                    clear("blz");
                  }}
                />
              )}
            </Field>
            <Field label={t("banking.dialogs.fintsServer")} error={errors.server}>
              {(control) => (
                <input
                  {...control}
                  className="mono"
                  type="url"
                  value={server}
                  placeholder="https://"
                  onChange={(event) => {
                    setServer(event.target.value);
                    clear("server");
                  }}
                />
              )}
            </Field>
          </>
        )}
        <Field label={t("banking.dialogs.login")} error={errors.login}>
          {(control) => (
            <input
              {...control}
              value={login}
              autoComplete="off"
              onChange={(event) => {
                setLogin(event.target.value);
                clear("login");
              }}
            />
          )}
        </Field>
        <Field label={t("banking.dialogs.customerId")} hint={t("banking.dialogs.customerIdHint")}>
          {(control) => (
            <input {...control} value={customerId} autoComplete="off" onChange={(event) => setCustomerId(event.target.value)} />
          )}
        </Field>
        <Field label={t("banking.dialogs.pin")} hint={t("banking.dialogs.pinHint")} error={errors.pin}>
          {(control) => (
            <input
              {...control}
              type="password"
              value={pin}
              autoComplete="off"
              onChange={(event) => {
                setPin(event.target.value);
                clear("pin");
              }}
            />
          )}
        </Field>
      </div>
    </FormDialog>
  );
}

/** Enable Banking: choose the bank, then the browser goes to the bank's login and comes back to /bank/callback. */
export function AddEnableBankingDialog({ visibility, onClose }: { visibility?: Visibility; onClose: () => void }) {
  const loadBanks = useServerFn(getEnableBankingBanksFn);
  const [name, setName] = useState("");
  const [country, setCountry] = useState("DE");
  const [bank, setBank] = useState("");
  const [banks, setBanks] = useState<{ name: string; sandbox: boolean }[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ name: string; bank: string; country: string }>();
  const create = useAction(createBankConnectionFn, { invalidate: false });
  const t = useT();
  const bankOptions = useMemo(
    () => (banks ?? []).map((b) => ({ value: b.name, label: b.sandbox ? `${b.name}${t("banking.dialogs.sandbox")}` : b.name })),
    [banks, t],
  );

  useEffect(() => {
    if (!/^[A-Za-z]{2}$/.test(country)) return;
    let live = true;
    setBanks(null);
    setLoadError(null);
    loadBanks({ data: { country } }).then(
      (list) => live && setBanks(list),
      (error) => live && setLoadError(errorMessage(error, t)),
    );
    return () => {
      live = false;
    };
  }, [country, loadBanks, t]);

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("banking.dialogs.nameRequired"),
        country: /^[A-Za-z]{2}$/.test(country) ? undefined : t("banking.dialogs.countryRequired"),
        bank: bank ? undefined : t("banking.dialogs.bankRequired"),
      })
    )
      return;
    const result = await create.run({
      data: { name: name.trim(), visibility, enableBanking: { bankName: bank, country: country.toUpperCase() } },
    });
    if (result.ok && result.value.url) window.location.assign(result.value.url);
  }

  return (
    <FormDialog
      title={t("banking.dialogs.ebTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={create.busy} label={t("banking.dialogs.toBank")} onClose={onClose} />}
    >
      {create.error && <Banner tone="danger">{create.error}</Banner>}
      <p className="muted">{t("banking.dialogs.ebIntro")}</p>
      <Field label={t("common.fields.name")} error={errors.name}>
        {(control) => (
          <input
            {...control}
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
          />
        )}
      </Field>
      <Field label={t("banking.dialogs.country")} hint={t("banking.dialogs.countryHint")} error={errors.country}>
        {(control) => (
          <input
            {...control}
            className="mono"
            value={country}
            maxLength={2}
            onChange={(event) => {
              setCountry(event.target.value.toUpperCase());
              setBank("");
              clear("country");
            }}
          />
        )}
      </Field>
      {loadError && <Banner tone="danger">{loadError}</Banner>}
      <Field
        label={t("common.fields.bank")}
        hint={banks ? t("banking.dialogs.banksAvailable", { count: banks.length }) : t("banking.dialogs.loadingList")}
        error={errors.bank}
      >
        {(control) => (
          <div className="bank-pick">
            {bank ? (
              <BankBadge label={bank} logo={bankLogoUrl(country, bank)} />
            ) : (
              <span className="monogram monogram-empty" aria-hidden="true">
                <Icon name="bank" size={18} />
              </span>
            )}
            <Combobox
              {...control}
              label={t("common.fields.bank")}
              options={bankOptions}
              value={bank}
              placeholder={t("banking.dialogs.bankPlaceholder")}
              disabled={!banks}
              onChange={(next) => {
                setBank(next);
                clear("bank");
              }}
            />
          </div>
        )}
      </Field>
    </FormDialog>
  );
}

/** Trade Republic: phone number and PIN; the job dialog then waits for the approval in the Trade Republic app. */
export function AddTradeRepublicDialog({ visibility, onClose }: { visibility?: Visibility; onClose: () => void }) {
  const [name, setName] = useState("Trade Republic");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [accepted, setAccepted] = useState(false);
  const { form, errors, check, clear } = useFormErrors<{ name: string; phone: string; pin: string; accepted: string }>();
  const create = useAction(createBankConnectionFn);
  const { track } = useBankJobs();
  const t = useT();

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("banking.dialogs.nameRequired"),
        phone: /^\+?[\d\s/()-]{8,20}$/.test(phone.trim()) ? undefined : t("banking.unofficial.phoneRequired"),
        pin: /^\d{4}$/.test(pin) ? undefined : t("banking.unofficial.pinFormat"),
        accepted: accepted ? undefined : t("banking.unofficial.acceptRequired"),
      })
    )
      return;
    const result = await create.run({
      data: { name: name.trim(), visibility, tradeRepublic: { phone: phone.trim(), pin, acknowledged: true } },
    });
    if (!result.ok) return;
    setPin("");
    onClose();
    if (result.value.job) track([{ job: result.value.job, label: result.value.connection.name }]);
  }

  return (
    <FormDialog
      title={t("banking.unofficial.trade_republic.title")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={create.busy} label={t("banking.unofficial.login")} onClose={onClose} />}
    >
      {create.error && <Banner tone="danger">{create.error}</Banner>}
      <UnofficialWarning provider="trade_republic" />
      <p className="muted">{t("banking.unofficial.trade_republic.intro")}</p>
      <div className="form-grid">
        <Field label={t("common.fields.name")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("banking.unofficial.phone")} hint={t("banking.unofficial.phoneHint")} error={errors.phone}>
          {(control) => (
            <input
              {...control}
              type="tel"
              value={phone}
              autoComplete="off"
              onChange={(event) => {
                setPhone(event.target.value);
                clear("phone");
              }}
            />
          )}
        </Field>
        <Field label={t("banking.unofficial.trPin")} hint={t("banking.dialogs.pinHint")} error={errors.pin}>
          {(control) => (
            <input
              {...control}
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              autoComplete="off"
              onChange={(event) => {
                setPin(event.target.value);
                clear("pin");
              }}
            />
          )}
        </Field>
      </div>
      <AcceptField
        checked={accepted}
        error={errors.accepted}
        onChange={(value) => {
          setAccepted(value);
          clear("accepted");
        }}
      />
    </FormDialog>
  );
}

/** givve: e-mail address and password of the card portal; givve then mails a code, typed in the job dialog. */
export function AddGivveDialog({ visibility, onClose }: { visibility?: Visibility; onClose: () => void }) {
  const [name, setName] = useState("givve Card");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const { form, errors, check, clear } = useFormErrors<{ name: string; email: string; password: string; accepted: string }>();
  const create = useAction(createBankConnectionFn);
  const { track } = useBankJobs();
  const t = useT();

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("banking.dialogs.nameRequired"),
        email: /^\S+@\S+\.\S+$/.test(email.trim()) ? undefined : t("banking.unofficial.emailRequired"),
        password: password ? undefined : t("banking.unofficial.passwordRequired"),
        accepted: accepted ? undefined : t("banking.unofficial.acceptRequired"),
      })
    )
      return;
    const result = await create.run({
      data: { name: name.trim(), visibility, givve: { email: email.trim(), password, acknowledged: true } },
    });
    if (!result.ok) return;
    setPassword("");
    onClose();
    if (result.value.job) track([{ job: result.value.job, label: result.value.connection.name }]);
  }

  return (
    <FormDialog
      title={t("banking.unofficial.givve.title")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={create.busy} label={t("banking.unofficial.login")} onClose={onClose} />}
    >
      {create.error && <Banner tone="danger">{create.error}</Banner>}
      <UnofficialWarning provider="givve" />
      <p className="muted">{t("banking.unofficial.givve.intro")}</p>
      <div className="form-grid">
        <Field label={t("common.fields.name")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("banking.unofficial.email")} error={errors.email}>
          {(control) => (
            <input
              {...control}
              type="email"
              value={email}
              autoComplete="off"
              onChange={(event) => {
                setEmail(event.target.value);
                clear("email");
              }}
            />
          )}
        </Field>
        <Field label={t("banking.unofficial.password")} hint={t("banking.dialogs.pinHint")} error={errors.password}>
          {(control) => (
            <input
              {...control}
              type="password"
              value={password}
              autoComplete="off"
              onChange={(event) => {
                setPassword(event.target.value);
                clear("password");
              }}
            />
          )}
        </Field>
      </div>
      <AcceptField
        checked={accepted}
        error={errors.accepted}
        onChange={(value) => {
          setAccepted(value);
          clear("accepted");
        }}
      />
    </FormDialog>
  );
}

/** The required confirmation that the risks above were read. */
export function AcceptField({ checked, error, onChange }: { checked: boolean; error?: string; onChange: (checked: boolean) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        {t("banking.unofficial.accept")}
      </label>
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function EditConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: Connection;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const fints = connection.provider === "fints";
  const unofficial = connection.provider === "trade_republic" || connection.provider === "givve";
  const [name, setName] = useState(connection.name);
  // The stored phone number is shown masked; an empty field keeps it.
  const [login, setLogin] = useState(connection.provider === "trade_republic" ? "" : (connection.login ?? ""));
  const [customerId, setCustomerId] = useState("");
  const [pin, setPin] = useState("");
  const [tan, setTan] = useState(connection.tanMechanism ?? "");
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const save = useAction(updateBankConnectionFn);
  const t = useT();

  async function submit() {
    if (!check({ name: name.trim() ? undefined : t("banking.dialogs.nameRequired") })) return;
    const result = await save.run({
      data: {
        id: connection.id,
        name: name.trim(),
        ...(fints
          ? { login: login.trim() || undefined, customerId: customerId.trim() || undefined, pin: pin || undefined, tanMechanism: tan }
          : unofficial
            ? { login: login.trim() || undefined, pin: pin || undefined }
            : {}),
      },
    });
    if (!result.ok) return;
    onSaved(t("banking.dialogs.saved", { name: name.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={t("banking.dialogs.editTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={save.busy} label={t("common.save")} onClose={onClose} />}
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <Field label={t("common.fields.name")} error={errors.name}>
        {(control) => (
          <input
            {...control}
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
          />
        )}
      </Field>
      {unofficial && (
        <>
          <Field
            label={connection.provider === "givve" ? t("banking.unofficial.email") : t("banking.unofficial.phone")}
            hint={
              connection.provider === "trade_republic" ? t("banking.unofficial.phoneKeep", { phone: connection.login ?? "" }) : undefined
            }
          >
            {(control) => (
              <input
                {...control}
                type={connection.provider === "givve" ? "email" : "tel"}
                value={login}
                autoComplete="off"
                onChange={(event) => setLogin(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={connection.provider === "givve" ? t("banking.unofficial.newPassword") : t("banking.dialogs.newPin")}
            hint={t("banking.dialogs.newPinHint")}
          >
            {(control) => (
              <input {...control} type="password" value={pin} autoComplete="off" onChange={(event) => setPin(event.target.value)} />
            )}
          </Field>
        </>
      )}
      {fints && (
        <>
          <Field label={t("banking.dialogs.login")}>
            {(control) => <input {...control} value={login} autoComplete="off" onChange={(event) => setLogin(event.target.value)} />}
          </Field>
          <Field label={t("banking.dialogs.customerId")} hint={t("banking.dialogs.customerIdKeep")}>
            {(control) => (
              <input {...control} value={customerId} autoComplete="off" onChange={(event) => setCustomerId(event.target.value)} />
            )}
          </Field>
          <Field label={t("banking.dialogs.newPin")} hint={t("banking.dialogs.newPinHint")}>
            {(control) => (
              <input {...control} type="password" value={pin} autoComplete="off" onChange={(event) => setPin(event.target.value)} />
            )}
          </Field>
          <Field label={t("banking.dialogs.tanMethod")}>
            {(control) => (
              <select {...control} value={tan} onChange={(event) => setTan(event.target.value)}>
                <option value="">{t("banking.dialogs.tanAuto")}</option>
                {Object.entries(connection.tanMechanisms).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

/** "… kommt bereits über Enable Banking („TR“)": another connection already fetches this account. */
export function coveredText(t: Translate, remote: Connection["remoteAccounts"][number]): string {
  if (!remote.coveredBy) return "";
  if (remote.coveredBy.name === null) {
    return t("banking.coveredByOther", { account: remote.name, provider: providerName(t, remote.coveredBy.provider) });
  }
  return t("banking.coveredBy", {
    account: remote.name,
    provider: providerName(t, remote.coveredBy.provider),
    name: remote.coveredBy.name,
  });
}

/** Fallback when the bank sends the browser back on another device, where the return address does not reach Saldo. */
export function FinishAuthorizationDialog({ onClose, onDone }: { onClose: () => void; onDone: (notice: Notice) => void }) {
  const [address, setAddress] = useState("");
  const complete = useAction(completeBankAuthorizationFn);
  const { track } = useBankJobs();
  const { form, errors, check, clear } = useFormErrors<{ address: string }>();
  const t = useT();

  async function submit() {
    if (!check({ address: /^https?:\/\/\S+[?&]code=/.test(address.trim()) ? undefined : t("banking.page.finish.addressRequired") })) return;
    const result = await complete.run({ data: { redirectedUrl: address.trim() } });
    if (!result.ok) return;
    const { connection, job, message, tone } = result.value;
    onDone({ tone, text: message });
    onClose();
    if (job) track([{ job, label: connection.name }]);
  }

  return (
    <FormDialog
      title={t("banking.page.finish.title")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={complete.busy} aria-busy={complete.busy}>
            {t("banking.page.finish.submit")}
          </button>
        </>
      }
    >
      {complete.error && <Banner tone="danger">{complete.error}</Banner>}
      <p className="muted">{t("banking.page.finish.text")}</p>
      <Field label={t("banking.page.redirectUrl")} error={errors.address}>
        {(control) => (
          <textarea
            {...control}
            className="mono"
            rows={3}
            value={address}
            spellCheck={false}
            placeholder="https://localhost:8443/bank/callback?state=…&code=…"
            onChange={(event) => {
              setAddress(event.target.value);
              clear("address");
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
