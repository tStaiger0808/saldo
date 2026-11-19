import { createFileRoute } from "@tanstack/react-router";
import { AiDetailsField } from "../../../components/AiDetailsField.tsx";
import { LanguageField } from "../../../components/LanguageField.tsx";
import { Banner } from "../../../components/Status.tsx";
import { ThemePicker } from "../../../components/ThemePicker.tsx";
import { useT } from "../../../i18n/react.tsx";
import { useAction } from "../../../lib/action.ts";
import { setOwnLocaleFn } from "../../../server/functions/session.ts";

export const Route = createFileRoute("/_app/persoenlich/darstellung")({ component: AppearanceSection });

function AppearanceSection() {
  const { user, session } = Route.useRouteContext();
  const t = useT();
  const save = useAction(setOwnLocaleFn);
  return (
    <section className="card" aria-labelledby="look-title" style={{ maxWidth: 520 }}>
      <h2 id="look-title">{t("sections.personal.darstellung.label")}</h2>
      <p className="muted">{t("language.appearanceIntro")}</p>
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      <LanguageField
        value={user.localePreference}
        automatic={session.automaticLocale}
        onChange={(locale) => save.run({ data: { locale } })}
      />
      <ThemePicker />
      <AiDetailsField />
    </section>
  );
}
