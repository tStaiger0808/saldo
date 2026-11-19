// After a redeploy an open tab still runs the old build; its server-function and chunk ids no longer exist.
const STALE_BUILD = /Invariant failed|dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i;
const RELOAD_KEY = "saldo-stale-reload";

export function isStaleBuild(message: string): boolean {
  return STALE_BUILD.test(message);
}

/** Reloads the page once to pick up the new build; a second failure within 30 s is shown instead of looping. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
