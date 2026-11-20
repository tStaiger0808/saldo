import type { Translate } from "../i18n/index.ts";
import type { PageChoice } from "./PageHead.tsx";

type Group = { id: number; name: string };

/** A group the viewer still sees, else all accounts; old or foreign links never reach the server with a hidden group. */
export function knownGroup(groups: readonly Group[], groupId: number | undefined): number | null {
  return groupId !== undefined && groups.some((g) => g.id === groupId) ? groupId : null;
}

/** Narrows a page to one group of accounts; only offered when there is more than one group to choose from. */
export function groupChoice(
  t: Translate,
  groups: readonly Group[],
  value: number | null,
  onChange: (groupId: number | undefined) => void,
): PageChoice | null {
  if (groups.length < 2) return null;
  return {
    label: t("common.fields.group"),
    display: "select",
    value: value === null ? "" : String(value),
    options: [{ value: "", label: t("common.allAccounts") }, ...groups.map((g) => ({ value: String(g.id), label: g.name }))],
    onChange: (next) => onChange(next ? Number(next) : undefined),
  };
}
