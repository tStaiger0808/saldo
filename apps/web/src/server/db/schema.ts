import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { LOCALES } from "../../i18n/locales.ts";
import type { AuditDetails } from "../../lib/audit.ts";
import {
  BACKUP_RUN_STATUSES,
  BACKUP_TARGET_TYPES,
  BACKUP_TRIGGERS,
  type BackupRunResult,
  type BackupTargetConfig,
  DEFAULT_KEEP,
} from "../../lib/backup.ts";
import type { BookingFilter, BookingView } from "../../lib/booking-filter.ts";
import {
  CONTRACT_LIST_MODES,
  CONTRACT_SORTS,
  CONTRACT_VIEW_SHARING,
  DEFAULT_CONTRACT_PREFERENCES,
} from "../../lib/contract-preferences.ts";
import { DASHBOARD_PERIODS } from "../../lib/periods.ts";
import type { ChatUsage } from "../modules/ai/history.ts";
import type { Lookup } from "../modules/tools/index.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const id = () => integer("id").primaryKey().generatedAlwaysAsIdentity();
// Cents fit easily into a JS number; bigint keeps huge bank amounts from overflowing an int4 column.
const cents = (name: string) => bigint(name, { mode: "number" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// ---- better-auth (column names follow its defaults; `role`, `aiAllowed` and `locale` are our additional fields)

export const ROLES = ["superuser", "familyAdmin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  role: text("role", { enum: ROLES }).notNull().default("member"),
  // Superusers may always use AI; for everyone else a superuser decides.
  aiAllowed: boolean("ai_allowed").notNull().default(false),
  // `email` is a better-auth placeholder; notifications go to this address only.
  notifyEmail: text("notify_email"),
  // Null follows the browser's language.
  locale: text("locale", { enum: LOCALES }),
  // Saved AI chats older than this are deleted; null keeps them.
  chatRetentionDays: integer("chat_retention_days").default(90),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- accounts and groups

export const accountGroups = pgTable("account_groups", {
  id: id(),
  name: text("name").notNull().unique(),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});

/** Household data is shared through groups; private data is seen by its owner, superusers and explicit shares only. */
export const VISIBILITIES = ["household", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const BANK_PROVIDERS = ["fints", "enable_banking", "trade_republic", "givve"] as const;
export type BankProvider = (typeof BANK_PROVIDERS)[number];

export const bankConnections = pgTable("bank_connections", {
  id: id(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  visibility: text("visibility", { enum: VISIBILITIES }).notNull().default("household"),
  provider: text("provider", { enum: BANK_PROVIDERS }).notNull(),
  bank: text("bank").notNull(),
  status: text("status").notNull().default("new"),
  // PIN, FinTS state, Enable Banking session and pending state, unofficial sessions as encrypted JSON.
  ciphertext: text("ciphertext").notNull(),
  remoteAccounts: jsonb("remote_accounts").$type<RemoteAccountJson[]>().notNull().default([]),
  tanMechanisms: jsonb("tan_mechanisms").$type<Record<string, string>>().notNull().default({}),
  consentValidUntil: timestamp("consent_valid_until", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error").notNull().default(""),
  // The last slot of the schedule (local YYYY-MM-DDTHH:MM) a sync was started for; claimed atomically by the scheduler.
  lastScheduledSlot: text("last_scheduled_slot"),
  // Fetched only by its own "Abrufen", never by "Konten abrufen" or the schedule.
  skipSyncAll: boolean("skip_sync_all").notNull().default(false),
  createdAt: createdAt(),
});

export type RemoteAccountJson = {
  ref: string;
  iban: string | null;
  name: string;
  currency: string | null;
  product?: string | null;
  type?: string | null;
  /**
   * Another bank connection already delivers this account (same IBAN), so it is not adopted here; id and name are null
   * for a viewer who does not manage that connection.
   */
  coveredBy?: { connectionId: number | null; name: string | null; provider: BankProvider } | null;
};

export const ACCOUNT_KINDS = ["checking", "savings", "credit_card", "brokerage", "prepaid"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const accounts = pgTable("accounts", {
  id: id(),
  name: text("name").notNull(),
  bank: text("bank").notNull(),
  kind: text("kind", { enum: ACCOUNT_KINDS }).notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  visibility: text("visibility", { enum: VISIBILITIES }).notNull().default("household"),
  iban: text("iban"),
  transferPatterns: jsonb("transfer_patterns").$type<string[]>().notNull().default([]),
  color: text("color").notNull().default("#1f6f5c"),
  balanceCents: cents("balance_cents"),
  balanceDate: date("balance_date", { mode: "string" }),
  connectionId: integer("connection_id").references(() => bankConnections.id, { onDelete: "set null" }),
  remoteRef: text("remote_ref"),
  createdAt: createdAt(),
});

export const accountGroupMembers = pgTable(
  "account_group_members",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => accountGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.groupId] })],
);

/** Direct shares of an account with single users; shares with groups are rows of account_group_members. */
export const accountShares = pgTable(
  "account_shares",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] }), index("account_shares_user_idx").on(t.userId)],
);

