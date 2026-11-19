import { definePlugin } from "nitro";
import { db } from "../db/index.ts";
import { env } from "../env.ts";
import { startScheduler } from "../modules/scheduler/index.ts";

// One timer per process, even if the dev server loads the plugin again.
const KEY = Symbol.for("saldo.scheduler");
const store = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export default definePlugin((nitroApp) => {
  if (env().SALDO_SCHEDULER === "off") {
    console.info("Scheduler is off (SALDO_SCHEDULER=off): no automatic syncs or notifications.");
    return;
  }
  store[KEY]?.();
  const stop = startScheduler(db);
  store[KEY] = stop;
  nitroApp.hooks.hook("close", () => {
    stop();
    if (store[KEY] === stop) store[KEY] = undefined;
  });
});
