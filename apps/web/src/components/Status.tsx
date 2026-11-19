import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/react.tsx";
import type { Notice } from "../lib/action.ts";
import { useExitInPlace } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";

export type StatusTone = "neutral" | "ok" | "info" | "warn" | "danger";

/** State of an object as dot and word, with an optional detail below; never a filled pill. */
export function Status({
  tone = "neutral",
  emphasis,
  detail,
  inline = false,
  children,
}: {
  tone?: StatusTone;
  emphasis?: "notice" | "urgent";
  detail?: ReactNode;
  inline?: boolean;
  children: ReactNode;
}) {
  const className = ["status", `status-${tone}`, emphasis && `status-${emphasis}`, inline && "status-inline"].filter(Boolean).join(" ");
  return (
    <span className={className}>
      <span className="status-label">{children}</span>
      {detail != null && detail !== "" && (
        <>
          {" "}
          <span className="status-detail">{detail}</span>
        </>
      )}
    </span>
  );
}

/** A property without state (role, kind): quiet, no dot. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

const BANNER_ICON = { ok: "check", info: "info", warn: "alert", danger: "alert" } as const;

/** Screen readers only read out changes to a status region they already know, so its text follows a moment later. */
const STATUS_DELAY_MS = 100;

/**
 * Result of an action: success and hints as status, failures as alert. `live={false}` for a banner that holds controls
 * or longer content and must not be read out on every change.
 */
export function Banner({
  tone = "info",
  live = true,
  children,
  onClose,
}: {
  tone?: Notice["tone"];
  live?: boolean;
  children: ReactNode;
  onClose?: () => void;
}) {
  const t = useT();
  const status = live && tone !== "danger";
  const [ready, setReady] = useState(!status);
  const node = useRef<HTMLDivElement>(null);
  useExitInPlace(node);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  return (
    <div ref={node} className={`banner banner-${tone}`} role={live ? (tone === "danger" ? "alert" : "status") : undefined}>
      <Icon name={BANNER_ICON[tone]} />
      <div className="banner-body">{ready && children}</div>
      {onClose && (
        <button type="button" className="btn btn-ghost btn-icon btn-sm btn-close" aria-label={t("common.closeMessage")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

export function NoticeBanner({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <Banner tone={notice.tone} onClose={onClose}>
      {notice.text}
    </Banner>
  );
}
