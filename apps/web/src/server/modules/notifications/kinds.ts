import type { MessageKey } from "../../../i18n/index.ts";
import type { NotificationKind } from "../../db/schema.ts";

/** Threshold per event: cents for amounts, percent for price changes, a count for reminders, days ahead for consents and due dates. */
export const DEFAULT_THRESHOLDS: Partial<Record<NotificationKind, number>> = {
  large_expense: 50_000,
  low_balance: 10_000,
  price_change: 5,
  uncategorized: 10,
  bank_problem: 14,
  contract_upcoming: 3,
};

export const THRESHOLD_RANGES: Partial<Record<NotificationKind, readonly [min: number, max: number, message: MessageKey]>> = {
  large_expense: [100, 1_000_000_000, "notifications.errors.range.large_expense"],
  low_balance: [-1_000_000_000, 1_000_000_000, "notifications.errors.range.low_balance"],
  price_change: [1, 100, "notifications.errors.range.price_change"],
  uncategorized: [0, 100_000, "notifications.errors.range.uncategorized"],
  bank_problem: [1, 90, "notifications.errors.range.bank_problem"],
  contract_upcoming: [1, 30, "notifications.errors.range.contract_upcoming"],
};

/** Kinds about the whole instance that only superusers can choose and receive. */
export const SUPERUSER_KINDS: readonly NotificationKind[] = ["backup_failed", "backup_succeeded"];

/** The preference before a person chooses one; every other kind starts switched off. */
export const DEFAULT_PREFERENCES: Partial<Record<NotificationKind, { enabled: boolean; push: boolean; email: boolean }>> = {
  backup_failed: { enabled: true, push: false, email: true },
};
