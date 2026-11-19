/**
 * Bank connections: provider settings and credential checks (superusers), connections of the household and of single
 * people, account mapping and the detached discover/sync jobs. Each provider is set up on its own; every connection
 * picks one of those that are ready.
 */
import { randomBytes } from "node:crypto";
import {
  type Aspsp,
  BankError,
  createFinTSClient,
  EnableBankingClient,
  FINTS_PRESETS,
  type FinTSAccess,
  type FinTSClientFactory,
  type FinTSPreset,
  FinTSSession,
  GivveClient,
  type GivveSession,
  parsePrivateKey,
  type RawBooking,
  type RawHolding,
  type RawPendingBooking,
  ReauthRequired,
  type RemoteAccount,
  type RemoteBalance,
  TR_CASH_REF,
  TR_DEPOT_REF,
  TradeRepublicClient,
  type TrSession,
} from "@saldo/banking";
import { guessAccountKind, remoteAccountName } from "@saldo/core";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale, msg, render, type Translatable } from "../../../i18n/index.ts";
import { clientIp } from "../../client-ip.ts";
import { decrypt, encrypt } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import {
  ACCOUNT_KINDS,
  accounts,
  type BankProvider,
  bankConnections,
  type RemoteAccountJson,
  settings,
  user,
  VISIBILITIES,
} from "../../db/schema.ts";
import { bankRedirectUrl, env } from "../../env.ts";
import { Forbidden, NotFound, UserError } from "../../errors.ts";
import {
  canManage,
  isSuperuser,
  manageableConnectionIds,
  managesHousehold,
  mayUseAi,
  requireManageableAccount,
  requireManageableConnection,
  requireSuperuser,
  requireVisibleConnection,
  type Viewer,
  visibleAccountIds,
} from "../access/index.ts";
import { createAccount, replaceHoldings } from "../accounts/index.ts";
import { categorizeNewBookings } from "../ai/index.ts";
import { failureReason, record } from "../audit/index.ts";
import { reclassifyAll } from "../classification/index.ts";
import { relinkContracts } from "../contracts/index.ts";
import { localDay, notifyAfterSync, notifyBankProblem } from "../notifications/index.ts";
import { dropPendingBookings, fetchStart, importBookings, replacePendingBookings } from "../transactions/index.ts";
import {
  type AccountResult,
  APPROVAL_NEEDED,
  activeJobFor,
  activeJobs,
  getJob,
  isCancellation,
  type Job,
  type JobKind,
  type JobStatus,
  type JobView,
  startJob,
} from "./jobs.ts";
import { type BankLogo, cachedBankLogo, cachedSiteIcon, type LogoDeps, SITES } from "./logos.ts";
import { failureText, isRestrictedAppError, readText, SaldoBankError, SaldoReauthRequired, storeText, type Text } from "./texts.ts";

export { type AccountResult, APPROVAL_NEEDED, type JobStatus, type JobView, jobTiming, resetJobsForTests } from "./jobs.ts";
export { type BankLogo, bankLogoResponse, noBankLogoResponse } from "./logos.ts";

export type { BankProvider };
export type PsuHeaders = Record<string, string>;

// ---- dependencies (replaced in tests; never real banks there)

type BankingDeps = {
  fetch: typeof fetch | undefined;
  fintsClient: FinTSClientFactory;
  tradeRepublic: () => TradeRepublicClient;
  givve: () => GivveClient;
  now: () => Date;
};
const defaultDeps: BankingDeps = {
  fetch: undefined,
  fintsClient: createFinTSClient,
  tradeRepublic: () => new TradeRepublicClient(),
  givve: () => new GivveClient({ baseUrl: env().GIVVE_API_URL, now: () => deps.now() }),
  now: () => new Date(),
};
let deps: BankingDeps = defaultDeps;

export function setBankingDepsForTests(overrides: Partial<BankingDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

const today = () => deps.now().toISOString().slice(0, 10);

// ---- settings

const KEYS = {
  fintsProductId: "fints_product_id",
  fintsProductVersion: "fints_product_version",
  ebAppId: "enable_banking_app_id",
  ebKey: "enable_banking_private_key",
  ebCheck: "enable_banking_check",
  tradeRepublic: "trade_republic_enabled",
  givve: "givve_enabled",
  schedule: "bank_sync_schedule",
} as const;

/** Providers without an official interface; a superuser enables them knowingly and they are fetched only on request by default. */
export const UNOFFICIAL_PROVIDERS = ["trade_republic", "givve"] as const satisfies readonly BankProvider[];
export type UnofficialProvider = (typeof UNOFFICIAL_PROVIDERS)[number];

const isUnofficial = (provider: BankProvider): provider is UnofficialProvider =>
  (UNOFFICIAL_PROVIDERS as readonly BankProvider[]).includes(provider);

async function readSetting(db: Db, key: string): Promise<{ value: unknown; ciphertext: string | null } | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row;
}

async function readString(db: Db, key: string): Promise<string | null> {
  const value = (await readSetting(db, key))?.value;
  return typeof value === "string" && value ? value : null;
}

async function writeSetting(db: Db, key: string, value: unknown, ciphertext: string | null = null): Promise<void> {
  await db.insert(settings).values({ key, value, ciphertext }).onConflictDoUpdate({ target: settings.key, set: { value, ciphertext } });
}

/** As stored in the settings, `message` may still be translatable; views carry it rendered. */
type StoredCredentialCheck = Omit<CredentialCheck, "message"> & { message: Text };

export type CredentialCheck = {
  status: "ok" | "inactive" | "invalid";
  message: string;
  appName: string | null;
  environment: string | null;
  redirectRegistered: boolean;
  checkedAt: string;
};

export type BankingSettings = {
  /** The providers a new connection can use right now, in the order they are offered. */
  available: BankProvider[];
  redirectUrl: string;
  fints: { productId: string | null; productVersion: string | null };
  enableBanking: { appId: string | null; keySet: boolean; check: CredentialCheck | null };
  /** Unofficial providers a superuser has enabled. */
  unofficial: Record<UnofficialProvider, boolean>;
  fintsPresets: FinTSPreset[];
  /** When every connection not marked "only manually" is fetched; the times are in `serverTimeZone`. */
  schedule: SyncSchedule;
  // Scheduled syncs run in this zone (the container's TZ).
  serverTimeZone: string;
  /** A superuser has set up at least one provider far enough for anyone to connect a bank. */
  ready: boolean;
};

async function availableProviders(db: Db): Promise<BankProvider[]> {
  const check = (await readSetting(db, KEYS.ebCheck))?.value as StoredCredentialCheck | null | undefined;
  const eb =
    Boolean((await readString(db, KEYS.ebAppId)) && (await readSetting(db, KEYS.ebKey))?.ciphertext) && check?.status !== "invalid";
  const found: [BankProvider, boolean][] = [
    ["enable_banking", eb],
    ["fints", Boolean(await readString(db, KEYS.fintsProductId))],
    ["trade_republic", (await readSetting(db, KEYS.tradeRepublic))?.value === true],
    ["givve", (await readSetting(db, KEYS.givve))?.value === true],
  ];
  return found.filter(([, ok]) => ok).map(([provider]) => provider);
}

async function fintsVersion(db: Db): Promise<string | null> {
  const value = (await readSetting(db, KEYS.fintsProductVersion))?.value as { version?: unknown } | null | undefined;
  return typeof value?.version === "string" && value.version ? value.version : null;
}

async function requireAvailable(db: Db, provider: BankProvider): Promise<void> {
  if (!(await availableProviders(db)).includes(provider)) {
    throw new UserError(msg("banking.errors.providerUnavailable", { provider: providerName(provider) }), 400);
  }
}

/** Everyone who may connect a bank learns which providers are ready; app id, product id and the check stay with superusers. */
export async function getBankingSettings(db: Db, viewer: Viewer): Promise<BankingSettings> {
  const full = isSuperuser(viewer);
  const check = full ? ((await readSetting(db, KEYS.ebCheck))?.value as StoredCredentialCheck | null | undefined) : null;
  const available = await availableProviders(db);
  return {
    available,
    redirectUrl: bankRedirectUrl(),
    fints: {
      productId: full ? await readString(db, KEYS.fintsProductId) : null,
      productVersion: full ? await fintsVersion(db) : null,
    },
    enableBanking: {
      appId: full ? await readString(db, KEYS.ebAppId) : null,
      keySet: Boolean((await readSetting(db, KEYS.ebKey))?.ciphertext),
      check: check ? renderCheck(check, viewerLocale(viewer)) : null,
    },
    unofficial: { trade_republic: available.includes("trade_republic"), givve: available.includes("givve") },
    fintsPresets: FINTS_PRESETS,
    schedule: await readSchedule(db),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ready: available.length > 0,
  };
}

const providerName = (provider: BankProvider): Translatable => msg(`banking.providers.${provider}.name`);

/** For audit details, which are stored as written. */
const PROVIDER_NAMES: Record<BankProvider, string> = {
  fints: "FinTS",
  enable_banking: "Enable Banking",
  trade_republic: "Trade Republic (inoffiziell)",
  givve: "givve (inoffiziell)",
};

export const fintsSettingsInput = z.object({
  productId: z
    .string()
    .trim()
    .min(1, "banking.errors.productIdRequired")
    // The registration is filled into HKVVB as is and must never exceed 25 characters.
    .max(25, "banking.errors.productIdFormat")
    .regex(/^[A-Za-z0-9]+$/, "banking.errors.productIdFormat"),
  // Empty: the default version.
  productVersion: z
    .string()
    .trim()
    .max(16)
    .regex(/^[A-Za-z0-9.]*$/, "banking.errors.productVersionFormat")
    .optional(),
});

