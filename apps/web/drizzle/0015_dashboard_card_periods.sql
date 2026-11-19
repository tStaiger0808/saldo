-- Cards follow their dashboard's period now. A card that showed "this month", the dashboard default, follows it; any
-- other period stays the card's own. A card without a stored period showed its type's default, which is kept the same way.
UPDATE "dashboards" SET "cards" = (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN jsonb_typeof(e.card->'options') IS DISTINCT FROM 'object' THEN e.card
      WHEN e.card->'options'->>'period' = 'this_month' THEN jsonb_set(e.card, '{options,period}', '"dashboard"')
      WHEN e.card->'options' ? 'period' THEN e.card
      WHEN e.card->>'type' IN ('summary', 'category_breakdown', 'ai_usage') THEN jsonb_set(e.card, '{options,period}', '"dashboard"')
      WHEN e.card->>'type' IN ('monthly_trend', 'category_trend', 'tag_trend') THEN jsonb_set(e.card, '{options,period}', '"last_12_months"')
      WHEN e.card->>'type' IN ('top_counterparties', 'period_comparison') THEN jsonb_set(e.card, '{options,period}', '"last_3_months"')
      WHEN e.card->>'type' = 'category_matrix' THEN jsonb_set(e.card, '{options,period}', '"last_6_months"')
      ELSE e.card
    END ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("dashboards"."cards") WITH ORDINALITY AS e(card, ord)
);
