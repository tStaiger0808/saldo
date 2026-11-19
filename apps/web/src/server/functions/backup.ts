import { createServerFn } from "@tanstack/react-start";
import { db } from "../db/index.ts";
import { superuserMiddleware } from "../middleware.ts";
import {
  archivesInput,
  cancelBackupRestore,
  confirmBackupRestore,
  confirmRestoreInput,
  deleteTarget,
  getBackupOverview,
  listTargetArchives,
  passphraseInput,
  prepareBackupRestore,
  prepareRestoreInput,
  restoreIdInput,
  saveSchedule,
  saveTarget,
  scheduleInput,
  setPassphrase,
  startBackup,
  targetIdInput,
  targetInput,
  testBackupTarget,
} from "../modules/backup/index.ts";

export const getBackupOverviewFn = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => getBackupOverview(db(), context.user));

export const getBackupArchivesFn = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .validator(archivesInput)
  .handler(({ data, context }) => listTargetArchives(db(), context.user, data));

export const saveBackupTargetFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(targetInput)
  .handler(({ data, context }) => saveTarget(db(), context.user, data));

export const testBackupTargetFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(targetIdInput)
  .handler(({ data, context }) => testBackupTarget(db(), context.user, data));

export const deleteBackupTargetFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(targetIdInput)
  .handler(({ data, context }) => deleteTarget(db(), context.user, data));

export const saveBackupScheduleFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(scheduleInput)
  .handler(({ data, context }) => saveSchedule(db(), context.user, data));

export const setBackupPassphraseFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(passphraseInput)
  .handler(({ data, context }) => setPassphrase(db(), context.user, data));

export const startBackupFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => startBackup(db(), context.user));

export const prepareRestoreFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(prepareRestoreInput)
  .handler(({ data, context }) => prepareBackupRestore(db(), context.user, data));

export const cancelRestoreFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(restoreIdInput)
  .handler(({ data, context }) => cancelBackupRestore(context.user, data));

export const confirmRestoreFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(confirmRestoreInput)
  .handler(({ data, context }) => confirmBackupRestore(db(), context.user, data));