/**
 * Daily balances: entered by hand for accounts without a bank connection, written by each sync for depots. The latest one
 * is the account's balance.
 */
export const accountBalanceEntries = pgTable(
  "account_balance_entries",
  {
    id: id(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    balanceCents: cents("balance_cents").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique("account_balance_entries_account_date_unique").on(t.accountId, t.date)],
);

/** The positions of a depot as of its last sync; every sync replaces them. */
export const accountHoldings = pgTable(
  "account_holdings",
  {
    id: id(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    isin: text("isin"),
    name: text("name").notNull(),
    quantity: numeric("quantity", { precision: 24, scale: 8, mode: "number" }).notNull(),
    // Per unit in `currency`; bonds quoted in percent carry the fraction of the nominal value and currency "%".
    price: numeric("price", { precision: 24, scale: 8, mode: "number" }),
    currency: text("currency").notNull().default("EUR"),
    valueCents: cents("value_cents").notNull(),
    costBasisCents: cents("cost_basis_cents"),
    asOf: date("as_of", { mode: "string" }).notNull(),
  },
  (t) => [index("account_holdings_account_idx").on(t.accountId)],
);

/**
 * Bookings the bank has announced but not booked yet, as of the account's last successful sync, which replaces them all.
 * Kept apart from `transactions` so no balance, sum, rule or notification can count them.
 */
export const pendingTransactions = pgTable(
  "pending_transactions",
  {
    id: id(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    bookingDate: date("booking_date", { mode: "string" }),
    valueDate: date("value_date", { mode: "string" }),
    amountCents: cents("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    counterparty: text("counterparty").notNull().default(""),
    purpose: text("purpose").notNull().default(""),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pending_transactions_account_idx").on(t.accountId)],
);

export const userGroupAccess = pgTable(
  "user_group_access",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => accountGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);

// ---- categorization

export const categories = pgTable("categories", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["expense", "income", "savings"] }).notNull(),
  color: text("color").notNull(),
  position: integer("position").notNull().default(0),
});

export const tags = pgTable("tags", {
  id: id(),
  name: text("name").notNull().unique(),
  color: text("color").notNull(),
  // "ai" marks tags the AI proposed, so people can review them.
  createdBy: text("created_by", { enum: ["user", "ai"] })
    .notNull()
    .default("user"),
  createdAt: createdAt(),
});

export const rules = pgTable("rules", {
  id: id(),
  pattern: text("pattern").notNull(),
  field: text("field", { enum: ["any", "counterparty", "purpose"] })
    .notNull()
    .default("any"),
  direction: text("direction", { enum: ["any", "out", "in"] })
    .notNull()
    .default("any"),
  categoryId: integer("category_id").references(() => categories.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(100),
  source: text("source", { enum: ["manual", "seed", "ai"] })
    .notNull()
    .default("manual"),
  createdAt: createdAt(),
});

export const ruleTags = pgTable(
  "rule_tags",
  {
    ruleId: integer("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.tagId] })],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    source: text("source").notNull(),
    bookingDate: date("booking_date", { mode: "string" }).notNull(),
    valueDate: date("value_date", { mode: "string" }),
    amountCents: cents("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    counterparty: text("counterparty").notNull().default(""),
    counterpartyIban: text("counterparty_iban"),
    purpose: text("purpose").notNull().default(""),
    isTransfer: boolean("is_transfer").notNull().default(false),
    transferManual: boolean("transfer_manual").notNull().default(false),
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    categorySource: text("category_source", { enum: ["manual", "ai", "rule"] }),
    note: text("note").notNull().default(""),
    isUnread: boolean("is_unread").notNull().default(true),
    manualTagIds: jsonb("manual_tag_ids").$type<number[]>().notNull().default([]),
    // The AI's tags of its latest answer; a re-run replaces them, manual tags stay.
    aiTagIds: jsonb("ai_tag_ids").$type<number[]>().notNull().default([]),
    // Set by contract matching (modules/contracts), never by hand.
    contractId: integer("contract_id").references(() => contracts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("transactions_account_external_unique").on(t.accountId, t.externalId),
    index("transactions_booking_date_idx").on(t.bookingDate),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_contract_idx").on(t.contractId),
  ],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    // Derived by classification from manual_tag_ids, ai_tag_ids and the rules.
    source: text("source", { enum: ["manual", "rule", "ai"] })
      .notNull()
      .default("manual"),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);

// ---- dashboards

export type DashboardCard = {
  id: string;
  type: string;
  title: string;
  width: "full" | "half" | "third";
  options: Record<string, string | number | boolean | number[]>;
};

export const dashboards = pgTable(
  "dashboards",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Null means all accounts the owner may see.
    groupId: integer("group_id").references(() => accountGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    cards: jsonb("cards").$type<DashboardCard[]>().notNull().default([]),
    // The owner's chosen period; `period_from`/`period_to` only for "custom".
    period: text("period", { enum: DASHBOARD_PERIODS }).notNull().default("this_month"),
    periodFrom: date("period_from", { mode: "string" }),
    periodTo: date("period_to", { mode: "string" }),
  },
  (t) => [index("dashboards_owner_idx").on(t.ownerId)],
);

// ---- saved booking filters: private to their owner, one list for the bookings page and one for account pages

export const SAVED_FILTER_SCOPES = ["transactions", "account"] as const;
export type SavedFilterScope = (typeof SAVED_FILTER_SCOPES)[number];

export const savedFilters = pgTable(
  "saved_filters",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: SAVED_FILTER_SCOPES }).notNull(),
    name: text("name").notNull(),
    filter: jsonb("filter").$type<BookingFilter>().notNull(),
    // Applied when the page is opened without filters.
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("saved_filters_name_unique").on(t.userId, t.scope, t.name),
    uniqueIndex("saved_filters_one_default").on(t.userId, t.scope).where(sql`${t.isDefault}`),
  ],
);

// ---- contracts

export const CONTRACT_DIRECTIONS = ["income", "expense"] as const;
export const CONTRACT_INTERVALS = ["weekly", "monthly", "quarterly", "half_yearly", "yearly", "custom"] as const;

/**
 * Recurring income and expenses. On an account a contract is seen by whoever sees the account; without one its
 * visibility decides (household: everyone, private: owner and superusers).
 */
export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    name: text("name").notNull(),
    direction: text("direction", { enum: CONTRACT_DIRECTIONS }).notNull(),
    // Positive; for a variable contract the typical amount.
    amountCents: cents("amount_cents").notNull(),
    variable: boolean("variable").notNull().default(false),
    interval: text("interval", { enum: CONTRACT_INTERVALS }).notNull().default("monthly"),
    // Only for interval "custom".
    intervalMonths: integer("interval_months"),
    // The due date entered last; the following ones are computed from it.
    nextDue: date("next_due", { mode: "string" }).notNull(),
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    matchPayee: text("match_payee").notNull().default(""),
    matchPurpose: text("match_purpose").notNull().default(""),
    // Deviation that counts as a price change; null: never.
    tolerancePercent: integer("tolerance_percent"),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    notes: text("notes").notNull().default(""),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    visibility: text("visibility", { enum: VISIBILITIES }).notNull().default("household"),
    createdAt: createdAt(),
  },
  (t) => [index("contracts_account_idx").on(t.accountId), index("contracts_owner_idx").on(t.ownerUserId)],
);

/** Suggested contracts a user dismissed, keyed by direction and normalized payee. */
export const contractDismissals = pgTable(
  "contract_dismissals",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** A person's own tabs on the contracts page; each shows the contracts and suggestions of its accounts. */
export const contractViews = pgTable(
  "contract_views",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    // Narrowed to the accounts the owner may see whenever the view is used.
    accountIds: integer("account_ids").array().notNull().default(sql`'{}'::integer[]`),
    // "people" shares with the rows in contract_view_shares; recipients only ever see their own accounts of it.
    sharing: text("sharing", { enum: CONTRACT_VIEW_SHARING }).notNull().default("private"),
    createdAt: createdAt(),
  },
  (t) => [index("contract_views_owner_idx").on(t.ownerId)],
);

/** The people a contract view is shared with when its sharing is "people". */
export const contractViewShares = pgTable(
  "contract_view_shares",
  {
    viewId: integer("view_id")
      .notNull()
      .references(() => contractViews.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.userId] }), index("contract_view_shares_user_idx").on(t.userId)],
);

