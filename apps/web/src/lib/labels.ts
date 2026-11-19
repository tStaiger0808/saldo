/** Fixed value sets; their labels live under `labels.*` in the messages. */
export const ACCOUNT_KINDS = ["checking", "savings", "credit_card", "brokerage", "prepaid"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CATEGORY_KINDS = ["expense", "income", "savings"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const RULE_FIELDS = ["any", "counterparty", "purpose"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_DIRECTIONS = ["any", "out", "in"] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

export const ROLES = ["member", "familyAdmin", "superuser"] as const;
export type Role = (typeof ROLES)[number];

export const VISIBILITIES = ["household", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
