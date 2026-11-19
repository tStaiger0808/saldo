/**
 * Saved AI chats. They are strictly private: every query is bound to the viewer's own id, superusers included, and
 * while a superuser views Saldo as someone else nothing is listed, read or written. The audit log only gets counts.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { msg } from "../../../i18n/index.ts";
import type { BookingView } from "../../../lib/booking-filter.ts";
import { CHAT_RETENTION_DAYS } from "../../../lib/chat.ts";
import type { Db } from "../../db/index.ts";
import { chatConversations, chatMessages, user } from "../../db/schema.ts";
import { NotFound, UserError } from "../../errors.ts";
import type { Viewer } from "../access/index.ts";
import { record } from "../audit/index.ts";
import type { Lookup } from "../tools/index.ts";
import type { ChatMessage } from "./client.ts";
import type { ContextWindow } from "./tokens.ts";

export const TITLE_MAX = 80;
/** Characters of earlier turns sent along with a question; the newest turns win. */
export const HISTORY_BUDGET = 24_000;
/** A long earlier answer is cut, so it cannot crowd out the turns before it. */
export const TURN_LIMIT = 4_000;
const HISTORY_MESSAGES = 30;
const LIST_LIMIT = 500;

/**
 * What an answer cost, kept with it so a reopened chat names its model and token counts again. Token sums cover every
 * model call of the answer; the optional fields may be missing on stored answers.
 */
export type ChatUsage = {
  providerName: string;
  model: string;
  mode: "tools" | "attached";
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** The largest single request, the one that has to fit into the context window. */
  maxInputTokens?: number;
  /** False when the provider left out the usage of a call. */
  reported?: boolean;
  /** As known when the answer came: from the provider's model list, or estimated from the model family. */
  contextWindow?: ContextWindow | null;
};

export type ConversationSummary = { id: number; title: string; createdAt: string; updatedAt: string };
export type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  lookups: Lookup[];
  usage: ChatUsage | null;
  createdAt: string;
};
export type ConversationOut = ConversationSummary & { messages: StoredMessage[] };

type ConversationRow = typeof chatConversations.$inferSelect;

export const conversationInput = z.object({ id: z.number().int() });
export const renameConversationInput = conversationInput.extend({
  title: z.string().trim().min(1, "ai.history.errors.titleRequired").max(TITLE_MAX),
});
export const chatRetentionInput = z.object({
  days: z.literal([...CHAT_RETENTION_DAYS]).nullable(),
});

const viewingAsSomeoneElse = (viewer: Viewer) => Boolean(viewer.impersonation);

/** The first question on one line, cut to the title length. */
export function titleOf(question: string): string {
  const line = question.split(/\s+/).filter(Boolean).join(" ");
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const summary = (row: ConversationRow): ConversationSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function owned(db: Db, viewer: Viewer, id: number): Promise<ConversationRow> {
  if (viewingAsSomeoneElse(viewer)) throw new NotFound(msg("ai.history.errors.notFound"));
  const [row] = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, viewer.id)));
  if (!row) throw new NotFound(msg("ai.history.errors.notFound"));
  return row;
}

export async function listConversations(db: Db, viewer: Viewer): Promise<ConversationSummary[]> {
  if (viewingAsSomeoneElse(viewer)) return [];
  const rows = await db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.userId, viewer.id))
    .orderBy(desc(chatConversations.updatedAt), desc(chatConversations.id))
    .limit(LIST_LIMIT);
  return rows.map(summary);
}

