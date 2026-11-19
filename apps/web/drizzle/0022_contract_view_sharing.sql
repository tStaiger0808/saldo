CREATE TABLE "contract_view_hidden" (
	"view_id" integer NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "contract_view_hidden_view_id_user_id_pk" PRIMARY KEY("view_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "contract_view_shares" (
	"view_id" integer NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "contract_view_shares_view_id_user_id_pk" PRIMARY KEY("view_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "contract_preferences" ADD COLUMN "all_view_name" text;--> statement-breakpoint
ALTER TABLE "contract_views" ADD COLUMN "sharing" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_view_hidden" ADD CONSTRAINT "contract_view_hidden_view_id_contract_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."contract_views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_view_hidden" ADD CONSTRAINT "contract_view_hidden_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_view_shares" ADD CONSTRAINT "contract_view_shares_view_id_contract_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."contract_views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_view_shares" ADD CONSTRAINT "contract_view_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_view_shares_user_idx" ON "contract_view_shares" USING btree ("user_id");