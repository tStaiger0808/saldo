import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type Formatter, formatter } from "../lib/format.ts";
import { DEFAULT_LOCALE, type Locale, type Translate, translator } from "./index.ts";

type I18n = { locale: Locale; t: Translate; f: Formatter };

function create(locale: Locale): I18n {
  return { locale, t: translator(locale), f: formatter(locale) };
}

// German without a provider, so a component rendered outside the root (tests, error fallbacks) still works.
const I18nContext = createContext<I18n>(create(DEFAULT_LOCALE));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => create(locale), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Locale, translation and formatting of the current reader. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useFormat(): Formatter {
  return useContext(I18nContext).f;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
