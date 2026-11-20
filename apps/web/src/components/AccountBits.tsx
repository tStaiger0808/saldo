import { type CSSProperties, type ReactNode, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useI18n } from "../i18n/react.tsx";
import type { Formatter } from "../lib/format.ts";
import type { AccountSummary } from "../server/modules/accounts/index.ts";
import { useBankJobsOptional } from "./BankJobs.tsx";
import { Status, Tag } from "./Status.tsx";

/** FinTS gives no reliable way to the bank's logo, so its connections keep the monogram without asking. */
export function connectionLogoUrl(connection: { id: number; provider: string }): string | null {
  return connection.provider === "fints" ? null : `/api/bank-logo/${connection.id}`;
}

export function bankLogoUrl(country: string, name: string): string {
  return `/api/bank-logo/by-name?${new URLSearchParams({ country, name })}`;
}

/**
 * Bank logo, or the monogram in the given colour while it loads and when there is none. Decorative: the name is
 * always written next to it. The letter stays underneath, so a missing logo changes nothing in the layout.
 */
export function BankBadge({
  label,
  color,
  logo,
  large = false,
  syncing = false,
}: {
  label: string;
  color?: string;
  logo?: string | null;
  large?: boolean;
  /** Draws the progress ring while the connection is being fetched. */
  syncing?: boolean;
}) {
  const [state, setState] = useState<{ src: string; status: "loaded" | "failed" } | null>(null);
  const status = state && state.src === logo ? state.status : null;
  const letter = label.trim().charAt(0).toLocaleUpperCase() || "?";
  const settle = (img: HTMLImageElement | null) => {
    // An image that finished before hydration fires no load event.
    if (!logo || !img?.complete) return;
    const settled = img.naturalWidth > 0 ? "loaded" : "failed";
    setState((prev) => (prev?.src === logo ? prev : { src: logo, status: settled }));
  };
  return (
    <span
      className={large ? "monogram monogram-lg" : "monogram"}
      data-logo={status === "loaded" ? "" : undefined}
      data-syncing={syncing || undefined}
      style={color ? ({ "--account": color } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {letter}
      {logo && status !== "failed" && (
        <img
          key={logo}
          ref={settle}
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState({ src: logo, status: "loaded" })}
          onError={() => setState({ src: logo, status: "failed" })}
        />
      )}
    </span>
  );
}

export function AccountBadge({
  account,
  large = false,
}: {
  account: Pick<AccountSummary, "bankName" | "name" | "color" | "connection">;
  large?: boolean;
}) {
  const jobs = useBankJobsOptional();
  const connectionId = account.connection?.id;
  return (
    <BankBadge
      label={account.bankName || account.name}
      color={account.color}
      logo={account.connection ? connectionLogoUrl(account.connection) : null}
      large={large}
      syncing={connectionId !== undefined && Boolean(jobs?.fetching.has(connectionId))}
    />
  );
}

/** "1 neu" in the account's sub line; the row opens all bookings with the new ones marked on top. */
export function UnreadBadge({ count }: { count: number }) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <span className="unread-badge">
      <span aria-hidden="true">{t("accounts.unreadBadge", { count })}</span>
      <span className="visually-hidden">, {t("accounts.unreadLabel", { count })}</span>
    </span>
  );
}

export function MaskedIban({ last4 }: { last4: string }) {
  const { t } = useI18n();
  return (
    <>
      <span className="mono" aria-hidden="true">
        ···· {last4}
      </span>
      <span className="visually-hidden">{t("accounts.ibanEnding", { digits: last4 })}</span>
    </>
  );
}

/** Groups the IBAN in blocks of four for reading. */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Connected accounts say when they were last fetched (with time); manual ones the date of their balance. `compact`
 * shows only date and time of the fetch; screen readers still hear what the time means.
 */
export function balanceAsOf(
  account: Pick<AccountSummary, "balanceCents" | "balanceDate" | "connection">,
  t: Translate,
  f: Formatter,
  { compact = false }: { compact?: boolean } = {},
): ReactNode {
  const syncedAt = account.connection?.lastSyncAt;
  if (syncedAt && compact)
    return (
      <>
        <span className="visually-hidden">{t("accounts.lastSyncedPrefix")} </span>
        {f.dateTime(syncedAt)}
      </>
    );
  if (syncedAt) return t("accounts.syncedAt", { date: f.dateTime(syncedAt) });
  if (account.balanceDate) return t("accounts.balanceAsOf", { date: f.date(account.balanceDate) });
  if (account.balanceCents === null) return t("accounts.noBalance");
  return null;
}

/** Only shown when the bank connection needs attention; a working connection stays quiet. */
export function AccountStatus({ connection }: { connection: NonNullable<AccountSummary["connection"]> }) {
  const { t, f } = useI18n();
  switch (connection.attention) {
    case "error":
      return <Status tone="danger">{t("accounts.attention.error")}</Status>;
    case "expired":
      return (
        <Status tone="warn" emphasis="notice">
          {t("accounts.attention.expired")}
        </Status>
      );
    case "expiring":
      return <Status tone="warn">{t("accounts.attention.expiring", { date: f.date(connection.consentValidUntil) })}</Status>;
    default:
      return null;
  }
}

/** "Privat", "Geteilt mit …" or "Geteilt von …"; household accounts carry no badge. */
export function SharingBadge({ sharing }: { sharing: AccountSummary["sharing"] }) {
  const { t } = useI18n();
  if (sharing.visibility === "household") return null;
  if (sharing.sharedWith && sharing.sharedWith.length > 0) {
    return <Tag>{t("accounts.sharing.sharedWith", { names: sharing.sharedWith.join(", ") })}</Tag>;
  }
  if (sharing.sharedWith === null && sharing.owner) return <Tag>{t("accounts.sharing.sharedBy", { owner: sharing.owner })}</Tag>;
  return <Tag>{sharing.owner ? t("accounts.sharing.privateOf", { owner: sharing.owner }) : t("labels.visibility.private")}</Tag>;
}
