-- Idempotent resume of daily-recommendations migration. Safe to run repeatedly.
BEGIN;

-- 1. recommendation_snapshots.snapshot_date — rename only if old column still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recommendation_snapshots' AND column_name = 'week_start_date'
  ) THEN
    ALTER TABLE recommendation_snapshots RENAME COLUMN week_start_date TO snapshot_date;
  END IF;
END $$;

-- 2. recommendation_snapshots.kind
ALTER TABLE recommendation_snapshots
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'weekly';
ALTER TABLE recommendation_snapshots
  ALTER COLUMN kind SET DEFAULT 'daily';

-- 3. unique constraint swap
ALTER TABLE recommendation_snapshots
  DROP CONSTRAINT IF EXISTS recommendation_snapshots_week_start_date_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recommendation_snapshots_snapshot_date_kind_key'
  ) THEN
    ALTER TABLE recommendation_snapshots
      ADD CONSTRAINT recommendation_snapshots_snapshot_date_kind_key
      UNIQUE (snapshot_date, kind);
  END IF;
END $$;

-- 4. indexes
DROP INDEX IF EXISTS recommendation_snapshots_week_start_date_idx;
DROP INDEX IF EXISTS recommendation_snapshots_ai_provider_week_start_date_idx;
CREATE INDEX IF NOT EXISTS recommendation_snapshots_snapshot_date_idx
  ON recommendation_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS recommendation_snapshots_kind_snapshot_date_idx
  ON recommendation_snapshots (kind, snapshot_date);
CREATE INDEX IF NOT EXISTS recommendation_snapshots_ai_provider_snapshot_date_idx
  ON recommendation_snapshots (ai_provider, snapshot_date);

-- 5. tracked_picks.ai_provider / ai_model
ALTER TABLE tracked_picks
  ADD COLUMN IF NOT EXISTS ai_provider TEXT;
ALTER TABLE tracked_picks
  ADD COLUMN IF NOT EXISTS ai_model TEXT;

UPDATE tracked_picks tp
SET ai_provider = rs.ai_provider,
    ai_model    = rs.ai_model
FROM recommendation_snapshots rs
WHERE tp.snapshot_id = rs.id
  AND (tp.ai_provider IS NULL OR tp.ai_model IS NULL);

-- 6. enforce NOT NULL — only if every row is now populated
DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count FROM tracked_picks WHERE ai_provider IS NULL OR ai_model IS NULL;
  IF null_count = 0 THEN
    ALTER TABLE tracked_picks ALTER COLUMN ai_provider SET NOT NULL;
    ALTER TABLE tracked_picks ALTER COLUMN ai_model    SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'Cannot SET NOT NULL: % tracked_picks rows still have NULL ai_provider/ai_model', null_count;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tracked_picks_ai_provider_snapshot_id_idx
  ON tracked_picks (ai_provider, snapshot_id);

COMMIT;
