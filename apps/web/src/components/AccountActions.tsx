import { CSV_PRESETS, type CsvMapping, type CsvPreset, guessMapping, parseCsv, parseCsvAmount, readCsvBookings } from "@saldo/core";
import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n, useT } from "../i18n/react.tsx";
import { errorMessage, type Notice, useAction } from "../lib/action.ts";
import { csvExportUrl } from "../lib/booking-filter.ts";
import { focusFirstInvalid, useFormErrors } from "../lib/forms.ts";
import { ACCOUNT_KINDS, type AccountKind } from "../lib/labels.ts";
import { isoDate } from "../lib/periods.ts";
import {
  addManualBookingFn,
  deleteAccountFn,
  deleteBalanceEntryFn,
  editAccountFn,
  getAccountDetailFn,
  getAccountSharingFn,
  recordBalanceFn,
  setAccountSharingFn,
} from "../server/functions/accounts.ts";
import {
  authorizeBankConnectionFn,
  deleteBankConnectionFn,
  discoverBankConnectionFn,
  setSkipSyncAllFn,
} from "../server/functions/banking.ts";
import { markAllReadFn } from "../server/functions/transactions.ts";
import { getPeopleFn } from "../server/functions/users.ts";
import type { AccountSummary, BalanceEntry } from "../server/modules/accounts/index.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { ActionSheet, type SheetAction } from "./ActionSheet.tsx";
import { type Connection, EditConnectionDialog } from "./BankDialogs.tsx";
import { useBankJobs } from "./BankJobs.tsx";
import { Balance, Money } from "./Bits.tsx";
import { ConfirmDialog, FormDialog } from "./Dialog.tsx";
import { CheckGroup, Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

/** What the account menu needs besides the account: its connection (if the viewer manages it). */
export type AccountContext = {
  connection: Connection | undefined;
  balanceEntries?: BalanceEntry[];
};

type DialogKind = "edit" | "share" | "balance" | "booking" | "csv" | "access" | "disconnect" | "delete";

const appRoute = getRouteApi("/_app");

/** "betrifft auch: …" for actions on a connection that more accounts share. */
export function useAlsoAffects(account: AccountSummary): string | null {
  const t = useT();
  const others = account.connection?.otherAccounts ?? [];
  return others.length > 0 ? t("accounts.actions.alsoAffects", { names: others.join(", ") }) : null;
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

/** The checkbox entry that leaves a connection out of "Konten abrufen" and the schedule (or takes it back in). */
function useSkipSyncAllItem(connection: Connection | undefined, onNotice: (notice: Notice) => void) {
  const t = useT();
  const toggle = useAction(setSkipSyncAllFn);
  if (!connection || connection.status === "new") return null;
  const skip = !connection.skipSyncAll;
  return {
    label: t("accounts.actions.manualOnly"),
    icon: "clock" as const,
    checked: connection.skipSyncAll,
    disabled: toggle.busy,
    onSelect: async () => {
      const result = await toggle.run({ data: { id: connection.id, skip } });
      if (!result.ok) return onNotice({ tone: "danger", text: result.error });
      onNotice({
        tone: "ok",
        text: skip
          ? t("accounts.actions.skipSyncAllOn", { name: connection.name })
          : t("accounts.actions.skipSyncAllOff", { name: connection.name }),
      });
    },
  };
}

/**
 * Safari writes to the clipboard only within the tap, so the text goes in as a promise right away and arrives once
 * loaded; engines without promised clipboard items take it when it is there.
 */
async function copyPending(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
      ]);
      return;
    } catch {
      // Falls back to plain text below.
    }
  }
  await navigator.clipboard.writeText(await text);
}

/** Amounts as people type them: "1.234,56", "-12,30" or "12.30". */
export function parseAmount(text: string): number | null {
  return parseCsvAmount(text, "comma") ?? parseCsvAmount(text, "point");
}

type Item = SheetAction | false | null | undefined;

