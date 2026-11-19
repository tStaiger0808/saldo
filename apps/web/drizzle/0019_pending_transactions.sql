CREATE TABLE "pending_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pending_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"booking_date" date,
	"value_date" date,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD CONSTRAINT "pending_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_transactions_account_idx" ON "pending_transactions" USING btree ("account_id");