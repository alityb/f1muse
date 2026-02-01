-- =====================================================
-- F1 Muse Schema Migration
-- Run this in Supabase SQL Editor to align your schema
-- =====================================================

-- 1. Fix drivers table
ALTER TABLE drivers
  ALTER COLUMN driver_id TYPE VARCHAR(10),
  ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Populate full_name from existing data
UPDATE drivers SET full_name = first_name || ' ' || last_name WHERE full_name IS NULL;
ALTER TABLE drivers ALTER COLUMN full_name SET NOT NULL;

-- Note: Keeping 'code' column as it might be useful for your own purposes

-- 2. Fix driver_aliases table
ALTER TABLE driver_aliases
  RENAME COLUMN is_ambiguous TO is_primary;

-- Update logic: is_ambiguous BOOLEAN inverts to is_primary
-- If you had is_ambiguous=TRUE (meaning ambiguous), it should be is_primary=FALSE
-- If you had is_ambiguous=FALSE (meaning not ambiguous), it should be is_primary=TRUE
UPDATE driver_aliases SET is_primary = NOT is_primary;

-- 3. Fix tracks table
ALTER TABLE tracks
  RENAME COLUMN name TO track_name;

-- 4. Fix track_aliases table
ALTER TABLE track_aliases
  RENAME COLUMN is_ambiguous TO is_primary;

-- Update logic: same as driver_aliases
UPDATE track_aliases SET is_primary = NOT is_primary;

-- 5. Fix driver_season_entries table
ALTER TABLE driver_season_entries
  DROP CONSTRAINT driver_season_entries_pkey,
  RENAME COLUMN season_year TO season;

-- Re-add primary key with correct column name
ALTER TABLE driver_season_entries
  ADD PRIMARY KEY (season, driver_id);

-- 6. Fix pace_metric_summary_driver_season table
ALTER TABLE pace_metric_summary_driver_season
  DROP CONSTRAINT pace_metric_summary_driver_season_pkey,
  RENAME COLUMN season_year TO season,
  RENAME COLUMN value TO metric_value,
  RENAME COLUMN is_clean_air_filtered TO clean_air_only,
  ADD COLUMN session_scope TEXT NOT NULL DEFAULT 'all';

-- Re-add primary key
ALTER TABLE pace_metric_summary_driver_season
  ADD PRIMARY KEY (
    season,
    driver_id,
    metric_name,
    normalization,
    compound_context,
    clean_air_only,
    session_scope
  );

-- 7. Fix pace_metric_summary_driver_track table
-- First, drop the auto-increment ID and use composite primary key
ALTER TABLE pace_metric_summary_driver_track
  DROP CONSTRAINT IF EXISTS pace_metric_summary_driver_track_pkey,
  DROP CONSTRAINT IF EXISTS pace_metric_summary_driver_track_season_year_track_id_sessio_key;

ALTER TABLE pace_metric_summary_driver_track
  DROP COLUMN IF EXISTS id,
  RENAME COLUMN session_type TO session_scope,
  DROP COLUMN IF EXISTS tyre_compound,
  RENAME COLUMN value TO metric_value,
  RENAME COLUMN is_clean_air_filtered TO clean_air_only;

-- Re-add composite primary key
ALTER TABLE pace_metric_summary_driver_track
  ADD PRIMARY KEY (
    season,
    track_id,
    driver_id,
    metric_name,
    compound_context,
    clean_air_only,
    session_scope
  );

-- =====================================================
-- Add indexes for query performance
-- =====================================================

-- Season-level metrics indexes
CREATE INDEX IF NOT EXISTS idx_pace_season_driver
  ON pace_metric_summary_driver_season(driver_id, season);
CREATE INDEX IF NOT EXISTS idx_pace_season_metric
  ON pace_metric_summary_driver_season(metric_name, normalization);

-- Track-level metrics indexes
CREATE INDEX IF NOT EXISTS idx_pace_track_driver
  ON pace_metric_summary_driver_track(driver_id, season, track_id);
CREATE INDEX IF NOT EXISTS idx_pace_track_metric
  ON pace_metric_summary_driver_track(metric_name, normalization);

-- Identity resolution indexes
CREATE INDEX IF NOT EXISTS idx_driver_alias
  ON driver_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_track_alias
  ON track_aliases(alias);

-- =====================================================
-- DONE! Your schema now matches F1 Muse expectations
-- =====================================================
