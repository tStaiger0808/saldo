CREATE TABLE "contract_documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contract_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contract_id" integer NOT NULL,
	"uploaded_by" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_due_reads" (
	"user_id" text NOT NULL,
	"contract_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_due_reads_user_id_contract_id_due_date_pk" PRIMARY KEY("user_id","contract_id","due_date")
);
--> statement-breakpoint
CREATE TABLE "contract_views" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contract_views_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"account_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_due_reads" ADD CONSTRAINT "contract_due_reads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_due_reads" ADD CONSTRAINT "contract_due_reads_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_views" ADD CONSTRAINT "contract_views_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_documents_contract_idx" ON "contract_documents" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_views_owner_idx" ON "contract_views" USING btree ("owner_id");