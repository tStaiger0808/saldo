import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ActionMenu } from "../../../components/ActionMenu.tsx";
import { TableWrap } from "../../../components/Bits.tsx";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { CheckGroup, Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner, Status, type StatusTone, Tag } from "../../../components/Status.tsx";
import { useTasks } from "../../../components/Tasks.tsx";
import { INTL_LOCALES } from "../../../i18n/index.ts";
import { useI18n } from "../../../i18n/react.tsx";
import { errorMessage, useAction, useNotice } from "../../../lib/action.ts";
import {
  BACKUP_FREQUENCIES,
  BACKUP_TARGET_TYPES,
  type BackupFrequency,
  type BackupTargetConfig,
  type BackupTargetType,
  DEFAULT_KEEP,
  DEFAULT_PORTS,
  FTP_TLS_MODES,
  MAX_KEEP,
  MAX_UPLOAD_BYTES,
  MIN_PASSPHRASE,
  passphraseStrength,
  type SecretField,
  SFTP_AUTH,
  WEBDAV_VENDORS,
} from "../../../lib/backup.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { requireSection } from "../../../lib/settings.ts";
import {
  cancelRestoreFn,
  confirmRestoreFn,
  deleteBackupTargetFn,
  getBackupArchivesFn,
  getBackupOverviewFn,
  prepareRestoreFn,
  saveBackupScheduleFn,
  saveBackupTargetFn,
  setBackupPassphraseFn,
  startBackupFn,
  testBackupTargetFn,
} from "../../../server/functions/backup.ts";
import { getTasksFn } from "../../../server/functions/tasks.ts";

export const Route = createFileRoute("/_app/einstellungen/sicherung")({
  beforeLoad: requireSection("sicherung"),
  loader: () => getBackupOverviewFn(),
  component: BackupSection,
});

type Overview = Awaited<ReturnType<typeof getBackupOverviewFn>>;
type TargetView = Overview["targets"][number];
type RunView = Overview["runs"][number];
type Archive = Awaited<ReturnType<typeof getBackupArchivesFn>>[number];
type Preview = Awaited<ReturnType<typeof prepareRestoreFn>>;
type RestoreSource = { kind: "target"; targetId: number; name: string } | { kind: "upload"; uploadId: string; name: string };
type Notify = (tone: "ok" | "danger" | "info" | "warn", text: string) => void;

function BackupSection() {
  const overview = Route.useLoaderData();
  const { t } = useI18n();
  const { notice, setNotice, clear } = useNotice();
  const [source, setSource] = useState<RestoreSource | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const notify: Notify = (tone, text) => setNotice({ tone, text });
  const missing = [
    !overview.tools.rclone && "rclone",
    !overview.tools.pgDump && "pg_dump",
    !overview.tools.pgRestore && "pg_restore",
  ].filter(Boolean);

  return (
    <div className="stack">
      <section className="card" aria-labelledby="backup-title">
        <h2 id="backup-title">{t("sections.settings.sicherung.label")}</h2>
        <p className="muted measure">{t("backup.intro")}</p>
        {missing.length > 0 && <Banner tone="warn">{t("backup.toolsMissing", { tools: missing.join(", ") })}</Banner>}
        {overview.busy && <Banner tone="info">{t(`backup.busy.${overview.busy}`)}</Banner>}
      </section>
      <NoticeBanner notice={notice} onClose={clear} />
      <PassphraseCard overview={overview} notify={notify} />
      <TargetsCard overview={overview} notify={notify} />
      <ScheduleCard overview={overview} notify={notify} />
      <HistoryCard runs={overview.runs} />
      <ArchivesCard targets={overview.targets} onRestore={setSource} />
      <RestoreCard
        restoring={restoring}
        preview={preview}
        onSource={setSource}
        onDiscard={() => setPreview(null)}
        onStarted={(taskId) => {
          setPreview(null);
          setRestoring(taskId);
        }}
        notify={notify}
      />
      {source && (
        <CheckArchiveDialog
          source={source}
          onClose={() => setSource(null)}
          onChecked={(value) => {
            setSource(null);
            setPreview(value);
            requestAnimationFrame(() => document.getElementById("restore-preview")?.focus());
          }}
        />
      )}
    </div>
  );
}

// ---- passphrase

const STRENGTH = ["tooShort", "weak", "fair", "good", "strong"] as const;

function PassphraseCard({ overview, notify }: { overview: Overview; notify: Notify }) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState(false);
  const { set, changedAt } = overview.passphrase;
  return (
    <section className="card" aria-labelledby="passphrase-title">
      <div className="card-head">
        <h2 id="passphrase-title">{t("backup.passphrase.title")}</h2>
        <div className="actions">
          <button type="button" className={set ? "btn" : "btn btn-primary"} onClick={() => setOpen(true)}>
            <Icon name="key" size={18} /> {set ? t("backup.passphrase.change") : t("backup.passphrase.define")}
          </button>
        </div>
      </div>
      <p>
        {set ? (
          <Status tone="ok">
            {changedAt ? t("backup.passphrase.setOn", { date: f.dateTime(changedAt) }) : t("backup.passphrase.set")}
          </Status>
        ) : (
          <Status tone="warn" emphasis="notice">
            {t("backup.passphrase.missing")}
          </Status>
        )}
      </p>
      <Banner tone="warn" live={false}>
        {t("backup.passphrase.warning")}
      </Banner>
      {open && (
        <PassphraseDialog
          changing={set}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            notify("ok", t("backup.passphrase.saved"));
          }}
        />
      )}
    </section>
  );
}

