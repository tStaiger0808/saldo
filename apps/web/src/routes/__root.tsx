import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { I18nProvider, useT } from "../i18n/react.tsx";
import { isStaleBuild, reloadForNewBuild } from "../lib/stale.ts";
import { HEAD_SCRIPT } from "../lib/theme.ts";
import { getSessionState } from "../server/functions/session.ts";
import styles from "../styles.css?url";

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#16211c"/><path fill="#3fa284" d="M7 7h18l-2.7 4.7H7zM7 13.5h13l-2.7 4.7H7zM7 20h7.5l-2.7 4.7H7z"/></svg>',
)}`;

export const Route = createRootRoute({
  beforeLoad: async () => ({ session: await getSessionState() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, interactive-widget=resizes-content" },
      { name: "theme-color", content: "#16211c" },
      { name: "robots", content: "noindex, nofollow" },
      { title: "Saldo" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: FAVICON, type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function NotFound() {
  const t = useT();
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>{t("shell.notFound.title")}</h1>
        <p className="muted">{t("shell.notFound.text")}</p>
        <a className="btn btn-primary" href="/">
          {t("shell.notFound.home")}
        </a>
      </div>
    </main>
  );
}

function ErrorPage({ error }: { error: unknown }) {
  const t = useT();
  const message = error instanceof Error ? error.message : String(error);
  useEffect(() => {
    if (isStaleBuild(message)) reloadForNewBuild();
  }, [message]);
  return (
    <main className="auth-page">
      <div className="card auth-card" role="alert">
        <h1>{t("shell.error.title")}</h1>
        <p className="muted">{t("shell.error.text")}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          {t("shell.error.reload")}
        </button>
        <details>
          <summary>{t("shell.error.details")}</summary>
          <pre className="mono small">{message}</pre>
        </details>
      </div>
    </main>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const { locale } = Route.useRouteContext({ select: (context) => context.session });
  return (
    // data-theme, data-mode and data-amounts are set by the head script before hydration; the server does not know them.
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant script from the source, applied before the first paint */}
        <script dangerouslySetInnerHTML={{ __html: HEAD_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <I18nProvider locale={locale}>{children}</I18nProvider>
        <Scripts />
      </body>
    </html>
  );
}
