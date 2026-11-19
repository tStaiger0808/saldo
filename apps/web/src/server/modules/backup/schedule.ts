/** When scheduled backups are due, in the server's local time (TZ of the app container). */
import type { BackupSchedule } from "../../../lib/backup.ts";

type Timing = Pick<BackupSchedule, "frequency" | "time" | "weekday" | "monthDay">;

const isoWeekday = (date: Date) => ((date.getDay() + 6) % 7) + 1;

function at(year: number, month: number, day: number, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month, day, hours ?? 0, minutes ?? 0, 0, 0);
}

function monthSlot(schedule: Timing, year: number, month: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  const day = schedule.monthDay === "last" ? last : Math.min(schedule.monthDay, last);
  return at(year, month, day, schedule.time);
}

/** Candidate slots around `now`: the day's slot from a week back to a week ahead, or the months around it. */
function candidates(schedule: Timing, now: Date): Date[] {
  if (schedule.frequency === "off") return [];
  if (schedule.frequency === "monthly") {
    return [-1, 0, 1].map((offset) => monthSlot(schedule, now.getFullYear(), now.getMonth() + offset));
  }
  const days: Date[] = [];
  for (let offset = -7; offset <= 7; offset++) {
    const day = at(now.getFullYear(), now.getMonth(), now.getDate() + offset, schedule.time);
    if (schedule.frequency === "daily" || isoWeekday(day) === schedule.weekday) days.push(day);
  }
  return days;
}

/** The most recent slot at or before `now`; null when backups are off. */
export function latestSlot(schedule: Timing, now: Date): Date | null {
  return candidates(schedule, now)
    .filter((slot) => slot.getTime() <= now.getTime())
    .reduce<Date | null>((latest, slot) => (latest === null || slot > latest ? slot : latest), null);
}

/** The first slot after `now`; null when backups are off. */
export function nextSlot(schedule: Timing, now: Date): Date | null {
  return candidates(schedule, now)
    .filter((slot) => slot.getTime() > now.getTime())
    .reduce<Date | null>((first, slot) => (first === null || slot < first ? slot : first), null);
}