function PassphraseDialog({ changing, onClose, onSaved }: { changing: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ passphrase: string; confirmation: string }>();
  const save = useAction(setBackupPassphraseFn);
  const strength = passphraseStrength(passphrase);
  const strengthId = useId();

  async function submit() {
    if (
      !check({
        passphrase: [...passphrase].length < MIN_PASSPHRASE ? t("backup.passphrase.tooShort", { min: MIN_PASSPHRASE }) : undefined,
        confirmation: confirmation !== passphrase ? t("backup.passphrase.mismatch") : undefined,
      })
    )
      return;
    const result = await save.run({ data: { passphrase, confirmation } });
    if (result.ok) onSaved();
  }

  return (
    <FormDialog
      title={t("backup.passphrase.dialogTitle")}
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
      <Banner tone="warn" live={false}>
        {t("backup.passphrase.warning")}
      </Banner>
      {changing && <p className="muted small">{t("backup.passphrase.changeNote")}</p>}
      <Field label={t("backup.passphrase.field")} hint={t("backup.passphrase.hint", { min: MIN_PASSPHRASE })} error={errors.passphrase}>
        {(control) => (
          <input
            {...control}
            aria-describedby={[control["aria-describedby"], strengthId].filter(Boolean).join(" ")}
            type="password"
            value={passphrase}
            autoComplete="new-password"
            maxLength={1024}
            onChange={(event) => {
              setPassphrase(event.target.value);
              clear("passphrase");
            }}
          />
        )}
      </Field>
      <div className="passphrase-strength">
        <meter min={0} max={4} low={2} high={3} optimum={4} value={strength} aria-labelledby={strengthId} />
        <span id={strengthId} className="field-hint">
          {t("backup.passphrase.strength", { level: t(`backup.passphrase.levels.${STRENGTH[strength]}`) })}
        </span>
      </div>
      <Field label={t("backup.passphrase.confirm")} error={errors.confirmation}>
        {(control) => (
          <input
            {...control}
            type="password"
            value={confirmation}
            autoComplete="new-password"
            maxLength={1024}
            onChange={(event) => {
              setConfirmation(event.target.value);
              clear("confirmation");
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}

// ---- targets

function targetSummary(target: TargetView, backupDir: string, t: ReturnType<typeof useI18n>["t"]): string {
  const c = target.config;
  const path = (p: string) => (p ? `/${p.replace(/^\/+/, "")}` : "");
  switch (c.type) {
    case "local":
      return t("backup.targets.localSummary", { folder: `${backupDir.replace(/\/$/, "")}${path(c.path)}` });
    case "sftp":
    case "ftp":
      return `${c.username}@${c.host}:${c.port}${path(c.path)}`;
    case "smb":
      return `${c.username}@${c.host}:${c.port}/${c.share}${path(c.path)}`;
    case "b2":
      return `${c.bucket}${path(c.path)}`;
    case "s3":
      return `${c.endpoint} · ${c.bucket}${path(c.path)}`;
    case "webdav":
      return `${c.url}${path(c.path)}`;
  }
}

function TargetsCard({ overview, notify }: { overview: Overview; notify: Notify }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<TargetView | "new" | null>(null);
  const [deleting, setDeleting] = useState<TargetView | null>(null);
  const test = useAction(testBackupTargetFn, { invalidate: false });
  const remove = useAction(deleteBackupTargetFn);

  async function runTest(target: TargetView) {
    const result = await test.run({ data: { id: target.id } });
    if (result.ok) notify(result.value.ok ? "ok" : "danger", result.value.message);
    else notify("danger", result.error);
  }

  async function destroy(target: TargetView) {
    const result = await remove.run({ data: { id: target.id } });
    notify(result.ok ? "ok" : "danger", result.ok ? t("backup.targets.deleted", { name: target.name }) : result.error);
  }

  return (
    <section className="card" aria-labelledby="targets-title">
      <div className="card-head">
        <h2 id="targets-title">{t("backup.targets.title")}</h2>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={18} /> <span className="btn-label">{t("backup.targets.add")}</span>
          </button>
        </div>
      </div>
      <p className="muted measure">{t("backup.targets.intro")}</p>
      {overview.targets.length === 0 ? (
        <p className="empty">{t("backup.targets.empty")}</p>
      ) : (
        <ul className="list">
          {overview.targets.map((target) => (
            <li key={target.id} className="list-row">
              <span className="list-main">
                <span className="list-title">
                  {target.name} <Tag>{t(`backup.types.${target.type}`)}</Tag>
                </span>
                <span className="list-sub">
                  <span className="mono break">{targetSummary(target, overview.backupDir, t)}</span> ·{" "}
                  {t("backup.targets.keeps", { count: target.keep })}
                </span>
              </span>
              <span className="actions list-actions">
                <button type="button" className="btn btn-sm" disabled={test.busy} aria-busy={test.busy} onClick={() => runTest(target)}>
                  {t("backup.targets.test")}
                  <span className="visually-hidden">: {target.name}</span>
                </button>
                <ActionMenu
                  name={target.name}
                  items={[
                    { label: t("common.edit"), onSelect: () => setEditing(target) },
                    { label: t("common.delete"), danger: true, onSelect: () => setDeleting(target) },
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <TargetDialog
          target={editing === "new" ? null : editing}
          backupDir={overview.backupDir}
          onClose={() => setEditing(null)}
          onSaved={(tone, text) => {
            setEditing(null);
            notify(tone, text);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("backup.targets.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("backup.targets.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("backup.targets.deleteText")}</p>
      </ConfirmDialog>
    </section>
  );
}

type Draft = {
  type: BackupTargetType;
  name: string;
  keep: string;
  path: string;
  host: string;
  port: string;
  username: string;
  auth: (typeof SFTP_AUTH)[number];
  knownHosts: string;
  tls: (typeof FTP_TLS_MODES)[number];
  skipVerify: boolean;
  domain: string;
  share: string;
  accountId: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  pathStyle: boolean;
  url: string;
  vendor: (typeof WEBDAV_VENDORS)[number];
  secrets: Record<SecretField, string>;
};

const NO_SECRETS: Record<SecretField, string> = {
  password: "",
  privateKey: "",
  privateKeyPassphrase: "",
  applicationKey: "",
  secretAccessKey: "",
};

function draftOf(target: TargetView | null): Draft {
  const c = (target?.config ?? { type: "local", path: "" }) as Partial<Record<string, unknown>> & BackupTargetConfig;
  const text = (key: string, fallback = "") => (typeof c[key] === "string" ? (c[key] as string) : fallback);
  return {
    type: c.type,
    name: target?.name ?? "",
    keep: String(target?.keep ?? DEFAULT_KEEP),
    path: text("path"),
    host: text("host"),
    port: typeof c.port === "number" ? String(c.port) : String(DEFAULT_PORTS[c.type] ?? ""),
    username: text("username"),
    auth: c.type === "sftp" ? c.auth : "password",
    knownHosts: text("knownHosts"),
    tls: c.type === "ftp" ? c.tls : "explicit",
    skipVerify: c.skipVerify === true,
    domain: text("domain"),
    share: text("share"),
    accountId: text("accountId"),
    bucket: text("bucket"),
    endpoint: text("endpoint"),
    region: text("region"),
    accessKeyId: text("accessKeyId"),
    pathStyle: c.type === "s3" ? c.pathStyle : true,
    url: text("url"),
    vendor: c.type === "webdav" ? c.vendor : "nextcloud",
    secrets: { ...NO_SECRETS },
  };
}

function configOf(d: Draft): BackupTargetConfig {
  const port = Number(d.port);
  const path = d.path.trim();
  switch (d.type) {
    case "local":
      return { type: "local", path };
    case "sftp":
      return { type: "sftp", host: d.host.trim(), port, username: d.username.trim(), auth: d.auth, path, knownHosts: d.knownHosts };
    case "ftp":
      return { type: "ftp", host: d.host.trim(), port, username: d.username.trim(), tls: d.tls, skipVerify: d.skipVerify, path };
    case "smb":
      return { type: "smb", host: d.host.trim(), port, username: d.username.trim(), domain: d.domain.trim(), share: d.share.trim(), path };
    case "b2":
      return { type: "b2", accountId: d.accountId.trim(), bucket: d.bucket.trim(), path };
    case "s3":
      return {
        type: "s3",
        endpoint: d.endpoint.trim(),
        region: d.region.trim(),
        accessKeyId: d.accessKeyId.trim(),
        bucket: d.bucket.trim(),
        path,
        pathStyle: d.pathStyle,
      };
    case "webdav":
      return { type: "webdav", url: d.url.trim(), vendor: d.vendor, username: d.username.trim(), skipVerify: d.skipVerify, path };
  }
}

type DraftErrors = Partial<
  Record<"name" | "keep" | "host" | "port" | "username" | "share" | "bucket" | "accountId" | "endpoint" | "accessKeyId" | "url", string>
>;

const NETWORK = new Set<BackupTargetType>(["sftp", "ftp", "smb"]);

type FieldLabel =
  | "type"
  | "host"
  | "port"
  | "username"
  | "password"
  | "auth"
  | "privateKey"
  | "privateKeyHint"
  | "privateKeyPassphrase"
  | "privateKeyPassphraseHint"
  | "knownHosts"
  | "knownHostsHint"
  | "path"
  | "pathHint"
  | "localPath"
  | "tls"
  | "skipVerify"
  | "domain"
  | "domainHint"
  | "share"
  | "accountId"
  | "applicationKey"
  | "bucket"
  | "endpoint"
  | "endpointHint"
  | "region"
  | "accessKeyId"
  | "secretAccessKey"
  | "pathStyle"
  | "url"
  | "urlHint"
  | "vendor"
  | "keep"
  | "keepHint";

function TargetDialog({
  target,
  backupDir,
  onClose,
  onSaved,
}: {
  target: TargetView | null;
  backupDir: string;
  onClose: () => void;
  onSaved: (tone: "ok" | "danger", text: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftOf(target));
  const { form, errors, check, clear } = useFormErrors<DraftErrors>();
  const save = useAction(saveBackupTargetFn);
  const stored = new Set(target && target.type === draft.type ? target.secretsSet : []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clear(key as keyof DraftErrors);
  };
  const setSecret = (key: SecretField, value: string) =>
    setDraft((current) => ({ ...current, secrets: { ...current.secrets, [key]: value } }));

  function chooseType(type: BackupTargetType) {
    setDraft((current) => ({ ...current, type, port: String(DEFAULT_PORTS[type] ?? current.port) }));
  }

  async function submit() {
    const required = t("backup.targets.required");
    const keep = Number(draft.keep);
    const port = Number(draft.port);
    const needs = (types: BackupTargetType[], value: string) => (types.includes(draft.type) && !value.trim() ? required : undefined);
    if (
      !check({
        name: draft.name.trim() ? undefined : t("backup.targets.nameRequired"),
        keep: Number.isInteger(keep) && keep >= 1 && keep <= MAX_KEEP ? undefined : t("backup.targets.keepInvalid", { max: MAX_KEEP }),
        host: needs(["sftp", "ftp", "smb"], draft.host),
        port:
          NETWORK.has(draft.type) && !(Number.isInteger(port) && port >= 1 && port <= 65535) ? t("backup.targets.portInvalid") : undefined,
        username: needs(["sftp", "ftp", "smb"], draft.username),
        share: needs(["smb"], draft.share),
        bucket: needs(["b2", "s3"], draft.bucket),
        accountId: needs(["b2"], draft.accountId),
        endpoint: needs(["s3"], draft.endpoint),
        accessKeyId: needs(["s3"], draft.accessKeyId),
        url: needs(["webdav"], draft.url),
      })
    )
      return;
    const secrets = Object.fromEntries(Object.entries(draft.secrets).filter(([, value]) => value));
    const result = await save.run({
      data: { id: target?.id, name: draft.name.trim(), keep, config: configOf(draft), secrets },
    });
    if (!result.ok) return;
    const { test } = result.value;
    onSaved(test.ok ? "ok" : "danger", t("backup.targets.saved", { name: draft.name.trim(), test: test.message }));
  }

  const text = (key: keyof DraftErrors | "path" | "region" | "domain", label: string, options: { hint?: string; mono?: boolean } = {}) => (
    <Field label={label} hint={options.hint} error={errors[key as keyof DraftErrors]}>
      {(control) => (
        <input
          {...control}
          className={options.mono ? "mono" : undefined}
          value={draft[key] as string}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </Field>
  );

  const secret = (key: SecretField, label: string, options: { hint?: string; multiline?: boolean } = {}) => (
    <Field
      label={label}
      hint={[options.hint, stored.has(key) ? t("backup.targets.fields.secretStored") : t("backup.targets.fields.secretEncrypted")]
        .filter(Boolean)
        .join(" ")}
    >
      {(control) =>
        options.multiline ? (
          <textarea
            {...control}
            className="mono"
            rows={4}
            value={draft.secrets[key]}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSecret(key, event.target.value)}
          />
        ) : (
          <input
            {...control}
            type="password"
            value={draft.secrets[key]}
            autoComplete="new-password"
            onChange={(event) => setSecret(key, event.target.value)}
          />
        )
      }
    </Field>
  );

  const checkbox = (key: "skipVerify" | "pathStyle", label: string) => (
    <label className="checkbox">
      <input type="checkbox" checked={draft[key]} onChange={(event) => set(key, event.target.checked)} />
      {label}
    </label>
  );

  const f = (key: FieldLabel) => t(`backup.targets.fields.${key}`);

  return (
    <FormDialog
      title={target ? t("backup.targets.editTitle") : t("backup.targets.addTitle")}
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
            {t("backup.targets.saveAndTest")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <div className="form-grid">
        <Field label={f("type")}>
          {(control) => (
            <select {...control} value={draft.type} onChange={(event) => chooseType(event.target.value as BackupTargetType)}>
              {BACKUP_TARGET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`backup.types.${type}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("common.fields.name")} error={errors.name}>
          {(control) => <input {...control} value={draft.name} maxLength={64} onChange={(event) => set("name", event.target.value)} />}
        </Field>
      </div>
      {NETWORK.has(draft.type) && (
        <div className="form-grid">
          {text("host", f("host"), { mono: true })}
          <Field label={f("port")} error={errors.port}>
            {(control) => (
              <input {...control} inputMode="numeric" value={draft.port} onChange={(event) => set("port", event.target.value)} />
            )}
          </Field>
          {text("username", f("username"))}
          {draft.type === "smb" && text("domain", f("domain"), { hint: f("domainHint") })}
        </div>
      )}
      {draft.type === "sftp" && (
        <>
          <Field label={f("auth")}>
            {(control) => (
              <select {...control} value={draft.auth} onChange={(event) => set("auth", event.target.value as Draft["auth"])}>
                {SFTP_AUTH.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`backup.targets.fields.authModes.${mode}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {draft.auth === "password" ? (
            secret("password", f("password"))
          ) : (
            <>
              {secret("privateKey", f("privateKey"), { hint: f("privateKeyHint"), multiline: true })}
              {secret("privateKeyPassphrase", f("privateKeyPassphrase"), { hint: f("privateKeyPassphraseHint") })}
            </>
          )}
          <Field label={f("knownHosts")} hint={f("knownHostsHint")}>
            {(control) => (
              <textarea
                {...control}
                className="mono"
                rows={3}
                value={draft.knownHosts}
                spellCheck={false}
                onChange={(event) => set("knownHosts", event.target.value)}
              />
            )}
          </Field>
        </>
      )}
      {draft.type === "ftp" && (
        <>
          {secret("password", f("password"))}
          <Field label={f("tls")}>
            {(control) => (
              <select {...control} value={draft.tls} onChange={(event) => set("tls", event.target.value as Draft["tls"])}>
                {FTP_TLS_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`backup.targets.fields.tlsModes.${mode}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {draft.tls !== "none" && checkbox("skipVerify", f("skipVerify"))}
        </>
      )}
      {draft.type === "smb" && (
        <>
          {secret("password", f("password"))}
          {text("share", f("share"))}
        </>
      )}
      {draft.type === "b2" && (
        <div className="form-grid">
          {text("accountId", f("accountId"), { mono: true })}
          {secret("applicationKey", f("applicationKey"))}
          {text("bucket", f("bucket"), { mono: true })}
        </div>
      )}
      {draft.type === "s3" && (
        <>
          {text("endpoint", f("endpoint"), { hint: f("endpointHint"), mono: true })}
          <div className="form-grid">
            {text("region", f("region"))}
            {text("bucket", f("bucket"), { mono: true })}
            {text("accessKeyId", f("accessKeyId"), { mono: true })}
            {secret("secretAccessKey", f("secretAccessKey"))}
          </div>
          {checkbox("pathStyle", f("pathStyle"))}
        </>
      )}
      {draft.type === "webdav" && (
        <>
          {text("url", f("url"), { hint: f("urlHint"), mono: true })}
          <div className="form-grid">
            <Field label={f("vendor")}>
              {(control) => (
                <select {...control} value={draft.vendor} onChange={(event) => set("vendor", event.target.value as Draft["vendor"])}>
                  {WEBDAV_VENDORS.map((vendor) => (
                    <option key={vendor} value={vendor}>
                      {t(`backup.targets.fields.vendors.${vendor === "other" ? "generic" : vendor}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {text("username", f("username"))}
          </div>
          {secret("password", f("password"))}
          {checkbox("skipVerify", f("skipVerify"))}
        </>
      )}
      <div className="form-grid">
        {draft.type === "local"
          ? text("path", f("localPath"), { hint: t("backup.targets.fields.localPathHint", { folder: backupDir }), mono: true })
          : text("path", f("path"), { hint: f("pathHint"), mono: true })}
        <Field label={f("keep")} hint={f("keepHint")} error={errors.keep}>
          {(control) => <input {...control} inputMode="numeric" value={draft.keep} onChange={(event) => set("keep", event.target.value)} />}
        </Field>
      </div>
    </FormDialog>
  );
}

// ---- schedule

function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  return [1, 2, 3, 4, 5, 6, 7].map((day) => format.format(new Date(Date.UTC(2024, 0, day))));
}

function inZone(value: string, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
  }
}

function ScheduleCard({ overview, notify }: { overview: Overview; notify: Notify }) {
  const { t, locale } = useI18n();
  const tag = INTL_LOCALES[locale];
  const stored = overview.schedule;
  const [frequency, setFrequency] = useState<BackupFrequency>(stored.frequency);
  const [weekday, setWeekday] = useState(stored.weekday);
  const [monthDay, setMonthDay] = useState<number | "last">(stored.monthDay);
  const [time, setTime] = useState(stored.time);
  const [targetIds, setTargetIds] = useState<number[]>(stored.targetIds);
  const save = useAction(saveBackupScheduleFn);
  const start = useAction(startBackupFn);
  const { refresh } = useTasks();
  const ready = overview.passphrase.set && stored.targetIds.length > 0 && overview.busy === null;

  useEffect(() => {
    setFrequency(stored.frequency);
    setWeekday(stored.weekday);
    setMonthDay(stored.monthDay);
    setTime(stored.time);
    setTargetIds(stored.targetIds);
  }, [stored]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await save.run({ data: { frequency, weekday, monthDay, time, targetIds } });
    if (result.ok) notify("ok", t("backup.schedule.saved"));
  }

  async function backupNow() {
    const result = await start.run();
    if (!result.ok) return notify("danger", result.error);
    notify("info", t("backup.schedule.started"));
    await refresh();
  }

  return (
    <form className="card" noValidate onSubmit={submit} aria-labelledby="schedule-title">
      <h2 id="schedule-title">{t("backup.schedule.title")}</h2>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <div className="form-grid">
        <Field label={t("backup.schedule.frequency")}>
          {(control) => (
            <select {...control} value={frequency} onChange={(event) => setFrequency(event.target.value as BackupFrequency)}>
              {BACKUP_FREQUENCIES.map((value) => (
                <option key={value} value={value}>
                  {t(`backup.schedule.frequencies.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {frequency === "weekly" && (
          <Field label={t("backup.schedule.weekday")}>
            {(control) => (
              <select {...control} value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                {weekdayNames(tag).map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {frequency === "monthly" && (
          <Field label={t("backup.schedule.monthDay")}>
            {(control) => (
              <select
                {...control}
                value={String(monthDay)}
                onChange={(event) => setMonthDay(event.target.value === "last" ? "last" : Number(event.target.value))}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={day}>
                    {day}.
                  </option>
                ))}
                <option value="last">{t("backup.schedule.lastDay")}</option>
              </select>
            )}
          </Field>
        )}
        {frequency !== "off" && (
          <Field label={t("backup.schedule.time")} hint={t("backup.schedule.timeHint", { zone: overview.timeZone })}>
            {(control) => <input {...control} type="time" step={60} value={time} onChange={(event) => setTime(event.target.value)} />}
          </Field>
        )}
      </div>
      <CheckGroup
        legend={t("backup.schedule.targets")}
        hint={t("backup.schedule.targetsHint")}
        options={overview.targets.map((target) => ({ id: target.id, label: target.name, detail: t(`backup.types.${target.type}`) }))}
        value={targetIds}
        onChange={setTargetIds}
        empty={t("backup.schedule.noTargets")}
        layout="list"
      />
      <p className="muted small" role="status">
        {stored.frequency === "off" || !stored.nextRun
          ? t("backup.schedule.off")
          : t("backup.schedule.next", { at: inZone(stored.nextRun, tag, overview.timeZone) })}
      </p>
      {!overview.passphrase.set && <p className="field-hint">{t("backup.schedule.needsPassphrase")}</p>}
      {overview.passphrase.set && stored.targetIds.length === 0 && <p className="field-hint">{t("backup.schedule.needsTargets")}</p>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
          {t("common.save")}
        </button>
        <button type="button" className="btn" disabled={!ready || start.busy} aria-busy={start.busy} onClick={backupNow}>
          <Icon name="upload" size={18} /> {t("backup.schedule.backupNow")}
        </button>
      </div>
      <p className="muted small measure">{t("backup.schedule.legacy")}</p>
    </form>
  );
}

// ---- history

const RUN_TONES: Record<RunView["status"], StatusTone> = { running: "info", ok: "ok", partial: "warn", failed: "danger" };

function duration(ms: number | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (ms === null) return "–";
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? t("backup.history.seconds", { seconds })
    : t("backup.history.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function HistoryCard({ runs }: { runs: RunView[] }) {
  const { t, f } = useI18n();
  return (
    <section className="card card-flush" aria-labelledby="history-title">
      <div className="card-head">
        <h2 id="history-title">{t("backup.history.title")}</h2>
      </div>
      {runs.length === 0 ? (
        <p className="empty">{t("backup.history.empty")}</p>
      ) : (
        <TableWrap>
          <table className="data-table responsive">
            <caption className="visually-hidden">{t("backup.history.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("backup.history.time")}</th>
                <th scope="col">{t("backup.history.trigger")}</th>
                <th scope="col">{t("backup.history.result")}</th>
                <th scope="col">{t("backup.history.size")}</th>
                <th scope="col">{t("backup.history.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <time dateTime={run.startedAt}>{f.dateTime(run.startedAt)}</time>
                  </td>
                  <td>
                    {t(`backup.history.triggers.${run.trigger}`)}
                    {run.startedBy && <span className="cell-sub"> {t("backup.history.by", { name: run.startedBy })}</span>}
                  </td>
                  <td className="span">
                    <Status tone={RUN_TONES[run.status]}>{t(`backup.history.statuses.${run.status}`)}</Status>
                    {run.error && <span className="cell-sub break"> {run.error}</span>}
                    {run.results.length > 0 && (
                      <ul className="plain-list small">
                        {run.results.map((result) => (
                          <li key={`${result.targetId}-${result.name}`} className="break">
                            {!result.ok
                              ? t("backup.history.targetFailed", { name: result.name, reason: result.error ?? "" })
                              : result.error
                                ? t("backup.history.targetWarning", { name: result.name, reason: result.error })
                                : result.deleted > 0
                                  ? t("backup.history.targetPruned", { name: result.name, count: result.deleted })
                                  : t("backup.history.targetOk", { name: result.name })}
                          </li>
                        ))}
                      </ul>
                    )}
                    {run.fileName && <span className="cell-sub mono break">{run.fileName}</span>}
                  </td>
                  <td>{run.sizeBytes === null ? "–" : f.bytes(run.sizeBytes)}</td>
                  <td>{duration(run.durationMs, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}

// ---- archives

function ArchivesCard({ targets, onRestore }: { targets: TargetView[]; onRestore: (source: RestoreSource) => void }) {
  const { t, f } = useI18n();
  const load = useServerFn(getBackupArchivesFn);
  const [targetId, setTargetId] = useState<number | null>(targets[0]?.id ?? null);
  const [archives, setArchives] = useState<{ targetId: number; items: Archive[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((candidate) => candidate.id === targetId) ?? null;
  const shown = archives && archives.targetId === targetId ? archives.items : null;

  useEffect(() => {
    if (!targets.some((candidate) => candidate.id === targetId)) setTargetId(targets[0]?.id ?? null);
  }, [targets, targetId]);

  async function fetchArchives() {
    if (targetId === null) return;
    setBusy(true);
    setError(null);
    try {
      setArchives({ targetId, items: await load({ data: { targetId } }) });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-flush" aria-labelledby="archives-title">
      <div className="card-head">
        <h2 id="archives-title">{t("backup.archives.title")}</h2>
      </div>
      <div className="card-body stack-sm">
        <p className="muted measure">{t("backup.archives.intro")}</p>
        {targets.length === 0 ? (
          <p className="empty">{t("backup.targets.empty")}</p>
        ) : (
          <div className="row" style={{ alignItems: "flex-end" }}>
            <Field label={t("backup.archives.target")}>
              {(control) => (
                <select {...control} value={targetId ?? ""} onChange={(event) => setTargetId(Number(event.target.value))}>
                  {targets.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button type="button" className="btn" disabled={busy || targetId === null} aria-busy={busy} onClick={fetchArchives}>
              <Icon name="sync" size={18} /> {t("backup.archives.load")}
            </button>
          </div>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {shown && target && (
          <p className="small" role="status">
            {shown.length === 0 ? t("backup.archives.empty") : t("backup.archives.loaded", { count: shown.length, name: target.name })}
          </p>
        )}
      </div>
      {shown && target && shown.length > 0 && (
        <TableWrap>
          <table className="data-table responsive">
            <caption className="visually-hidden">{t("backup.archives.caption", { name: target.name })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("backup.archives.file")}</th>
                <th scope="col">{t("backup.archives.created")}</th>
                <th scope="col">{t("backup.archives.size")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("backup.archives.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((archive) => (
                <tr key={archive.name}>
                  <td className="span">
                    <span className="cell-title mono break">{archive.name}</span>
                    {archive.kind === "safety" && <span className="cell-sub"> {t("backup.archives.safety")}</span>}
                  </td>
                  <td>{archive.createdAt ? <time dateTime={archive.createdAt}>{f.dateTime(archive.createdAt)}</time> : "–"}</td>
                  <td>{f.bytes(archive.sizeBytes)}</td>
                  <td className="row-actions">
                    <span className="actions">
                      <a
                        className="btn btn-sm"
                        href={`/api/backup/download?target=${target.id}&name=${encodeURIComponent(archive.name)}`}
                        download={archive.name}
                      >
                        <Icon name="download" size={16} /> {t("backup.archives.download")}
                        <span className="visually-hidden">: {archive.name}</span>
                      </a>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onRestore({ kind: "target", targetId: target.id, name: archive.name })}
                      >
                        <Icon name="history" size={16} /> {t("backup.archives.restore")}
                        <span className="visually-hidden">: {archive.name}</span>
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}

// ---- restore

/** Uploads with XMLHttpRequest, which (unlike fetch) reports upload progress. */
function uploadArchive(file: File, onProgress: (share: number) => void): Promise<{ uploadId: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/backup/upload?name=${encodeURIComponent(file.name)}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    request.onerror = () => reject(new Error(""));
    request.onload = () => {
      let body: { uploadId?: string; error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // Not JSON: a proxy's error page, reported as a generic failure below.
      }
      if (request.status === 200 && body.uploadId) resolve({ uploadId: body.uploadId });
      else reject(new Error(body.error ?? ""));
    };
    request.send(file);
  });
}

function RestoreCard({
  restoring,
  preview,
  onSource,
  onDiscard,
  onStarted,
  notify,
}: {
  restoring: string | null;
  preview: Preview | null;
  onSource: (source: RestoreSource) => void;
  onDiscard: () => void;
  onStarted: (taskId: string) => void;
  notify: Notify;
}) {
  const { t } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const discard = useAction(cancelRestoreFn, { invalidate: false });

  async function upload(event: FormEvent) {
    event.preventDefault();
    const chosen = file.current?.files?.[0];
    setError(null);
    if (!chosen) return setError(t("backup.restore.chooseFile"));
    if (chosen.size > MAX_UPLOAD_BYTES) return setError(t("backup.errors.uploadTooLarge"));
    setProgress(0);
    try {
      const { uploadId } = await uploadArchive(chosen, setProgress);
      onSource({ kind: "upload", uploadId, name: chosen.name });
    } catch (e) {
      setError(t("backup.restore.uploadFailed", { reason: errorMessage(e, t) }));
    } finally {
      setProgress(null);
    }
  }

  async function drop() {
    if (!preview) return;
    await discard.run({ data: { restoreId: preview.restoreId } });
    onDiscard();
  }

  return (
    <section className="card" aria-labelledby="restore-title">
      <h2 id="restore-title">{t("backup.restore.title")}</h2>
      <p className="muted measure">{t("backup.restore.intro")}</p>
      {restoring ? (
        <RestoreProgress taskId={restoring} />
      ) : (
        <>
          <p className="small">{t("backup.restore.fromTarget")}</p>
          <form className="stack-sm" noValidate onSubmit={upload}>
            {error && <Banner tone="danger">{error}</Banner>}
            <Field label={t("backup.restore.upload")} hint={t("backup.restore.uploadHint")}>
              {(control) => <input {...control} ref={file} type="file" accept=".saldo-backup,application/octet-stream" />}
            </Field>
            {progress !== null && (
              <div className="row">
                <progress max={1} value={progress} aria-label={t("backup.restore.uploading")} />
                <span className="small" aria-hidden="true">
                  {Math.round(progress * 100)} %
                </span>
              </div>
            )}
            <div className="actions">
              <button type="submit" className="btn" disabled={progress !== null} aria-busy={progress !== null}>
                <Icon name="upload" size={18} /> {t("backup.restore.uploadButton")}
              </button>
            </div>
          </form>
          {preview && <PreviewPanel preview={preview} onRestore={() => setConfirming(true)} onDiscard={drop} />}
        </>
      )}
      {confirming && preview && (
        <ConfirmRestoreDialog
          preview={preview}
          onClose={() => setConfirming(false)}
          onStarted={(taskId) => {
            setConfirming(false);
            onStarted(taskId);
            notify("info", t("backup.restore.running"));
          }}
        />
      )}
    </section>
  );
}

function PreviewPanel({ preview, onRestore, onDiscard }: { preview: Preview; onRestore: () => void; onDiscard: () => void }) {
  const { t, f } = useI18n();
  const c = preview.counts;
  return (
    <section id="restore-preview" className="restore-preview stack-sm" tabIndex={-1} aria-labelledby="restore-preview-title">
      <h3 id="restore-preview-title">{t("backup.restore.previewTitle", { file: preview.fileName })}</h3>
      <dl className="facts">
        <dt>{t("backup.restore.created")}</dt>
        <dd>
          <time dateTime={preview.createdAt}>{f.dateTime(preview.createdAt)}</time>
        </dd>
        <dt>{t("backup.restore.version")}</dt>
        <dd>
          {preview.appVersion ?? t("backup.restore.unknownVersion")}
          {preview.gitSha && <span className="mono"> ({preview.gitSha.slice(0, 12)})</span>}
        </dd>
        <dt>{t("backup.restore.postgres")}</dt>
        <dd>{preview.postgres}</dd>
        <dt>{t("backup.restore.contains")}</dt>
        <dd>
          {[
            t("backup.restore.counts.users", { count: c.users }),
            t("backup.restore.counts.accounts", { count: c.accounts }),
            t("backup.restore.counts.transactions", { count: c.transactions }),
            t("backup.restore.counts.contracts", { count: c.contracts }),
            t("backup.restore.counts.bankConnections", { count: c.bankConnections }),
            t("backup.restore.counts.documents", { count: c.documents }),
          ].join(" · ")}
        </dd>
      </dl>
      <p className="small">
        {preview.migrations.pending === 0
          ? t("backup.restore.sameSchema")
          : t("backup.restore.olderSchema", { count: preview.migrations.pending })}
      </p>
      {!preview.sameEncryptionKey && <p className="small">{t("backup.restore.otherKey")}</p>}
      <p className="small">
        {preview.safetyPassphrase === "backup" ? t("backup.restore.safetyBackup") : t("backup.restore.safetyArchive")}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-destructive" onClick={onRestore}>
          {t("backup.restore.start")}
        </button>
        <button type="button" className="btn" onClick={onDiscard}>
          {t("backup.restore.discard")}
        </button>
      </div>
    </section>
  );
}

function CheckArchiveDialog({
  source,
  onClose,
  onChecked,
}: {
  source: RestoreSource;
  onClose: () => void;
  onChecked: (preview: Preview) => void;
}) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ passphrase: string }>();
  const prepare = useAction(prepareRestoreFn, { invalidate: false });

  async function submit() {
    if (!check({ passphrase: passphrase ? undefined : t("backup.errors.passphraseRequired") })) return;
    const data =
      source.kind === "target"
        ? { source: { kind: "target" as const, targetId: source.targetId, name: source.name }, passphrase }
        : { source: { kind: "upload" as const, uploadId: source.uploadId }, passphrase };
    const result = await prepare.run({ data });
    if (result.ok) onChecked(result.value);
  }

  return (
    <FormDialog
      title={t("backup.restore.passphraseTitle", { file: source.name })}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={prepare.busy} aria-busy={prepare.busy}>
            {t("backup.restore.check")}
          </button>
        </>
      }
    >
      {prepare.error && <Banner tone="danger">{prepare.error}</Banner>}
      {prepare.busy && <Banner tone="info">{t("backup.restore.checking")}</Banner>}
      <Field label={t("backup.restore.passphraseField")} hint={t("backup.restore.passphraseHint")} error={errors.passphrase}>
        {(control) => (
          <input
            {...control}
            type="password"
            value={passphrase}
            autoComplete="off"
            maxLength={1024}
            onChange={(event) => {
              setPassphrase(event.target.value);
              clear("passphrase");
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}

function ConfirmRestoreDialog({
  preview,
  onClose,
  onStarted,
}: {
  preview: Preview;
  onClose: () => void;
  onStarted: (taskId: string) => void;
}) {
  const { t, f } = useI18n();
  const word = t("backup.restore.confirmWord");
  const [typed, setTyped] = useState("");
  const { form, errors, check, clear } = useFormErrors<{ typed: string }>();
  const confirm = useAction(confirmRestoreFn, { invalidate: false });

  async function submit() {
    if (
      !check({ typed: typed.trim().toLocaleUpperCase() === word.toLocaleUpperCase() ? undefined : t("backup.errors.confirmationMismatch") })
    )
      return;
    const result = await confirm.run({ data: { restoreId: preview.restoreId, confirmation: typed } });
    if (result.ok) onStarted(result.value.taskId);
  }

  return (
    <FormDialog
      title={t("backup.restore.confirmTitle")}
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-destructive" disabled={confirm.busy} aria-busy={confirm.busy}>
            {t("backup.restore.confirmButton")}
          </button>
        </>
      }
    >
      {confirm.error && <Banner tone="danger">{confirm.error}</Banner>}
      <p>{t("backup.restore.confirmText", { date: f.dateTime(preview.createdAt) })}</p>
      <Field label={t("backup.restore.confirmField", { word })} error={errors.typed}>
        {(control) => (
          <input
            {...control}
            className="mono"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            onChange={(event) => {
              setTyped(event.target.value);
              clear("typed");
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}

/**
 * Follows the restore task. Once the databases are swapped every session is gone, this one too, so the next poll is
 * refused: that is the sign the restore finished.
 */
function RestoreProgress({ taskId }: { taskId: string }) {
  const { t } = useI18n();
  const fetchTasks = useServerFn(getTasksFn);
  const [state, setState] = useState<{ phase: "running" | "finished" } | { phase: "failed"; message: string }>({ phase: "running" });

  useEffect(() => {
    if (state.phase !== "running") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const task = (await fetchTasks()).find((candidate) => candidate.id === taskId);
        if (stopped || !task || task.status === "running") return;
        setState(task.status === "failed" ? { phase: "failed", message: task.message ?? "" } : { phase: "finished" });
      } catch {
        if (!stopped) setState({ phase: "finished" });
      }
    }, 2_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fetchTasks, taskId, state.phase]);

  if (state.phase === "failed") return <Banner tone="danger">{t("backup.restore.failed", { reason: state.message })}</Banner>;
  if (state.phase === "finished") {
    return (
      <Banner tone="ok">
        {t("backup.restore.finished")}{" "}
        <a className="btn btn-sm" href="/login">
          {t("backup.restore.signIn")}
        </a>
      </Banner>
    );
  }
  return <Banner tone="info">{t("backup.restore.running")}</Banner>;
}
