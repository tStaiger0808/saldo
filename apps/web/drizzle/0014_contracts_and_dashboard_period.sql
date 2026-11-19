CREATE TABLE "contract_dismissals" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_dismissals_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contracts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"variable" boolean DEFAULT false NOT NULL,
	"interval" text DEFAULT 'monthly' NOT NULL,
	"interval_months" integer,
	"next_due" date NOT NULL,
	"account_id" integer,
	"category_id" integer,
	"match_payee" text DEFAULT '' NOT NULL,
	"match_purpose" text DEFAULT '' NOT NULL,
	"tolerance_percent" integer,
	"start_date" date,
	"end_date" date,
	"notes" text DEFAULT '' NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" text DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "period" text DEFAULT 'this_month' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "period_from" date;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "period_to" date;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "contract_id" integer;--> statement-breakpoint
ALTER TABLE "contract_dismissals" ADD CONSTRAINT "contract_dismissals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_account_idx" ON "contracts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "contracts_owner_idx" ON "contracts" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_contract_idx" ON "transactions" USING btree ("contract_id");