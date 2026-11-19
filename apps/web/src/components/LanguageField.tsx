import type { ReactNode } from "react";
import { LOCALE_NAMES, LOCALES, type Locale } from "../i18n/index.ts";
import { useT } from "../i18n/react.tsx";
import { Field } from "./Field.tsx";

/**
 * Language choice with "automatic" (null) first. `automatic` names what that resolves to in this browser; it is left
 * out where the choice is made for someone else, whose browser is unknown.
 */
export function LanguageField({
  value,
  onChange,
  automatic,
  hint,
}: {
  value: Locale | null;
  onChange: (locale: Locale | null) => void;
  automatic?: Locale;
  hint?: ReactNode;
}) {
  const t = useT();
  return (
    <Field label={t("language.label")} hint={hint ?? t("language.hint")}>
      {(control) => (
        <select {...control} value={value ?? ""} onChange={(event) => onChange((event.target.value || null) as Locale | null)}>
          <option value="">
            {automatic ? t("language.automaticWith", { language: LOCALE_NAMES[automatic] }) : t("language.automatic")}
          </option>
          {LOCALES.map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
