-- Former admins become superusers, members stay members; anything unknown falls back to the least access.
UPDATE "user" SET "role" = 'superuser' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "user" SET "role" = 'member' WHERE "role" NOT IN ('superuser', 'familyAdmin', 'member');--> statement-breakpoint
-- AI stays available to superusers and to everyone who already used it.
UPDATE "user" SET "ai_allowed" = true
WHERE "role" = 'superuser' OR "id" IN (SELECT "user_id" FROM "ai_usage" WHERE "user_id" IS NOT NULL);--> statement-breakpoint
-- Existing accounts and connections stay household data, owned by the first superuser (any user if none exists).
UPDATE "accounts" SET "owner_user_id" = (
  SELECT "id" FROM "user" ORDER BY ("role" = 'superuser') DESC, "created_at", "id" LIMIT 1
) WHERE "owner_user_id" IS NULL;--> statement-breakpoint
UPDATE "bank_connections" SET "owner_user_id" = (
  SELECT "id" FROM "user" ORDER BY ("role" = 'superuser') DESC, "created_at", "id" LIMIT 1
) WHERE "owner_user_id" IS NULL;
