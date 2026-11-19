CREATE TABLE "audit_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"username" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_user_at_idx" ON "audit_events" USING btree ("user_id","at");