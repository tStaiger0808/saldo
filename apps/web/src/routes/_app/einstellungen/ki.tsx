import { MAX_NEW_TAGS_PER_RUN } from "@saldo/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ActionMenu } from "../../../components/ActionMenu.tsx";
import { UsageView } from "../../../components/AiUsage.tsx";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner, Status, Tag } from "../../../components/Status.tsx";
import { useI18n } from "../../../i18n/react.tsx";
import { errorMessage, useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { isPeriod, PERIODS, type Period, resolvePeriod } from "../../../lib/periods.ts";
import { requireSection } from "../../../lib/settings.ts";
import {
  activateAiProviderFn,
  deleteAiProviderFn,
  getAiModels,
  getAiPresets,
  getAiProviders,
  getAiSettingsFn,
  getAiUsage,
  saveAiProviderFn,
  saveAiSettingsFn,
  testAiProviderFn,
} from "../../../server/functions/ai.ts";

export const Route = createFileRoute("/_app/einstellungen/ki")({
  beforeLoad: requireSection("ki"),
  validateSearch: (search: Record<string, unknown>): { zeitraum?: Period } =>
    isPeriod(search.zeitraum) ? { zeitraum: search.zeitraum } : {},
  loaderDeps: ({ search }) => ({ zeitraum: search.zeitraum ?? "this_month" }),
  loader: async ({ deps }) => {
    const [providers, presets, usage, settings] = await Promise.all([
      getAiProviders(),
      getAiPresets(),
      getAiUsage({ data: { ...resolvePeriod(deps.zeitraum), limit: 20 } }),
      getAiSettingsFn(),
    ]);
    return { providers, presets, usage, settings, period: deps.zeitraum };
  },
  component: AiSection,
});

type Provider = Awaited<ReturnType<typeof getAiProviders>>[number];
type Preset = Awaited<ReturnType<typeof getAiPresets>>[number];
type ModelOption = Awaited<ReturnType<typeof getAiModels>>[number];

function presetOf(presets: Preset[], provider: Provider | null): Preset {
  const custom = presets.find((p) => p.id === "custom") ?? (presets[0] as Preset);
  if (!provider) return presets[0] ?? custom;
  return presets.find((p) => p.id !== "custom" && p.kind === provider.kind && p.baseUrl === provider.baseUrl) ?? custom;
}

const KINDS = ["openai", "anthropic"] as const;

function AiSection() {
  const { providers, presets, usage, settings, period } = Route.useLoaderData();
  const navigate = useNavigate({ from: "/einstellungen/ki" });
  const { t, f } = useI18n();
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const activate = useAction(activateAiProviderFn);
  const remove = useAction(deleteAiProviderFn);
  const saveSettings = useAction(saveAiSettingsFn);

  async function setAutoCategorize(autoCategorize: boolean) {
    const result = await saveSettings.run({ data: { autoCategorize } });
    setNotice(
      result.ok
        ? { tone: "ok", text: t(autoCategorize ? "settings.ai.autoOn" : "settings.ai.autoOff") }
        : { tone: "danger", text: result.error },
    );
  }

  async function saveTagging(change: { assignTags?: boolean; createTags?: boolean; maxNewTags?: number | null }) {
    const result = await saveSettings.run({ data: change });
    setNotice(result.ok ? { tone: "ok", text: t("settings.ai.taggingSaved") } : { tone: "danger", text: result.error });
  }

  async function makeActive(p: Provider) {
    const result = await activate.run({ data: { id: p.id } });
    setNotice(result.ok ? { tone: "ok", text: t("settings.ai.activated", { name: p.name }) } : { tone: "danger", text: result.error });
  }

  async function destroy(p: Provider) {
    const result = await remove.run({ data: { id: p.id } });
    setNotice(result.ok ? { tone: "ok", text: t("settings.ai.deleted", { name: p.name }) } : { tone: "danger", text: result.error });
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card" aria-labelledby="ai-title">
        <div className="card-head">
          <h2 id="ai-title">{t("settings.ai.title")}</h2>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" size={18} /> {t("settings.ai.add")}
            </button>
          </div>
        </div>
        <p className="muted measure">{t("settings.ai.intro")}</p>
        {providers.length === 0 ? (
          <p className="empty">{t("settings.ai.empty")}</p>
        ) : (
          <ul className="list">
            {providers.map((p) => (
              <li key={p.id} style={{ flexWrap: "wrap" }}>
                <span className="list-main">
                  <span className="list-title">
                    {p.name} <Tag>{t(`settings.ai.kind.${p.kind}`)}</Tag>
                    {p.isActive ? <Status tone="ok">{t("common.fields.active")}</Status> : <Status>{t("settings.ai.ready")}</Status>}
                  </span>
                  <span className="list-sub">
                    {p.model ?? t("settings.ai.noModel")} · <span className="mono">{p.baseUrl}</span>
                    {!p.hasApiKey && t("settings.ai.noKey")}
                    {p.priceInputPerMtok != null &&
                      t("settings.ai.price", {
                        input: f.decimal(p.priceInputPerMtok, 6),
                        output: p.priceOutputPerMtok == null ? "?" : f.decimal(p.priceOutputPerMtok, 6),
                        currency: p.priceCurrency,
                      })}
                  </span>
                </span>
                <span className="actions">
                  {!p.isActive && (
                    <button type="button" className="btn btn-sm" disabled={activate.busy} onClick={() => makeActive(p)}>
                      {t("settings.ai.activate")}
                      <span className="visually-hidden">: {p.name}</span>
                    </button>
                  )}
                  <ActionMenu
                    name={p.name}
                    items={[
                      { label: t("common.edit"), onSelect: () => setEditing(p) },
                      { label: t("common.delete"), danger: true, onSelect: () => setDeleting(p) },
                    ]}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="ai-auto-title">
        <h2 id="ai-auto-title">{t("settings.ai.automation")}</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.autoCategorize}
            disabled={saveSettings.busy}
            aria-describedby="ai-auto-hint"
            onChange={(event) => setAutoCategorize(event.target.checked)}
          />
          {t("settings.ai.autoCategorize")}
        </label>
        <p id="ai-auto-hint" className="field-hint measure">
          {t("settings.ai.autoCategorizeHint")}
        </p>
      </section>
      <section className="card" aria-labelledby="ai-tags-title">
        <h2 id="ai-tags-title">{t("settings.ai.tagging")}</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.assignTags}
            disabled={saveSettings.busy}
            aria-describedby="ai-assign-tags-hint"
            onChange={(event) => saveTagging({ assignTags: event.target.checked })}
          />
          {t("settings.ai.assignTags")}
        </label>
        <p id="ai-assign-tags-hint" className="field-hint measure">
          {t("settings.ai.assignTagsHint")}
        </p>
        <div className="settings-nested stack-sm">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.createTags}
              disabled={saveSettings.busy || !settings.assignTags}
              aria-describedby="ai-create-tags-hint"
              onChange={(event) => saveTagging({ createTags: event.target.checked })}
            />
            {t("settings.ai.createTags")}
          </label>
          <p id="ai-create-tags-hint" className="field-hint measure">
            {t("settings.ai.createTagsHint")}
          </p>
          <Field label={t("settings.ai.maxNewTags")} hint={t("settings.ai.maxNewTagsHint")}>
            {(control) => (
              <select
                {...control}
                value={settings.maxNewTags ?? ""}
                disabled={saveSettings.busy || !settings.assignTags || !settings.createTags}
                onChange={(event) => saveTagging({ maxNewTags: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">{t("settings.ai.maxNewTagsUnlimited")}</option>
                {Array.from({ length: MAX_NEW_TAGS_PER_RUN }, (_, i) => i + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </section>
      <section className="card" aria-labelledby="usage-title">
        <div className="card-head">
          <h2 id="usage-title">{t("settings.ai.usage")}</h2>
          <Field label={t("common.fields.period")} className="field-inline">
            {(control) => (
              <select
                {...control}
                value={period}
                onChange={(event) => navigate({ search: { zeitraum: event.target.value as Period }, replace: true })}
              >
                {PERIODS.map((value) => (
                  <option key={value} value={value}>
                    {t(`periods.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <UsageView usage={usage} />
      </section>
      {editing && (
        <ProviderDialog
          provider={editing === "new" ? null : editing}
          presets={presets}
          onClose={() => setEditing(null)}
          onSaved={(text, tone) => setNotice({ tone, text })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("settings.ai.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("settings.ai.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("settings.ai.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

type Errors = { name: string; baseUrl: string; priceIn: string; priceOut: string; currency: string };

function ProviderDialog({
  provider,
  presets,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  presets: Preset[];
  onClose: () => void;
  onSaved: (text: string, tone: "ok" | "warn") => void;
}) {
  const loadModels = useServerFn(getAiModels);
  const { t, f } = useI18n();
  const decimalSeparator = f.decimal(1.5).charAt(1);
  const localDecimal = (value: number | null | undefined) => value?.toString().replace(".", decimalSeparator) ?? "";
  const initialPreset = presetOf(presets, provider);
  const [preset, setPreset] = useState<Preset>(initialPreset);
  const [name, setName] = useState(provider?.name ?? initialPreset.label);
  const [kind, setKind] = useState<Provider["kind"]>(provider?.kind ?? initialPreset.kind);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? initialPreset.baseUrl);
  const test = useAction(testAiProviderFn);
  const [testResult, setTestResult] = useState<string | null>(null);

  function choosePreset(id: string) {
    const next = presets.find((p) => p.id === id);
    if (!next) return;
    // Keep a name the user typed; replace one that only mirrored the previous preset.
    if (!name.trim() || name === preset.label) setName(next.id === "custom" ? "" : next.label);
    setPreset(next);
    setKind(next.kind);
    setBaseUrl(next.baseUrl);
    clear("baseUrl");
  }

  async function runTest() {
    if (!provider) return;
    setTestResult(null);
    const result = await test.run({ data: { id: provider.id } });
    if (result.ok) setTestResult(result.value.message);
  }
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(provider?.model ?? "");
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [allModels, setAllModels] = useState(false);
  const [loading, setLoading] = useState(false);
  const [priceIn, setPriceIn] = useState(localDecimal(provider?.priceInputPerMtok));
  const [priceOut, setPriceOut] = useState(localDecimal(provider?.priceOutputPerMtok));
  const [currency, setCurrency] = useState(provider?.priceCurrency ?? "USD");
  const { form, errors, check, clear } = useFormErrors<Errors>();
  const save = useAction(saveAiProviderFn);

  const price = (value: string) => (value.trim() ? Number(value.trim().replace(",", ".")) : null);
  const priced = (option: ModelOption) => {
    const p = option.price;
    if (!p) return option.id;
    if (p.inputPerMtok === 0 && p.outputPerMtok === 0) return t("settings.ai.modelFree", { model: option.id });
    return t("settings.ai.modelPrice", {
      model: option.id,
      input: f.decimal(p.inputPerMtok, 6),
      output: f.decimal(p.outputPerMtok, 6),
      currency: p.currency,
    });
  };
  const modelLabel = (option: ModelOption) => {
    const label = priced(option);
    if (option.trainsOnData) return t("settings.ai.modelTrains", { label });
    if (option.noRetention) return t("settings.ai.modelNoRetention", { label });
    return label;
  };

  function chooseModel(id: string) {
    setModel(id);
    const known = models?.find((m) => m.id === id)?.price;
    if (!known) return;
    setPriceIn(localDecimal(known.inputPerMtok));
    setPriceOut(localDecimal(known.outputPerMtok));
    setCurrency(known.currency);
    clear("priceIn");
    clear("priceOut");
    clear("currency");
  }
  const badPrice = (value: string) => {
    const n = price(value);
    return n !== null && !(Number.isFinite(n) && n >= 0) ? t("settings.ai.priceInvalid") : undefined;
  };

  async function fetchModels() {
    if (!provider) return;
    setLoading(true);
    setModelsError(null);
    try {
      setModels(await loadModels({ data: { id: provider.id, includeAll: allModels } }));
    } catch (e) {
      setModelsError(errorMessage(e, t));
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (
      !check({
        name: name.trim() ? undefined : t("settings.nameRequired"),
        baseUrl: !baseUrl.trim()
          ? t("settings.ai.baseUrlRequired")
          : /^https?:\/\//.test(baseUrl.trim())
            ? undefined
            : t("settings.ai.baseUrlScheme"),
        priceIn: badPrice(priceIn),
        priceOut: badPrice(priceOut),
        currency: /^[A-Za-z]{3}$/.test(currency.trim()) ? undefined : t("settings.ai.currencyInvalid"),
      })
    )
      return;
    const result = await save.run({
      data: {
        id: provider?.id,
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
        model: model.trim() || null,
        priceInputPerMtok: price(priceIn),
        priceOutputPerMtok: price(priceOut),
        priceCurrency: currency.trim().toUpperCase(),
      },
    });
    if (!result.ok) return;
    const { test: tested } = result.value;
    const next = provider || model.trim() ? "" : t("settings.ai.chooseModel");
    onSaved(
      t(provider ? "settings.ai.savedNotice" : "settings.ai.createdNotice", { name: name.trim(), test: tested.message, next }),
      tested.warning ? "warn" : "ok",
    );
    onClose();
  }

  return (
    <FormDialog
      title={provider ? t("settings.ai.editTitle") : t("settings.ai.addTitle")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {provider ? t("settings.ai.saveAndTest") : t("settings.ai.addAndTest")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <Field label={t("settings.ai.provider")} hint={preset.hint}>
        {(control) => (
          <select {...control} value={preset.id} onChange={(event) => choosePreset(event.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="form-grid">
        <Field label={t("common.fields.name")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={64}
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("settings.ai.interface")} hint={preset.id === "custom" ? undefined : t("settings.ai.interfaceFixed")}>
          {(control) => (
            <select
              {...control}
              value={kind}
              disabled={preset.id !== "custom"}
              onChange={(event) => setKind(event.target.value as Provider["kind"])}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`settings.ai.kind.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field
        label={t("settings.ai.address")}
        hint={preset.id === "custom" ? t("settings.ai.addressHintCustom") : t("settings.ai.addressHintPreset")}
        error={errors.baseUrl}
      >
        {(control) => (
          <input
            {...control}
            className="mono"
            type="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              clear("baseUrl");
            }}
          />
        )}
      </Field>
      <Field
        label={t("settings.ai.apiKey")}
        hint={
          provider?.hasApiKey
            ? t("settings.ai.keyStored")
            : preset.keyRequired
              ? t("settings.ai.keyEncrypted")
              : t("settings.ai.keyOptional")
        }
      >
        {(control) => (
          <input
            {...control}
            type="password"
            className="mono"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
          />
        )}
      </Field>
      <fieldset className="field">
        <legend>{t("common.fields.model")}</legend>
        {provider ? (
          <>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Field label={t("common.fields.model")} hideLabel>
                {(control) =>
                  models ? (
                    <select {...control} value={model} onChange={(event) => chooseModel(event.target.value)}>
                      <option value="">{t("settings.ai.noModelOption")}</option>
                      {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {modelLabel(m)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input {...control} className="mono" value={model} onChange={(event) => setModel(event.target.value)} />
                  )
                }
              </Field>
              <button type="button" className="btn" disabled={loading} aria-busy={loading} onClick={fetchModels}>
                <Icon name="sync" size={18} /> {t("settings.ai.loadModels")}
              </button>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={allModels} onChange={(event) => setAllModels(event.target.checked)} />
              {t("settings.ai.allModels")}
            </label>
            {models && <span className="field-hint">{t("settings.ai.modelPricesHint")}</span>}
            {modelsError && <Banner tone="danger">{modelsError}</Banner>}
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={test.busy} aria-busy={test.busy} onClick={runTest}>
                {t("settings.ai.testConnection")}
              </button>
            </div>
            {testResult && <Banner tone="ok">{testResult}</Banner>}
            {test.error && <Banner tone="danger">{test.error}</Banner>}
            <span className="field-hint">{t("settings.ai.modelsLive")}</span>
          </>
        ) : (
          <span className="field-hint">{t("settings.ai.modelsAfterAdd")}</span>
        )}
      </fieldset>
      <div className="form-grid">
        <Field label={t("settings.ai.priceIn")} hint={t("settings.ai.perMillion")} error={errors.priceIn}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              value={priceIn}
              onChange={(event) => {
                setPriceIn(event.target.value);
                clear("priceIn");
              }}
            />
          )}
        </Field>
        <Field label={t("settings.ai.priceOut")} hint={t("settings.ai.perMillion")} error={errors.priceOut}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              value={priceOut}
              onChange={(event) => {
                setPriceOut(event.target.value);
                clear("priceOut");
              }}
            />
          )}
        </Field>
        <Field label={t("settings.ai.currency")} error={errors.currency}>
          {(control) => (
            <input
              {...control}
              className="mono"
              value={currency}
              maxLength={3}
              onChange={(event) => {
                setCurrency(event.target.value.toUpperCase());
                clear("currency");
              }}
            />
          )}
        </Field>
      </div>
      {preset.id === "opencode-go" && <p className="field-hint">{t("settings.ai.opencodeGoPrices")}</p>}
    </FormDialog>
  );
}
