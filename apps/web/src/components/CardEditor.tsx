import { useId, useState } from "react";
import { useT } from "../i18n/react.tsx";
import {
  CARD_META,
  CARD_ORDER,
  CARD_WIDTHS,
  type Card,
  type CardType,
  type CardWidth,
  cardIds,
  cardKind,
  cardLimit,
  cardPeriod,
  createCard,
  defaultCardTitle,
  type Kind,
} from "../lib/cards.ts";
import { useFormErrors } from "../lib/forms.ts";
import { CATEGORY_KINDS } from "../lib/labels.ts";
import { type CardPeriod, PERIODS } from "../lib/periods.ts";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";

const MAX_PICKS = 6;

type Named = { id: number; name: string; color: string };

function TypePicker({
  value,
  onChange,
  aiAvailable,
  admin,
}: {
  value: CardType;
  onChange: (type: CardType) => void;
  aiAvailable: boolean;
  admin: boolean;
}) {
  const name = useId();
  const t = useT();
  return (
    <fieldset className="field">
      <legend>{t("dashboard.editor.typeLegend")}</legend>
      <div className="type-grid">
        {CARD_ORDER.filter((type) => type === value || ((aiAvailable || !CARD_META[type].ai) && (admin || !CARD_META[type].adminOnly))).map(
          (type) => (
            <label key={type} className="type-option">
              <input type="radio" name={name} value={type} checked={value === type} onChange={() => onChange(type)} />
              <strong>{t(`dashboard.cards.${type}.label`)}</strong>
              <span>{t(`dashboard.cards.${type}.description`)}</span>
            </label>
          ),
        )}
      </div>
    </fieldset>
  );
}

function IdPicker({
  kind,
  items,
  selected,
  onChange,
}: {
  kind: "category" | "tag";
  items: Named[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const t = useT();
  const hint = useId();
  const full = selected.length >= MAX_PICKS;
  return (
    <fieldset className="field" aria-describedby={hint}>
      <legend>{t(`dashboard.editor.pickerLegend.${kind}`)}</legend>
      <span id={hint} className="field-hint">
        {t(`dashboard.editor.pickerHint.${kind}`, { max: MAX_PICKS })}
      </span>
      {items.length === 0 ? (
        <p className="field-hint">{t(`dashboard.editor.pickerEmpty.${kind}`)}</p>
      ) : (
        <div className="chips">
          {items.map((item) => {
            const checked = selected.includes(item.id);
            return (
              <label key={item.id} className="chip">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
                />
                <span className="swatch" style={{ background: item.color }} aria-hidden="true" />
                {item.name}
              </label>
            );
          })}
        </div>
      )}
      <span className="field-hint" aria-live="polite">
        {t("dashboard.editor.picked", { count: selected.length, max: MAX_PICKS })}
      </span>
    </fieldset>
  );
}

export function CardEditor({
  card,
  categories,
  tags,
  aiAvailable,
  admin,
  onSave,
  onClose,
}: {
  card: Card | null;
  categories: Named[];
  tags: Named[];
  aiAvailable: boolean;
  admin: boolean;
  onSave: (card: Card) => void;
  onClose: () => void;
}) {
  const t = useT();
  const initial = card ?? createCard("summary", t);
  const [type, setType] = useState<CardType>(initial.type);
  const [title, setTitle] = useState(initial.title);
  const [width, setWidth] = useState<CardWidth>(initial.width);
  const [period, setPeriod] = useState<CardPeriod>(cardPeriod(initial));
  const [kind, setKind] = useState<Kind>(cardKind(initial));
  const [limit, setLimit] = useState(String(cardLimit(initial)));
  const [ids, setIds] = useState<number[]>(cardIds(initial));
  const { form, errors, check, clear } = useFormErrors<{ title: string; limit: string }>();
  const meta = CARD_META[type];

  function changeType(next: CardType) {
    const fresh = createCard(next, t);
    if (!title.trim() || title === defaultCardTitle(type, t)) setTitle(fresh.title);
    setWidth(fresh.width);
    setPeriod(cardPeriod(fresh));
    setLimit(String(cardLimit(fresh)));
    setIds([]);
    setType(next);
  }

  function submit() {
    const n = Number(limit);
    const max = meta.limit?.max ?? 0;
    if (
      !check({
        title: title.trim() ? undefined : t("dashboard.editor.titleRequired"),
        limit: meta.limit && !(Number.isInteger(n) && n >= 1 && n <= max) ? t("dashboard.editor.limitError", { max }) : undefined,
      })
    )
      return;
    const options: Card["options"] = {};
    if (meta.period) options.period = period;
    if (meta.kind) options.kind = kind;
    if (meta.limit) options.limit = n;
    if (meta.picker) options.ids = ids;
    onSave({ id: initial.id, type, title: title.trim(), width, options });
  }

  return (
    <FormDialog
      title={card ? t("dashboard.editor.editTitle") : t("dashboard.addCard")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {card ? t("common.apply") : t("dashboard.addCard")}
          </button>
        </>
      }
    >
      <TypePicker value={type} onChange={changeType} aiAvailable={aiAvailable} admin={admin} />
      <div className="form-grid">
        <Field label={t("dashboard.editor.titleField")} error={errors.title}>
          {(control) => (
            <input
              {...control}
              value={title}
              maxLength={80}
              required
              onChange={(event) => {
                setTitle(event.target.value);
                clear("title");
              }}
            />
          )}
        </Field>
        <Field label={t("dashboard.editor.width")}>
          {(control) => (
            <select {...control} value={width} onChange={(event) => setWidth(event.target.value as CardWidth)}>
              {CARD_WIDTHS.map((value) => (
                <option key={value} value={value}>
                  {t(`dashboard.widths.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {meta.period && (
          <Field label={t("common.fields.period")} hint={t("dashboard.editor.periodHint")}>
            {(control) => (
              <select {...control} value={period} onChange={(event) => setPeriod(event.target.value as CardPeriod)}>
                <option value="dashboard">{t("dashboard.editor.followDashboard")}</option>
                {PERIODS.map((value) => (
                  <option key={value} value={value}>
                    {t(`periods.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {meta.kind && (
          <Field label={t("common.fields.kind")}>
            {(control) => (
              <select {...control} value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                {CATEGORY_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`labels.categoryKind.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {meta.limit && (
          <Field label={t("dashboard.editor.limit")} hint={t("dashboard.editor.limitHint", { max: meta.limit.max })} error={errors.limit}>
            {(control) => (
              <input
                {...control}
                type="number"
                inputMode="numeric"
                min={1}
                max={meta.limit?.max}
                value={limit}
                onChange={(event) => {
                  setLimit(event.target.value);
                  clear("limit");
                }}
              />
            )}
          </Field>
        )}
      </div>
      {meta.picker && (
        <IdPicker kind={meta.picker} items={meta.picker === "category" ? categories : tags} selected={ids} onChange={setIds} />
      )}
    </FormDialog>
  );
}
