-- Create laps_normalized table for teammate gap ingestion
-- This table stores per-lap pace data with stint alignment

CREATE TABLE IF NOT EXISTS laps_normalized (
  -- Race identification
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  track_id TEXT NOT NULL,

  -- Driver identification
  driver_id TEXT NOT NULL,

  -- Lap identification
  lap_number INTEGER NOT NULL,

  -- Stint identification (AUTHORITATIVE - do not infer)
  stint_id INTEGER NOT NULL,
  stint_lap_index INTEGER NOT NULL,

  -- Lap time
  lap_time_seconds NUMERIC(8,3) NOT NULL,

  -- Validity flags (ALL must be satisfied for clean-air analysis)
  is_valid_lap BOOLEAN NOT NULL,
  is_pit_lap BOOLEAN NOT NULL,
  is_out_lap BOOLEAN NOT NULL,
  is_in_lap BOOLEAN NOT NULL,

  -- CRITICAL: Clean air flag (ingestion aborts if missing)
  clean_air_flag BOOLEAN NOT NULL,

  -- Optional metadata
  compound TEXT,
  tyre_age_laps INTEGER,

  -- Audit timestamp
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Primary key
  PRIMARY KEY (season, round, track_id, driver_id, lap_number)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_laps_normalized_season_round_track
  ON laps_normalized (season, round, track_id);

CREATE INDEX IF NOT EXISTS idx_laps_normalized_driver_season
  ON laps_normalized (driver_id, season);

CREATE INDEX IF NOT EXISTS idx_laps_normalized_stint
  ON laps_normalized (season, round, track_id, stint_id);

CREATE INDEX IF NOT EXISTS idx_laps_normalized_clean_air
  ON laps_normalized (season, clean_air_flag)
  WHERE is_valid_lap = true
    AND is_pit_lap = false
    AND is_out_lap = false
    AND is_in_lap = false;

-- Add comment
COMMENT ON TABLE laps_normalized IS 'Per-lap pace data with stint alignment and clean-air filtering for teammate gap analysis';
COMMENT ON COLUMN laps_normalized.stint_id IS 'AUTHORITATIVE stint boundaries - do not infer or modify';
COMMENT ON COLUMN laps_normalized.clean_air_flag IS 'CRITICAL for teammate gap ingestion - must be present';
