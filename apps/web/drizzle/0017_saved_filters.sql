CREATE TABLE "saved_filters" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "saved_filters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_filters_name_unique" UNIQUE("user_id","scope","name")
);
--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_filters_one_default" ON "saved_filters" USING btree ("user_id","scope") WHERE "saved_filters"."is_default";