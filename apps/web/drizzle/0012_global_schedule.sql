-- One schedule for every connection: on, with the times of all connections that had their own schedule switched on.
INSERT INTO "settings" ("key", "value")
SELECT 'bank_sync_schedule', jsonb_build_object('enabled', true, 'times', jsonb_agg(DISTINCT t.hhmm ORDER BY t.hhmm))
FROM "bank_connections" c, jsonb_array_elements_text(c."schedule_times") AS t(hhmm)
WHERE c."schedule_enabled"
HAVING count(*) > 0
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "bank_connections" DROP COLUMN "schedule_enabled";--> statement-breakpoint
ALTER TABLE "bank_connections" DROP COLUMN "schedule_times";