/**
 * Everything one can do with an account, in one menu: bank actions (they act on the whole connection), editing,
 * sharing and the bookkeeping of accounts without a bank connection. With `sheet`, the row also offers the
 * `ActionSheet`, which adds reading, export and navigation; on phones its button takes the place of the menu's.
 * While a superuser views Saldo as someone else, only the actions that change nothing are offered.
 */
export function AccountMenu({
  account,
  context,
  onNotice,
  sheet,
}: {
  account: AccountSummary;
  context: AccountContext;
  onNotice: (notice: Notice) => void;
  sheet?: { open: boolean; onOpen: () => void; onClose: () => void };
}) {
  const { t } = useI18n();
  const { user } = appRoute.useRouteContext();
  const [open, setOpen] = useState<DialogKind | null>(null);
  const { track, syncConnection, fetching } = useBankJobs();
  const navigate = useNavigate();
  const discover = useAction(discoverBankConnectionFn);
  const authorize = useAction(authorizeBankConnectionFn, { invalidate: false });
  const remove = useAction(deleteAccountFn, { invalidate: false });
  const markRead = useAction(markAllReadFn);
  const loadDetail = useServerFn(getAccountDetailFn);
  const router = useRouter();
  const also = useAlsoAffects(account);
  const writable = !user.impersonation;
  const c = account.connection;
  const connection = writable && c?.canManage ? context.connection : undefined;
  const label = also ? `${c?.name ?? ""} (${also})` : (c?.name ?? account.name);
  const skipItem = useSkipSyncAllItem(connection, onNotice);

  async function check() {
    if (!connection) return;
    const result = await discover.run({ data: { id: connection.id } });
    if (result.ok) track([{ job: result.value, label }]);
    else onNotice({ tone: "danger", text: result.error });
  }

  async function sync() {
    if (!connection) return;
    const error = await syncConnection(connection.id, c?.name ?? label);
    if (error) onNotice({ tone: "danger", text: error });
  }

  async function renew() {
    if (!connection) return;
    const result = await authorize.run({ data: { id: connection.id } });
    if (result.ok) window.location.assign(result.value.url);
    else onNotice({ tone: "danger", text: result.error });
  }

  async function destroy() {
    const result = await remove.run({ data: { id: account.id } });
    if (!result.ok) return onNotice({ tone: "danger", text: result.error });
    onNotice({ tone: "ok", text: t("accounts.actions.deleted", { name: account.name }) });
    await navigate({ to: "/konten" });
    await router.invalidate();
  }

  async function readAll() {
    const result = await markRead.run({ data: { accountId: account.id } });
    onNotice(
      result.ok ? { tone: "ok", text: t("accounts.actions.markedRead", { name: account.name }) } : { tone: "danger", text: result.error },
    );
  }

  // The overview only knows the last digits; the full IBAN comes from the access-checked account detail.
  async function copyIban() {
    const iban = loadDetail({ data: { accountId: account.id } }).then(({ account: detail }) => {
      if (!detail.iban) throw new Error("no IBAN");
      return detail.iban;
    });
    try {
      await copyPending(iban);
      onNotice({ tone: "ok", text: t("accounts.actions.ibanCopied", { name: account.name }) });
    } catch {
      onNotice({ tone: "danger", text: t("common.copyFailed") });
    }
  }

  const manage = writable && account.canManage;
  const bookkeeping = account.manual && manage;
  const grouping = writable && (account.canShare || (account.canManage && account.sharing.visibility === "household"));
  const syncItem: Item = connection &&
    connection.status !== "new" && {
      label: t("accounts.actions.sync"),
      icon: "sync",
      disabled: fetching.has(connection.id),
      onSelect: sync,
    };
  const loginItem: Item =
    connection &&
    (connection.provider === "enable_banking"
      ? { label: t("accounts.actions.renew"), icon: "key", disabled: authorize.busy, onSelect: renew }
      : { label: t("accounts.actions.check"), icon: "key", disabled: discover.busy, onSelect: check });
  const accessItem: Item = connection &&
    connection.provider !== "enable_banking" && { label: t("accounts.actions.access"), icon: "lock", onSelect: () => setOpen("access") };
  const renameItem: Item = manage && { label: t("accounts.actions.rename"), icon: "edit", onSelect: () => setOpen("edit") };
  const later: Item[] = [
    manage && { label: t("accounts.actions.kind"), icon: "wallet", onSelect: () => setOpen("edit") },
    grouping && { label: t("accounts.actions.share"), icon: "users", onSelect: () => setOpen("share") },
    bookkeeping && { label: t("accounts.actions.balance"), icon: "chart", onSelect: () => setOpen("balance") },
    bookkeeping && { label: t("accounts.actions.booking"), icon: "plus", onSelect: () => setOpen("booking") },
    bookkeeping && { label: t("accounts.actions.csv"), icon: "upload", onSelect: () => setOpen("csv") },
    connection && { label: t("accounts.actions.disconnect"), icon: "plug", danger: true, onSelect: () => setOpen("disconnect") },
    bookkeeping && { label: t("common.delete"), icon: "trash", danger: true, onSelect: () => setOpen("delete") },
  ];
  const items = [syncItem, loginItem, skipItem, accessItem, renameItem, ...later];
  const sheetItems: Item[] = [
    syncItem,
    writable &&
      account.unreadCount > 0 && { label: t("accounts.actions.markRead"), icon: "check", disabled: markRead.busy, onSelect: readAll },
    {
      label: t("accounts.actions.export"),
      icon: "download",
      onSelect: () => window.location.assign(csvExportUrl({ accountId: account.id })),
    },
    renameItem,
    account.ibanLast4 ? { label: t("accounts.detail.copyIban"), icon: "copy", onSelect: copyIban } : null,
    {
      label: t("accounts.detail.openInTransactions"),
      icon: "list",
      onSelect: () => navigate({ to: "/buchungen", search: { konto: account.id } }),
    },
    {
      label: t("accounts.actions.details"),
      icon: "info",
      onSelect: () => navigate({ to: "/konten/$accountId", params: { accountId: String(account.id) } }),
    },
    loginItem,
    skipItem,
    accessItem,
    ...later,
  ];
  if (!sheet && !items.some(Boolean)) return null;
  const close = () => setOpen(null);
  const saved = (text: string) => onNotice({ tone: "ok", text });

  return (
    <>
      <ActionMenu name={account.name} items={items} />
      {sheet && (
        <button type="button" className="btn btn-sm btn-icon account-sheet-button" aria-haspopup="dialog" onClick={sheet.onOpen}>
          <Icon name="more" size={18} />
          <span className="visually-hidden">{t("common.actionsFor", { name: account.name })}</span>
        </button>
      )}
      {sheet?.open && <ActionSheet title={account.name} items={sheetItems} onClose={sheet.onClose} />}
      {open === "edit" && <EditAccountDialog account={account} onClose={close} onSaved={saved} />}
      {open === "share" && <ShareDialog account={account} onClose={close} onSaved={saved} />}
      {open === "balance" && <BalanceDialog account={account} entries={context.balanceEntries} onClose={close} onSaved={saved} />}
      {open === "booking" && <BookingDialog account={account} onClose={close} onSaved={saved} />}
      {open === "csv" && <CsvImportDialog account={account} onClose={close} onSaved={saved} />}
      {open === "access" && connection && <EditConnectionDialog connection={connection} onClose={close} onSaved={saved} />}
      {open === "disconnect" && connection && (
        <DisconnectDialog
          subject={account.name}
          connection={connection}
          also={also}
          onClose={close}
          onDone={async (text, kept) => {
            onNotice({ tone: "ok", text });
            if (!kept) await navigate({ to: "/konten" });
          }}
        />
      )}
      <ConfirmDialog
        open={open === "delete"}
        title={t("accounts.actions.deleteTitle", { name: account.name })}
        confirmLabel={t("accounts.actions.deleteConfirm")}
        danger
        onConfirm={destroy}
        onClose={close}
      >
        <p>{t("accounts.actions.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

function EditAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountSummary;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [name, setName] = useState(account.name);
  const [kind, setKind] = useState<AccountKind>(account.kind);
  const { form, errors, check, clear } = useFormErrors<{ name: string }>();
  const save = useAction(editAccountFn);
  const t = useT();

  async function submit() {
    if (!check({ name: name.trim() ? undefined : t("accounts.actions.nameRequired") })) return;
    const result = await save.run({ data: { id: account.id, name: name.trim(), kind } });
    if (!result.ok) return;
    onSaved(t("accounts.actions.saved", { name: name.trim() }));
    onClose();
  }

  return (
    <FormDialog
      title={t("accounts.actions.editTitle", { name: account.name })}
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
      <KindField value={kind} onChange={setKind} />
    </FormDialog>
  );
}

export function KindField({ value, onChange }: { value: AccountKind; onChange: (kind: AccountKind) => void }) {
  const t = useT();
  return (
    <Field label={t("common.fields.kind")}>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value as AccountKind)}>
          {ACCOUNT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`labels.accountKind.${kind}`)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** People (owner's decision) and groups (everyone who sees the group); household admins only decide about groups. */
function ShareDialog({ account, onClose, onSaved }: { account: AccountSummary; onClose: () => void; onSaved: (text: string) => void }) {
  const { groups } = appRoute.useRouteContext();
  const loadSharing = useServerFn(getAccountSharingFn);
  const loadPeople = useServerFn(getPeopleFn);
  const [userIds, setUserIds] = useState<string[] | null>(null);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [people, setPeople] = useState<{ id: string; username: string }[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const save = useAction(setAccountSharingFn);
  const t = useT();

  useEffect(() => {
    let live = true;
    Promise.all([loadSharing({ data: { accountId: account.id } }), loadPeople()]).then(
      ([sharing, list]) => {
        if (!live) return;
        setUserIds(sharing.userIds);
        setGroupIds(sharing.groupIds);
        setPeople(list);
        setReady(true);
      },
      (error) => live && setLoadError(errorMessage(error, t)),
    );
    return () => {
      live = false;
    };
  }, [account.id, loadSharing, loadPeople, t]);

  async function submit() {
    const result = await save.run({ data: { accountId: account.id, groupIds, ...(userIds ? { userIds } : {}) } });
    if (!result.ok) return;
    onSaved(t("accounts.share.saved", { name: account.name }));
    onClose();
  }

  return (
    <FormDialog
      title={t("accounts.share.title", { name: account.name })}
      onClose={onClose}
      onSubmit={submit}
      footer={<Footer busy={save.busy || !ready} label={t("common.save")} onClose={onClose} />}
    >
      {(save.error || loadError) && <Banner tone="danger">{save.error ?? loadError}</Banner>}
      <p className="muted">
        {account.sharing.visibility === "private" ? t("accounts.share.introPrivate") : t("accounts.share.introHousehold")}
      </p>
      {ready && userIds && (
        <CheckGroup
          legend={t("accounts.share.people")}
          options={people.map((p) => ({ id: p.id, label: p.username }))}
          value={userIds}
          onChange={setUserIds}
          empty={t("accounts.share.noPeople")}
        />
      )}
      {ready && (
        <CheckGroup
          legend={t("accounts.share.groups")}
          hint={t("accounts.share.groupsHint")}
          options={groups.map((g) => ({ id: g.id, label: g.name }))}
          value={groupIds}
          onChange={setGroupIds}
          empty={t("users.noGroupsYet")}
        />
      )}
    </FormDialog>
  );
}

function BalanceDialog({
  account,
  entries,
  onClose,
  onSaved,
}: {
  account: AccountSummary;
  entries: BalanceEntry[] | undefined;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [date, setDate] = useState(isoDate(new Date()));
  const [amount, setAmount] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ date: string; amount: string }>();
  const save = useAction(recordBalanceFn);
  const remove = useAction(deleteBalanceEntryFn);
  const { t, f } = useI18n();

  async function submit() {
    const cents = parseAmount(amount);
    if (
      !check({
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : t("accounts.bookkeeping.dateRequired"),
        amount: cents === null ? t("accounts.bookkeeping.amountInvalid") : undefined,
      })
    )
      return;
    const result = await save.run({ data: { accountId: account.id, date, balanceCents: cents ?? 0 } });
    if (!result.ok) return;
    onSaved(t("accounts.bookkeeping.balanceSaved", { name: account.name }));
    onClose();
  }

  return (
    <FormDialog
      title={t("accounts.bookkeeping.balanceTitle", { name: account.name })}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={save.busy} label={t("common.save")} onClose={onClose} />}
    >
      {(save.error || remove.error) && <Banner tone="danger">{save.error ?? remove.error}</Banner>}
      <p className="muted">{t("accounts.bookkeeping.balanceIntro")}</p>
      <div className="form-grid">
        <Field label={t("accounts.bookkeeping.date")} error={errors.date}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                clear("date");
              }}
            />
          )}
        </Field>
        <Field label={t("accounts.bookkeeping.balance")} hint={t("accounts.bookkeeping.amountHint")} error={errors.amount}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              className="num"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                clear("amount");
              }}
            />
          )}
        </Field>
      </div>
      {entries && entries.length > 0 && (
        <section aria-label={t("accounts.bookkeeping.entries")}>
          <h3 className="small">{t("accounts.bookkeeping.entries")}</h3>
          <ul className="list">
            {entries.slice(0, 8).map((entry) => (
              <li key={entry.id} className="list-row">
                <span className="list-main">
                  <span className="list-title">{f.date(entry.date)}</span>
                </span>
                <span className="num">
                  <Balance cents={entry.balanceCents} />
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={remove.busy}
                  onClick={() => remove.run({ data: { accountId: account.id, id: entry.id } })}
                >
                  {t("common.delete")}
                  <span className="visually-hidden">: {f.date(entry.date)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </FormDialog>
  );
}

function BookingDialog({ account, onClose, onSaved }: { account: AccountSummary; onClose: () => void; onSaved: (text: string) => void }) {
  const [date, setDate] = useState(isoDate(new Date()));
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [purpose, setPurpose] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ date: string; amount: string }>();
  const save = useAction(addManualBookingFn);
  const t = useT();

  async function submit() {
    const cents = parseAmount(amount);
    if (
      !check({
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : t("accounts.bookkeeping.dateRequired"),
        amount: cents === null || cents === 0 ? t("accounts.bookkeeping.amountInvalid") : undefined,
      })
    )
      return;
    const value = Math.abs(cents ?? 0) * (direction === "out" ? -1 : 1);
    const result = await save.run({
      data: { accountId: account.id, bookingDate: date, amountCents: value, counterparty: payee.trim(), purpose: purpose.trim() },
    });
    if (!result.ok) return;
    onSaved(t("accounts.bookkeeping.bookingSaved", { name: account.name }));
    onClose();
  }

  return (
    <FormDialog
      title={t("accounts.bookkeeping.bookingTitle", { name: account.name })}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={save.busy} label={t("accounts.bookkeeping.bookingSubmit")} onClose={onClose} />}
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <div className="form-grid">
        <Field label={t("accounts.bookkeeping.date")} error={errors.date}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                clear("date");
              }}
            />
          )}
        </Field>
        <Field label={t("accounts.bookkeeping.direction")}>
          {(control) => (
            <select {...control} value={direction} onChange={(event) => setDirection(event.target.value as "out" | "in")}>
              <option value="out">{t("accounts.bookkeeping.out")}</option>
              <option value="in">{t("accounts.bookkeeping.in")}</option>
            </select>
          )}
        </Field>
        <Field label={t("accounts.bookkeeping.amount")} hint={t("accounts.bookkeeping.amountHint")} error={errors.amount}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              className="num"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                clear("amount");
              }}
            />
          )}
        </Field>
        <Field label={t("accounts.bookkeeping.payee")}>
          {(control) => <input {...control} value={payee} maxLength={200} onChange={(event) => setPayee(event.target.value)} />}
        </Field>
      </div>
      <Field label={t("accounts.bookkeeping.purpose")}>
        {(control) => <input {...control} value={purpose} maxLength={1000} onChange={(event) => setPurpose(event.target.value)} />}
      </Field>
    </FormDialog>
  );
}

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const PREVIEW_ROWS = 5;

