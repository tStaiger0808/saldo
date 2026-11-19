import { useT } from "../i18n/react.tsx";
import { Field } from "./Field.tsx";

type Group = { id: number; name: string };

/** A group the viewer still sees, else all accounts; old or foreign links never reach the server with a hidden group. */
export function knownGroup(groups: readonly Group[], groupId: number | undefined): number | null {
  return groupId !== undefined && groups.some((g) => g.id === groupId) ? groupId : null;
}

/** Narrows a page to one group of accounts; only offered when there is more than one group to choose from. */
export function GroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: readonly Group[];
  value: number | null;
  onChange: (groupId: number | undefined) => void;
}) {
  const t = useT();
  if (groups.length < 2) return null;
  return (
    <Field label={t("common.fields.group")} className="field-inline">
      {(control) => (
        <select
          {...control}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
        >
          <option value="">{t("common.allAccounts")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
