import { createFileRoute } from "@tanstack/react-router";
import { useT } from "../../../i18n/react.tsx";

export const Route = createFileRoute("/_app/persoenlich/")({ component: PersonalIndex });

function PersonalIndex() {
  const { user } = Route.useRouteContext();
  const t = useT();
  return (
    <section className="card" aria-labelledby="personal-intro">
      <h2 id="personal-intro">{user.name || user.username}</h2>
      <p className="muted">{t("sections.personal.intro", { role: t(`labels.role.${user.role}`) })}</p>
    </section>
  );
}
