import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { db } from "../db/index.ts";
import { authMiddleware, superuserMiddleware } from "../middleware.ts";
import {
  authorizeConnection,
  banksInput,
  cancelJob,
  completeAuthorization,
  completeInput,
  createConnection,
  createConnectionInput,
  deleteConnection,
  deleteConnectionInput,
  discoverConnection,
  enableBankingSettingsInput,
  fintsSettingsInput,
  getBankingSettings,
  getJobView,
  idInput,
  jobInput,
  linkAccount,
  linkInput,
  listConnections,
  listEnableBankingBanks,
  psuHeaders,
  recheckEnableBanking,
  saveEnableBankingSettings,
  saveFintsSettings,
  scheduleInput,
  setSkipSyncAll,
  setSyncSchedule,
  setUnofficialProvider,
  skipSyncAllInput,
  submitTan,
  syncAll,
  syncConnection,
  tanInput,
  unlinkAccount,
  unlinkInput,
  unofficialInput,
  updateConnection,
  updateConnectionInput,
} from "../modules/banking/index.ts";

export const getBankingSettingsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => getBankingSettings(db(), context.user));

export const setUnofficialProviderFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(unofficialInput)
  .handler(({ data, context }) => setUnofficialProvider(db(), context.user, data));

export const saveFintsSettingsFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(fintsSettingsInput)
  .handler(({ data, context }) => saveFintsSettings(db(), context.user, data));

export const saveEnableBankingSettingsFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(enableBankingSettingsInput)
  .handler(({ data, context }) => saveEnableBankingSettings(db(), context.user, data));

export const recheckEnableBankingFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => recheckEnableBanking(db(), context.user));

export const getEnableBankingBanksFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(banksInput)
  .handler(({ data, context }) => listEnableBankingBanks(db(), context.user, data));

export const getBankConnectionsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listConnections(db(), context.user));

export const createBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createConnectionInput)
  .handler(({ data, context }) => createConnection(db(), context.user, data));

export const updateBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(updateConnectionInput)
  .handler(({ data, context }) => updateConnection(db(), context.user, data));

export const deleteBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(deleteConnectionInput)
  .handler(({ data, context }) => deleteConnection(db(), context.user, data));

export const authorizeBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(({ data, context }) => authorizeConnection(db(), context.user, data));

export const completeBankAuthorizationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(completeInput)
  .handler(async ({ data, context }) => completeAuthorization(db(), context.user, data, await psuHeaders(getRequest())));

export const discoverBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(({ data, context }) => discoverConnection(db(), context.user, data));

export const linkBankAccountFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(linkInput)
  .handler(({ data, context }) => linkAccount(db(), context.user, data));

export const unlinkBankAccountFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(unlinkInput)
  .handler(({ data, context }) => unlinkAccount(db(), context.user, data));

export const syncBankConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(idInput)
  .handler(async ({ data, context }) => syncConnection(db(), context.user, data, await psuHeaders(getRequest())));

export const syncAllBankConnectionsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => syncAll(db(), context.user, await psuHeaders(getRequest())));

export const getBankJobFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(jobInput)
  .handler(({ data, context }) => getJobView(db(), context.user, data));

export const submitBankTanFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(tanInput)
  .handler(({ data, context }) => submitTan(db(), context.user, data));

export const cancelBankJobFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(jobInput)
  .handler(({ data, context }) => cancelJob(db(), context.user, data));

export const setSyncScheduleFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(scheduleInput)
  .handler(({ data, context }) => setSyncSchedule(db(), context.user, data));

export const setSkipSyncAllFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(skipSyncAllInput)
  .handler(({ data, context }) => setSkipSyncAll(db(), context.user, data));
