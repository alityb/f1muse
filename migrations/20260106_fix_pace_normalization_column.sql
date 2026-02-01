-- Fix missing normalization column in pace_metric_summary_driver_track
-- Run this in Supabase SQL Editor

-- Add missing normalization column to track metrics table
ALTER TABLE pace_metric_summary_driver_track
  ADD COLUMN normalization text NOT NULL DEFAULT 'none';

-- Drop and recreate primary key to include normalization
ALTER TABLE pace_metric_summary_driver_track
  DROP CONSTRAINT pace_metric_summary_driver_track_pkey;

ALTER TABLE pace_metric_summary_driver_track
  ADD PRIMARY KEY (
    season,
    track_id,
    driver_id,
    metric_name,
    normalization,
    compound_context,
    clean_air_only,
    session_scope
  );

-- Recreate index with correct column name
DROP INDEX IF EXISTS idx_pace_track_metric;
CREATE INDEX idx_pace_track_metric
  ON pace_metric_summary_driver_track(metric_name, normalization);

-- Verify the fix
SELECT 'Schema is now ready! ✅' as status;