export async function saveFintsSettings(db: Db, viewer: Viewer, input: z.input<typeof fintsSettingsInput>): Promise<void> {
  requireSuperuser(viewer);
  const data = fintsSettingsInput.parse(input);
  await db.transaction(async (tx) => {
    await writeSetting(tx, KEYS.fintsProductId, data.productId);
    // Wrapped: a bare "2.1" would come back from the jsonb column as the number 2.1.
    if (data.productVersion !== undefined) {
      await writeSetting(tx, KEYS.fintsProductVersion, data.productVersion ? { version: data.productVersion } : null);
    }
  });
  await record(db, { action: "bank.settingsChanged", actor: viewer, details: { setting: "fints" } });
}

export const unofficialInput = z.object({
  provider: z.enum(UNOFFICIAL_PROVIDERS),
  enabled: z.boolean(),
  /** The superuser confirmed the warning (terms of use, lock risk, stored credentials); required to enable. */
  acknowledged: z.boolean().default(false),
});

/** Enabling takes the confirmed warning; disabling stops new connections and fetches of existing ones. */
export async function setUnofficialProvider(db: Db, viewer: Viewer, input: z.input<typeof unofficialInput>): Promise<void> {
  requireSuperuser(viewer);
  const data = unofficialInput.parse(input);
  if (data.enabled && !data.acknowledged) throw new UserError(msg("banking.errors.acknowledgeRequired"));
  await writeSetting(db, data.provider === "trade_republic" ? KEYS.tradeRepublic : KEYS.givve, data.enabled);
  await record(db, {
    action: "bank.settingsChanged",
    actor: viewer,
    details: { setting: "unofficial", provider: PROVIDER_NAMES[data.provider], enabled: data.enabled },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422]);

function ebClient(appId: string, privateKeyPem: string, psuHeaders: PsuHeaders = {}): EnableBankingClient {
  return new EnableBankingClient({ appId, privateKeyPem, psuHeaders, baseUrl: env().ENABLE_BANKING_API_URL, fetch: deps.fetch });
}

/** App id format, then the key (must be RSA), then a live GET /application. Unreachable is an error, not a verdict. */
async function checkCredentials(appId: string, privateKeyPem: string): Promise<StoredCredentialCheck> {
  const result = (status: CredentialCheck["status"], message: Text, extra: Partial<StoredCredentialCheck> = {}): StoredCredentialCheck => ({
    status,
    message,
    appName: null,
    environment: null,
    redirectRegistered: false,
    checkedAt: deps.now().toISOString(),
    ...extra,
  });
  if (!UUID.test(appId)) return result("invalid", msg("banking.check.appIdFormat"));
  try {
    parsePrivateKey(privateKeyPem);
  } catch (error) {
    return result("invalid", (error as Error).message);
  }
  let app: Awaited<ReturnType<EnableBankingClient["application"]>>;
  try {
    app = await ebClient(appId, privateKeyPem).application();
  } catch (error) {
    if (error instanceof BankError && error.status && REJECTED_STATUSES.has(error.status)) {
      return result("invalid", msg("banking.check.rejected"));
    }
    if (error instanceof BankError) throw new UserError(error.message, 502);
    throw error;
  }
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  const redirectRegistered = app.redirectUrls.some((url) => normalize(url) === normalize(bankRedirectUrl()));
  const extra = { appName: app.name || null, environment: app.environment || null, redirectRegistered };
  const hint = redirectRegistered ? "" : msg("banking.check.redirectMissing", { url: bankRedirectUrl() });
  if (!app.active) return result("inactive", msg("banking.check.inactive", { hint }), extra);
  return result("ok", msg("banking.check.ok", { name: app.name, environment: app.environment, hint }), extra);
}

function renderCheck(check: StoredCredentialCheck, locale: Locale): CredentialCheck {
  return { ...check, message: render(locale, check.message) };
}

function viewerLocale(viewer: Viewer): Locale {
  return viewer.locale ?? DEFAULT_LOCALE;
}

export const enableBankingSettingsInput = z.object({
  appId: z.string().trim().min(1, "banking.errors.appIdRequired").max(64),
  // Empty keeps the stored key.
  privateKey: z.string().trim().max(20_000).optional(),
});

async function storedKey(db: Db): Promise<string | null> {
  const ciphertext = (await readSetting(db, KEYS.ebKey))?.ciphertext;
  return ciphertext ? decrypt(ciphertext) : null;
}

export async function saveEnableBankingSettings(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof enableBankingSettingsInput>,
): Promise<CredentialCheck> {
  requireSuperuser(viewer);
  const data = enableBankingSettingsInput.parse(input);
  const key = data.privateKey || (await storedKey(db));
  if (!key) throw new UserError(msg("banking.errors.keyRequired"));
  const check = await checkCredentials(data.appId, key);
  if (check.status === "invalid") throw new UserError(check.message, 400);
  await db.transaction(async (tx) => {
    await writeSetting(tx, KEYS.ebAppId, data.appId);
    await writeSetting(tx, KEYS.ebKey, null, encrypt(key));
    await writeSetting(tx, KEYS.ebCheck, check);
  });
  await record(db, {
    action: "bank.settingsChanged",
    actor: viewer,
    details: { setting: "enableBanking", keyChanged: Boolean(data.privateKey) },
  });
  return renderCheck(check, viewerLocale(viewer));
}

export async function recheckEnableBanking(db: Db, viewer: Viewer): Promise<CredentialCheck> {
  requireSuperuser(viewer);
  const appId = await readString(db, KEYS.ebAppId);
  const key = await storedKey(db);
  if (!appId || !key) throw new UserError(msg("banking.errors.ebNotSetUp"));
  const check = await checkCredentials(appId, key);
  await writeSetting(db, KEYS.ebCheck, check);
  return renderCheck(check, viewerLocale(viewer));
}

async function configuredEbClient(db: Db, psuHeaders: PsuHeaders = {}): Promise<EnableBankingClient> {
  const appId = await readString(db, KEYS.ebAppId);
  const key = await storedKey(db);
  if (!appId || !key) throw new SaldoBankError(msg("banking.errors.ebNotConfigured"));
  return ebClient(appId, key, psuHeaders);
}

async function fintsProduct(db: Db): Promise<{ productId: string; productVersion?: string }> {
  const productId = await readString(db, KEYS.fintsProductId);
  if (!productId) throw new SaldoBankError(msg("banking.errors.productIdMissing"));
  const productVersion = await fintsVersion(db);
  return productVersion ? { productId, productVersion } : { productId };
}

function asUserError(error: unknown, status = 502): never {
  if (error instanceof BankError)
    throw new UserError(isRestrictedAppError(error.message) ? msg("banking.errors.restrictedApp") : failureText(error), status);
  throw error;
}

export const banksInput = z.object({
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "banking.errors.countryCode"),
});

/** Anyone signed in may pick a bank: members connect their own. */
export async function listEnableBankingBanks(db: Db, viewer: Viewer, input: z.input<typeof banksInput>): Promise<Aspsp[]> {
  const { country } = banksInput.parse(input);
  try {
    const banks = await (await configuredEbClient(db)).banks(country);
    // Enable Banking lists banks in its own order; case, accents and numbers are ordered the way people read them.
    const collator = new Intl.Collator(viewerLocale(viewer), { sensitivity: "base", numeric: true });
    return banks.sort((a, b) => collator.compare(a.name, b.name));
  } catch (error) {
    asUserError(error);
  }
}

// ---- connection secrets (encrypted JSON in bank_connections.ciphertext)

type BankingInformation = NonNullable<FinTSAccess["bankingInformation"]>;

type FintsSecrets = {
  blz: string;
  server: string;
  login: string;
  customerId: string | null;
  pin: string;
  tanMethodId: number | null;
  tanMediaName: string | null;
  bankingInformation: BankingInformation | null;
};

type EbSecrets = {
  bankName: string;
  country: string;
  sessionId: string | null;
  pendingState: string | null;
  pendingStateAt: string | null;
  pendingValidUntil: string | null;
};

/** `session` is the cookie jar of the last login; null until the first login and after Trade Republic ended it. */
type TrSecrets = { phone: string; pin: string; deviceId: string; session: TrSession | null };

type GivveSecrets = { email: string; password: string; session: GivveSession | null };

type Connection = typeof bankConnections.$inferSelect;

function readSecrets<T>(connection: Pick<Connection, "ciphertext">): T {
  return JSON.parse(decrypt(connection.ciphertext)) as T;
}

const sealSecrets = (secrets: FintsSecrets | EbSecrets | TrSecrets | GivveSecrets) => encrypt(JSON.stringify(secrets));

