CREATE TABLE "account_balance_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_balance_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"date" date NOT NULL,
	"balance_cents" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_balance_entries_account_date_unique" UNIQUE("account_id","date")
);
--> statement-breakpoint
CREATE TABLE "account_shares" (
	"account_id" integer NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "account_shares_account_id_user_id_pk" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "visibility" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "visibility" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ai_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_balance_entries" ADD CONSTRAINT "account_balance_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance_entries" ADD CONSTRAINT "account_balance_entries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_shares_user_idx" ON "account_shares" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;