import { getRouteApi } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { useAction } from "../lib/action.ts";
import { useFormErrors } from "../lib/forms.ts";
import type { AccountKind, Visibility } from "../lib/labels.ts";
import { managesHousehold } from "../lib/roles.ts";
import { saveAccountFn } from "../server/functions/accounts.ts";
import { KindField } from "./AccountActions.tsx";
import {
  AddEnableBankingDialog,
  AddFintsDialog,
  AddGivveDialog,
  AddTradeRepublicDialog,
  type BankingSettings,
  type Provider,
  providerName,
} from "./BankDialogs.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

const appRoute = getRouteApi("/_app");

/** Household admins choose; for members everything they add is private. */
function VisibilityField({ value, onChange }: { value: Visibility; onChange: (value: Visibility) => void }) {
  const t = useT();
  return (
    <Field label={t("accounts.add.visibility")} hint={t(`accounts.add.visibilityHint.${value}`)}>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value as Visibility)}>
          <option value="household">{t("accounts.add.forHousehold")}</option>
          <option value="private">{t("accounts.add.forMe")}</option>
        </select>
      )}
    </Field>
  );
}

type Step = "choose" | "provider" | "custom" | "bank" | "manual";

/** Providers with an official interface; every other one is a custom integration, listed together under one choice. */
const STANDARD: readonly Provider[] = ["fints", "enable_banking"];
const isCustom = (provider: Provider) => !STANDARD.includes(provider);
/** From this many custom integrations on, their list gets a search field. */
const SEARCH_FROM = 6;

/** One entry for every new account: connect a bank (its accounts appear by themselves) or keep one by hand. */
export function AddAccountDialog({
  settings,
  onClose,
  onSaved,
}: {
  settings: BankingSettings;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const { user } = appRoute.useRouteContext();
  const admin = managesHousehold(user);
  const [step, setStep] = useState<Step>("choose");
  const [visibility, setVisibility] = useState<Visibility>(admin ? "household" : "private");
  const [provider, setProvider] = useState<Provider | null>(null);
  const t = useT();
  const name = useId();
  const only = settings.available.length === 1 ? settings.available[0] : undefined;

  const custom = settings.available.filter(isCustom);
  if (step === "provider")
    return (
      <ProviderChoiceDialog
        available={settings.available}
        onClose={onClose}
        onChoose={(choice) => {
          setProvider(choice === "custom" ? null : choice);
          setStep(choice === "custom" ? "custom" : "bank");
        }}
      />
    );
  if (step === "custom")
    return (
      <CustomIntegrationDialog
        available={custom}
        onBack={settings.available.some((p) => !isCustom(p)) ? () => setStep("provider") : undefined}
        onClose={onClose}
        onChoose={(choice) => {
          setProvider(choice);
          setStep("bank");
        }}
      />
    );
  const chosen = provider ?? only;
  if (step === "bank" && chosen === "fints") return <AddFintsDialog settings={settings} visibility={visibility} onClose={onClose} />;
  if (step === "bank" && chosen === "enable_banking") return <AddEnableBankingDialog visibility={visibility} onClose={onClose} />;
  if (step === "bank" && chosen === "trade_republic") return <AddTradeRepublicDialog visibility={visibility} onClose={onClose} />;
  if (step === "bank" && chosen === "givve") return <AddGivveDialog visibility={visibility} onClose={onClose} />;
  if (step === "manual") return <ManualAccountDialog visibility={visibility} onClose={onClose} onSaved={onSaved} />;

  return (
    <FormDialog
      title={t("accounts.add.title")}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
      }
    >
      {admin && <VisibilityField value={visibility} onChange={setVisibility} />}
      {!admin && <p className="muted">{t("accounts.add.privateNote")}</p>}
      <fieldset className="field">
        <legend id={name}>{t("accounts.add.how")}</legend>
        <div className="choice-list">
          <button
            type="button"
            className="btn choice"
            disabled={!settings.ready}
            aria-describedby={`${name}-bank`}
            onClick={() => setStep(only ? "bank" : settings.available.every(isCustom) ? "custom" : "provider")}
          >
            <Icon name="bank" size={18} /> {t("accounts.add.bank")}
          </button>
          <span id={`${name}-bank`} className="field-hint">
            {settings.ready ? t("accounts.add.bankHint") : t("accounts.add.bankNotReady")}
          </span>
          <button type="button" className="btn choice" aria-describedby={`${name}-manual`} onClick={() => setStep("manual")}>
            <Icon name="plus" size={18} /> {t("accounts.add.manual")}
          </button>
          <span id={`${name}-manual`} className="field-hint">
            {t("accounts.add.manualHint")}
          </span>
        </div>
      </fieldset>
    </FormDialog>
  );
}

