import { createFileRoute } from "@tanstack/react-router";
import { SectionLayout } from "../../../components/SectionLayout.tsx";
import { useT } from "../../../i18n/react.tsx";
import { sectionsFor } from "../../../lib/settings.ts";

export const Route = createFileRoute("/_app/einstellungen")({ component: SettingsLayout });

function SettingsLayout() {
  const { user } = Route.useRouteContext();
  const t = useT();
  const sections = sectionsFor(user.role).map((s) => ({
    ...s,
    label: t(`sections.settings.${s.slug}.label`),
    hint: t(`sections.settings.${s.slug}.hint`),
  }));
  return (
    <SectionLayout
      base="/einstellungen"
      title={t("sections.settings.title")}
      navLabel={t("sections.settings.navLabel")}
      sections={sections}
    />
  );
}
