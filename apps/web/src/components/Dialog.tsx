import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/react.tsx";
import { playExit } from "../lib/motion.ts";
import { Icon } from "./Icon.tsx";

/** True while a modal dialog is open; page shortcuts ignore keys then. */
export function isDialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/** Opens a native modal <dialog>, focuses `initial` (or the first field) and returns focus to the trigger. */
function useModal(dialog: RefObject<HTMLDialogElement | null>, initial?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    const target = initial?.current ?? node?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
    target?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [dialog, initial]);
  useFieldAboveKeyboard(dialog);
  useDialogExit(dialog);
}

/**
 * However the page closes a dialog, it fades out over a stand-in backdrop that does not block the page, so focus is
 * back on the trigger at once.
 */
function useDialogExit(dialog: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const node = dialog.current;
    return () => {
      const body = node?.querySelector(".dialog-body");
      const scrollTop = body?.scrollTop ?? 0;
      playExit(node, (leaving) => {
        leaving.removeAttribute("open");
        const layer = document.createElement("div");
        layer.className = "dialog-exit";
        layer.append(leaving);
        document.body.append(layer);
        if (body) body.scrollTop = scrollTop;
        return layer;
      });
    };
  }, [dialog]);
}

/**
 * When the on-screen keyboard opens or the focus moves, the focused field scrolls back into the visible part of the
 * dialog; `--viewport-h` keeps the dialog within the area the keyboard leaves free.
 */
function useFieldAboveKeyboard(dialog: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const node = dialog.current;
    const viewport = window.visualViewport;
    if (!node || !viewport) return;
    const root = document.documentElement;
    const reveal = () => {
      const field = document.activeElement;
      if (field instanceof HTMLElement && node.contains(field) && field.matches("input, select, textarea"))
        field.scrollIntoView({ block: "nearest" });
    };
    const resize = () => {
      root.style.setProperty("--viewport-h", `${viewport.height}px`);
      reveal();
    };
    resize();
    viewport.addEventListener("resize", resize);
    node.addEventListener("focusin", reveal);
    return () => {
      viewport.removeEventListener("resize", resize);
      node.removeEventListener("focusin", reveal);
      if (!document.querySelector("dialog[open]")) root.style.removeProperty("--viewport-h");
    };
  }, [dialog]);
}

/**
 * Confirmation before anything with consequences. The title is a question with the object, the button names the
 * action (never "OK"); focus starts on "Abbrechen". The dialog closes before the action runs; the page reports the result.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <OpenConfirm title={title} confirmLabel={confirmLabel} danger={danger} onConfirm={onConfirm} onClose={onClose}>
      {children}
    </OpenConfirm>,
    document.body,
  );
}

function OpenConfirm({
  title,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const t = useT();
  useModal(dialog, cancel);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="confirm-dialog-body">
        {children}
      </div>
      <div className="confirm-dialog-actions">
        <button ref={cancel} type="button" className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={danger ? "btn btn-destructive" : "btn btn-primary"}
          onClick={(event) => {
            if (event.detail > 1) return;
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/**
 * A form in a modal dialog with a fixed head and footer; only the body scrolls. `footer` holds the buttons, the
 * primary one last. `variant="drawer"` slides in from the right edge. A click outside closes a drawer, and any dialog
 * whose `dismissible` is true (e.g. while nothing in it was changed). `headTools` sit in the head before the close button.
 */
export function FormDialog({
  title,
  onClose,
  onSubmit,
  footer,
  variant,
  className,
  formRef,
  dismissible,
  headTools,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  footer?: ReactNode;
  headTools?: ReactNode;
  variant?: "wide" | "drawer";
  className?: string;
  formRef?: RefObject<HTMLFormElement | null>;
  dismissible?: boolean;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <OpenFormDialog
      title={title}
      onClose={onClose}
      onSubmit={onSubmit}
      footer={footer}
      variant={variant}
      className={className}
      formRef={formRef}
      dismissible={dismissible}
      headTools={headTools}
    >
      {children}
    </OpenFormDialog>,
    document.body,
  );
}

function outside(event: { target: EventTarget; currentTarget: HTMLElement; clientX: number; clientY: number }): boolean {
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}

function OpenFormDialog({
  title,
  onClose,
  onSubmit,
  footer,
  variant,
  className: extra,
  formRef,
  dismissible,
  headTools,
  children,
}: Parameters<typeof FormDialog>[0]) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const t = useT();
  useModal(dialog);
  const className = ["form-dialog", variant === "wide" && "wide", variant === "drawer" && "drawer", extra].filter(Boolean).join(" ");
  const close = (
    <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}>
      <Icon name="close" />
    </button>
  );
  const inner = (
    <>
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        {headTools ? (
          <div className="dialog-head-tools">
            {headTools}
            {close}
          </div>
        ) : (
          close
        )}
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </>
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the outside click only adds a mouse shortcut; Esc and the close button already close it from the keyboard.
    <dialog
      ref={dialog}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A click on the dimmed area lands on the dialog element itself, outside its box; pressing inside and releasing outside does not count.
      onPointerDown={(event) => {
        pressedBackdrop.current = outside(event);
      }}
      onClick={(event) => {
        if ((variant === "drawer" || dismissible) && pressedBackdrop.current && outside(event)) onClose();
      }}
    >
      {onSubmit ? (
        <form
          ref={formRef}
          className="form-dialog-inner"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event);
          }}
        >
          {inner}
        </form>
      ) : (
        <div className="form-dialog-inner">{inner}</div>
      )}
    </dialog>
  );
}
