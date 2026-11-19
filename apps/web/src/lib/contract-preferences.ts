/** How the contracts list is laid out: in category groups, or plainly with income first and expenses below. */
export const CONTRACT_LIST_MODES = ["category", "list"] as const;
export type ContractListMode = (typeof CONTRACT_LIST_MODES)[number];

export const CONTRACT_SORTS = ["name", "monthly", "next_due"] as const;
export type ContractSort = (typeof CONTRACT_SORTS)[number];

/** The choices for how many days ahead a due date counts as soon. */
export const DUE_SOON_WINDOWS = [3, 7, 14, 30] as const;
export type DueSoonWindow = (typeof DUE_SOON_WINDOWS)[number];

/** Who else sees a contract view: nobody, everyone in the household, or chosen people. */
export const CONTRACT_VIEW_SHARING = ["private", "household", "people"] as const;
export type ContractViewSharing = (typeof CONTRACT_VIEW_SHARING)[number];

export type ContractPreferences = {
  listMode: ContractListMode;
  sort: ContractSort;
  dueSoonDays: DueSoonWindow;
  /** The person's own name for the "all" tab; null for the default label. */
  allViewName: string | null;
};

export const DEFAULT_CONTRACT_PREFERENCES: ContractPreferences = { listMode: "category", sort: "name", dueSoonDays: 7, allViewName: null };