type ProviderChoice = Provider | "custom";

/**
 * Shown only when more than one provider is set up: the official accesses one by one, all custom integrations behind
 * a single "Weitere Zugänge" choice, so the list stays short however many there are.
 */
function ProviderChoiceDialog({
  available,
  onClose,
  onChoose,
}: {
  available: Provider[];
  onClose: () => void;
  onChoose: (provider: ProviderChoice) => void;
}) {
  const t = useT();
  const name = useId();
  const standard = available.filter((p) => !isCustom(p));
  const custom = available.filter(isCustom);
  const options: ProviderChoice[] = custom.length > 0 ? [...standard, "custom"] : standard;
  const [choice, setChoice] = useState<ProviderChoice>(available.includes("enable_banking") ? "enable_banking" : (options[0] ?? "custom"));
  return (
    <FormDialog
      title={t("accounts.add.providerTitle")}
      onClose={onClose}
      onSubmit={() => onChoose(choice)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {t("accounts.add.next")}
          </button>
        </>
      }
    >
      <fieldset className="field">
        <legend>{t("accounts.add.providerLegend")}</legend>
        <div className="radio-cards">
          {options.map((p) => (
            <label key={p} className="radio-card">
              <input type="radio" name={name} value={p} checked={choice === p} onChange={() => setChoice(p)} />
              <span className="radio-card-text">
                <strong>{p === "custom" ? t("accounts.add.customName") : providerName(t, p)}</strong>
                <span>
                  {p === "custom"
                    ? t("accounts.add.customDescription", { names: custom.map((c) => providerName(t, c)).join(", ") })
                    : t(`banking.providers.${p}.description`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </FormDialog>
  );
}

/** The custom integrations set up by a super-user, with a search field once the list gets long. */
function CustomIntegrationDialog({
  available,
  onBack,
  onClose,
  onChoose,
}: {
  available: Provider[];
  onBack?: () => void;
  onClose: () => void;
  onChoose: (provider: Provider) => void;
}) {
  const t = useT();
  const name = useId();
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<Provider | null>(available[0] ?? null);
  const shown = available.filter((p) => !query.trim() || providerName(t, p).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <FormDialog
      title={t("accounts.add.customTitle")}
      onClose={onClose}
      onSubmit={() => choice && shown.includes(choice) && onChoose(choice)}
      footer={
        <>
          {onBack && (
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              {t("accounts.add.back")}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!choice || !shown.includes(choice)}>
            {t("accounts.add.next")}
          </button>
        </>
      }
    >
      <p className="muted">{t("accounts.add.customIntro")}</p>
      {available.length >= SEARCH_FROM && (
        <Field label={t("accounts.add.customSearch")}>
          {(control) => <input {...control} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />}
        </Field>
      )}
      <fieldset className="field">
        <legend>{t("accounts.add.customLegend")}</legend>
        {shown.length === 0 ? (
          <p className="muted">{t("accounts.add.customNone")}</p>
        ) : (
          <div className="radio-cards">
            {shown.map((p) => (
              <label key={p} className="radio-card">
                <input type="radio" name={name} value={p} checked={choice === p} onChange={() => setChoice(p)} />
                <span className="radio-card-text">
                  <strong>{providerName(t, p)}</strong>
                  <span>{t(`banking.providers.${p}.description`)}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </FormDialog>
  );
}

function ManualAccountDialog({
  visibility,
  onClose,
  onSaved,
}: {
  visibility: Visibility;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [kind, setKind] = useState<AccountKind>("checking");
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const save = useAction(saveAccountFn);
  const t = useT();

  async function submit() {
    if (!check({ name: name.trim() ? undefined : t("accounts.actions.nameRequired") })) return;
    const result = await save.run({
      data: { name: name.trim(), bank: (bank.trim() || name.trim()).slice(0, 32), kind, color: "#1f6f5c", visibility },
    });
    if (!result.ok) return;
    onSaved(t("accounts.add.created", { name: name.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={t("accounts.add.manualTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {t("accounts.add.create")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <p className="muted">{t("accounts.add.manualIntro")}</p>
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
      <Field label={t("accounts.add.provider")} hint={t("accounts.add.providerHint")}>
        {(control) => <input {...control} value={bank} maxLength={32} onChange={(event) => setBank(event.target.value)} />}
      </Field>
      <KindField value={kind} onChange={setKind} />
    </FormDialog>
  );
}
