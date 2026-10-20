-- The betting games (the race and the wheel) were taken out. A segment saved with one plays a random game instead.
UPDATE "channel"
SET "persona" = jsonb_set(
  "persona",
  '{segments}',
  (
    SELECT jsonb_agg(
      CASE WHEN seg->'game'->>'kind' IN ('race', 'wheel') THEN jsonb_set(seg, '{game,kind}', '"random"') ELSE seg END
      ORDER BY ord
    )
    FROM jsonb_array_elements("persona"->'segments') WITH ORDINALITY AS t(seg, ord)
  )
)
WHERE jsonb_typeof("persona"->'segments') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("persona"->'segments') AS s(seg) WHERE seg->'game'->>'kind' IN ('race', 'wheel')
  );
