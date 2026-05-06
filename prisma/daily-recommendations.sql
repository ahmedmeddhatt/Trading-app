-- Daily AI Recommendations migration
-- Schema changes: rename weekStartDate → snapshotDate + add kind discriminator on
-- recommendation_snapshots; add per-pick AI attribution to tracked_picks.
-- Apply this BEFORE running `pnpm prisma generate` so the client matches the DB.
--
-- Steps (idempotent, run inside a transaction):
BEGIN;

-- ── 1. recommendation_snapshots: rename + add kind ──────────────────────
ALTER TABLE recommendation_snapshots
  RENAME COLUMN week_start_date TO snapshot_date;

ALTER TABLE recommendation_snapshots
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'weekly';
-- Existing rows are weekly snapshots — leave them as 'weekly'. New rows default
-- to 'daily' once we update the @default in schema.prisma. We change the default
-- on the column itself here so DB-level inserts also default to 'daily':
ALTER TABLE recommendation_snapshots
  ALTER COLUMN kind SET DEFAULT 'daily';

-- Replace single-column unique with composite unique
ALTER TABLE recommendation_snapshots
  DROP CONSTRAINT IF EXISTS recommendation_snapshots_week_start_date_key;
ALTER TABLE recommendation_snapshots
  ADD CONSTRAINT recommendation_snapshots_snapshot_date_kind_key
  UNIQUE (snapshot_date, kind);

-- Drop old indexes and create new ones
DROP INDEX IF EXISTS recommendation_snapshots_week_start_date_idx;
DROP INDEX IF EXISTS recommendation_snapshots_ai_provider_week_start_date_idx;

CREATE INDEX IF NOT EXISTS recommendation_snapshots_snapshot_date_idx
  ON recommendation_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS recommendation_snapshots_kind_snapshot_date_idx
  ON recommendation_snapshots (kind, snapshot_date);
CREATE INDEX IF NOT EXISTS recommendation_snapshots_ai_provider_snapshot_date_idx
  ON recommendation_snapshots (ai_provider, snapshot_date);

-- ── 2. tracked_picks: add per-pick AI attribution ───────────────────────
-- Add as nullable first, backfill from parent snapshot, then enforce NOT NULL.
ALTER TABLE tracked_picks
  ADD COLUMN IF NOT EXISTS ai_provider TEXT;
ALTER TABLE tracked_picks
  ADD COLUMN IF NOT EXISTS ai_model TEXT;

-- Backfill existing picks from their parent snapshot's provider/model
UPDATE tracked_picks tp
SET ai_provider = rs.ai_provider,
    ai_model    = rs.ai_model
FROM recommendation_snapshots rs
WHERE tp.snapshot_id = rs.id
  AND (tp.ai_provider IS NULL OR tp.ai_model IS NULL);

ALTER TABLE tracked_picks
  ALTER COLUMN ai_provider SET NOT NULL,
  ALTER COLUMN ai_model    SET NOT NULL;

CREATE INDEX IF NOT EXISTS tracked_picks_ai_provider_snapshot_id_idx
  ON tracked_picks (ai_provider, snapshot_id);

COMMIT;
