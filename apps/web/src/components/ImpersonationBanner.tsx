import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useT } from "../i18n/react.tsx";
import { useAction } from "../lib/action.ts";
import type { Role } from "../lib/labels.ts";
import { stopImpersonationFn } from "../server/functions/impersonation.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";

/** Shown on every page while a superuser views Saldo as someone else; ending it returns to the users page. */
export function ImpersonationBanner({
  name,
  avatar,
  role,
  expiresAt,
}: {
  name: string;
  avatar?: string | null;
  role: Role;
  expiresAt: string;
}) {
  const t = useT();
  const router = useRouter();
  const stop = useAction(stopImpersonationFn, { invalidate: false });

  // The server ends the view once it expires; reloading the route data then brings back one's own view.
  useEffect(() => {
    const timer = setTimeout(() => router.invalidate(), Math.max(0, Date.parse(expiresAt) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [expiresAt, router]);

  async function end() {
    // A full load drops everything fetched as the other person.
    if ((await stop.run()).ok) window.location.assign("/einstellungen/benutzer");
  }

  return (
    <section className="impersonation-bar" aria-label={t("impersonation.region")}>
      <Icon name="eye" />
      {avatar && <Avatar name={name} src={avatar} decorative className="avatar avatar-sm" />}
      <p className="impersonation-text" role="status">
        {t("impersonation.banner", { name, role: t(`labels.role.${role}`) })}
      </p>
      <button type="button" className="btn btn-sm" onClick={end} disabled={stop.busy} aria-busy={stop.busy}>
        {t("impersonation.stop")}
      </button>
      {stop.error && (
        <p className="impersonation-error" role="alert">
          {stop.error}
        </p>
      )}
    </section>
  );
}