/** German banks still export Windows-1252; a file that is not valid UTF-8 is read that way. */
async function readText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

type CsvResult = { rows: number; imported: number; duplicates: number; invalid: number; invalidLines: number[] };

function CsvImportDialog({ account, onClose, onSaved }: { account: AccountSummary; onClose: () => void; onSaved: (text: string) => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { t, f } = useI18n();
  const previewId = useId();
  const form = useRef<HTMLFormElement>(null);

  const header = useMemo(() => (content && mapping ? (parseCsv(content, mapping.delimiter)[0] ?? []) : []), [content, mapping]);
  const preview = useMemo(() => (content && mapping ? readCsvBookings(content, mapping) : null), [content, mapping]);
  const columns = header.map((name, i) => ({
    value: i,
    label: mapping?.hasHeader && name.trim() ? name.trim() : t("accounts.csv.column", { n: i + 1 }),
  }));

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setContent(null);
    setMapping(null);
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) return setFileError(t("accounts.errors.csvTooLarge"));
    const text = await readText(file);
    setContent(text);
    setMapping(guessMapping(text));
  }

  function applyPreset(preset: CsvPreset) {
    if (content) setMapping({ ...guessMapping(content), ...CSV_PRESETS[preset] });
  }

  async function submit() {
    if (!content || !mapping) {
      setFileError(t("accounts.csv.fileRequired"));
      focusFirstInvalid(form);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/accounts/${account.id}/import.csv?${new URLSearchParams({ mapping: JSON.stringify(mapping) })}`, {
        method: "POST",
        headers: { "Content-Type": "text/csv; charset=utf-8" },
        body: content,
      });
      const body = (await response.json()) as CsvResult | { error: string };
      if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : t("common.genericError"));
      await router.invalidate();
      onSaved(t("accounts.csv.done", { imported: body.imported, duplicates: body.duplicates, invalid: body.invalid }));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const column = (key: "date" | "amount" | "payee" | "purpose", optional: boolean) => (
    <Field label={t(`accounts.csv.fields.${key}`)}>
      {(control) => (
        <select
          {...control}
          value={mapping?.[key] ?? ""}
          onChange={(event) => mapping && setMapping({ ...mapping, [key]: event.target.value === "" ? null : Number(event.target.value) })}
        >
          {optional && <option value="">{t("common.none")}</option>}
          {columns.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <FormDialog
      title={t("accounts.csv.title", { name: account.name })}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={<Footer busy={busy} label={t("accounts.csv.submit")} onClose={onClose} />}
    >
      {error && <Banner tone="danger">{error}</Banner>}
      <p className="muted">{t("accounts.csv.intro")}</p>
      <Field label={t("accounts.csv.file")} hint={t("accounts.csv.fileHint")} error={fileError ?? undefined}>
        {(control) => <input {...control} type="file" accept=".csv,text/csv,text/plain" onChange={choose} />}
      </Field>
      {mapping && content && (
        <>
          <div className="form-grid">
            <Field label={t("accounts.csv.preset")}>
              {(control) => (
                <select
                  {...control}
                  value={
                    mapping.decimal === "comma" && mapping.dateFormat === "dmy"
                      ? "de"
                      : mapping.decimal === "point" && mapping.dateFormat === "ymd"
                        ? "intl"
                        : ""
                  }
                  onChange={(event) => event.target.value && applyPreset(event.target.value as CsvPreset)}
                >
                  <option value="">{t("accounts.csv.presets.custom")}</option>
                  <option value="de">{t("accounts.csv.presets.de")}</option>
                  <option value="intl">{t("accounts.csv.presets.intl")}</option>
                </select>
              )}
            </Field>
            <Field label={t("accounts.csv.delimiter")}>
              {(control) => (
                <select
                  {...control}
                  value={mapping.delimiter}
                  onChange={(event) => setMapping({ ...mapping, delimiter: event.target.value as CsvMapping["delimiter"] })}
                >
                  <option value=";">{t("accounts.csv.delimiters.semicolon")}</option>
                  <option value=",">{t("accounts.csv.delimiters.comma")}</option>
                  <option value={"\t"}>{t("accounts.csv.delimiters.tab")}</option>
                </select>
              )}
            </Field>
            <Field label={t("accounts.csv.decimal")}>
              {(control) => (
                <select
                  {...control}
                  value={mapping.decimal}
                  onChange={(event) => setMapping({ ...mapping, decimal: event.target.value as CsvMapping["decimal"] })}
                >
                  <option value="comma">{t("accounts.csv.decimals.comma")}</option>
                  <option value="point">{t("accounts.csv.decimals.point")}</option>
                </select>
              )}
            </Field>
            <Field label={t("accounts.csv.dateFormat")}>
              {(control) => (
                <select
                  {...control}
                  value={mapping.dateFormat}
                  onChange={(event) => setMapping({ ...mapping, dateFormat: event.target.value as CsvMapping["dateFormat"] })}
                >
                  <option value="dmy">{t("accounts.csv.dateFormats.dmy")}</option>
                  <option value="ymd">{t("accounts.csv.dateFormats.ymd")}</option>
                </select>
              )}
            </Field>
            {column("date", false)}
            {column("amount", false)}
            {column("payee", true)}
            {column("purpose", true)}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={mapping.hasHeader}
              onChange={(event) => setMapping({ ...mapping, hasHeader: event.target.checked })}
            />
            {t("accounts.csv.hasHeader")}
          </label>
          {preview && (
            <section aria-labelledby={previewId}>
              <h3 id={previewId} className="small">
                {t("accounts.csv.preview", { count: preview.bookings.length })}
              </h3>
              {preview.errors.length > 0 && (
                <p className="muted small">
                  {t("accounts.csv.invalidRows", {
                    count: preview.errors.length,
                    lines: preview.errors
                      .slice(0, 5)
                      .map((e) => e.line)
                      .join(", "),
                  })}
                </p>
              )}
              <div className="csv-preview">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("accounts.csv.fields.date")}</th>
                      <th scope="col">{t("accounts.csv.fields.payee")}</th>
                      <th scope="col">{t("accounts.csv.fields.purpose")}</th>
                      <th scope="col" className="num">
                        {t("accounts.csv.fields.amount")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.bookings.slice(0, PREVIEW_ROWS).map((b) => (
                      <tr key={b.line}>
                        <td>{f.date(b.bookingDate)}</td>
                        <td>{b.counterparty}</td>
                        <td>{b.purpose}</td>
                        <td className="num">
                          <Money>{f.euro(b.amountCents)}</Money>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </FormDialog>
  );
}

type ConnectionDialog = "access" | "disconnect";

/** Connection actions for the superuser's overview; the same jobs and dialogs as the account menu. */
export function ConnectionMenu({ connection, onNotice }: { connection: Connection; onNotice: (notice: Notice) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<ConnectionDialog | null>(null);
  const { track, syncConnection, fetching } = useBankJobs();
  const discover = useAction(discoverBankConnectionFn);
  const authorize = useAction(authorizeBankConnectionFn, { invalidate: false });
  const accounts = connection.linkedAccounts.map((a) => a.name).join(", ");
  const skipItem = useSkipSyncAllItem(connection, onNotice);

  async function check() {
    const result = await discover.run({ data: { id: connection.id } });
    if (result.ok) track([{ job: result.value, label: connection.name }]);
    else onNotice({ tone: "danger", text: result.error });
  }

  async function sync() {
    const error = await syncConnection(connection.id, connection.name);
    if (error) onNotice({ tone: "danger", text: error });
  }

  async function renew() {
    const result = await authorize.run({ data: { id: connection.id } });
    if (result.ok) window.location.assign(result.value.url);
    else onNotice({ tone: "danger", text: result.error });
  }

  const close = () => setOpen(null);
  const saved = (text: string) => onNotice({ tone: "ok", text });
  const items = [
    connection.status !== "new" &&
      connection.linkedAccounts.length > 0 && { label: t("accounts.actions.sync"), disabled: fetching.has(connection.id), onSelect: sync },
    connection.provider === "enable_banking"
      ? { label: t("accounts.actions.renew"), disabled: authorize.busy, onSelect: renew }
      : { label: t("accounts.actions.check"), disabled: discover.busy, onSelect: check },
    skipItem,
    connection.provider !== "enable_banking" && { label: t("accounts.actions.access"), onSelect: () => setOpen("access") },
    { label: t("accounts.actions.disconnect"), danger: true, onSelect: () => setOpen("disconnect") },
  ];

  return (
    <>
      <ActionMenu name={connection.name} items={items} />
      {open === "access" && <EditConnectionDialog connection={connection} onClose={close} onSaved={saved} />}
      {open === "disconnect" && (
        <DisconnectDialog
          subject={accounts || connection.name}
          connection={connection}
          also={null}
          onClose={close}
          onDone={(text) => onNotice({ tone: "ok", text })}
        />
      )}
    </>
  );
}

/** Removes the connection for all its accounts; they stay as accounts without a bank connection, or go with it. */
function DisconnectDialog({
  subject,
  connection,
  also,
  onClose,
  onDone,
}: {
  subject: string;
  connection: Connection;
  also: string | null;
  onClose: () => void;
  onDone: (text: string, kept: boolean) => void;
}) {
  const [keep, setKeep] = useState(true);
  const remove = useAction(deleteBankConnectionFn);
  const t = useT();
  const name = useId();

  async function submit() {
    const result = await remove.run({ data: { id: connection.id, keepAccounts: keep } });
    if (!result.ok) return;
    onClose();
    onDone(t("accounts.disconnect.done", { name: connection.name }), keep);
  }

  return (
    <FormDialog
      title={t("accounts.disconnect.title", { name: connection.name })}
      onClose={onClose}
      onSubmit={submit}
      footer={<Footer busy={remove.busy} label={t("accounts.disconnect.submit")} onClose={onClose} />}
    >
      {remove.error && <Banner tone="danger">{remove.error}</Banner>}
      <p>{t("accounts.disconnect.text", { account: subject })}</p>
      {also && <p className="muted">{also}</p>}
      <fieldset className="field">
        <legend>{t("accounts.disconnect.question")}</legend>
        <div className="checks">
          <label className="checkbox">
            <input type="radio" name={name} checked={keep} onChange={() => setKeep(true)} />
            {t("accounts.disconnect.keep")}
          </label>
          <label className="checkbox">
            <input type="radio" name={name} checked={!keep} onChange={() => setKeep(false)} />
            {t("accounts.disconnect.remove")}
          </label>
        </div>
      </fieldset>
    </FormDialog>
  );
}
