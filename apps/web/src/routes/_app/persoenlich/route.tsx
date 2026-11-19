import { createFileRoute } from "@tanstack/react-router";
import { SectionLayout } from "../../../components/SectionLayout.tsx";
import { useT } from "../../../i18n/react.tsx";
import { PERSONAL_SECTIONS } from "../../../lib/settings.ts";

export const Route = createFileRoute("/_app/persoenlich")({ component: PersonalLayout });

/** Settings that belong to the signed-in person, reached by clicking the user in the navigation. */
function PersonalLayout() {
  const t = useT();
  const sections = PERSONAL_SECTIONS.map((s) => ({
    ...s,
    label: t(`sections.personal.${s.slug}.label`),
    hint: t(`sections.personal.${s.slug}.hint`),
  }));
  return (
    <SectionLayout
      base="/persoenlich"
      title={t("sections.personal.title")}
      navLabel={t("sections.personal.navLabel")}
      sections={sections}
    />
  );
}
