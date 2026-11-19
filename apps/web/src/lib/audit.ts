import { hasMessage, type Locale, type Translate, translate } from "../i18n/index.ts";
import { BACKUP_FREQUENCIES, BACKUP_TARGET_TYPES } from "./backup.ts";
import type { Formatter } from "./format.ts";

/** Every action has the form `<category>.<name>`; the category drives the filter, labels live under `audit.*`. */
export const AUDIT_CATEGORIES = ["auth", "ai", "bank", "accounts", "users", "settings", "backup", "export"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_ACTIONS = [
  "auth.signIn",
  "auth.signOut",
  "auth.passwordChanged",
  "auth.passwordReset",
  "auth.sessionRevoked",
  "users.created",
  "users.updated",
  "users.deleted",
  "users.impersonationStarted",
  "users.impersonationEnded",
  "ai.categorize",
  "ai.recategorize",
  "ai.autoCategorize",
  "ai.analysis",
  "ai.chat",
  "ai.chatDeleted",
  "ai.chatPruned",
  "ai.suggest",
  "bank.connectionCreated",
  "bank.connectionUpdated",
  "bank.connectionDeleted",
  "bank.connectionAuthorized",
  "bank.connectionRenewed",
  "bank.syncStarted",
  "bank.syncFinished",
  "bank.settingsChanged",
  "accounts.created",
  "accounts.deleted",
  "accounts.sharingChanged",
  "accounts.csvImported",
  "settings.aiProviderCreated",
  "settings.aiProviderUpdated",
  "settings.aiProviderDeleted",
  "settings.aiProviderActivated",
  "settings.aiSettingsChanged",
  "settings.smtpChanged",
  "settings.testMail",
  "settings.mcpTokenCreated",
  "settings.mcpTokenRevoked",
  "backup.targetCreated",
  "backup.targetUpdated",
  "backup.targetDeleted",
  "backup.targetTested",
  "backup.scheduleChanged",
  "backup.passphraseChanged",
  "backup.run",
  "backup.downloaded",
  "backup.restored",
  "export.transactionsCsv",
  "export.auditCsv",
  "export.mcpTool",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = "ok" | "failed";
export type AuditDetailValue = string | number | boolean | null | string[];
/** Small, secret-free facts about an event; keys are listed in `describeAudit`. */
export type AuditDetails = Record<string, AuditDetailValue>;

export const categoryOf = (action: string): AuditCategory | null => {
  const category = action.split(".")[0];
  return (AUDIT_CATEGORIES as readonly string[]).includes(category ?? "") ? (category as AuditCategory) : null;
};

const isAction = (action: string): action is AuditAction => (AUDIT_ACTIONS as readonly string[]).includes(action);

const CHANGED_FIELDS = ["name", "login", "customerId", "pin", "tanMechanism", "skipSyncAll"] as const;
// "provider" stays for events written while an instance had exactly one provider.
const BANK_SETTINGS = ["provider", "fints", "enableBanking", "unofficial"] as const;

const text = (value: AuditDetailValue | undefined): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: AuditDetailValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The readable line of an event: the action, then its key details, joined by " · ". */
export function describeAudit(t: Translate, f: Formatter, locale: Locale, event: { action: string; details: AuditDetails }): string {
  const d = event.details;
  const parts: string[] = [isAction(event.action) ? t(`audit.actions.${event.action}`) : event.action];
  const name = text(d.name);
  if (name) parts.push(name);
  const attempted = text(d.attemptedUsername);
  if (attempted) parts.push(t("audit.details.attempted", { name: attempted }));
  const provider = text(d.provider);
  if (provider) parts.push(provider);
  const model = text(d.model);
  if (model) parts.push(model);
  const tokens = (num(d.inputTokens) ?? 0) + (num(d.outputTokens) ?? 0);
  if (num(d.inputTokens) !== null) parts.push(t("audit.details.tokens", { count: tokens }));
  const cost = num(d.costMicro);
  const currency = text(d.currency);
  if (cost !== null && currency) parts.push(t("audit.details.cost", { cost: f.micro(cost, currency) }));
  const role = text(d.role);
  // Events written before the three roles existed name the old admin role.
  const shownRole = role === "admin" ? "superuser" : role;
  if (shownRole === "superuser" || shownRole === "familyAdmin" || shownRole === "member") {
    parts.push(t("audit.details.role", { role: t(`labels.role.${shownRole}`) }));
  }
  if (d.aiAllowed === true) parts.push(t("audit.details.aiAllowedOn"));
  if (d.aiAllowed === false) parts.push(t("audit.details.aiAllowedOff"));
  if (d.visibility === "private" || d.visibility === "household") parts.push(t(`labels.visibility.${d.visibility}`));
  if (Array.isArray(d.sharedWith)) {
    parts.push(d.sharedWith.length > 0 ? t("audit.details.sharedWith", { names: d.sharedWith.join(", ") }) : t("audit.details.notShared"));
  }
  if (Array.isArray(d.groups)) {
    parts.push(d.groups.length > 0 ? t("audit.details.groups", { groups: d.groups.join(", ") }) : t("audit.details.noGroups"));
  }
  if (Array.isArray(d.changed) && d.changed.length > 0) {
    const fields = d.changed.filter((c): c is (typeof CHANGED_FIELDS)[number] => (CHANGED_FIELDS as readonly string[]).includes(c));
    if (fields.length > 0) parts.push(t("audit.details.changed", { fields: fields.map((c) => t(`audit.fields.${c}`)).join(", ") }));
  }
  const setting = text(d.setting);
  if (setting && (BANK_SETTINGS as readonly string[]).includes(setting)) {
    parts.push(t(`audit.bankSettings.${setting as (typeof BANK_SETTINGS)[number]}`));
  }
  if (d.enabled === true) parts.push(t("audit.details.enabledOn"));
  if (d.enabled === false) parts.push(t("audit.details.enabledOff"));
  if (d.keyChanged === true) parts.push(t("audit.details.keyChanged"));
  if (d.passwordChanged === true) parts.push(t("audit.details.passwordChanged"));
  const host = text(d.host);
  if (host) parts.push(num(d.port) !== null ? `${host}:${num(d.port)}` : host);
  if (d.autoCategorize === true) parts.push(t("audit.details.autoCategorizeOn"));
  if (d.autoCategorize === false) parts.push(t("audit.details.autoCategorizeOff"));
  if (d.assignTags === true) parts.push(t("audit.details.assignTagsOn"));
  if (d.assignTags === false) parts.push(t("audit.details.assignTagsOff"));
  if (d.createTags === true) parts.push(t("audit.details.createTagsOn"));
  if (d.createTags === false) parts.push(t("audit.details.createTagsOff"));
  const maxNewTags = num(d.maxNewTags);
  if (maxNewTags !== null) parts.push(t("audit.details.maxNewTags", { count: maxNewTags }));
  else if ("maxNewTags" in d && d.maxNewTags === null) parts.push(t("audit.details.maxNewTagsUnlimited"));
  const tagsCreated = num(d.tagsCreated);
  if (tagsCreated) parts.push(t("audit.details.tagsCreated", { count: tagsCreated }));
  if (d.trigger === "scheduled") parts.push(t("audit.details.scheduled"));
  if (d.trigger === "safety") parts.push(t("audit.details.safety"));
  const targetType = text(d.targetType);
  if (targetType && (BACKUP_TARGET_TYPES as readonly string[]).includes(targetType)) {
    parts.push(t(`backup.types.${targetType as (typeof BACKUP_TARGET_TYPES)[number]}`));
  }
  const frequency = text(d.frequency);
  if (frequency && (BACKUP_FREQUENCIES as readonly string[]).includes(frequency)) {
    parts.push(t(`backup.schedule.frequencies.${frequency as (typeof BACKUP_FREQUENCIES)[number]}`));
  }
  const fileName = text(d.fileName);
  if (fileName) parts.push(fileName);
  const sizeBytes = num(d.sizeBytes);
  if (sizeBytes !== null) parts.push(f.bytes(sizeBytes));
  if (Array.isArray(d.failedTargets) && d.failedTargets.length > 0) {
    parts.push(t("audit.details.failedTargets", { names: d.failedTargets.join(", ") }));
  }
  if (d.rekeyed === true) parts.push(t("audit.details.rekeyed"));
  const bookings = num(d.newBookings);
  if (bookings !== null) parts.push(t("audit.details.newBookings", { count: bookings }));
  const rows = num(d.rows);
  if (rows !== null) parts.push(t("audit.details.rows", { count: rows }));
  const tool = text(d.tool);
  if (tool) parts.push(tool);
  if (Array.isArray(d.tools) && d.tools.length > 0) parts.push(d.tools.join(", "));
  if (d.withoutTools === true) parts.push(t("audit.details.withoutTools"));
  const history = num(d.history);
  if (history) parts.push(t("audit.details.history", { count: history }));
  const conversations = num(d.conversations);
  if (conversations !== null) parts.push(t("audit.details.conversations", { count: conversations }));
  if (d.allSessions === true) parts.push(t("audit.details.allSessions"));
  const impersonatedBy = text(d.impersonatedBy);
  if (impersonatedBy) parts.push(t("audit.details.impersonatedBy", { name: impersonatedBy }));
  const reason = text(d.reason);
  if (reason && hasMessage(reason)) parts.push(translate(locale, reason));
  return parts.join(" · ");
}

/** Filters of the audit log page as search parameters (German keys, they show in the address bar). */
export type AuditSearch = {
  benutzer?: string;
  bereich?: AuditCategory;
  ergebnis?: AuditOutcome;
  von?: string;
  bis?: string;
  q?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseAuditSearch(raw: Record<string, unknown>): AuditSearch {
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const date = (v: unknown) => (typeof v === "string" && ISO_DATE.test(v) ? v : undefined);
  return {
    benutzer: str(raw.benutzer, 64),
    bereich: (AUDIT_CATEGORIES as readonly unknown[]).includes(raw.bereich) ? (raw.bereich as AuditCategory) : undefined,
    ergebnis: raw.ergebnis === "ok" || raw.ergebnis === "failed" ? raw.ergebnis : undefined,
    von: date(raw.von),
    bis: date(raw.bis),
    q: str(raw.q, 100),
  };
}

export function auditFilters(search: AuditSearch) {
  return {
    userId: search.benutzer ?? null,
    category: search.bereich ?? null,
    outcome: search.ergebnis ?? null,
    dateFrom: search.von ?? null,
    dateTo: search.bis ?? null,
    q: search.q ?? null,
  };
}

export function auditCsvUrl(search: AuditSearch): string {
  const p = new URLSearchParams();
  const entries: [string, string | undefined][] = [
    ["user", search.benutzer],
    ["category", search.bereich],
    ["outcome", search.ergebnis],
    ["from", search.von],
    ["to", search.bis],
    ["q", search.q],
  ];
  for (const [key, value] of entries) if (value) p.set(key, value);
  const query = p.toString();
  return `/api/audit/export.csv${query ? `?${query}` : ""}`;
}
