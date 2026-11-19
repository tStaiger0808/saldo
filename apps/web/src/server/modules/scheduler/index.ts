/**
 * Minute tick of the single app process: scheduled bank syncs and backups and, once a day from 08:00 server time, summaries,
 * reminders, consent checks, audit log and AI chat retention. Every step claims its slot in the database, so repeated or overlapping ticks are harmless.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db/index.ts";
import { settings } from "../../db/schema.ts";
import { pruneChatHistory } from "../ai/index.ts";
import { pruneAuditEvents } from "../audit/index.ts";
import { runScheduledBackup } from "../backup/index.ts";
import { runScheduledSyncs } from "../banking/index.ts";
import { localDay, pruneNotifications, runDailyChecks } from "../notifications/index.ts";

const DAILY_KEY = "scheduler_daily";
export const DAILY_AT_MINUTES = 8 * 60;

async function claimDay(db: Db, day: string): Promise<boolean> {
  const value = JSON.stringify(day);
  const rows = await db
    .insert(settings)
    .values({ key: DAILY_KEY, value: day })
    .onConflictDoUpdate({ target: settings.key, set: { value: day }, setWhere: sql`${settings.value} <> ${value}::jsonb` })
    .returning({ key: settings.key });
  return rows.length > 0;
}

export async function tick(db: Db, now: Date): Promise<void> {
  await runScheduledSyncs(db, now);
  await runScheduledBackup(db, now).catch((error: unknown) =>
    console.error(`Scheduled backup not started: ${error instanceof Error ? error.name : typeof error}`),
  );
  if (now.getHours() * 60 + now.getMinutes() < DAILY_AT_MINUTES || !(await claimDay(db, localDay(now)))) return;
  await runDailyChecks(db, now);
  await pruneNotifications(db);
  await pruneAuditEvents(db, now);
  await pruneChatHistory(db, now);
}

/** Starts the minute timer; a tick still running when the next is due is not overlapped. Returns a stop function. */
export function startScheduler(db: () => Db, intervalMs = 60_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(db(), new Date());
    } catch (error) {
      console.error(`Scheduler tick failed: ${error instanceof Error ? error.name : typeof error}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
