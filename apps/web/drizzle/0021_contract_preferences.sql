CREATE TABLE "contract_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"list_mode" text DEFAULT 'category' NOT NULL,
	"sort" text DEFAULT 'name' NOT NULL,
	"due_soon_days" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_preferences" ADD CONSTRAINT "contract_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;