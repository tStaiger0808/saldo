import { type ReactNode, useId } from "react";
import { useT } from "../i18n/react.tsx";

export type FieldControl = { id: string; "aria-describedby": string | undefined; "aria-invalid": true | undefined };

/**
 * Label, control, hint and error in one shape for every form. The label is only as wide as its text (no wrapping
 * `<label>`), so a hint never becomes part of the control's name.
 */
export function Field({
  label,
  hint,
  error,
  announceError = false,
  hideLabel = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  announceError?: boolean;
  hideLabel?: boolean;
  className?: string;
  children: (control: FieldControl) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label className={hideLabel ? "field-label visually-hidden" : "field-label"} htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hintId && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {errorId && (
        <span id={errorId} className="field-error" role={announceError ? "alert" : undefined}>
          {error}
        </span>
      )}
    </div>
  );
}

/** A group of checkboxes, e.g. groups of an account; the legend names the group. */
export function CheckGroup<T extends string | number>({
  legend,
  hint,
  options,
  value,
  onChange,
  empty,
  layout = "inline",
}: {
  legend: string;
  hint?: string;
  options: readonly { id: T; label: ReactNode; detail?: ReactNode }[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  empty?: ReactNode;
  /** "list": one option per row, names never wrap; for longer lists such as accounts. */
  layout?: "inline" | "list";
}) {
  const hintId = useId();
  const t = useT();
  return (
    <fieldset className="field" aria-describedby={hint ? hintId : undefined}>
      <legend>{legend}</legend>
      {options.length === 0 ? (
        <p className="field-hint">{empty ?? t("common.noEntries")}</p>
      ) : (
        <div className={layout === "list" ? "checks checks-list" : "checks"}>
          {options.map((option) => (
            <label key={option.id} className="checkbox">
              <input
                type="checkbox"
                checked={value.includes(option.id)}
                onChange={(event) => onChange(event.target.checked ? [...value, option.id] : value.filter((v) => v !== option.id))}
              />
              <span className="check-label">{option.label}</span>
              {option.detail && <span className="check-detail">{option.detail}</span>}
            </label>
          ))}
        </div>
      )}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </fieldset>
  );
}
