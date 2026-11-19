import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "../db/index.ts";
import { authMiddleware, householdAdminMiddleware, superuserMiddleware } from "../middleware.ts";
import {
  activateProvider,
  aiSettingsInput,
  aiStatus,
  analysesInput,
  analysisInput,
  categorizeInput,
  chat,
  chatInput,
  chatRetentionInput,
  conversationInput,
  createProvider,
  createSuggestedTags,
  deleteAllConversations,
  deleteConversation,
  deleteProvider,
  getAiSettings,
  getChatRetention,
  getConversation,
  listAnalyses,
  listConversations,
  listProviders,
  modelsInput,
  providerInput,
  providerModels,
  providerPresets,
  recategorizeInput,
  recategorizePreview,
  rememberCategory,
  rememberInput,
  renameConversation,
  renameConversationInput,
  saveAiSettings,
  setChatRetention,
  startAnalysis,
  startCategorize,
  startRecategorize,
  suggestCategory,
  suggestedTagsInput,
  suggestInput,
  testProvider,
  updateProvider,
  usageInput,
  usageSummary,
} from "../modules/ai/index.ts";

const idOnly = z.object({ id: z.number().int() });

export const getAiProviders = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => listProviders(db(), context.user));

export const saveAiProviderFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(providerInput.extend({ id: z.number().int().optional() }))
  .handler(({ data: { id, ...input }, context }) =>
    id === undefined ? createProvider(db(), context.user, input) : updateProvider(db(), context.user, id, input),
  );

export const getAiPresets = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => providerPresets(context.user.locale));

export const testAiProviderFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(z.object({ id: z.number().int() }))
  .handler(({ data, context }) => testProvider(db(), context.user, data.id));

export const activateAiProviderFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => activateProvider(db(), context.user, data.id));

export const deleteAiProviderFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(idOnly)
  .handler(({ data, context }) => deleteProvider(db(), context.user, data.id));

export const getAiModels = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(modelsInput)
  .handler(({ data, context }) => providerModels(db(), context.user, data));

export const getAiUsage = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .validator(usageInput)
  .handler(({ data, context }) => usageSummary(db(), context.user, data));

export const startCategorizeFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(categorizeInput)
  .handler(({ data, context }) => startCategorize(db(), context.user, data));

export const getAiStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => aiStatus(db(), context.user));

export const startAnalysisFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(analysisInput)
  .handler(({ data, context }) => startAnalysis(db(), context.user, data));

export const getAnalyses = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(analysesInput)
  .handler(({ data, context }) => listAnalyses(db(), context.user, data));

export const chatFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(chatInput)
  .handler(({ data, context }) => chat(db(), context.user, data));

export const getChatConversationsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => listConversations(db(), context.user));

export const getChatConversationFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(conversationInput)
  .handler(({ data, context }) => getConversation(db(), context.user, data));

export const renameChatConversationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(renameConversationInput)
  .handler(({ data, context }) => renameConversation(db(), context.user, data));

export const deleteChatConversationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(conversationInput)
  .handler(({ data, context }) => deleteConversation(db(), context.user, data));

export const deleteAllChatConversationsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => deleteAllConversations(db(), context.user));

export const getChatRetentionFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => getChatRetention(db(), context.user));

export const setChatRetentionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(chatRetentionInput)
  .handler(({ data, context }) => setChatRetention(db(), context.user, data));

export const getAiSettingsFn = createServerFn({ method: "GET" })
  .middleware([superuserMiddleware])
  .handler(({ context }) => getAiSettings(db(), context.user));

export const saveAiSettingsFn = createServerFn({ method: "POST" })
  .middleware([superuserMiddleware])
  .validator(aiSettingsInput)
  .handler(({ data, context }) => saveAiSettings(db(), context.user, data));

export const recategorizePreviewFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(recategorizeInput)
  .handler(({ data, context }) => recategorizePreview(db(), context.user, data));

export const startRecategorizeFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(recategorizeInput)
  .handler(({ data, context }) => startRecategorize(db(), context.user, data));

export const suggestCategoryFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(suggestInput)
  .handler(({ data, context }) => suggestCategory(db(), context.user, data));

export const rememberCategoryFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(rememberInput)
  .handler(({ data, context }) => rememberCategory(db(), context.user, data));

export const createSuggestedTagsFn = createServerFn({ method: "POST" })
  .middleware([householdAdminMiddleware])
  .validator(suggestedTagsInput)
  .handler(({ data, context }) => createSuggestedTags(db(), context.user, data));
