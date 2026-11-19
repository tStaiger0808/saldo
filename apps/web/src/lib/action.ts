import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState } from "react";
import type { Translate } from "../i18n/index.ts";
import { useT } from "../i18n/react.tsx";
import { isStaleBuild, reloadForNewBuild } from "./stale.ts";

/** A safe message from whatever a server function threw (zod issues arrive as JSON); the server has translated it. */
export function errorMessage(error: unknown, t: Translate): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (raw.startsWith("[")) {
    try {
      const issues = JSON.parse(raw) as { message?: string }[];
      if (issues[0]?.message) return issues[0].message;
    } catch {
      // Not JSON after all.
    }
  }
  if (isStaleBuild(raw)) return reloadForNewBuild() ? t("common.newVersionReloading") : t("common.newVersion");
  if (!raw || /fetch|network/i.test(raw)) return t("common.genericError");
  return raw;
}

export type Notice = { tone: "ok" | "danger" | "info" | "warn"; text: string };

// biome-ignore lint/suspicious/noExplicitAny: server functions differ in their argument shapes
type AnyFn = (...args: any[]) => Promise<any>;

/**
 * Runs a server function, keeps `busy` while it runs and reloads the route data afterwards
 * (mutation, then `router.invalidate()`). Errors land in `error` instead of being thrown.
 */
export function useAction<F extends AnyFn>(fn: F, { invalidate = true }: { invalidate?: boolean } = {}) {
  const router = useRouter();
  const t = useT();
  const call = useServerFn(fn) as unknown as F;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: Parameters<F>): Promise<{ ok: true; value: Awaited<ReturnType<F>> } | { ok: false; error: string }> => {
      setBusy(true);
      setError(null);
      try {
        const value = await call(...args);
        if (invalidate) await router.invalidate();
        return { ok: true, value };
      } catch (e) {
        const message = errorMessage(e, t);
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [call, invalidate, router, t],
  );

  return { run, busy, error, setError };
}

export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  return { notice, setNotice, clear: () => setNotice(null) };
}
