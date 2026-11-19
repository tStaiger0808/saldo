import { useSyncExternalStore } from "react";
import { useT } from "../i18n/react.tsx";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODES,
  type ModeId,
  readMode,
  readTheme,
  saveMode,
  saveTheme,
  subscribePrefs,
  THEMES,
  type ThemeId,
} from "../lib/theme.ts";
import { Field } from "./Field.tsx";

/** Colour and mode, stored in this browser; the server renders the defaults, the head script has already applied the choice. */
export function ThemePicker() {
  const theme = useSyncExternalStore(subscribePrefs, readTheme, () => DEFAULT_THEME);
  const mode = useSyncExternalStore(subscribePrefs, readMode, () => DEFAULT_MODE);
  const t = useT();
  return (
    <div className="form-row cols-2">
      <Field label={t("themes.color")}>
        {(control) => (
          <select {...control} value={theme} onChange={(event) => saveTheme(event.target.value as ThemeId)}>
            {THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {t(`themes.theme.${theme.id}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t("themes.mode")} hint={t("themes.modeHint")}>
        {(control) => (
          <select {...control} value={mode} onChange={(event) => saveMode(event.target.value as ModeId)}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {t(`themes.modes.${m.id}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  );
}
