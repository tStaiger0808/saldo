CREATE TABLE "impersonations" (
	"session_id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "impersonations_target_idx" ON "impersonations" USING btree ("target_user_id");