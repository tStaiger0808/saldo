import { merchantFromPurpose, paymentIntermediary } from "@saldo/core";
import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useI18n } from "../i18n/react.tsx";
import { useAction } from "../lib/action.ts";
import { CATEGORY_KINDS } from "../lib/labels.ts";
import { createSuggestedTagsFn, rememberCategoryFn, suggestCategoryFn } from "../server/functions/ai.ts";
import { type getTransactions, patchTransactionFn } from "../server/functions/transactions.ts";
import { Amount, TransferBadge } from "./Bits.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

export type TransactionItem = Awaited<ReturnType<typeof getTransactions>>["items"][number];
type Named = { id: number; name: string; color: string };
type Suggestion = Awaited<ReturnType<typeof suggestCategoryFn>>;
type AdoptedTags = { tagIds: number[]; newTags: string[] };

/** Edit one booking: category, tags, note and read state; admins also the transfer flag. */
export function TransactionDrawer({
  txn,
  accountName,
  categories,
  tags,
  admin,
  aiReady,
  onClose,
  onSaved,
}: {
  txn: TransactionItem;
  accountName: string;
  categories: (Named & { kind: string })[];
  tags: Named[];
  admin: boolean;
  aiReady: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t, f } = useI18n();
  const [categoryId, setCategoryId] = useState(txn.categoryId === null ? "" : String(txn.categoryId));
  const [tagIds, setTagIds] = useState<number[]>(txn.tagIds);
  // Tags the AI proposed and the person kept; they are created only when the booking is saved.
  const [newTags, setNewTags] = useState<string[]>([]);
  const [note, setNote] = useState(txn.note);
  const [unread, setUnread] = useState(txn.isUnread);
  const [transfer, setTransfer] = useState(txn.isTransfer);
  // A payment service is not the payee: rules and the AI go by the merchant in the purpose.
  const intermediary = paymentIntermediary(txn.counterparty) !== null;
  const merchant = intermediary ? merchantFromPurpose(txn.purpose) : "";
  const payee = intermediary ? merchant : txn.counterparty.trim();
  const patch = useAction(patchTransactionFn);
  const remember = useAction(rememberCategoryFn);
  const createTags = useAction(createSuggestedTagsFn, { invalidate: false });
  const [adopted, setAdopted] = useState<string | null>(null);
  const [rememberAll, setRememberAll] = useState(false);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const tagsRef = useRef<HTMLFieldSetElement>(null);
  const rememberHintId = useId();
  const transferHintId = useId();
  const canRemember = admin && adopted !== null && adopted === categoryId && payee !== "";

  async function submit() {
    let chosenTagIds = tagIds;
    if (newTags.length > 0) {
      const created = await createTags.run({ data: { names: newTags } });
      if (!created.ok) return;
      chosenTagIds = [...new Set([...tagIds, ...created.value])];
      setTagIds(chosenTagIds);
      setNewTags([]);
    }
    const sameTags = [...chosenTagIds].sort().join() === [...txn.tagIds].sort().join();
    const original = txn.categoryId === null ? "" : String(txn.categoryId);
    const categoryChanged = categoryId !== original;
    const result = await patch.run({
      data: {
        id: txn.id,
        categoryId: categoryId && (categoryChanged || adopted === categoryId) ? Number(categoryId) : null,
        clearCategory: categoryChanged && !categoryId,
        manualTagIds: sameTags ? null : chosenTagIds,
        note: note !== txn.note ? note : null,
        isUnread: unread !== txn.isUnread ? unread : null,
        isTransfer: admin && transfer !== txn.isTransfer ? transfer : null,
      },
    });
    if (!result.ok) return;
    if (canRemember && rememberAll) {
      const remembered = await remember.run({ data: { id: txn.id, categoryId: Number(categoryId) } });
      if (!remembered.ok) return;
      onSaved(t("transactions.drawer.savedRemembered", { name: payee }));
    } else onSaved(t("transactions.drawer.saved"));
    onClose();
  }

  return (
    <FormDialog
      title={t("transactions.drawer.title")}
      variant="drawer"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={patch.busy} aria-busy={patch.busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      {patch.error && <Banner tone="danger">{patch.error}</Banner>}
      {remember.error && <Banner tone="danger">{remember.error}</Banner>}
      {createTags.error && <Banner tone="danger">{createTags.error}</Banner>}
      <dl className="facts">
        <dt>{t("common.fields.counterparty")}</dt>
        <dd>{txn.counterparty || "–"}</dd>
        <dt>{t("common.fields.amount")}</dt>
        <dd>
          <Amount cents={txn.amountCents} currency={txn.currency} />
        </dd>
        <dt>{t("common.fields.date")}</dt>
        <dd>
          {f.date(txn.bookingDate)}
          {txn.valueDate && txn.valueDate !== txn.bookingDate && (
            <span className="muted"> · {t("transactions.drawer.valueDate", { date: f.date(txn.valueDate) })}</span>
          )}
        </dd>
        <dt>{t("common.fields.account")}</dt>
        <dd>{accountName}</dd>
        {txn.counterpartyIban && (
          <>
            <dt>IBAN</dt>
            <dd className="mono">{txn.counterpartyIban}</dd>
          </>
        )}
        <dt>{t("transactions.drawer.purpose")}</dt>
        <dd>{txn.purpose || "–"}</dd>
        {txn.transferKind && (
          <>
            <dt>{t("common.transfer")}</dt>
            <dd>
              <TransferBadge kind={txn.transferKind} label={txn.transferLabel} />
            </dd>
          </>
        )}
        {txn.contractId !== null && (
          <>
            <dt>{t("contracts.linkedTo")}</dt>
            <dd>
              <Link to="/vertraege" search={{ vertrag: txn.contractId }}>
                {t("contracts.toContract")}
              </Link>
            </dd>
          </>
        )}
      </dl>
      {txn.contractId === null && !txn.isTransfer && (
        <div className="row">
          <Link to="/vertraege" search={{ neu: txn.id }} className="btn btn-sm">
            <Icon name="contract" size={16} /> {t("contracts.createFromBooking")}
          </Link>
        </div>
      )}
      <Field
        label={t("common.fields.category")}
        hint={txn.categorySource ? t(`transactions.drawer.categoryHint.${txn.categorySource}`) : undefined}
      >
        {(control) => (
          <select {...control} ref={categoryRef} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">{t("transactions.drawer.noCategory")}</option>
            {CATEGORY_KINDS.map((kind) => (
              <optgroup key={kind} label={t(`labels.categoryKind.${kind}`)}>
                {categories
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
      </Field>
      {aiReady && (
        <AiSuggestion
          txnId={txn.id}
          onAdopt={(suggestion, chosen) => {
            setTagIds((current) => [...new Set([...current, ...chosen.tagIds])]);
            setNewTags((current) => [...new Set([...current, ...chosen.newTags])]);
            // The adopt button disappears; focus goes to the field that now shows the category, else to the tags.
            if (suggestion.categoryId === null) {
              requestAnimationFrame(() => {
                const tags = tagsRef.current;
                (tags?.querySelector<HTMLInputElement>("input:checked") ?? tags?.querySelector<HTMLInputElement>("input"))?.focus();
              });
              return;
            }
            setCategoryId(String(suggestion.categoryId));
            setAdopted(String(suggestion.categoryId));
            requestAnimationFrame(() => categoryRef.current?.focus());
          }}
        />
      )}
      {canRemember && (
        <div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={rememberAll}
              aria-describedby={rememberHintId}
              onChange={(event) => setRememberAll(event.target.checked)}
            />
            {t("transactions.drawer.remember", { name: payee })}
          </label>
          <span id={rememberHintId} className="field-hint">
            {t("transactions.drawer.rememberHint")}
          </span>
        </div>
      )}
      <fieldset className="field" ref={tagsRef}>
        <legend>{t("common.fields.tags")}</legend>
        {tags.length === 0 && newTags.length === 0 ? (
          <p className="field-hint">{t("transactions.drawer.noTags")}</p>
        ) : (
          <div className="chips">
            {tags.map((tag) => (
              <label key={tag.id} className="chip">
                <input
                  type="checkbox"
                  checked={tagIds.includes(tag.id)}
                  onChange={(event) => setTagIds(event.target.checked ? [...tagIds, tag.id] : tagIds.filter((id) => id !== tag.id))}
                />
                <span className="swatch" style={{ background: tag.color }} aria-hidden="true" />
                {tag.name}
              </label>
            ))}
            {newTags.map((name) => (
              <label key={`new:${name}`} className="chip">
                <input type="checkbox" checked onChange={() => setNewTags(newTags.filter((n) => n !== name))} />
                {name} · {t("transactions.drawer.newTag")}
              </label>
            ))}
          </div>
        )}
        {newTags.length > 0 && <span className="field-hint">{t("transactions.drawer.newTagsNote")}</span>}
      </fieldset>
      <Field label={t("transactions.drawer.note")}>
        {(control) => <textarea {...control} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />}
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={unread} onChange={(event) => setUnread(event.target.checked)} />
        {t("transactions.drawer.markNew")}
      </label>
      {admin && (
        <details className="drawer-advanced" open={txn.isTransfer || undefined}>
          <summary>{t("transactions.drawer.advanced")}</summary>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={transfer}
              aria-describedby={transferHintId}
              onChange={(event) => setTransfer(event.target.checked)}
            />
            {t("transactions.drawer.isTransfer")}
          </label>
          <span id={transferHintId} className="field-hint">
            {t("transactions.drawer.isTransferHint")}
          </span>
        </details>
      )}
    </FormDialog>
  );
}

/**
 * Asks the active AI provider for one category and, while the AI assigns tags, for tags; adopting fills the form with
 * the category and the tags left ticked, saving makes them manual.
 */
function AiSuggestion({ txnId, onAdopt }: { txnId: number; onAdopt: (suggestion: Suggestion, chosen: AdoptedTags) => void }) {
  const { t } = useI18n();
  const suggest = useAction(suggestCategoryFn, { invalidate: false });
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [adopted, setAdopted] = useState(false);
  const [chosen, setChosen] = useState<AdoptedTags>({ tagIds: [], newTags: [] });
  const hasTags = suggestion !== null && suggestion.tags.length + suggestion.newTags.length > 0;
  const headline = !suggestion
    ? ""
    : suggestion.categoryName
      ? adopted
        ? t("transactions.drawer.adopted", { category: suggestion.categoryName })
        : t("transactions.drawer.suggestion", { category: suggestion.categoryName })
      : t("transactions.drawer.noSuggestion");

  async function ask() {
    setSuggestion(null);
    setAdopted(false);
    const r = await suggest.run({ data: { id: txnId } });
    if (!r.ok) return;
    setSuggestion(r.value);
    setChosen({ tagIds: r.value.tags.map((tag) => tag.id), newTags: r.value.newTags });
  }

  const toggleTag = (id: number, on: boolean) =>
    setChosen((c) => ({ ...c, tagIds: on ? [...c.tagIds, id] : c.tagIds.filter((v) => v !== id) }));
  const toggleNew = (name: string, on: boolean) =>
    setChosen((c) => ({ ...c, newTags: on ? [...c.newTags, name] : c.newTags.filter((v) => v !== name) }));

  return (
    <div className="stack-sm">
      <div className="row ai-suggest-row">
        <button type="button" className="btn btn-sm" disabled={suggest.busy} aria-busy={suggest.busy} onClick={ask}>
          <Icon name="sparkles" size={16} /> {suggest.busy ? t("transactions.drawer.suggesting") : t("transactions.drawer.suggest")}
        </button>
        <span className="field-hint">{t("transactions.drawer.suggestNote")}</span>
      </div>
      {suggest.error && <Banner tone="danger">{suggest.error}</Banner>}
      <p className="visually-hidden" role="status">
        {headline}
      </p>
      {suggestion && (
        <Banner tone="info" live={false}>
          <p>
            <strong>{headline}</strong>
            {suggestion.reason && ` ${suggestion.reason}`}
          </p>
          {hasTags && !adopted && (
            <fieldset className="field">
              <legend>{t("transactions.drawer.suggestedTags")}</legend>
              <div className="chips">
                {suggestion.tags.map((tag) => (
                  <label key={tag.id} className="chip">
                    <input
                      type="checkbox"
                      checked={chosen.tagIds.includes(tag.id)}
                      onChange={(event) => toggleTag(tag.id, event.target.checked)}
                    />
                    {tag.name}
                  </label>
                ))}
                {suggestion.newTags.map((name) => (
                  <label key={`new:${name}`} className="chip">
                    <input
                      type="checkbox"
                      checked={chosen.newTags.includes(name)}
                      onChange={(event) => toggleNew(name, event.target.checked)}
                    />
                    {name} · {t("transactions.drawer.newTag")}
                  </label>
                ))}
              </div>
              {suggestion.newTags.length > 0 && <span className="field-hint">{t("transactions.drawer.newTagsNote")}</span>}
            </fieldset>
          )}
          {adopted && !suggestion.categoryName && <p>{t("transactions.drawer.adoptedTags")}</p>}
          {(suggestion.categoryName || hasTags) && !adopted && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onAdopt(suggestion, chosen);
                setAdopted(true);
              }}
            >
              {t("transactions.drawer.adopt")}
            </button>
          )}
        </Banner>
      )}
    </div>
  );
}
