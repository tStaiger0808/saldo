/** Choices for how many days saved AI chats are kept; null keeps them forever. */
export const CHAT_RETENTION_DAYS = [30, 90, 365] as const;
export type ChatRetentionDays = (typeof CHAT_RETENTION_DAYS)[number];
