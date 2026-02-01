-- Migration: Create driver_matchup_matrix_2025 table
-- Purpose: Precomputed head-to-head matchup results for fast lookup
-- Part of PART 6 implementation
--
-- This table stores precomputed head-to-head comparisons between all driver pairs
-- in a season, avoiding expensive runtime queries.

CREATE TABLE IF NOT EXISTS driver_matchup_matrix_2025 (
  -- Composite primary key: driver pair + metric
  driver_a_id TEXT NOT NULL,              -- F1DB driver.id (lexicographically first)
  driver_b_id TEXT NOT NULL,              -- F1DB driver.id (lexicographically second)
  metric TEXT NOT NULL,                    -- 'qualifying_position' or 'race_finish_position'
  season INTEGER NOT NULL DEFAULT 2025,

  -- Head-to-head results (always from perspective of driver_a)
  driver_a_wins INTEGER NOT NULL DEFAULT 0,
  driver_b_wins INTEGER NOT NULL DEFAULT 0,
  ties INTEGER NOT NULL DEFAULT 0,
  shared_events INTEGER NOT NULL DEFAULT 0,

  -- Coverage status
  coverage_status TEXT NOT NULL DEFAULT 'insufficient',

  -- Timestamps
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Primary key ensures uniqueness per driver pair + metric
  PRIMARY KEY (driver_a_id, driver_b_id, metric, season)
);

-- Create index for common lookups
CREATE INDEX IF NOT EXISTS idx_matchup_matrix_drivers
  ON driver_matchup_matrix_2025 (driver_a_id, driver_b_id);

CREATE INDEX IF NOT EXISTS idx_matchup_matrix_metric
  ON driver_matchup_matrix_2025 (metric);

CREATE INDEX IF NOT EXISTS idx_matchup_matrix_season
  ON driver_matchup_matrix_2025 (season);

-- Add constraint to ensure driver_a_id < driver_b_id (lexicographic ordering)
-- This ensures we don't store duplicate pairs (A vs B and B vs A)
ALTER TABLE driver_matchup_matrix_2025
  ADD CONSTRAINT chk_driver_ordering CHECK (driver_a_id < driver_b_id);

-- Add constraint for valid coverage status values
ALTER TABLE driver_matchup_matrix_2025
  ADD CONSTRAINT chk_coverage_status CHECK (
    coverage_status IN ('valid', 'low_coverage', 'insufficient')
  );

-- Add constraint for valid metric values
ALTER TABLE driver_matchup_matrix_2025
  ADD CONSTRAINT chk_metric_values CHECK (
    metric IN ('qualifying_position', 'race_finish_position')
  );

COMMENT ON TABLE driver_matchup_matrix_2025 IS
  'Precomputed head-to-head matchup results for 2025 season. Driver A is always lexicographically first.';

COMMENT ON COLUMN driver_matchup_matrix_2025.driver_a_wins IS
  'Number of events where driver_a finished/qualified ahead of driver_b';

COMMENT ON COLUMN driver_matchup_matrix_2025.driver_b_wins IS
  'Number of events where driver_b finished/qualified ahead of driver_a';

COMMENT ON COLUMN driver_matchup_matrix_2025.ties IS
  'Number of events where both drivers had the same position (rare, usually DNS)';

COMMENT ON COLUMN driver_matchup_matrix_2025.shared_events IS
  'Total number of events where both drivers participated';