/** Views shared with a person that they chose not to show as a tab. */
export const contractViewHidden = pgTable(
  "contract_view_hidden",
  {
    viewId: integer("view_id")
      .notNull()
      .references(() => contractViews.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.userId] })],
);

/** Files kept with a contract; in the database, so backups include them. The type is checked by content on upload. */
export const contractDocuments = pgTable(
  "contract_documents",
  {
    id: id(),
    contractId: integer("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("contract_documents_contract_idx").on(t.contractId)],
);

/** Due dates a user has marked as seen; the next due date of the same contract counts as new again. */
export const contractDueReads = pgTable(
  "contract_due_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contractId: integer("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.contractId, t.dueDate] })],
);

/** A person's choices on the contracts page; without a row the defaults apply. */
export const contractPreferences = pgTable("contract_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  listMode: text("list_mode", { enum: CONTRACT_LIST_MODES }).notNull().default(DEFAULT_CONTRACT_PREFERENCES.listMode),
  sort: text("sort", { enum: CONTRACT_SORTS }).notNull().default(DEFAULT_CONTRACT_PREFERENCES.sort),
  // One of DUE_SOON_WINDOWS; marks due dates on the page and counts them in the navigation.
  dueSoonDays: integer("due_soon_days").notNull().default(DEFAULT_CONTRACT_PREFERENCES.dueSoonDays),
  // The person's name for the built-in "all" tab; null shows the translated default.
  allViewName: text("all_view_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- AI

export const aiProviders = pgTable("ai_providers", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["openai", "anthropic"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  model: text("model"),
  isActive: boolean("is_active").notNull().default(false),
  priceInputPerMtok: real("price_input_per_mtok"),
  priceOutputPerMtok: real("price_output_per_mtok"),
  priceCurrency: text("price_currency").notNull().default("USD"),
});

export const aiAnalyses = pgTable("ai_analyses", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => accountGroups.id, { onDelete: "set null" }),
  periodFrom: date("period_from", { mode: "string" }).notNull(),
  periodTo: date("period_to", { mode: "string" }).notNull(),
  providerName: text("provider_name").notNull(),
  model: text("model").notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
});

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    providerId: integer("provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
    providerName: text("provider_name").notNull(),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose", { enum: ["categorize", "analysis", "chat", "suggest"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    reported: boolean("reported").notNull().default(true),
    // Millionths of `currency`, snapshotted when prices were known.
    costMicro: bigint("cost_micro", { mode: "number" }),
    currency: text("currency").notNull().default("USD"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);

/** Chats with the AI, private to their owner: nobody else lists or reads them, superusers included. */
export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The view the chat was started in; null: all visible accounts.
    groupId: integer("group_id").references(() => accountGroups.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // The booking list the chat last showed or was asked about, the context of follow-up questions.
    lastViewFilter: jsonb("last_view_filter").$type<BookingView>(),
  },
  (t) => [index("chat_conversations_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const CHAT_ROLES = ["user", "assistant"] as const;

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: CHAT_ROLES }).notNull(),
    content: text("content").notNull(),
    lookups: jsonb("lookups").$type<Lookup[]>().notNull().default([]),
    usage: jsonb("usage").$type<ChatUsage>(),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_conversation_idx").on(t.conversationId, t.id)],
);

