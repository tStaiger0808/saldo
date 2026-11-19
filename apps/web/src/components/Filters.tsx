import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useI18n, useT } from "../i18n/react.tsx";
import {
  activeFilterCount,
  clearKeys,
  type FilterChip,
  type FilterDef,
  type FilterValues,
  filterChips,
  pickFilterValues,
  type SearchDef,
} from "../lib/filters.ts";
import { useFormErrors } from "../lib/forms.ts";
import { MaskedText, useMaskAmounts } from "./Bits.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { useShortcut, useShortcutHint } from "./Shortcuts.tsx";

/**
 * Search field, a "Filtern" button with the other filters in a dialog, and the active filters as removable chips.
 * `leading` sits left of the search (quick filters), `trailing` below the chips (saved filters). `onApply` gets a patch
 * of search parameters, unset keys as undefined.
 */
export function FilterBar({
  label,
  defs,
  values,
  search,
  resultCount,
  className,
  leading,
  trailing,
  onApply,
}: {
  label: string;
  defs: readonly FilterDef[];
  values: FilterValues;
  search: SearchDef & { placeholder: string };
  resultCount: number;
  className?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onApply: (patch: FilterValues) => void;
}) {
  const { t, f } = useI18n();
  const current = values[search.key];
  const [q, setQ] = useState(typeof current === "string" ? current : "");
  const [dialog, setDialog] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchHint = useShortcutHint("search");
  const filterHint = useShortcutHint("filter");
  useShortcut("search", () => searchInput.current?.select());
  useShortcut("filter", () => setDialog(true));
  const active = activeFilterCount(defs, values);
  const chips = filterChips(defs, values, search, t, f);

  useEffect(() => setQ(typeof current === "string" ? current : ""), [current]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onApply({ [search.key]: q.trim() || undefined });
  }

  return (
    <search className={className ? `filter-bar ${className}` : "filter-bar"}>
      <div className="filter-top">
        {leading}
        <form className="filter-toolbar" onSubmit={submit} aria-label={label}>
          <Field label={search.label} hideLabel={Boolean(leading)}>
            {(control) => (
              <input
                {...control}
                ref={searchInput}
                type="search"
                value={q}
                placeholder={search.placeholder}
                aria-keyshortcuts={searchHint.aria}
                onChange={(event) => setQ(event.target.value)}
              />
            )}
          </Field>
          <div className="actions">
            <button type="submit" className="btn">
              <Icon name="search" size={18} /> {t("common.search")}
            </button>
            <button
              ref={button}
              type="button"
              className="btn"
              aria-haspopup="dialog"
              aria-keyshortcuts={filterHint.aria}
              title={filterHint.title(t("filters.open"))}
              aria-label={active > 0 ? t("filters.openActive", { count: active }) : undefined}
              onClick={() => setDialog(true)}
            >
              <Icon name="filter" size={18} /> {t("filters.open")}
              {active > 0 && (
                <>
                  {" "}
                  <span className="filter-count">{f.integer(active)}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
      <FilterChips chips={chips} fallback={button} onRemove={(keys) => onApply(clearKeys(keys))} />
      {trailing}
      <ResultAnnouncer text={t("transactions.count", { count: resultCount })} values={values} />
      {dialog && <FilterDialog title={label} defs={defs} values={values} onApply={onApply} onClose={() => setDialog(false)} />}
    </search>
  );
}

const blank = (value: FilterValues[string]) => (value === undefined || value === "" || value === false ? null : value);

function sameValues(a: FilterValues, b: FilterValues): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => blank(a[key]) === blank(b[key]));
}

