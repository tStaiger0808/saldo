import { createFileRoute } from "@tanstack/react-router";
import { useT } from "../../../i18n/react.tsx";

export const Route = createFileRoute("/_app/einstellungen/")({ component: SettingsIndex });

function SettingsIndex() {
  const { user } = Route.useRouteContext();
  const t = useT();
  return (
    <section className="card" aria-labelledby="settings-intro">
      <h2 id="settings-intro">{t("sections.settings.signedInAs", { name: user.name || user.username })}</h2>
      <p className="muted">
        {t("sections.settings.intro", { role: t(`labels.role.${user.role}`) })} {t(`sections.settings.introRole.${user.role}`)}
      </p>
    </section>
  );
}
