import { redirect } from "@tanstack/react-router";
import type { Role } from "./labels.ts";

const HOUSEHOLD: readonly Role[] = ["superuser", "familyAdmin"];
const SUPERUSER: readonly Role[] = ["superuser"];
const EVERYONE: readonly Role[] = ["superuser", "familyAdmin", "member"];

/**
 * Labels and hints live under `sections.settings.<slug>` in the messages; the slugs are stable URLs. Accounts and
 * their bank connections are managed on the accounts page itself.
 */
export const SECTIONS = [
  { slug: "gruppen", to: "/einstellungen/gruppen", roles: HOUSEHOLD },
  { slug: "kategorien", to: "/einstellungen/kategorien", roles: HOUSEHOLD },
  { slug: "tags", to: "/einstellungen/tags", roles: HOUSEHOLD },
  { slug: "regeln", to: "/einstellungen/regeln", roles: HOUSEHOLD },
  { slug: "bankverbindungen", to: "/einstellungen/bankverbindungen", roles: SUPERUSER },
  { slug: "ki", to: "/einstellungen/ki", roles: SUPERUSER },
  { slug: "benutzer", to: "/einstellungen/benutzer", roles: HOUSEHOLD },
  { slug: "email", to: "/einstellungen/email", roles: SUPERUSER },
  { slug: "mcp", to: "/einstellungen/mcp", roles: EVERYONE },
  { slug: "sicherung", to: "/einstellungen/sicherung", roles: SUPERUSER },
  { slug: "protokoll", to: "/einstellungen/protokoll", roles: SUPERUSER },
] as const satisfies readonly { slug: string; to: `/einstellungen/${string}`; roles: readonly Role[] }[];

export type SectionSlug = (typeof SECTIONS)[number]["slug"];

/** Labels and hints live under `sections.personal.<slug>` in the messages; the slugs are stable URLs. */
export const PERSONAL_SECTIONS = [
  { slug: "daten", to: "/persoenlich/daten" },
  { slug: "benachrichtigungen", to: "/persoenlich/benachrichtigungen" },
  { slug: "darstellung", to: "/persoenlich/darstellung" },
  { slug: "tastenkuerzel", to: "/persoenlich/tastenkuerzel" },
  { slug: "passwort", to: "/persoenlich/passwort" },
] as const;

export function sectionsFor(role: Role) {
  return SECTIONS.filter((s) => (s.roles as readonly Role[]).includes(role));
}

/** Sections the role may not open send back to the list; the server functions refuse them anyway. */
export function requireSection(slug: SectionSlug) {
  return ({ context }: { context: { user: { role: Role } } }) => {
    if (!sectionsFor(context.user.role).some((s) => s.slug === slug)) throw redirect({ to: "/einstellungen" });
  };
}
