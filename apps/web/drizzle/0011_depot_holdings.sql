CREATE TABLE "account_holdings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_holdings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"isin" text,
	"name" text NOT NULL,
	"quantity" numeric(24, 8) NOT NULL,
	"price" numeric(24, 8),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"value_cents" bigint NOT NULL,
	"cost_basis_cents" bigint,
	"as_of" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "skip_sync_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_holdings" ADD CONSTRAINT "account_holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_holdings_account_idx" ON "account_holdings" USING btree ("account_id");