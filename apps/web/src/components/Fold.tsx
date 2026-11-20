import type { ReactNode } from "react";
import { useT } from "../i18n/react.tsx";
import { type FoldId, setFolded, useFolded } from "../lib/fold.ts";
import { Icon } from "./Icon.tsx";

/** The chevron in a card head that folds a remembered section (`FoldBody` with the same `fold`) away and back. */
export function FoldToggle({ fold, controls, name }: { fold: FoldId; controls: string; name: string }) {
  const t = useT();
  const folded = useFolded(fold);
  const label = t(folded ? "common.expand" : "common.collapse", { name });
  return (
    <button
      type="button"
      className="btn btn-sm btn-icon btn-ghost fold-toggle"
      aria-expanded={!folded}
      aria-controls={controls}
      data-fold-toggle={fold}
      title={label}
      onClick={() => setFolded(fold, !folded)}
    >
      <Icon name="chevron-down" size={18} />
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

/** The part of a section that folds away; without `fold` it always stays open. */
export function FoldBody({ fold, id, className, children }: { fold?: FoldId; id?: string; className: string; children: ReactNode }) {
  const folded = useFolded(fold);
  return (
    <div id={id} className={`collapsible ${className}`} data-fold={fold} hidden={folded}>
      {children}
    </div>
  );
}
