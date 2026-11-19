import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useT } from "../i18n/react.tsx";
import { Icon } from "./Icon.tsx";
import { PageHead } from "./PageHead.tsx";

export type Section = { slug: string; to: string; label: string; hint: string };

/** Settings-style page: a list of sections on the left (its own page on small screens), the chosen section on the right; the head stays put while switching. */
export function SectionLayout({
  base,
  title,
  navLabel,
  sections,
}: {
  base: string;
  title: string;
  navLabel: string;
  sections: readonly Section[];
}) {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const slug = pathname.slice(base.length).replace(/^\//, "").split("/")[0] ?? "";
  const current = sections.find((s) => s.slug === slug);
  return (
    <>
      <PageHead title={title} section={current?.label} />
      <div className="settings-layout" data-overview={current ? undefined : ""}>
        <nav className="settings-nav" aria-label={navLabel}>
          {sections.map((s) => (
            <Link key={s.slug} to={s.to} className="settings-nav-link">
              <span className="settings-nav-label">{s.label}</span>
              <span className="settings-nav-hint">{s.hint}</span>
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          {/* Only shown on narrow screens, where the section list is a page of its own. */}
          <Link to={base} className="settings-back">
            <Icon name="chevron-left" size={16} /> {t("sections.allSections")}
          </Link>
          <Outlet />
        </div>
      </div>
    </>
  );
}