export async function getConversation(db: Db, viewer: Viewer, input: z.input<typeof conversationInput>): Promise<ConversationOut> {
  const row = await owned(db, viewer, conversationInput.parse(input).id);
  const messages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, row.id)).orderBy(asc(chatMessages.id));
  return {
    ...summary(row),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      lookups: m.lookups,
      usage: m.usage ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function renameConversation(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof renameConversationInput>,
): Promise<ConversationSummary> {
  const data = renameConversationInput.parse(input);
  const row = await owned(db, viewer, data.id);
  const [saved] = await db.update(chatConversations).set({ title: data.title }).where(eq(chatConversations.id, row.id)).returning();
  if (!saved) throw new NotFound(msg("ai.history.errors.notFound"));
  return summary(saved);
}

export async function deleteConversation(db: Db, viewer: Viewer, input: z.input<typeof conversationInput>): Promise<void> {
  const row = await owned(db, viewer, conversationInput.parse(input).id);
  await db.delete(chatConversations).where(eq(chatConversations.id, row.id));
  await record(db, { action: "ai.chatDeleted", actor: viewer, details: { conversations: 1 } });
}

/** Returns how many chats went. */
export async function deleteAllConversations(db: Db, viewer: Viewer): Promise<number> {
  if (viewingAsSomeoneElse(viewer)) return 0;
  const deleted = await db.delete(chatConversations).where(eq(chatConversations.userId, viewer.id)).returning({ id: chatConversations.id });
  if (deleted.length > 0) await record(db, { action: "ai.chatDeleted", actor: viewer, details: { conversations: deleted.length } });
  return deleted.length;
}

export async function getChatRetention(db: Db, viewer: Viewer): Promise<{ days: number | null }> {
  const [row] = await db.select({ days: user.chatRetentionDays }).from(user).where(eq(user.id, viewer.id));
  return { days: row ? row.days : null };
}

export async function setChatRetention(db: Db, viewer: Viewer, input: z.input<typeof chatRetentionInput>): Promise<void> {
  const { days } = chatRetentionInput.parse(input);
  await db.update(user).set({ chatRetentionDays: days }).where(eq(user.id, viewer.id));
}

/** Deletes the chats untouched for longer than their owner keeps them; returns how many went. */
export async function pruneChatHistory(db: Db, now: Date): Promise<number> {
  const deleted = await db
    .delete(chatConversations)
    .where(
      sql`exists (select 1 from ${user} where ${user.id} = ${chatConversations.userId} and ${user.chatRetentionDays} is not null
        and ${chatConversations.updatedAt} < ${now.toISOString()}::timestamptz - make_interval(days => ${user.chatRetentionDays}))`,
    )
    .returning({ id: chatConversations.id });
  if (deleted.length > 0) await record(db, { action: "ai.chatPruned", actor: null, details: { conversations: deleted.length } });
  return deleted.length;
}

// ---- used by the chat

export type ContinuedConversation = { id: number; groupId: number | null; lastView: BookingView | null; turns: ChatMessage[] };

/** The newest earlier turns of a chat that fit `HISTORY_BUDGET`, starting with a question. */
export async function earlierTurns(db: Db, viewer: Viewer, id: number): Promise<ContinuedConversation> {
  const row = await owned(db, viewer, id);
  const newest = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, row.id))
    .orderBy(desc(chatMessages.id))
    .limit(HISTORY_MESSAGES);
  const turns: ChatMessage[] = [];
  let room = HISTORY_BUDGET;
  for (const message of newest) {
    const content = message.content.length > TURN_LIMIT ? `${message.content.slice(0, TURN_LIMIT)} […]` : message.content;
    if (content.length > room) break;
    room -= content.length;
    turns.unshift({ role: message.role, content });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return { id: row.id, groupId: row.groupId, lastView: row.lastViewFilter ?? null, turns };
}

export type SavedTurn = { id: number; title: string };

/** Stores a question and its answer, in a new chat titled after the question or appended to `conversationId`. */
export async function saveTurn(
  db: Db,
  viewer: Viewer,
  turn: {
    conversationId: number | null;
    groupId: number | null;
    question: string;
    answer: string;
    lookups: Lookup[];
    usage: ChatUsage;
    lastView: BookingView | null;
  },
): Promise<SavedTurn> {
  if (viewingAsSomeoneElse(viewer)) throw new UserError(msg("ai.history.errors.notSaved"));
  return db.transaction(async (tx) => {
    let conversation: ConversationRow | undefined;
    if (turn.conversationId === null) {
      [conversation] = await tx
        .insert(chatConversations)
        .values({ userId: viewer.id, groupId: turn.groupId, title: titleOf(turn.question), lastViewFilter: turn.lastView })
        .returning();
    } else {
      [conversation] = await tx
        .update(chatConversations)
        .set({ updatedAt: sql`now()`, ...(turn.lastView ? { lastViewFilter: turn.lastView } : {}) })
        .where(and(eq(chatConversations.id, turn.conversationId), eq(chatConversations.userId, viewer.id)))
        .returning();
    }
    if (!conversation) throw new NotFound(msg("ai.history.errors.notFound"));
    await tx.insert(chatMessages).values([
      { conversationId: conversation.id, role: "user", content: turn.question },
      { conversationId: conversation.id, role: "assistant", content: turn.answer, lookups: turn.lookups, usage: turn.usage },
    ]);
    return { id: conversation.id, title: conversation.title };
  });
}
