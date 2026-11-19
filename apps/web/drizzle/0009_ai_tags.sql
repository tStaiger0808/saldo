ALTER TABLE "tags" ADD COLUMN "created_by" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "ai_tag_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;