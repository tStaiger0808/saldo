import { definePlugin } from "nitro";
import { closeDatabase, db } from "../db/index.ts";
import { env } from "../env.ts";
import { closeAbandonedRuns } from "../modules/backup/index.ts";
import { cleanupAiRules, reclassifyAll } from "../modules/classification/index.ts";
import { relinkContracts } from "../modules/contracts/index.ts";
import { ensureVapidKeys } from "../modules/notifications/index.ts";
import { seedDefaults } from "../modules/seed/index.ts";
import { backfillPayees } from "../modules/transactions/index.ts";
import { bootstrapAdmin } from "../modules/users/index.ts";

// Migrations already ran in deploy/entrypoint.sh; this fills defaults and the first login.
export default definePlugin(async (nitroApp) => {
  nitroApp.hooks.hook("close", () => closeDatabase());
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = env();
  await seedDefaults(db());
  await ensureVapidKeys(db());
  const payees = await backfillPayees(db());
  if (payees > 0) console.info(`Filled in the payee of ${payees} card payments from their purpose`);
  const cleanup = await cleanupAiRules(db());
  if (cleanup.remove.length + cleanup.narrow.length > 0)
    console.info(`AI rule cleanup: removed ${cleanup.remove.length}, gave ${cleanup.narrow.length} a direction`);
  // A newer transfer detection reaches stored bookings; only changed rows are written.
  if (cleanup.remove.length + cleanup.narrow.length === 0) await reclassifyAll(db());
  // Payees filled in above, or a newer matching, can change which bookings belong to a contract.
  await relinkContracts(db());
  await closeAbandonedRuns(db());
  const result = await bootstrapAdmin(db(), ADMIN_USERNAME, ADMIN_PASSWORD);
  if (result === "created") console.info(`Created admin user ${ADMIN_USERNAME}`);
  if (result === "no-password") console.warn("No user exists and ADMIN_PASSWORD is not set; nobody can sign in yet.");
});