/** Shows enough of a phone number to recognize it. */
function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 3)} ••• ${phone.slice(-3)}` : "•••";
}

async function loadConnection(db: Db, id: number): Promise<Connection> {
  const [row] = await db.select().from(bankConnections).where(eq(bankConnections.id, id));
  if (!row) throw new NotFound(msg("banking.errors.connectionNotFound"));
  return row;
}

export type LinkedAccount = { id: number; name: string; remoteRef: string | null };

export type ConnectionView = {
  id: number;
  name: string;
  visibility: (typeof VISIBILITIES)[number];
  /** The owner's name when it is not the viewer. */
  owner: string | null;
  provider: BankProvider;
  bank: string;
  status: string;
  remoteAccounts: RemoteAccountJson[];
  linkedAccounts: LinkedAccount[];
  tanMechanisms: Record<string, string>;
  tanMechanism: string | null;
  /** FinTS login, the masked phone number (Trade Republic) or the e-mail address (givve). */
  login: string | null;
  target: { blz: string; server: string } | { bankName: string; country: string } | { service: UnofficialProvider };
  consentValidUntil: string | null;
  lastSyncAt: string | null;
  lastError: string;
  activeJobId: string | null;
  /** Fetched only on its own request: left out of "Konten abrufen" and of the schedule. */
  skipSyncAll: boolean;
  /** Not through an official interface; may stop working (Trade Republic, givve). */
  unofficial: boolean;
};

async function connectionView(db: Db, viewer: Viewer, connection: Connection): Promise<ConnectionView> {
  const locale = viewerLocale(viewer);
  const [owner] =
    connection.ownerUserId === viewer.id
      ? []
      : await db.select({ name: user.displayUsername, username: user.username }).from(user).where(eq(user.id, connection.ownerUserId));
  // An account its owner made private stays out of sight, even for someone who manages the connection: neither the
  // account nor the bank's account behind it is listed.
  const visible = new Set(await visibleAccountIds(db, viewer));
  const all = await db
    .select({ id: accounts.id, name: accounts.name, remoteRef: accounts.remoteRef })
    .from(accounts)
    .where(eq(accounts.connectionId, connection.id))
    .orderBy(asc(accounts.name));
  const linked = all.filter((a) => visible.has(a.id));
  const hiddenRefs = new Set(all.filter((a) => !visible.has(a.id)).map((a) => a.remoteRef));
  const managed = new Set(await manageableConnectionIds(db, viewer));
  const remoteAccounts = connection.remoteAccounts
    .filter((r) => !hiddenRefs.has(r.ref))
    .map((r) =>
      r.coveredBy && r.coveredBy.connectionId !== null && !managed.has(r.coveredBy.connectionId)
        ? { ...r, coveredBy: { connectionId: null, name: null, provider: r.coveredBy.provider } }
        : r,
    );
  const fints = connection.provider === "fints" ? readSecrets<FintsSecrets>(connection) : null;
  const eb = connection.provider === "enable_banking" ? readSecrets<EbSecrets>(connection) : null;
  const tr = connection.provider === "trade_republic" ? readSecrets<TrSecrets>(connection) : null;
  const givve = connection.provider === "givve" ? readSecrets<GivveSecrets>(connection) : null;
  return {
    id: connection.id,
    name: connection.name,
    visibility: connection.visibility,
    owner: owner ? (owner.name ?? owner.username ?? "") : null,
    provider: connection.provider,
    bank: connection.bank,
    status: connection.status,
    remoteAccounts,
    linkedAccounts: linked,
    tanMechanisms: connection.tanMechanisms,
    tanMechanism: fints?.tanMethodId ? String(fints.tanMethodId) : null,
    login: fints?.login ?? (tr ? maskPhone(tr.phone) : null) ?? givve?.email ?? null,
    target: fints
      ? { blz: fints.blz, server: fints.server }
      : isUnofficial(connection.provider)
        ? { service: connection.provider }
        : { bankName: eb?.bankName ?? "", country: eb?.country ?? "" },
    consentValidUntil: connection.consentValidUntil?.toISOString() ?? null,
    lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
    lastError: readText(connection.lastError, locale),
    activeJobId: activeJobFor(connection.id)?.id ?? null,
    skipSyncAll: connection.skipSyncAll,
    unofficial: isUnofficial(connection.provider),
  };
}

/** The connections the viewer manages: all for superusers, the household's and their own for family admins, their own for members. */
export async function listConnections(db: Db, viewer: Viewer): Promise<ConnectionView[]> {
  const ids = await manageableConnectionIds(db, viewer);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(bankConnections)
    .where(inArray(bankConnections.id, ids))
    .orderBy(asc(bankConnections.name), asc(bankConnections.id));
  return Promise.all(rows.map((row) => connectionView(db, viewer, row)));
}

// ---- create, update, delete

const presetKeys = FINTS_PRESETS.map((p) => p.key) as [string, ...string[]];

const phoneSchema = z
  .string()
  .transform((v) =>
    v
      .replace(/[\s/()-]/g, "")
      .replace(/^00/, "+")
      .replace(/^0(?=1)/, "+49"),
  )
  .pipe(z.string().regex(/^\+\d{8,15}$/, "banking.errors.phoneFormat"));

export const createConnectionInput = z.object({
  name: z.string().trim().min(1, "banking.errors.nameRequired").max(100),
  /** Members only connect private banks; omitted means household for the household's admins. */
  visibility: z.enum(VISIBILITIES).optional(),
  bank: z.string().trim().min(1).max(32).optional(),
  fints: z
    .object({
      preset: z.enum(presetKeys).optional(),
      blz: z
        .string()
        .trim()
        .regex(/^\d{8}$/, "banking.errors.blzFormat")
        .optional(),
      server: z
        .url("banking.errors.serverInvalid")
        .refine((url) => url.startsWith("https://"), "banking.errors.serverHttps")
        .optional(),
      login: z.string().trim().min(1, "banking.errors.loginRequired").max(100),
      customerId: z.string().trim().max(100).optional(),
      pin: z.string().min(1, "banking.errors.pinRequired").max(100),
    })
    .optional(),
  enableBanking: z
    .object({
      bankName: z.string().trim().min(1, "banking.errors.bankRequired").max(100),
      country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "banking.errors.countryCode"),
    })
    .optional(),
  tradeRepublic: z
    .object({
      phone: phoneSchema,
      pin: z.string().regex(/^\d{4}$/, "banking.errors.trPinFormat"),
      acknowledged: z.literal(true, "banking.errors.acknowledgeRequired"),
    })
    .optional(),
  givve: z
    .object({
      email: z.email("banking.errors.emailInvalid").max(200),
      password: z.string().min(1, "banking.errors.passwordRequired").max(200),
      acknowledged: z.literal(true, "banking.errors.acknowledgeRequired"),
    })
    .optional(),
});

export type CreateConnectionResult = { connection: ConnectionView; job: JobView | null; url: string | null };

const DEFAULT_CONSENT_SECONDS = 90 * 24 * 3600;
const PENDING_STATE_MAX_AGE_MS = 60 * 60_000;

/** Starts the bank login; the consent runs as long as the bank allows (90 days if it does not say). */
async function beginAuthorization(db: Db, bankName: string, country: string): Promise<{ url: string; state: string; validUntil: Date }> {
  const client = await configuredEbClient(db);
  const bank = (await client.banks(country)).find((b) => b.name === bankName);
  const seconds = bank?.maximumConsentValidity || DEFAULT_CONSENT_SECONDS;
  const validUntil = new Date(deps.now().getTime() + seconds * 1000 - 5 * 60_000);
  const state = randomBytes(24).toString("base64url");
  const url = await client.startAuthorization({ bank: bankName, country, redirectUrl: bankRedirectUrl(), state, validUntil });
  console.info(`Bank authorization started: ${bankName} (${country}), return to ${bankRedirectUrl()}`);
  return { url, state, validUntil };
}

export async function createConnection(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof createConnectionInput>,
): Promise<CreateConnectionResult> {
  const data = createConnectionInput.parse(input);
  const visibility = data.visibility ?? (managesHousehold(viewer) ? "household" : "private");
  if (visibility === "household" && !managesHousehold(viewer)) throw new Forbidden(msg("settings.errors.householdOnlyAdmins"));
  const owned = { ownerUserId: viewer.id, visibility };
  const given = (["fints", "enableBanking", "tradeRepublic", "givve"] as const).filter((key) => data[key] !== undefined);
  if (given.length !== 1) throw new UserError(msg("banking.errors.chooseProvider"));
  const provider = ({ fints: "fints", enableBanking: "enable_banking", tradeRepublic: "trade_republic", givve: "givve" } as const)[
    given[0] as (typeof given)[number]
  ];
  await requireAvailable(db, provider);

  if (data.tradeRepublic || data.givve) {
    const secrets: TrSecrets | GivveSecrets = data.tradeRepublic
      ? { phone: data.tradeRepublic.phone, pin: data.tradeRepublic.pin, deviceId: randomBytes(64).toString("hex"), session: null }
      : { email: data.givve?.email ?? "", password: data.givve?.password ?? "", session: null };
    const [row] = await db
      .insert(bankConnections)
      .values({ name: data.name, provider, bank: provider, status: "new", ciphertext: sealSecrets(secrets), skipSyncAll: true, ...owned })
      .returning();
    if (!row) throw new UserError(msg("banking.errors.createFailed"));
    // Log in right away: the app approval or e-mail code is asked for while the dialog is still open.
    const job = startJob(row.id, "discover", { name: row.name, startedBy: viewer.id }, (j) => discoverWork(db, j, row, viewer));
    await recordCreated(db, viewer, row);
    return { connection: await connectionView(db, viewer, row), job: await viewJob(db, viewer, job), url: null };
  }

  if (data.fints) {
    try {
      await fintsProduct(db);
    } catch (error) {
      asUserError(error, 400);
    }
    const preset = FINTS_PRESETS.find((p) => p.key === data.fints?.preset);
    const blz = data.fints.blz ?? preset?.blz;
    const server = data.fints.server ?? preset?.server;
    if (!blz || !server) throw new UserError(msg("banking.errors.fintsTarget"));
    const secrets: FintsSecrets = {
      blz,
      server,
      login: data.fints.login,
      customerId: data.fints.customerId || null,
      pin: data.fints.pin,
      tanMethodId: null,
      tanMediaName: null,
      bankingInformation: null,
    };
    const [row] = await db
      .insert(bankConnections)
      .values({
        name: data.name,
        provider,
        bank: data.bank ?? preset?.key ?? "fints",
        status: "new",
        ciphertext: sealSecrets(secrets),
        ...owned,
      })
      .returning();
    if (!row) throw new UserError(msg("banking.errors.createFailed"));
    // Discover right away, so a wrong login or PIN shows up while the dialog is still open.
    const job = startJob(row.id, "discover", { name: row.name, startedBy: viewer.id }, (j) => discoverWork(db, j, row, viewer));
    await recordCreated(db, viewer, row);
    return { connection: await connectionView(db, viewer, row), job: await viewJob(db, viewer, job), url: null };
  }

  if (!data.enableBanking) throw new UserError(msg("banking.errors.chooseProvider"));
  const { bankName, country } = data.enableBanking;
  let auth: Awaited<ReturnType<typeof beginAuthorization>>;
  try {
    auth = await beginAuthorization(db, bankName, country);
  } catch (error) {
    asUserError(error);
  }
  const secrets: EbSecrets = {
    bankName,
    country,
    sessionId: null,
    pendingState: auth.state,
    pendingStateAt: deps.now().toISOString(),
    pendingValidUntil: auth.validUntil.toISOString(),
  };
  const bank =
    data.bank ??
    (bankName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) ||
      "bank");
  const [row] = await db
    .insert(bankConnections)
    .values({ name: data.name, provider, bank, status: "new", ciphertext: sealSecrets(secrets), ...owned })
    .returning();
  if (!row) throw new UserError(msg("banking.errors.createFailed"));
  await recordCreated(db, viewer, row);
  return { connection: await connectionView(db, viewer, row), job: null, url: auth.url };
}

const connectionTarget = (connection: Pick<Connection, "id">) => ({ type: "bank_connection", id: connection.id });

function recordCreated(db: Db, viewer: Viewer, row: Connection): Promise<void> {
  return record(db, {
    action: "bank.connectionCreated",
    actor: viewer,
    target: connectionTarget(row),
    details: { name: row.name, provider: PROVIDER_NAMES[row.provider], visibility: row.visibility },
  });
}

export const idInput = z.object({ id: z.number().int() });
export const deleteConnectionInput = idInput.extend({ keepAccounts: z.boolean().default(true) });

/** Renews (or retries) the Enable Banking consent; returns the bank's login address. */
export async function authorizeConnection(db: Db, viewer: Viewer, input: z.input<typeof idInput>): Promise<{ url: string }> {
  const connection = await requireManageableConnection(db, viewer, idInput.parse(input).id);
  if (connection.provider !== "enable_banking") throw new UserError(msg("banking.errors.ebOnly"));
  const secrets = readSecrets<EbSecrets>(connection);
  let auth: Awaited<ReturnType<typeof beginAuthorization>>;
  try {
    auth = await beginAuthorization(db, secrets.bankName, secrets.country);
  } catch (error) {
    asUserError(error);
  }
  await db
    .update(bankConnections)
    .set({
      ciphertext: sealSecrets({
        ...secrets,
        pendingState: auth.state,
        pendingStateAt: deps.now().toISOString(),
        pendingValidUntil: auth.validUntil.toISOString(),
      }),
    })
    .where(eq(bankConnections.id, connection.id));
  return { url: auth.url };
}

export const completeInput = z.object({
  code: z.string().trim().max(2000).optional(),
  state: z.string().trim().max(200).optional(),
  error: z.string().trim().max(200).optional(),
  errorDescription: z.string().trim().max(500).optional(),
  redirectedUrl: z.string().trim().max(4000).optional(),
});

function completionParams(data: z.infer<typeof completeInput>): { code: string; state: string } {
  let { code, state, error, errorDescription } = data;
  if (data.redirectedUrl) {
    let url: URL;
    try {
      url = new URL(data.redirectedUrl);
    } catch {
      throw new UserError(msg("banking.errors.invalidAddress"));
    }
    const query = url.searchParams;
    code = query.get("code") ?? undefined;
    state = query.get("state") ?? undefined;
    error = query.get("error") ?? undefined;
    errorDescription = query.get("error_description") ?? undefined;
  }
  if (error) {
    const reason = (errorDescription || error).slice(0, 200);
    throw new UserError(
      isRestrictedAppError(reason) ? msg("banking.errors.restrictedApp") : msg("banking.errors.bankRejected", { reason }),
    );
  }
  if (!code || !state) throw new UserError(msg("banking.errors.codeMissing"));
  return { code, state };
}

/** `message` says what came of the bank login; a sync of its accounts is already running when `job` is set. */
export type AuthorizationResult = { connection: ConnectionView; job: JobView | null; message: string; tone: "ok" | "warn" };

/**
 * Completes the bank login with code and state. The state is single-use: it is consumed before the session is created.
 * Only connections the viewer manages are candidates, so nobody completes someone else's login. The accounts of the
 * consent are fetched right away; a consent without accounts (e.g. a restricted app whose control panel does not
 * list the bank's accounts yet) leaves the connection waiting for a renewal.
 */
export async function completeAuthorization(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof completeInput>,
  psu: PsuHeaders = {},
): Promise<AuthorizationResult> {
  const { code, state } = completionParams(completeInput.parse(input));
  const manageable = await manageableConnectionIds(db, viewer);
  const candidates =
    manageable.length === 0
      ? []
      : await db
          .select()
          .from(bankConnections)
          .where(and(eq(bankConnections.provider, "enable_banking"), inArray(bankConnections.id, manageable)));
  const connection = candidates.find((c) => readSecrets<EbSecrets>(c).pendingState === state);
  if (!connection) throw new UserError(msg("banking.errors.unknownAuthorization"));
  const pending = readSecrets<EbSecrets>(connection);
  const consumed: EbSecrets = { ...pending, pendingState: null, pendingStateAt: null };
  const claimed = await db
    .update(bankConnections)
    .set({ ciphertext: sealSecrets(consumed) })
    .where(and(eq(bankConnections.id, connection.id), eq(bankConnections.ciphertext, connection.ciphertext)))
    .returning({ id: bankConnections.id });
  if (claimed.length === 0) throw new UserError(msg("banking.errors.unknownAuthorization"));
  if (!pending.pendingStateAt || deps.now().getTime() - new Date(pending.pendingStateAt).getTime() > PENDING_STATE_MAX_AGE_MS) {
    throw new UserError(msg("banking.errors.authorizationExpired"));
  }

  let session: Awaited<ReturnType<EnableBankingClient["createSession"]>>;
  let client: EnableBankingClient;
  const audit = {
    action: pending.sessionId ? ("bank.connectionRenewed" as const) : ("bank.connectionAuthorized" as const),
    actor: viewer,
    target: connectionTarget(connection),
  };
  try {
    client = await configuredEbClient(db);
    session = await client.createSession(code);
  } catch (error) {
    const failure =
      error instanceof BankError && isRestrictedAppError(error.message) ? msg("banking.errors.restrictedApp") : failureText(error);
    await record(db, { ...audit, outcome: "failed", details: { name: connection.name, reason: failureReason(failure) } });
    if (error instanceof BankError) {
      await db
        .update(bankConnections)
        .set({ status: "error", lastError: storeText(failure) })
        .where(eq(bankConnections.id, connection.id));
    }
    asUserError(error);
  }
  if (pending.sessionId && pending.sessionId !== session.sessionId) {
    // The old consent expires on its own; a failed delete must not block the renewal.
    await client.deleteSession(pending.sessionId).catch(() => undefined);
  }

  const known = new Set(session.accounts.map((a) => a.ref));
  const previous = new Map(connection.remoteAccounts.map((a) => [a.ref, a]));
  const validUntil = session.validUntil ?? (pending.pendingValidUntil ? new Date(pending.pendingValidUntil) : null);
  await db.transaction(async (tx) => {
    await tx
      .update(bankConnections)
      .set({
        ciphertext: sealSecrets({ ...consumed, sessionId: session.sessionId, pendingValidUntil: null }),
        remoteAccounts: session.accounts,
        consentValidUntil: validUntil,
        status: session.accounts.length > 0 ? "active" : "no_accounts",
        lastError: "",
      })
      .where(eq(bankConnections.id, connection.id));
    // A renewed consent comes with new account uids; relink by IBAN where possible.
    const linked = await tx.select().from(accounts).where(eq(accounts.connectionId, connection.id));
    for (const account of linked) {
      if (account.remoteRef && known.has(account.remoteRef)) continue;
      const iban = account.iban ?? (account.remoteRef ? previous.get(account.remoteRef)?.iban : null) ?? null;
      const match = iban ? session.accounts.find((a) => a.iban && a.iban.replace(/\s+/g, "") === iban) : undefined;
      await tx
        .update(accounts)
        .set(match ? { remoteRef: match.ref } : { connectionId: null, remoteRef: null })
        .where(eq(accounts.id, account.id));
    }
  });
  await record(db, { ...audit, details: { name: connection.name } });
  const created = await adoptRemoteAccounts(db, connection.id, viewer);
  const stored = await loadConnection(db, connection.id);
  const job = (await linkedAccounts(db, connection.id)).length > 0 ? beginSync(db, stored, psu, viewer) : null;
  const { name } = connection;
  const message =
    session.accounts.length === 0
      ? msg("banking.authorizedNoAccounts", { name })
      : !job
        ? msg("banking.authorizedCovered", { name })
        : created > 0
          ? msg("banking.authorized", { name, count: created })
          : msg("banking.renewed", { name });
  const locale = viewerLocale(viewer);
  return {
    connection: await connectionView(db, viewer, stored),
    job: job ? await viewJob(db, viewer, job) : null,
    message: render(locale, message),
    tone: session.accounts.length === 0 ? "warn" : "ok",
  };
}

export const updateConnectionInput = z.object({
  id: z.number().int(),
  name: z.string().trim().min(1).max(100).optional(),
  login: z.string().trim().min(1).max(100).optional(),
  customerId: z.string().trim().max(100).optional(),
  pin: z.string().min(1).max(100).optional(),
  // Empty string: choose automatically again.
  tanMechanism: z
    .string()
    .trim()
    .regex(/^\d{0,5}$/)
    .optional(),
});

export async function updateConnection(db: Db, viewer: Viewer, input: z.input<typeof updateConnectionInput>): Promise<ConnectionView> {
  const data = updateConnectionInput.parse(input);
  const connection = await requireManageableConnection(db, viewer, data.id);
  const update: Partial<typeof bankConnections.$inferInsert> = {};
  if (data.name) update.name = data.name;
  if (connection.provider === "fints") {
    const secrets = readSecrets<FintsSecrets>(connection);
    if (data.login) secrets.login = data.login;
    if (data.customerId !== undefined) secrets.customerId = data.customerId || null;
    if (data.pin) secrets.pin = data.pin;
    if (data.tanMechanism !== undefined) {
      secrets.tanMethodId = data.tanMechanism ? Number(data.tanMechanism) : null;
      secrets.tanMediaName = null;
    }
    update.ciphertext = sealSecrets(secrets);
  } else if (connection.provider === "trade_republic") {
    const secrets = readSecrets<TrSecrets>(connection);
    if (data.login) secrets.phone = phoneSchema.parse(data.login);
    if (data.pin)
      secrets.pin = z
        .string()
        .regex(/^\d{4}$/, "banking.errors.trPinFormat")
        .parse(data.pin);
    // Other credentials end the stored session, so the next fetch logs in with them.
    if (data.login || data.pin) secrets.session = null;
    update.ciphertext = sealSecrets(secrets);
  } else if (connection.provider === "givve") {
    const secrets = readSecrets<GivveSecrets>(connection);
    if (data.login) secrets.email = z.email("banking.errors.emailInvalid").parse(data.login);
    if (data.pin) secrets.password = data.pin;
    if (data.login || data.pin) secrets.session = null;
    update.ciphertext = sealSecrets(secrets);
  }
  if (Object.keys(update).length > 0) await db.update(bankConnections).set(update).where(eq(bankConnections.id, data.id));
  const { id: _, ...fields } = data;
  await record(db, {
    action: "bank.connectionUpdated",
    actor: viewer,
    target: connectionTarget(connection),
    details: {
      name: data.name ?? connection.name,
      changed: Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined),
    },
  });
  return connectionView(db, viewer, await loadConnection(db, data.id));
}

/** Its accounts stay with their bookings as accounts without a bank connection, or go with it (those the viewer manages). */
export async function deleteConnection(db: Db, viewer: Viewer, input: z.input<typeof deleteConnectionInput>): Promise<void> {
  const { id, keepAccounts } = deleteConnectionInput.parse(input);
  const connection = await requireManageableConnection(db, viewer, id);
  activeJobFor(connection.id)?.cancel();
  if (connection.provider === "enable_banking") {
    const { sessionId } = readSecrets<EbSecrets>(connection);
    if (sessionId) {
      // The consent expires on its own; removing the local link must not depend on the bank.
      await configuredEbClient(db)
        .then((client) => client.deleteSession(sessionId))
        .catch(() => undefined);
    }
  }
  await db.transaction(async (tx) => {
    if (!keepAccounts) {
      const linked = await tx.select().from(accounts).where(eq(accounts.connectionId, connection.id));
      const removed = linked.filter((a) => canManage(viewer, a)).map((a) => a.id);
      if (removed.length > 0) await tx.delete(accounts).where(inArray(accounts.id, removed));
    }
    const kept = await tx
      .update(accounts)
      .set({ connectionId: null, remoteRef: null })
      .where(eq(accounts.connectionId, connection.id))
      .returning({ id: accounts.id });
    await dropPendingBookings(
      tx,
      kept.map((a) => a.id),
    );
    await tx.delete(bankConnections).where(eq(bankConnections.id, connection.id));
  });
  await record(db, {
    action: "bank.connectionDeleted",
    actor: viewer,
    target: connectionTarget(connection),
    details: { name: connection.name, keepAccounts },
  });
}

// ---- account mapping

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "banking.errors.colorFormat");

export const linkInput = z.object({
  connectionId: z.number().int(),
  remoteRef: z.string().min(1).max(128),
  accountId: z.number().int().optional(),
  newAccount: z
    .object({
      name: z.string().trim().min(1).max(100),
      kind: z.enum(ACCOUNT_KINDS).default("checking"),
      color: hexColor.default("#1f6f5c"),
      groupIds: z.array(z.number().int()).default([]),
    })
    .optional(),
});

function cleanIban(value: string | null | undefined): string | null {
  const iban = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) ? iban : null;
}

/** New accounts belong to the connection's owner and share its visibility. */
export async function linkAccount(db: Db, viewer: Viewer, input: z.input<typeof linkInput>): Promise<ConnectionView> {
  const data = linkInput.parse(input);
  const connection = await requireManageableConnection(db, viewer, data.connectionId);
  const remote = connection.remoteAccounts.find((a) => a.ref === data.remoteRef);
  if (!remote) throw new UserError(msg("banking.errors.unknownRemote"));
  if (data.accountId === undefined && !data.newAccount) throw new UserError(msg("banking.errors.accountRequired"));
  const iban = cleanIban(remote.iban);
  // Relinking takes the bank account away from the Saldo account it feeds now, which needs authority over that one too.
  const [bound] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.connectionId, connection.id), eq(accounts.remoteRef, data.remoteRef)));
  if (bound) await requireManageableAccount(db, viewer, bound.id);
  await db.transaction(async (tx) => {
    let accountId = data.accountId;
    if (accountId !== undefined) await requireManageableAccount(tx, viewer, accountId);
    else if (data.newAccount) {
      accountId = await createAccount(
        tx,
        viewer,
        { ...data.newAccount, bank: connection.bank, iban, visibility: connection.visibility },
        connection.ownerUserId,
      );
    }
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId ?? -1));
    if (!account) throw new NotFound(msg("banking.errors.accountNotFound"));
    const released = await tx
      .update(accounts)
      .set({ connectionId: null, remoteRef: null })
      .where(and(eq(accounts.connectionId, connection.id), eq(accounts.remoteRef, data.remoteRef)))
      .returning({ id: accounts.id });
    await dropPendingBookings(tx, [...released.map((a) => a.id), account.id]);
    await tx
      .update(accounts)
      .set({ connectionId: connection.id, remoteRef: data.remoteRef, iban: account.iban ?? iban })
      .where(eq(accounts.id, account.id));
  });
  await reclassifyAll(db);
  return connectionView(db, viewer, connection);
}

export const unlinkInput = z.object({ connectionId: z.number().int(), accountId: z.number().int() });

export async function unlinkAccount(db: Db, viewer: Viewer, input: z.input<typeof unlinkInput>): Promise<ConnectionView> {
  const data = unlinkInput.parse(input);
  const connection = await requireManageableConnection(db, viewer, data.connectionId);
  await requireManageableAccount(db, viewer, data.accountId);
  const updated = await db
    .update(accounts)
    .set({ connectionId: null, remoteRef: null })
    .where(and(eq(accounts.id, data.accountId), eq(accounts.connectionId, connection.id)))
    .returning({ id: accounts.id });
  if (updated.length === 0) throw new NotFound(msg("banking.errors.notLinked"));
  await dropPendingBookings(db, [data.accountId]);
  return connectionView(db, viewer, connection);
}

// ---- jobs: discover and sync

const PRIVATE_IP = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

/** Home-network and container addresses mean nothing to a bank, and some banks reject the request when they get one. */
export function isPublicIp(ip: string): boolean {
  const plain = ip.replace(/^::ffff:/i, "");
  return plain.length > 0 && !PRIVATE_IP.some((range) => range.test(plain));
}

const PUBLIC_IP_TTL_MS = 60 * 60_000;
let publicIpCache: { value: string | null; at: number } | null = null;

/** The household's public address as the bank would see the person, looked up once an hour (one plain GET, no data). */
export async function resolvePsuIp(
  requestIp: string | undefined,
  options: { fixed: string; lookup: boolean } = { fixed: env().PSU_IP_ADDRESS, lookup: env().PSU_IP_LOOKUP === "on" },
): Promise<string | null> {
  if (requestIp && isPublicIp(requestIp)) return requestIp;
  if (options.fixed) return options.fixed;
  if (!options.lookup) return null;
  if (publicIpCache && deps.now().getTime() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.value;
  let value: string | null = null;
  try {
    const response = await (deps.fetch ?? fetch)("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
    const text = (await response.text()).trim();
    value = response.ok && /^[\d.:a-f]{3,45}$/i.test(text) && isPublicIp(text) ? text : null;
  } catch {
    value = null;
  }
  publicIpCache = { value, at: deps.now().getTime() };
  return value;
}

export function resetPsuIpCache(): void {
  publicIpCache = null;
}

/** Psu-* headers tell the bank a person is present, which lifts the unattended-access limits; some banks require them. */
export async function psuHeaders(request: Request): Promise<PsuHeaders> {
  const headers: PsuHeaders = {};
  const ip = await resolvePsuIp(clientIp(request) ?? undefined);
  if (ip) headers["Psu-Ip-Address"] = ip;
  const agent = request.headers.get("user-agent");
  if (agent) headers["Psu-User-Agent"] = agent.slice(0, 200);
  return headers;
}

/**
 * `holdings` only for depots whose positions were read; they replace the stored ones and set the balance. `pending` replaces
 * the account's pending bookings; providers that deliver none leave it out, which empties them.
 */
type Fetched = {
  accountId: number;
  accountName: string;
  bookings: RawBooking[];
  pending?: RawPendingBooking[];
  balance: RemoteBalance | null;
  holdings?: RawHolding[] | null;
};

async function linkedAccounts(db: Db, connectionId: number) {
  return (await db.select().from(accounts).where(eq(accounts.connectionId, connectionId)).orderBy(asc(accounts.name))).filter(
    (a): a is typeof a & { remoteRef: string } => Boolean(a.remoteRef),
  );
}

/**
 * Every account the bank delivers becomes a Saldo account of the connection's owner with the connection's visibility.
 * An unlinked account of the owner with the same IBAN is linked instead of creating a twin; one another connection
 * already fetches stays with that connection and is marked as covered here. Returns the number of new links.
 */
export async function adoptRemoteAccounts(db: Db, connectionId: number, actor: { id: string } | null): Promise<number> {
  const connection = await loadConnection(db, connectionId);
  const [owner] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, connection.ownerUserId));
  if (!owner) return 0;
  const linked = new Set((await db.select().from(accounts).where(eq(accounts.connectionId, connectionId))).map((a) => a.remoteRef));
  let adopted = 0;
  const remotes: RemoteAccountJson[] = [];
  for (const remote of connection.remoteAccounts) {
    const iban = cleanIban(remote.iban);
    const [covering] =
      iban && !linked.has(remote.ref)
        ? await db
            .select({ connectionId: bankConnections.id, name: bankConnections.name, provider: bankConnections.provider })
            .from(accounts)
            .innerJoin(bankConnections, eq(accounts.connectionId, bankConnections.id))
            .where(and(eq(accounts.iban, iban), isNotNull(accounts.connectionId), ne(accounts.connectionId, connectionId)))
            .limit(1)
        : [];
    remotes.push(remote.coveredBy || covering ? { ...remote, coveredBy: covering ?? null } : remote);
    if (linked.has(remote.ref) || covering) continue;
    const twins = iban
      ? await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.iban, iban), isNull(accounts.connectionId)))
      : [];
    const twin = twins.find((a) => canManage(owner, a));
    if (twin) {
      await db.update(accounts).set({ connectionId, remoteRef: remote.ref }).where(eq(accounts.id, twin.id));
    } else {
      const name = remoteAccountName(remote, connection.name);
      const [row] = await db
        .insert(accounts)
        .values({
          name,
          bank: connection.bank,
          kind: guessAccountKind(remote),
          iban,
          connectionId,
          remoteRef: remote.ref,
          ownerUserId: connection.ownerUserId,
          visibility: connection.visibility,
        })
        .returning({ id: accounts.id });
      if (row) {
        await record(db, {
          action: "accounts.created",
          actor,
          target: { type: "account", id: row.id },
          details: { name, visibility: connection.visibility },
        });
      }
    }
    adopted += 1;
  }
  if (JSON.stringify(remotes) !== JSON.stringify(connection.remoteAccounts)) {
    await db.update(bankConnections).set({ remoteAccounts: remotes }).where(eq(bankConnections.id, connectionId));
  }
  if (adopted > 0) await reclassifyAll(db);
  return adopted;
}

/** Database rejections of bank data take the same path as bank errors: rollback and a visible status. */
async function storeResults(
  db: Db,
  job: Job,
  connectionId: number,
  fetched: Fetched[],
  source: string,
  discovered: { remoteAccounts: RemoteAccount[]; tanMechanisms: Record<string, string> } | null,
): Promise<void> {
  job.progress(msg("banking.job.saving"));
  try {
    const added: number[] = [];
    const unread: number[] = [];
    const results: AccountResult[] = [];
    await db.transaction(async (tx) => {
      if (discovered) await tx.update(bankConnections).set(discovered).where(eq(bankConnections.id, connectionId));
      for (const item of fetched) {
        const imported = await importBookings(tx, item.accountId, item.bookings, source, today());
        await replacePendingBookings(tx, item.accountId, item.pending ?? [], deps.now());
        added.push(...imported.ids);
        unread.push(...imported.unreadIds);
        results.push({
          accountId: item.accountId,
          name: item.accountName,
          newBookings: imported.ids.length,
          firstImport: imported.firstImport,
        });
        if (item.holdings) {
          await replaceHoldings(tx, item.accountId, item.holdings, item.balance?.amountCents ?? 0, item.balance?.date ?? today());
        } else if (item.balance && Number.isSafeInteger(item.balance.amountCents)) {
          await tx
            .update(accounts)
            .set({ balanceCents: item.balance.amountCents, balanceDate: item.balance.date })
            .where(eq(accounts.id, item.accountId));
        }
      }
    });
    job.newBookings = added.length;
    job.transactionIds = added;
    job.unreadTransactionIds = unread;
    job.accounts = results;
    job.accountsSynced = fetched.length;
    if (fetched.length > 0) {
      job.progress(msg("banking.job.assigning"));
      await reclassifyAll(db);
      await relinkContracts(db);
    }
  } catch (error) {
    if (error instanceof BankError || isCancellation(error)) throw error;
    // Not the error itself: driver messages carry the statement parameters, i.e. booking data.
    console.error(`Storing bank data failed: ${error instanceof Error ? error.name : typeof error}`);
    throw new SaldoBankError(msg("banking.errors.storeFailed"));
  }
}

async function recordOutcome(db: Db, connectionId: number, kind: JobKind, error: unknown, ciphertext?: string): Promise<void> {
  const update: Partial<typeof bankConnections.$inferInsert> = ciphertext ? { ciphertext } : {};
  if (error === null) {
    Object.assign(update, { status: "active", lastError: "" }, kind === "sync" ? { lastSyncAt: deps.now() } : {});
  } else if (!isCancellation(error)) {
    update.status = error instanceof ReauthRequired ? "needs_reauth" : "error";
    update.lastError = storeText(failureText(error));
  }
  if (Object.keys(update).length > 0) await db.update(bankConnections).set(update).where(eq(bankConnections.id, connectionId));
}

async function runFints(db: Db, job: Job, connectionId: number, discoverOnly: boolean): Promise<void> {
  const connection = await loadConnection(db, connectionId);
  const secrets = readSecrets<FintsSecrets>(connection);
  const kind: JobKind = discoverOnly ? "discover" : "sync";
  let session: FinTSSession | null = null;
  const sealed = () => (session ? sealSecrets({ ...secrets, ...session.state() }) : undefined);
  try {
    const product = await fintsProduct(db);
    session = new FinTSSession(deps.fintsClient({ ...product, ...secrets }), (challenge) => job.askTan(challenge), secrets.tanMethodId);
    let discovered: { remoteAccounts: RemoteAccount[]; tanMechanisms: Record<string, string> } | null = null;
    if (discoverOnly || !secrets.bankingInformation?.upd) {
      job.progress(msg("banking.job.checkingAccess"));
      const result = await session.synchronize();
      discovered = { remoteAccounts: result.accounts, tanMechanisms: result.tanMethods };
    }
    const fetched: Fetched[] = [];
    if (!discoverOnly) {
      const day = today();
      const linked = await linkedAccounts(db, connectionId);
      for (const account of linked) {
        job.steps = { done: fetched.length, total: linked.length };
        job.progress(msg("banking.job.fetchingBookings", { account: account.name }), account.id);
        const result = await session.fetchAccount(account.remoteRef, await fetchStart(db, account.id, day), day, day);
        fetched.push({ accountId: account.id, accountName: account.name, ...result });
      }
      job.steps = { done: fetched.length, total: linked.length };
    }
    await storeResults(db, job, connectionId, fetched, "fints", discovered);
    await recordOutcome(db, connectionId, kind, null, sealed());
    if (discovered) await adoptRemoteAccounts(db, connectionId, job.origin.startedBy ? { id: job.origin.startedBy } : null);
  } catch (error) {
    await recordOutcome(db, connectionId, kind, error, sealed());
    throw error;
  }
}

async function runEnableBanking(db: Db, job: Job, connectionId: number, psu: PsuHeaders): Promise<void> {
  try {
    const connection = await loadConnection(db, connectionId);
    const secrets = readSecrets<EbSecrets>(connection);
    if (!secrets.sessionId) throw new SaldoReauthRequired(msg("banking.errors.notAuthorizedYet"));
    if (connection.consentValidUntil && connection.consentValidUntil.getTime() < deps.now().getTime()) throw new ReauthRequired();
    const client = await configuredEbClient(db, psu);
    const day = today();
    const fetched: Fetched[] = [];
    const linked = await linkedAccounts(db, connectionId);
    for (const account of linked) {
      job.steps = { done: fetched.length, total: linked.length };
      job.progress(msg("banking.job.fetchingBookings", { account: account.name }), account.id);
      const { bookings, pending } = await client.transactions(account.remoteRef, await fetchStart(db, account.id, day));
      job.progress(msg("banking.job.fetchingBalance", { account: account.name }), account.id);
      fetched.push({
        accountId: account.id,
        accountName: account.name,
        bookings,
        pending,
        balance: await client.balance(account.remoteRef, day),
      });
    }
    job.steps = { done: fetched.length, total: linked.length };
    await storeResults(db, job, connectionId, fetched, "eb", null);
    await recordOutcome(db, connectionId, "sync", null);
  } catch (error) {
    await recordOutcome(db, connectionId, "sync", error);
    throw error;
  }
}

/**
 * A stored session of an unofficial provider is reused; when the provider ended it, a person present logs in again
 * (with the app approval or the e-mail code), while an unattended run stops with "needs re-login".
 */
async function unofficialSession<T>(
  job: Job,
  provider: UnofficialProvider,
  stored: T | null,
  resume: (session: T) => Promise<T>,
  login: () => Promise<T>,
): Promise<T> {
  if (stored) {
    try {
      return await resume(stored);
    } catch (error) {
      if (!(error instanceof ReauthRequired)) throw error;
    }
  }
  if (job.unattended) throw new SaldoReauthRequired(msg("banking.errors.reloginNeeded", { provider: providerName(provider) }));
  job.progress(msg("banking.job.loggingIn"));
  return login();
}

async function runUnofficial(db: Db, job: Job, connectionId: number, discoverOnly: boolean): Promise<void> {
  const connection = await loadConnection(db, connectionId);
  const kind: JobKind = discoverOnly ? "discover" : "sync";
  if (connection.provider === "trade_republic") {
    const secrets = readSecrets<TrSecrets>(connection);
    await runWithSession(db, job, connection, kind, secrets, async () => {
      const client = deps.tradeRepublic();
      secrets.session = await unofficialSession(
        job,
        "trade_republic",
        secrets.session,
        (session) => client.refresh(session),
        () => client.login(secrets.phone, secrets.pin, secrets.deviceId, (challenge) => job.askTan(challenge)),
      );
      const account = await client.accountFacts(secrets.session);
      secrets.session = account.session;
      const remoteAccounts = client.remoteAccounts(account.facts);
      const fetched: Fetched[] = [];
      if (!discoverOnly) {
        const linked = await linkedAccounts(db, connectionId);
        const cash = linked.find((a) => a.remoteRef === TR_CASH_REF);
        const depot = linked.find((a) => a.remoteRef === TR_DEPOT_REF);
        const first = cash ?? depot;
        if (first) {
          const day = today();
          job.progress(msg("banking.job.fetchingBookings", { account: first.name }), first.id);
          const since = cash ? await fetchStart(db, cash.id, day) : day;
          const snapshot = await client.snapshot(
            secrets.session,
            account.facts,
            { cash: Boolean(cash), depot: Boolean(depot) },
            since,
            day,
          );
          if (cash) fetched.push({ accountId: cash.id, accountName: cash.name, bookings: snapshot.bookings, balance: snapshot.cash });
          if (depot) {
            fetched.push({
              accountId: depot.id,
              accountName: depot.name,
              bookings: [],
              balance: snapshot.depotTotal,
              holdings: snapshot.holdings,
            });
          }
        }
      }
      return { fetched, remoteAccounts, source: "tr" };
    });
    return;
  }
  const secrets = readSecrets<GivveSecrets>(connection);
  await runWithSession(db, job, connection, kind, secrets, async () => {
    const client = deps.givve();
    secrets.session = await unofficialSession(
      job,
      "givve",
      secrets.session,
      (session) => client.resume(session),
      () => client.login(secrets.email, secrets.password, (challenge) => job.askTan(challenge)),
    );
    const session = secrets.session;
    const remoteAccounts = await client.cards(session);
    const fetched: Fetched[] = [];
    if (!discoverOnly) {
      const day = today();
      const linked = await linkedAccounts(db, connectionId);
      for (const account of linked) {
        job.steps = { done: fetched.length, total: linked.length };
        job.progress(msg("banking.job.fetchingBookings", { account: account.name }), account.id);
        const bookings = await client.transactions(session, account.remoteRef, await fetchStart(db, account.id, day));
        fetched.push({
          accountId: account.id,
          accountName: account.name,
          bookings,
          balance: await client.balance(session, account.remoteRef, day),
        });
      }
      job.steps = { done: fetched.length, total: linked.length };
    }
    return { fetched, remoteAccounts, source: "givve" };
  });
}

/** Stores the run's results and the (renewed or ended) session; an ended session is dropped, so the next run logs in. */
async function runWithSession(
  db: Db,
  job: Job,
  connection: Connection,
  kind: JobKind,
  secrets: TrSecrets | GivveSecrets,
  work: () => Promise<{ fetched: Fetched[]; remoteAccounts: RemoteAccount[]; source: string }>,
): Promise<void> {
  try {
    const result = await work();
    await storeResults(db, job, connection.id, result.fetched, result.source, { remoteAccounts: result.remoteAccounts, tanMechanisms: {} });
    await recordOutcome(db, connection.id, kind, null, sealSecrets(secrets));
    await adoptRemoteAccounts(db, connection.id, job.origin.startedBy ? { id: job.origin.startedBy } : null);
  } catch (caught) {
    let error = caught;
    if (error instanceof ReauthRequired) {
      secrets.session = null;
      if (!(error instanceof SaldoReauthRequired)) {
        error = new SaldoReauthRequired(msg("banking.errors.reloginNeeded", { provider: providerName(connection.provider) }));
      }
    }
    await recordOutcome(db, connection.id, kind, error, sealSecrets(secrets));
    throw error;
  }
}

const SYNC_FAILED = msg("banking.notify.syncFailed");

function named(name: string, text: Translatable): Translatable {
  return msg("banking.named", { name, text });
}

/** Those who manage the connection hear about failures of unattended runs; a person running a sync sees the result on screen. */
async function reportUnattendedFailure(db: Db, job: Job, connection: Connection, slot: string | null, error: unknown): Promise<void> {
  if (job.approvalNeeded) {
    await notifyBankProblem(
      db,
      connection,
      `bank_tan:${connection.id}:${slot ?? job.id}`,
      named(connection.name, APPROVAL_NEEDED),
      msg("banking.notify.approvalNeededBody"),
    );
  } else if (!isCancellation(error)) {
    await notifyBankProblem(db, connection, `bank_sync_failed:${job.id}`, named(connection.name, SYNC_FAILED), failureText(error));
  }
}

async function syncWork(
  db: Db,
  job: Job,
  connection: Connection,
  psu: PsuHeaders,
  slot: string | null,
  actor: Viewer | null,
): Promise<void> {
  const audit = { actor, target: connectionTarget(connection) };
  const about = { name: connection.name, trigger: slot === null ? "manual" : "scheduled" };
  await record(db, { ...audit, action: "bank.syncStarted", details: about });
  try {
    if (connection.provider === "fints") await runFints(db, job, connection.id, false);
    else if (connection.provider === "enable_banking") await runEnableBanking(db, job, connection.id, psu);
    else await runUnofficial(db, job, connection.id, false);
  } catch (error) {
    const reason = isCancellation(error) ? (job.approvalNeeded ? APPROVAL_NEEDED : msg("banking.job.cancelled")) : failureText(error);
    await record(db, { ...audit, action: "bank.syncFinished", outcome: "failed", details: { ...about, reason: failureReason(reason) } });
    if (job.unattended) await reportUnattendedFailure(db, job, connection, slot, error).catch(logNotifyFailure);
    throw error;
  }
  await record(db, { ...audit, action: "bank.syncFinished", details: { ...about, newBookings: job.newBookings } });
  // Booking texts of a connection only reach the AI when its owner may use it.
  if (await ownerMayUseAi(db, connection)) await categorizeNewBookings(db, job.transactionIds);
  await notifyAfterSync(db, { jobId: job.id, transactionIds: job.unreadTransactionIds }).catch(logNotifyFailure);
}

async function ownerMayUseAi(db: Db, connection: Connection): Promise<boolean> {
  const [owner] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, connection.ownerUserId));
  return owner ? mayUseAi(db, owner) : false;
}

function logNotifyFailure(error: unknown): void {
  console.error(`Sync notifications failed: ${error instanceof Error ? error.name : typeof error}`);
}

async function startSync(db: Db, connection: Connection, psu: PsuHeaders, actor: Viewer | null, slot: string | null = null): Promise<Job> {
  try {
    if (connection.provider === "fints") await fintsProduct(db);
    else if (connection.provider === "enable_banking") await configuredEbClient(db);
    else await requireAvailable(db, connection.provider);
  } catch (error) {
    asUserError(error, 400);
  }
  return beginSync(db, connection, psu, actor, slot);
}

/** Starts the sync without checking the provider setup; a running job of the connection is returned instead. */
function beginSync(db: Db, connection: Connection, psu: PsuHeaders, actor: Viewer | null, slot: string | null = null): Job {
  const origin = { name: connection.name, startedBy: actor?.id ?? null };
  return startJob(connection.id, "sync", origin, (job) => syncWork(db, job, connection, psu, slot, actor), slot !== null);
}

/**
 * Discovery logs in and creates the accounts but fetches no bookings, so a connection never fetched before gets its
 * first sync right after it; the login it just made (TAN, app approval, e-mail code) is reused.
 */
async function discoverWork(db: Db, job: Job, connection: Connection, viewer: Viewer): Promise<void> {
  if (connection.provider === "fints") await runFints(db, job, connection.id, true);
  else await runUnofficial(db, job, connection.id, true);
  const current = await loadConnection(db, connection.id);
  if (current.lastSyncAt || (await linkedAccounts(db, connection.id)).length === 0) return;
  job.afterwards(() => beginSync(db, current, {}, viewer));
}

/** Logs in and lists the accounts (FinTS: BPD/UPD); Enable Banking gets them from the consent instead. */
export async function discoverConnection(db: Db, viewer: Viewer, input: z.input<typeof idInput>): Promise<JobView> {
  const connection = await requireManageableConnection(db, viewer, idInput.parse(input).id);
  if (connection.provider === "enable_banking") throw new UserError(msg("banking.errors.ebNoDiscover"));
  if (isUnofficial(connection.provider)) await requireAvailable(db, connection.provider);
  else {
    try {
      await fintsProduct(db);
    } catch (error) {
      asUserError(error, 400);
    }
  }
  const origin = { name: connection.name, startedBy: viewer.id };
  return viewJob(
    db,
    viewer,
    startJob(connection.id, "discover", origin, (job) => discoverWork(db, job, connection, viewer)),
  );
}

export async function syncConnection(db: Db, viewer: Viewer, input: z.input<typeof idInput>, psu: PsuHeaders = {}): Promise<JobView> {
  const connection = await requireManageableConnection(db, viewer, idInput.parse(input).id);
  return viewJob(db, viewer, await startSync(db, connection, psu, viewer));
}

/** `skipped`: the connection is fetched only on its own request, so "Konten abrufen" left it out. */
export type SyncAllItem = { connectionId: number; job: JobView | null; error: string | null; skipped?: boolean };

/**
 * Starts a sync for every authorized connection the viewer manages with at least one linked account, except those set
 * to be fetched only on their own request (listed as skipped).
 */
export async function syncAll(db: Db, viewer: Viewer, psu: PsuHeaders = {}): Promise<SyncAllItem[]> {
  const ids = await manageableConnectionIds(db, viewer);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(bankConnections)
    .where(and(ne(bankConnections.status, "new"), inArray(bankConnections.id, ids)))
    .orderBy(asc(bankConnections.id));
  const result: SyncAllItem[] = [];
  for (const connection of rows) {
    if ((await linkedAccounts(db, connection.id)).length === 0) continue;
    if (connection.skipSyncAll) {
      result.push({ connectionId: connection.id, job: null, error: null, skipped: true });
      continue;
    }
    try {
      result.push({
        connectionId: connection.id,
        job: await viewJob(db, viewer, await startSync(db, connection, psu, viewer)),
        error: null,
      });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      result.push({ connectionId: connection.id, job: null, error: error.localized(viewerLocale(viewer)) });
    }
  }
  return result;
}

export const jobInput = z.object({ jobId: z.string().min(1).max(64) });
export const tanInput = jobInput.extend({ tan: z.string().trim().min(1, "banking.errors.tanRequired").max(64) });

/** Jobs of connections the viewer does not manage do not exist for them. */
/** A job as the viewer may see it: accounts they cannot see are neither listed nor named. */
async function viewJob(db: Db, viewer: Viewer, job: Job): Promise<JobView> {
  return job.view(viewerLocale(viewer), new Set(await visibleAccountIds(db, viewer)));
}

async function manageableJob(db: Db, viewer: Viewer, jobId: string): Promise<Job | undefined> {
  const job = getJob(jobId);
  return job && (await manageableConnectionIds(db, viewer)).includes(job.connectionId) ? job : undefined;
}

async function requireJob(db: Db, viewer: Viewer, jobId: string): Promise<Job> {
  const job = await manageableJob(db, viewer, jobId);
  if (!job) throw new NotFound(msg("banking.errors.jobNotFound"));
  return job;
}

export type ActiveJob = { id: string; connectionId: number; kind: JobKind; status: JobStatus };

/** Every running job (manual or scheduled) of the viewer's connections, so the shell can show that a fetch is in progress. */
export async function listActiveJobs(db: Db, viewer: Viewer): Promise<ActiveJob[]> {
  const ids = new Set(await manageableConnectionIds(db, viewer));
  return activeJobs()
    .filter((job) => ids.has(job.connectionId))
    .map((job) => ({ id: job.id, connectionId: job.connectionId, kind: job.kind, status: job.status }));
}

export async function getJobView(db: Db, viewer: Viewer, input: z.input<typeof jobInput>): Promise<JobView> {
  return viewJob(db, viewer, await requireJob(db, viewer, jobInput.parse(input).jobId));
}

export async function submitTan(db: Db, viewer: Viewer, input: z.input<typeof tanInput>): Promise<JobView> {
  const data = tanInput.parse(input);
  const job = await manageableJob(db, viewer, data.jobId);
  if (!job) throw new UserError(msg("banking.errors.noTanExpected"), 409);
  job.submitTan(data.tan);
  return viewJob(db, viewer, job);
}

export async function cancelJob(db: Db, viewer: Viewer, input: z.input<typeof jobInput>): Promise<JobView> {
  const job = await requireJob(db, viewer, jobInput.parse(input).jobId);
  job.cancel();
  return viewJob(db, viewer, job);
}

export const skipSyncAllInput = z.object({ id: z.number().int(), skip: z.boolean() });

/** Whether "Konten abrufen" and the schedule leave the connection out; its own fetch is not affected. */
export async function setSkipSyncAll(db: Db, viewer: Viewer, input: z.input<typeof skipSyncAllInput>): Promise<ConnectionView> {
  const data = skipSyncAllInput.parse(input);
  const connection = await requireManageableConnection(db, viewer, data.id);
  await db.update(bankConnections).set({ skipSyncAll: data.skip }).where(eq(bankConnections.id, connection.id));
  await record(db, {
    action: "bank.connectionUpdated",
    actor: viewer,
    target: connectionTarget(connection),
    details: { name: connection.name, changed: ["skipSyncAll"] },
  });
  return connectionView(db, viewer, await loadConnection(db, connection.id));
}

// ---- scheduled sync: one schedule for every connection

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Daily start times as HH:MM in the server's timezone, sorted. */
export type SyncSchedule = { enabled: boolean; times: string[] };

export const scheduleInput = z.object({
  enabled: z.boolean(),
  times: z.array(z.string().regex(TIME, "banking.errors.timeFormat")).max(12, "banking.errors.tooManyTimes"),
});

async function readSchedule(db: Db): Promise<SyncSchedule> {
  const value = (await readSetting(db, KEYS.schedule))?.value as Partial<SyncSchedule> | null | undefined;
  const times = Array.isArray(value?.times) ? value.times.filter((t): t is string => typeof t === "string" && TIME.test(t)) : [];
  return { enabled: value?.enabled === true && times.length > 0, times };
}

/** Superusers set when every connection is fetched; a connection marked "only manually" is left out. */
export async function setSyncSchedule(db: Db, viewer: Viewer, input: z.input<typeof scheduleInput>): Promise<SyncSchedule> {
  requireSuperuser(viewer);
  const data = scheduleInput.parse(input);
  const times = [...new Set(data.times)].sort();
  if (data.enabled && times.length === 0) throw new UserError(msg("banking.errors.timeRequired"));
  const schedule = { enabled: data.enabled, times };
  await writeSetting(db, KEYS.schedule, schedule);
  await record(db, { action: "bank.settingsChanged", actor: viewer, details: { setting: "schedule", ...schedule } });
  return schedule;
}

// A slot missed by more than this (server busy or restarting) is skipped instead of run late.
const CATCH_UP_MINUTES = 15;

function dueSlot(times: string[], now: Date): string | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const due = times.filter((t) => {
    const at = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return at <= minutes && minutes - at < CATCH_UP_MINUTES;
  });
  const latest = due.sort().at(-1);
  return latest ? `${localDay(now)}T${latest}` : null;
}

/** Set up and fetched before (a failed last run included); new, unreleased and logged-out connections wait for a person. */
const SCHEDULABLE_STATUSES = ["active", "error"];

/**
 * Starts an unattended sync for every usable connection not marked "only manually" when a slot of the schedule is due
 * (server timezone). Each connection claims the slot in the database first, so it runs once even if ticks overlap or repeat.
 */
export async function runScheduledSyncs(db: Db, now: Date): Promise<SyncAllItem[]> {
  const schedule = await readSchedule(db);
  const slot = schedule.enabled ? dueSlot(schedule.times, now) : null;
  if (!slot) return [];
  const rows = await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.skipSyncAll, false), inArray(bankConnections.status, SCHEDULABLE_STATUSES)))
    .orderBy(asc(bankConnections.id));
  const result: SyncAllItem[] = [];
  for (const connection of rows) {
    if ((await linkedAccounts(db, connection.id)).length === 0) continue;
    const claimed = await db
      .update(bankConnections)
      .set({ lastScheduledSlot: slot })
      .where(
        and(
          eq(bankConnections.id, connection.id),
          or(isNull(bankConnections.lastScheduledSlot), lt(bankConnections.lastScheduledSlot, slot)),
        ),
      )
      .returning({ id: bankConnections.id });
    if (claimed.length === 0) continue;
    try {
      result.push({ connectionId: connection.id, job: (await startSync(db, connection, {}, null, slot)).view(), error: null });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      await notifyBankProblem(db, connection, `bank_sync_failed:${connection.id}:${slot}`, named(connection.name, SYNC_FAILED), error.text);
      result.push({ connectionId: connection.id, job: null, error: error.message });
    }
  }
  return result;
}

// ---- bank logos: Enable Banking's list, else the provider's own site icon; FinTS has no reliable source

function logoDeps(db: Db, country: string, name: string): LogoDeps {
  return {
    fetch: deps.fetch ?? fetch,
    now: deps.now,
    lookup: async () => {
      const bank = (await (await configuredEbClient(db)).banks(country)).find((b) => b.name === name);
      return bank ? bank.logo : undefined;
    },
  };
}

/** Trade Republic's entry in Enable Banking's list, the same one an Enable Banking connection to it uses. */
const TR_LISTED = { country: "DE", name: "Trade Republic" };

export async function connectionLogo(db: Db, viewer: Viewer, input: z.input<typeof idInput>): Promise<BankLogo | null> {
  const { id } = idInput.parse(input);
  await requireVisibleConnection(db, viewer, id);
  const connection = await loadConnection(db, id);
  const site = { fetch: deps.fetch ?? fetch, now: deps.now };
  switch (connection.provider) {
    case "enable_banking": {
      const { bankName, country } = readSecrets<EbSecrets>(connection);
      if (!bankName || !country) return null;
      return cachedBankLogo(db, { country, name: bankName }, logoDeps(db, country, bankName));
    }
    case "trade_republic": {
      if ((await availableProviders(db)).includes("enable_banking")) {
        const listed = await cachedBankLogo(db, TR_LISTED, logoDeps(db, TR_LISTED.country, TR_LISTED.name));
        if (listed) return listed;
      }
      return cachedSiteIcon(db, SITES.trade_republic, site);
    }
    case "givve":
      return cachedSiteIcon(db, SITES.givve, site);
    default:
      return null;
  }
}

export const bankLogoInput = z.object({ country: banksInput.shape.country, name: z.string().trim().min(1).max(200) });

/** For the bank picker of anyone who may connect a bank: only banks in Enable Banking's list for that country. */
export async function enableBankingLogo(db: Db, _viewer: Viewer, input: z.input<typeof bankLogoInput>): Promise<BankLogo | null> {
  const { country, name } = bankLogoInput.parse(input);
  return cachedBankLogo(db, { country, name }, logoDeps(db, country, name), true);
}
