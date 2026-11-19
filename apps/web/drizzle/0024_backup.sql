CREATE TABLE "backup_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trigger" text NOT NULL,
	"started_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"file_name" text,
	"size_bytes" bigint,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "backup_targets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_targets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"ciphertext" text,
	"keep" integer DEFAULT 14 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at");