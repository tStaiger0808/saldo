import { Link, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { INTL_LOCALES, type Locale } from "../i18n/locales.ts";
import { useI18n, useT } from "../i18n/react.tsx";
import { errorMessage, type Notice, useAction } from "../lib/action.ts";
import { useFormErrors } from "../lib/forms.ts";
import { CATEGORY_KINDS, VISIBILITIES, type Visibility } from "../lib/labels.ts";
import {
  deleteContractDocumentFn,
  deleteContractFn,
  type getContractFn,
  type getContractsFn,
  saveContractFn,
} from "../server/functions/contracts.ts";
import { parseAmount } from "./AccountActions.tsx";
import { Amount, Money } from "./Bits.tsx";
import { ConfirmDialog, FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner, Status } from "./Status.tsx";

export type ContractItem = Awaited<ReturnType<typeof getContractsFn>>["items"][number];
export type ContractDetailData = Awaited<ReturnType<typeof getContractFn>>;
export type ContractFields = Parameters<typeof saveContractFn>[0]["data"]["contract"];
type Interval = ContractItem["interval"];
type Direction = ContractItem["direction"];

const INTERVALS = ["weekly", "monthly", "quarterly", "half_yearly", "yearly", "custom"] as const satisfies readonly Interval[];
const DIRECTIONS = ["expense", "income"] as const satisfies readonly Direction[];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function intervalLabel(t: Translate, c: { interval: Interval; intervalMonths: number | null }): string {
  return c.interval === "custom" ? t("contracts.everyMonths", { count: c.intervalMonths ?? 1 }) : t(`contracts.interval.${c.interval}`);
}

/** Income is shown with a plus, expenses with a minus, like bookings. */
export const signedCents = (c: { direction: Direction }, cents: number) => (c.direction === "income" ? cents : -cents);

export function ContractStatus({ contract }: { contract: Pick<ContractItem, "state" | "endDate"> }) {
  const { t, f } = useI18n();
  const { state } = contract;
  switch (state.status) {
    case "overdue":
      return (
        <Status tone="danger" detail={state.nextDue ? t("contracts.statusDetail.overdue", { date: f.date(state.nextDue) }) : undefined}>
          {t("contracts.status.overdue")}
        </Status>
      );
    case "price_changed":
      return (
        <Status
          tone="warn"
          detail={
            state.priceChange && (
              <Money>
                {t("contracts.statusDetail.price_changed", {
                  previous: f.euro(state.priceChange.expectedCents),
                  current: f.euro(state.priceChange.actualCents),
                })}
              </Money>
            )
          }
        >
          {t("contracts.status.price_changed")}
        </Status>
      );
    case "ending":
      return <Status tone="info">{t("contracts.status.ending", { date: f.date(contract.endDate) })}</Status>;
    case "ended":
      return <Status>{t("contracts.status.ended")}</Status>;
    default:
      return <Status tone="ok">{t("contracts.status.active")}</Status>;
  }
}

/** "Due today" or "due in 3 days" for a contract due within the next days; nothing otherwise. */
export function DueStatus({ days }: { days: number | null }) {
  const t = useT();
  if (days === null) return null;
  return (
    <Status tone="warn" emphasis={days <= 1 ? "urgent" : "notice"}>
      {days === 0 ? t("contracts.due.today") : t("contracts.due.inDays", { count: days })}
    </Status>
  );
}

/** Euro amounts in the reader's notation without grouping, so the text parses back as typed. */
function euroText(cents: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(
    cents / 100,
  );
}

type Named = { id: number; name: string };
type FormErrors = {
  name: string;
  amount: string;
  months: string;
  nextDue: string;
  tolerance: string;
  endDate: string;
};

/** New contract, one prefilled from a booking or a suggestion, or an existing one to edit. */
export function ContractForm({
  initial,
  contractId,
  accounts,
  categories,
  householdAdmin,
  note,
  onClose,
  onSaved,
}: {
  initial: Partial<ContractFields> | null;
  contractId?: number;
  accounts: Named[];
  categories: (Named & { kind: string })[];
  householdAdmin: boolean;
  /** Explains where prefilled values come from. */
  note?: string;
  onClose: () => void;
  onSaved: (id: number, name: string) => void;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? "expense");
  const [amount, setAmount] = useState(initial?.amountCents ? euroText(initial.amountCents, locale) : "");
  const [variable, setVariable] = useState(initial?.variable ?? false);
  const [interval, setIntervalKind] = useState<Interval>(initial?.interval ?? "monthly");
  const [months, setMonths] = useState(String(initial?.intervalMonths ?? 2));
  const [nextDue, setNextDue] = useState(initial?.nextDue ?? "");
  const [accountId, setAccountId] = useState(initial?.accountId ? String(initial.accountId) : "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ? String(initial.categoryId) : "");
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? (householdAdmin ? "household" : "private"));
  const [matchPayee, setMatchPayee] = useState(initial?.matchPayee ?? "");
  const [matchPurpose, setMatchPurpose] = useState(initial?.matchPurpose ?? "");
  const [tolerance, setTolerance] = useState(initial?.tolerancePercent == null ? (initial ? "" : "10") : String(initial.tolerancePercent));
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const { form, errors, check, clear } = useFormErrors<FormErrors>();
  const save = useAction(saveContractFn);

  async function submit() {
    const cents = parseAmount(amount);
    const monthCount = Number(months);
    const percent = Number(tolerance);
    const ok = check({
      name: name.trim() ? undefined : t("contracts.form.required"),
      amount: cents !== null && cents > 0 ? undefined : t("contracts.form.amountFormat"),
      months:
        interval !== "custom" || (Number.isInteger(monthCount) && monthCount >= 1 && monthCount <= 120)
          ? undefined
          : t("contracts.form.monthsFormat"),
      nextDue: ISO_DAY.test(nextDue) ? undefined : t("contracts.form.dateFormat"),
      tolerance:
        tolerance.trim() === "" || (/^\d+$/.test(tolerance.trim()) && percent <= 100) ? undefined : t("contracts.form.percentFormat"),
      endDate: startDate && endDate && endDate < startDate ? t("contracts.form.endBeforeStart") : undefined,
    });
    if (!ok || cents === null) return;
    const contract: ContractFields = {
      name: name.trim(),
      direction,
      amountCents: cents,
      variable,
      interval,
      intervalMonths: interval === "custom" ? monthCount : null,
      nextDue,
      accountId: accountId ? Number(accountId) : null,
      categoryId: categoryId ? Number(categoryId) : null,
      visibility: accountId ? undefined : visibility,
      matchPayee: matchPayee.trim(),
      matchPurpose: matchPurpose.trim(),
      tolerancePercent: tolerance.trim() === "" ? null : percent,
      startDate: startDate || null,
      endDate: endDate || null,
      notes,
    };
    const result = await save.run({ data: { id: contractId, contract } });
    if (result.ok) onSaved(result.value, contract.name);
  }

  return (
    <FormDialog
      title={contractId === undefined ? t("contracts.form.newTitle") : t("contracts.form.editTitle")}
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
            {t("common.save")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}
      <div className="form-grid">
        <Field label={t("contracts.form.name")} error={errors.name}>
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={100}
              required
              onChange={(event) => {
                setName(event.target.value);
                clear("name");
              }}
            />
          )}
        </Field>
        <Field label={t("contracts.form.direction")}>
          {(control) => (
            <select {...control} value={direction} onChange={(event) => setDirection(event.target.value as Direction)}>
              {DIRECTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`contracts.direction.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={variable ? t("contracts.form.typicalAmount") : t("contracts.form.amount")} error={errors.amount}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              required
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                clear("amount");
              }}
            />
          )}
        </Field>
        <Field label={t("contracts.form.interval")}>
          {(control) => (
            <select {...control} value={interval} onChange={(event) => setIntervalKind(event.target.value as Interval)}>
              {INTERVALS.map((value) => (
                <option key={value} value={value}>
                  {t(`contracts.interval.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {interval === "custom" && (
          <Field label={t("contracts.form.intervalMonths")} error={errors.months}>
            {(control) => (
              <input
                {...control}
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
                required
                value={months}
                onChange={(event) => {
                  setMonths(event.target.value);
                  clear("months");
                }}
              />
            )}
          </Field>
        )}
        <Field label={t("contracts.form.nextDue")} error={errors.nextDue}>
          {(control) => (
            <input
              {...control}
              type="date"
              required
              value={nextDue}
              onChange={(event) => {
                setNextDue(event.target.value);
                clear("nextDue");
              }}
            />
          )}
        </Field>
        <Field label={t("contracts.form.account")}>
          {(control) => (
            <select {...control} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{t("contracts.form.noAccount")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {householdAdmin && !accountId && (
          <Field label={t("contracts.form.visibility")} hint={t("contracts.form.visibilityHint")}>
            {(control) => (
              <select {...control} value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
                {VISIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`labels.visibility.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t("contracts.form.category")}>
          {(control) => (
            <select {...control} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t("contracts.form.noCategory")}</option>
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
      </div>
      <div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={variable}
            aria-describedby="contract-variable-hint"
            onChange={(event) => setVariable(event.target.checked)}
          />
          {t("contracts.form.variable")}
        </label>
        <span id="contract-variable-hint" className="field-hint">
          {t("contracts.form.variableHint")}
        </span>
      </div>
      <fieldset className="field" aria-describedby="contract-match-hint">
        <legend>{t("contracts.form.matchLegend")}</legend>
        <span id="contract-match-hint" className="field-hint">
          {t("contracts.form.matchHint")}
        </span>
        <div className="form-grid">
          <Field label={t("contracts.form.matchPayee")}>
            {(control) => <input {...control} value={matchPayee} maxLength={200} onChange={(event) => setMatchPayee(event.target.value)} />}
          </Field>
          <Field label={t("contracts.form.matchPurpose")}>
            {(control) => (
              <input {...control} value={matchPurpose} maxLength={200} onChange={(event) => setMatchPurpose(event.target.value)} />
            )}
          </Field>
          {!variable && (
            <Field label={t("contracts.form.tolerance")} hint={t("contracts.form.toleranceHint")} error={errors.tolerance}>
              {(control) => (
                <input
                  {...control}
                  inputMode="numeric"
                  value={tolerance}
                  onChange={(event) => {
                    setTolerance(event.target.value);
                    clear("tolerance");
                  }}
                />
              )}
            </Field>
          )}
        </div>
      </fieldset>
      <div className="form-grid">
        <Field label={t("contracts.form.startDate")}>
          {(control) => <input {...control} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />}
        </Field>
        <Field label={t("contracts.form.endDate")} error={errors.endDate}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={endDate}
              onChange={(event) => {
                setEndDate(event.target.value);
                clear("endDate");
              }}
            />
          )}
        </Field>
      </div>
      <Field label={t("contracts.form.notes")}>
        {(control) => <textarea {...control} value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />}
      </Field>
    </FormDialog>
  );
}

/** The contract with its terms and the bookings linked to it; editing and deleting for those who may. */
export function ContractDetail({
  data,
  readOnly = false,
  onClose,
  onEdit,
  onDeleted,
}: {
  data: ContractDetailData;
  /** While viewing as someone else nothing can be uploaded or deleted. */
  readOnly?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: (name: string) => void;
}) {
  const { t, f } = useI18n();
  const { contract: c, payments, documents } = data;
  const [confirm, setConfirm] = useState(false);
  const remove = useAction(deleteContractFn, { invalidate: false });
  const term = [
    c.startDate && t("contracts.detail.from", { date: f.date(c.startDate) }),
    c.endDate && t("contracts.detail.until", { date: f.date(c.endDate) }),
  ]
    .filter(Boolean)
    .join(" ");
  const match = [
    c.matchPayee && t("contracts.detail.payeeContains", { text: c.matchPayee }),
    c.matchPurpose && t("contracts.detail.purposeContains", { text: c.matchPurpose }),
  ]
    .filter(Boolean)
    .join(", ");

  async function destroy() {
    const result = await remove.run({ data: { id: c.id } });
    if (result.ok) onDeleted(c.name);
  }

  return (
    <FormDialog
      title={c.name}
      variant="drawer"
      onClose={onClose}
      footer={
        <>
          {c.canManage && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
              {t("common.delete")}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          {c.canManage && (
            <button type="button" className="btn btn-primary" onClick={onEdit}>
              {t("common.edit")}
            </button>
          )}
        </>
      }
    >
      {remove.error && <Banner tone="danger">{remove.error}</Banner>}
      {!c.canManage && <Banner tone="info">{t("contracts.detail.readOnly")}</Banner>}
      <div className="contract-detail-status">
        <ContractStatus contract={c} />
        <DueStatus days={c.dueInDays} />
      </div>
      <dl className="facts">
        <dt>{c.variable ? t("contracts.form.typicalAmount") : t("contracts.list.amount")}</dt>
        <dd>
          <Amount cents={signedCents(c, c.amountCents)} /> · {intervalLabel(t, c)}
          {c.variable && ` · ${t("contracts.list.variable")}`}
        </dd>
        <dt>{t("contracts.list.perMonth")}</dt>
        <dd>
          <Amount cents={signedCents(c, c.state.monthlyCents)} />
        </dd>
        <dt>{t("contracts.list.nextDue")}</dt>
        <dd>
          {f.date(c.state.nextDue)}
          {c.variable && c.state.nextDue && (
            <>
              {" "}
              · <Amount cents={signedCents(c, c.state.expectedCents)} />
            </>
          )}
        </dd>
        <dt>{t("contracts.detail.lastPayment")}</dt>
        <dd>
          {c.state.lastPayment ? (
            <>
              {f.date(c.state.lastPayment.bookingDate)} · <Amount cents={c.state.lastPayment.amountCents} />
            </>
          ) : (
            "–"
          )}
        </dd>
        <dt>{t("contracts.form.account")}</dt>
        <dd>{c.accountName ?? "–"}</dd>
        <dt>{t("contracts.form.category")}</dt>
        <dd>{c.categoryName ?? "–"}</dd>
        <dt>{t("contracts.detail.match")}</dt>
        <dd>{match || t("contracts.detail.matchNone")}</dd>
        {!c.variable && (
          <>
            <dt>{t("contracts.detail.tolerance")}</dt>
            <dd>{c.tolerancePercent === null ? t("contracts.detail.toleranceNone") : f.percent(c.tolerancePercent / 100)}</dd>
          </>
        )}
        {term && (
          <>
            <dt>{t("contracts.detail.term")}</dt>
            <dd>{term}</dd>
          </>
        )}
        <dt>{t("contracts.form.visibility")}</dt>
        <dd>{t(`labels.visibility.${c.visibility}`)}</dd>
        {c.notes && (
          <>
            <dt>{t("contracts.form.notes")}</dt>
            <dd style={{ whiteSpace: "pre-line" }}>{c.notes}</dd>
          </>
        )}
      </dl>
      <ContractDocuments contractId={c.id} documents={documents} canManage={c.canManage && !readOnly} />
      <h3>{t("contracts.detail.payments")}</h3>
      {payments.length === 0 ? (
        <p className="muted">{t("contracts.detail.noPayments")}</p>
      ) : (
        <ul className="list">
          {payments.map((p) => (
            <li key={p.id}>
              <span className="list-main">
                <span className="list-title">
                  <Link to="/buchungen" search={{ konto: p.accountId, von: p.bookingDate, bis: p.bookingDate }}>
                    {p.counterparty || p.purpose || "–"}
                  </Link>
                </span>
                <span className="list-sub">
                  {f.date(p.bookingDate)}
                  {p.priceChanged && ` · ${t("contracts.detail.priceChanged")}`}
                </span>
              </span>
              <span className="num">
                <Amount cents={p.amountCents} currency={p.currency} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm}
        title={t("contracts.detail.confirmDelete", { name: c.name })}
        confirmLabel={t("contracts.detail.delete")}
        danger
        onConfirm={destroy}
        onClose={() => setConfirm(false)}
      >
        <p>{t("contracts.detail.confirmDeleteText")}</p>
      </ConfirmDialog>
    </FormDialog>
  );
}

type ContractDocument = ContractDetailData["documents"][number];

/** Mirrors the server's limit, so a too large file is refused before it is sent. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOCUMENT_TYPES = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

function fileSize(t: Translate, f: ReturnType<typeof useI18n>["f"], bytes: number): string {
  return bytes < 1024 * 1024
    ? t("contracts.documents.sizeKb", { size: f.decimal(Math.max(1, Math.round(bytes / 1024)), 0) })
    : t("contracts.documents.sizeMb", { size: f.decimal(bytes / (1024 * 1024), 1) });
}

/** The files of a contract: download for whoever sees it, upload and delete for whoever may change it. */
function ContractDocuments({
  contractId,
  documents,
  canManage,
}: {
  contractId: number;
  documents: ContractDocument[];
  canManage: boolean;
}) {
  const { t, f } = useI18n();
  const router = useRouter();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<ContractDocument | null>(null);
  const remove = useAction(deleteContractDocumentFn);

  async function upload(file: File) {
    setMessage(null);
    setFileError(undefined);
    if (file.size > MAX_DOCUMENT_BYTES) {
      setFileError(t("contracts.documents.errors.tooLarge"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/contracts/${contractId}/documents?${new URLSearchParams({ name: file.name })}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? t("common.genericError"));
      await router.invalidate();
      setMessage({ tone: "ok", text: t("contracts.documents.uploaded", { name: file.name }) });
    } catch (error) {
      setFileError(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function destroy(doc: ContractDocument) {
    const result = await remove.run({ data: { id: doc.id } });
    setMessage(
      result.ok ? { tone: "ok", text: t("contracts.documents.deleted", { name: doc.fileName }) } : { tone: "danger", text: result.error },
    );
  }

  return (
    <section className="contract-documents" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("contracts.documents.title")}</h3>
      {message && (
        <Banner tone={message.tone} onClose={() => setMessage(null)}>
          {message.text}
        </Banner>
      )}
      {documents.length === 0 ? (
        <p className="muted">{t("contracts.documents.empty")}</p>
      ) : (
        <ul className="list">
          {documents.map((doc) => (
            <li key={doc.id} className="list-row">
              <span className="list-main">
                <span className="list-title">
                  <a
                    href={`/api/contract-documents/${doc.id}`}
                    download={doc.fileName}
                    aria-label={t("contracts.documents.download", { name: doc.fileName })}
                  >
                    <Icon name="download" size={16} /> {doc.fileName}
                  </a>
                </span>
                <span className="list-sub">
                  {fileSize(t, f, doc.sizeBytes)} · {f.date(doc.createdAt.slice(0, 10))}
                  {doc.uploadedBy && ` · ${doc.uploadedBy}`}
                </span>
              </span>
              {canManage && (
                <span className="actions list-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={remove.busy}
                    aria-label={t("contracts.documents.deleteLabel", { name: doc.fileName })}
                    onClick={() => setConfirm(doc)}
                  >
                    <Icon name="trash" size={16} /> {t("contracts.documents.delete")}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <Field label={t("contracts.documents.choose")} hideLabel hint={t("contracts.documents.hint")} error={fileError} announceError>
          {(control) => (
            <div className="file-picker">
              <input
                {...control}
                type="file"
                className="visually-hidden"
                accept={DOCUMENT_TYPES}
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <label htmlFor={control.id} className="btn" aria-busy={busy}>
                <Icon name="upload" size={18} /> {busy ? t("contracts.documents.uploading") : t("contracts.documents.choose")}
              </label>
            </div>
          )}
        </Field>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t("contracts.documents.confirmDelete", { name: confirm?.fileName ?? "" })}
        confirmLabel={t("contracts.documents.delete")}
        danger
        onConfirm={() => confirm && destroy(confirm)}
        onClose={() => setConfirm(null)}
      >
        <p>{t("contracts.documents.confirmDeleteText")}</p>
      </ConfirmDialog>
    </section>
  );
}