// ---- instance settings and MCP

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  // Secret settings (Enable Banking key) live here, never in `value`.
  ciphertext: text("ciphertext"),
});

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Null for tokens created before tokens expired; those stay valid until revoked.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_tokens_user_idx").on(t.userId)],
);

// ---- notifications

export const NOTIFICATION_KINDS = [
  "new_bookings",
  "large_expense",
  "low_balance",
  "price_change",
  "uncategorized",
  "weekly_summary",
  "monthly_summary",
  "bank_problem",
  "contract_changed",
  "contract_missed",
  "contract_upcoming",
  "backup_failed",
  "backup_succeeded",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    push: boolean("push").notNull().default(false),
    email: boolean("email").notNull().default(false),
    // Threshold of the event (cents, percent, count or days), null for events without one.
    threshold: integer("threshold"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);

/** One row per event and user that was notified; the unique key is what keeps a notification from going out twice. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dedupKey: text("dedup_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("notification_deliveries_user_key_unique").on(t.userId, t.dedupKey)],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

// ---- audit log (admins only)

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    // Snapshot, so the event still names who it was after the user is deleted.
    username: text("username"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome", { enum: ["ok", "failed"] })
      .notNull()
      .default("ok"),
    details: jsonb("details").$type<AuditDetails>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("audit_events_at_idx").on(t.at), index("audit_events_user_at_idx").on(t.userId, t.at)],
);

// ---- impersonation: a superuser's session shows Saldo as another person, read-only, for a limited time

export const impersonations = pgTable(
  "impersonations",
  {
    // Bound to the superuser's own session, so signing out or revoking it ends the view as well.
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("impersonations_target_idx").on(t.targetUserId)],
);

// ---- profile pictures: one per user, shown to everyone signed in, like the name

export const userAvatars = pgTable("user_avatars", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull(),
  data: bytea("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- backups (superusers only): where archives go and how each run ended; schedule and passphrase live in `settings`

export const backupTargets = pgTable("backup_targets", {
  id: id(),
  name: text("name").notNull(),
  type: text("type", { enum: BACKUP_TARGET_TYPES }).notNull(),
  // Host, path, user name and options; passwords and keys only in `ciphertext`.
  config: jsonb("config").$type<BackupTargetConfig>().notNull(),
  ciphertext: text("ciphertext"),
  // Archives kept on this target; older ones Saldo wrote are deleted after each run.
  keep: integer("keep").notNull().default(DEFAULT_KEEP),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: id(),
    trigger: text("trigger", { enum: BACKUP_TRIGGERS }).notNull(),
    startedBy: text("started_by").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status", { enum: BACKUP_RUN_STATUSES }).notNull().default("running"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    results: jsonb("results").$type<BackupRunResult[]>().notNull().default([]),
    // Message key of a failure before any target was reached.
    error: text("error"),
  },
  (t) => [index("backup_runs_started_idx").on(t.startedAt)],
);
