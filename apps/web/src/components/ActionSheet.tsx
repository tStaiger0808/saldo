import type { ActionMenuItem } from "./ActionMenu.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Icon, type IconName } from "./Icon.tsx";

export type SheetAction = ActionMenuItem & { icon: IconName };

/**
 * The actions of a row as a sheet rising from the bottom on phones, a small dialog elsewhere. Destructive actions come
 * last. Choosing one closes the sheet before it runs, so a dialog it opens returns focus to where the sheet would.
 */
export function ActionSheet({
  title,
  items,
  onClose,
}: {
  title: string;
  items: (SheetAction | false | null | undefined)[];
  onClose: () => void;
}) {
  const visible = items.filter((item): item is SheetAction => Boolean(item));
  const ordered = [...visible.filter((item) => !item.danger), ...visible.filter((item) => item.danger)];
  const firstDanger = ordered.find((item) => item.danger);

  function choose(item: SheetAction) {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  }

  return (
    <FormDialog title={title} onClose={onClose} className="action-sheet" dismissible>
      <ul className="sheet-actions">
        {ordered.map((item) => (
          <li key={item.label} data-separated={item === firstDanger && item !== ordered[0] ? "" : undefined}>
            <button
              type="button"
              className={item.danger ? "sheet-action danger" : "sheet-action"}
              aria-disabled={item.disabled || undefined}
              aria-pressed={item.checked}
              onClick={() => choose(item)}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.checked && (
                <span className="sheet-action-check">
                  <Icon name="check" size={18} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </FormDialog>
  );
}
