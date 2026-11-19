-- Until now a booking's tags were its manual_tag_ids plus the tags of its rules, so the source is known: tags not set by hand came from a rule.
UPDATE "transaction_tags" SET "source" = 'rule'
WHERE NOT EXISTS (
  SELECT 1 FROM "transactions" t
  WHERE t."id" = "transaction_tags"."transaction_id" AND t."manual_tag_ids" @> to_jsonb("transaction_tags"."tag_id")
);
