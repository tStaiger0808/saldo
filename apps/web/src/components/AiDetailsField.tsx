import { getRouteApi } from "@tanstack/react-router";
import { useId } from "react";
import { useT } from "../i18n/react.tsx";
import { setAiDetailsShown, useAiDetails } from "../lib/ai-details.ts";

const appRoute = getRouteApi("/_app");

/** The per-browser switch for token counts under AI answers and tasks; only for people who may use the AI. */
export function AiDetailsField() {
  const t = useT();
  const hint = useId();
  const { user } = appRoute.useRouteContext();
  const { aiAllowed } = appRoute.useLoaderData();
  const shown = useAiDetails(user, aiAllowed);
  if (!aiAllowed) return null;
  return (
    <div className="field">
      <label className="checkbox">
        <input type="checkbox" checked={shown} aria-describedby={hint} onChange={(event) => setAiDetailsShown(event.target.checked)} />
        {t("ai.details.setting")}
      </label>
      <span id={hint} className="field-hint">
        {t("ai.details.settingHint")}
      </span>
    </div>
  );
}
