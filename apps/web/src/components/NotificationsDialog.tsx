import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/react.tsx";
import { errorMessage } from "../lib/action.ts";
import { internalLink } from "../lib/links.ts";
import { getNotificationsFn, markAllNotificationsReadFn, markNotificationReadFn } from "../server/functions/notifications.ts";
import { MaskedText, NewMark } from "./Bits.tsx";
import { FormDialog } from "./Dialog.tsx";
import { Banner } from "./Status.tsx";

type Listing = Awaited<ReturnType<typeof getNotificationsFn>>;
type Item = Listing["items"][number];

/** Only paths inside Saldo are followed; anything else is shown without a link. */

/** The latest notifications of the signed-in user, opened from the bell in the navigation. */
export function NotificationsDialog({ onClose, onUnread }: { onClose: () => void; onUnread: (count: number) => void }) {
  const router = useRouter();
  const { t, f } = useI18n();
  const load = useServerFn(getNotificationsFn);
  const markOne = useServerFn(markNotificationReadFn);
  const markAll = useServerFn(markAllNotificationsReadFn);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await load({ data: { limit: 30 } });
      setListing(next);
      onUnread(next.unread);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }, [load, onUnread, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function read(item: Item) {
    setError(null);
    try {
      await markOne({ data: { id: item.id } });
      await refresh();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }

  async function readAll() {
    setBusy(true);
    setError(null);
    try {
      await markAll();
      await refresh();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function follow(event: MouseEvent<HTMLAnchorElement>, item: Item, link: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!item.read) await markOne({ data: { id: item.id } }).catch(() => undefined);
    onClose();
    await router.navigate({ href: link });
  }

  const unread = listing?.unread ?? 0;
  return (
    <FormDialog
      title={t("shell.notifications")}
      variant="drawer"
      onClose={onClose}
      footer={
        <>
          <Link to="/persoenlich/benachrichtigungen" className="btn" onClick={onClose}>
            {t("shell.settings")}
          </Link>
          <button type="button" className="btn btn-primary" disabled={busy || unread === 0} aria-busy={busy} onClick={readAll}>
            {t("personal.inbox.markAllRead")}
          </button>
        </>
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}
      <p className="visually-hidden" role="status">
        {listing ? t("personal.inbox.unread", { count: unread }) : ""}
      </p>
      {listing === null ? (
        <p className="loading">{t("common.loading")}</p>
      ) : listing.items.length === 0 ? (
        <p className="empty">{t("personal.inbox.empty")}</p>
      ) : (
        <ul className="list notification-list">
          {listing.items.map((item) => {
            const link = internalLink(item.link);
            return (
              <li key={item.id} data-unread={item.read ? undefined : ""}>
                <span className="list-main">
                  <span className="list-title">
                    {link ? (
                      <a href={link} onClick={(event) => follow(event, item, link)}>
                        <MaskedText text={item.title} />
                      </a>
                    ) : (
                      <MaskedText text={item.title} />
                    )}
                    {!item.read && <NewMark />}
                  </span>
                  {item.body && (
                    <span className="notification-body">
                      <MaskedText text={item.body} />
                    </span>
                  )}
                  <span className="list-sub">
                    <time dateTime={item.createdAt}>{f.dateTime(item.createdAt)}</time>
                  </span>
                </span>
                {!item.read && (
                  <button type="button" className="btn btn-sm" onClick={() => read(item)}>
                    {t("personal.inbox.read")}
                    <span className="visually-hidden">
                      : <MaskedText text={item.title} />
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </FormDialog>
  );
}