function FilterDialog({
  title,
  defs,
  values,
  onApply,
  onClose,
}: {
  title: string;
  defs: readonly FilterDef[];
  values: FilterValues;
  onApply: (patch: FilterValues) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [initial] = useState(() => pickFilterValues(defs, values));
  const [draft, setDraft] = useState(initial);
  const { form, errors, check, clear } = useFormErrors<{ range: string; amount: string }>();
  const set = (key: string, value: FilterValues[string]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const patch = (values: FilterValues) => setDraft((prev) => ({ ...prev, ...values }));
  const selects = defs.filter((def) => def.kind === "select");
  const ranges = defs.filter((def) => def.kind === "dateRange");
  const amounts = defs.filter((def) => def.kind === "amountRange");
  const periods = defs.filter((def) => def.kind === "period");
  const flags = defs.filter((def) => def.kind === "flag");

  function submit() {
    const inverted = [...ranges, ...periods].some((def) => {
      const from = draft[def.from];
      const to = draft[def.to];
      return typeof from === "string" && typeof to === "string" && from > to;
    });
    const amountInverted = amounts.some((def) => {
      const from = draft[def.from];
      const to = draft[def.to];
      return typeof from === "number" && typeof to === "number" && from > to;
    });
    if (!check({ range: inverted ? t("filters.rangeOrder") : undefined, amount: amountInverted ? t("filters.amountOrder") : undefined }))
      return;
    onApply(draft);
    onClose();
  }

  return (
    <FormDialog
      title={title}
      className="filter-dialog"
      dismissible={sameValues(draft, initial)}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost filter-reset"
            onClick={() => {
              setDraft(pickFilterValues(defs, {}));
              clear("range");
              clear("amount");
            }}
          >
            {t("filters.reset")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {t("filters.apply")}
          </button>
        </>
      }
    >
      {selects.length > 0 && (
        <div className="form-grid">
          {selects.map((def) => (
            <Field key={def.key} label={def.label}>
              {(control) => (
                <select
                  {...control}
                  value={String(draft[def.key] ?? "")}
                  onChange={(event) => set(def.key, def.options.find((o) => String(o.value) === event.target.value)?.value)}
                >
                  <option value="">{def.anyLabel}</option>
                  {def.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
        </div>
      )}
      {ranges.map((def) => (
        <fieldset key={def.from} className="field">
          <legend>{def.label}</legend>
          <div className="form-grid">
            <Field label={t("transactions.filter.from")}>
              {(control) => (
                <input
                  {...control}
                  type="date"
                  value={String(draft[def.from] ?? "")}
                  onChange={(event) => {
                    set(def.from, event.target.value || undefined);
                    clear("range");
                  }}
                />
              )}
            </Field>
            <Field label={t("transactions.filter.to")} error={errors.range}>
              {(control) => (
                <input
                  {...control}
                  type="date"
                  value={String(draft[def.to] ?? "")}
                  onChange={(event) => {
                    set(def.to, event.target.value || undefined);
                    clear("range");
                  }}
                />
              )}
            </Field>
          </div>
        </fieldset>
      ))}
      {amounts.map((def) => (
        <fieldset key={def.from} className="field">
          <legend>{def.label}</legend>
          <div className="form-grid">
            <AmountInput
              label={t("transactions.filter.amountMin")}
              hint={t("transactions.filter.amountHint")}
              value={draft[def.from]}
              onChange={(value) => {
                set(def.from, value);
                clear("amount");
              }}
            />
            <AmountInput
              label={t("transactions.filter.amountMax")}
              error={errors.amount}
              value={draft[def.to]}
              onChange={(value) => {
                set(def.to, value);
                clear("amount");
              }}
            />
          </div>
        </fieldset>
      ))}
      {periods.map((def) => (
        <PeriodControl
          key={def.key}
          def={def}
          draft={draft}
          error={errors.range}
          onChange={(values) => {
            patch(values);
            clear("range");
          }}
        />
      ))}
      {flags.length > 0 && (
        <fieldset className="field">
          <legend>{t("filters.more")}</legend>
          <div className="checks">
            {flags.map((def) => (
              <label key={def.key} className="checkbox">
                <input
                  type="checkbox"
                  checked={draft[def.key] === true}
                  onChange={(event) => set(def.key, event.target.checked || undefined)}
                />
                {def.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </FormDialog>
  );
}

/** Euros without sign; an empty or invalid entry leaves the bound out. */
function AmountInput({
  label,
  hint,
  error,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  error?: string;
  value: FilterValues[string];
  onChange: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  // "Zurücksetzen" clears the bound from outside.
  useEffect(() => {
    if (value === undefined) setText("");
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <input
          {...control}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.01}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const amount = event.target.valueAsNumber;
            onChange(Number.isFinite(amount) && amount >= 0 ? amount : undefined);
          }}
        />
      )}
    </Field>
  );
}

const CUSTOM = "custom";

/** A relative period, or "custom" with two dates. */
function PeriodControl({
  def,
  draft,
  error,
  onChange,
}: {
  def: Extract<FilterDef, { kind: "period" }>;
  draft: FilterValues;
  error?: string;
  onChange: (values: FilterValues) => void;
}) {
  const t = useT();
  const preset = draft[def.key];
  const [custom, setCustom] = useState(!preset && Boolean(draft[def.from] || draft[def.to]));
  const choice = preset ? String(preset) : custom ? CUSTOM : "";
  const date = (key: string, label: string, fieldError?: string) => (
    <Field label={label} error={fieldError}>
      {(control) => (
        <input
          {...control}
          type="date"
          value={String(draft[key] ?? "")}
          onChange={(event) => onChange({ [key]: event.target.value || undefined })}
        />
      )}
    </Field>
  );
  return (
    <div className="stack-sm">
      <Field label={def.label}>
        {(control) => (
          <select
            {...control}
            value={choice}
            onChange={(event) => {
              const value = event.target.value;
              setCustom(value === CUSTOM);
              onChange(
                value === CUSTOM ? { [def.key]: undefined } : { [def.key]: value || undefined, [def.from]: undefined, [def.to]: undefined },
              );
            }}
          >
            <option value="">{def.anyLabel}</option>
            {def.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM}>{t("periods.custom")}</option>
          </select>
        )}
      </Field>
      {custom && (
        <div className="form-grid">
          {date(def.from, t("transactions.filter.from"))}
          {date(def.to, t("transactions.filter.to"), error)}
        </div>
      )}
    </div>
  );
}

/** After a chip is removed, focus moves to the chip now in its place, or back to the "Filtern" button. */
function FilterChips({
  chips,
  fallback,
  onRemove,
}: {
  chips: FilterChip[];
  fallback: RefObject<HTMLButtonElement | null>;
  onRemove: (keys: string[]) => void;
}) {
  const t = useT();
  const mask = useMaskAmounts();
  const list = useRef<HTMLUListElement>(null);
  const refocus = useRef<number | null>(null);
  const ids = chips.map((chip) => chip.id).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of chips changed after a removal.
  useEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    (buttons[Math.min(index, buttons.length - 1)] ?? fallback.current)?.focus();
  }, [ids, fallback]);

  if (chips.length === 0) return null;
  return (
    <div className="filter-chips">
      <ul ref={list} aria-label={t("filters.active")}>
        {chips.map((chip, index) => (
          <li key={chip.id} className="filter-chip">
            <span>
              <MaskedText text={chip.text} />
            </span>
            <button
              type="button"
              className="filter-chip-remove"
              aria-label={t("filters.remove", { name: mask(chip.text) })}
              onClick={() => {
                refocus.current = index;
                onRemove(chip.keys);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {chips.length >= 2 && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            refocus.current = -1;
            onRemove(chips.flatMap((chip) => chip.keys));
          }}
        >
          {t("filters.removeAll")}
        </button>
      )}
    </div>
  );
}

/** Reads the new result count once the filters changed; not on the first render. */
function ResultAnnouncer({ text, values }: { text: string; values: FilterValues }) {
  const [message, setMessage] = useState("");
  const signature = JSON.stringify(values);
  const mounted = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change is announced even when the count stays the same.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setMessage("");
    // Cleared first, so the same count is read again after another filter change.
    const timer = setTimeout(() => setMessage(text), 150);
    return () => clearTimeout(timer);
  }, [signature, text]);

  return (
    <p className="visually-hidden" aria-live="polite">
      {message}
    </p>
  );
}
