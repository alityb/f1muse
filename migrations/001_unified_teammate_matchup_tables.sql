-- Migration: Unified Teammate Gap and Matchup Tables
-- Date: 2026-01-26
-- Description: Create season-agnostic tables for teammate gaps and matchup matrices
--              to support 2022-2025 data instead of just 2025

-- ============================================================================
-- 1. CREATE UNIFIED TEAMMATE GAP RACE-LEVEL TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS teammate_gap_race_level (
  race_gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  driver_primary_id TEXT NOT NULL,
  driver_secondary_id TEXT NOT NULL,
  primary_median_lap_time_seconds NUMERIC(10,6),
  secondary_median_lap_time_seconds NUMERIC(10,6),
  shared_laps INTEGER,
  gap_seconds NUMERIC(8,6),
  gap_percent NUMERIC(8,3),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (season, round, team_id, driver_primary_id, driver_secondary_id)
);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_race_level_season ON teammate_gap_race_level(season);
CREATE INDEX IF NOT EXISTS idx_teammate_gap_race_level_drivers ON teammate_gap_race_level(driver_primary_id, driver_secondary_id);

-- ============================================================================
-- 2. CREATE UNIFIED TEAMMATE GAP SEASON SUMMARY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS teammate_gap_season_summary (
  season_summary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  driver_primary_id TEXT NOT NULL,
  driver_secondary_id TEXT NOT NULL,
  driver_pair_gap_season NUMERIC(8,3),
  driver_pair_dispersion NUMERIC(8,3),
  total_shared_laps INTEGER NOT NULL DEFAULT 0,
  num_valid_stints INTEGER NOT NULL DEFAULT 0,
  driver_pair_gap_percent NUMERIC(8,6),
  driver_pair_gap_seconds NUMERIC(8,6),
  gap_percent NUMERIC(8,3),
  shared_races INTEGER,
  faster_driver_primary_count INTEGER,
  coverage_status TEXT NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (season, team_id, driver_primary_id, driver_secondary_id)
);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_season_summary_season ON teammate_gap_season_summary(season);
CREATE INDEX IF NOT EXISTS idx_teammate_gap_season_summary_drivers ON teammate_gap_season_summary(driver_primary_id, driver_secondary_id);

-- ============================================================================
-- 3. CREATE UNIFIED QUALIFYING RACE-LEVEL TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_race_level (
  race_gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  driver_primary_id TEXT NOT NULL,
  driver_secondary_id TEXT NOT NULL,
  session_used TEXT,
  primary_time_ms INTEGER,
  secondary_time_ms INTEGER,
  gap_seconds NUMERIC(8,6),
  gap_percent NUMERIC(8,3),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (season, round, team_id, driver_primary_id, driver_secondary_id)
);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_qualifying_race_level_season ON teammate_gap_qualifying_race_level(season);

-- ============================================================================
-- 4. CREATE UNIFIED QUALIFYING SEASON SUMMARY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary (
  season_summary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  driver_primary_id TEXT NOT NULL,
  driver_secondary_id TEXT NOT NULL,
  driver_pair_gap_percent NUMERIC(8,3),
  driver_pair_gap_seconds NUMERIC(8,6),
  gap_percent NUMERIC(8,3),
  shared_races INTEGER NOT NULL DEFAULT 0,
  faster_driver_primary_count INTEGER NOT NULL DEFAULT 0,
  coverage_status TEXT NOT NULL,
  failure_reason TEXT,
  session_used TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (season, team_id, driver_primary_id, driver_secondary_id)
);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_qualifying_season_summary_season ON teammate_gap_qualifying_season_summary(season);
CREATE INDEX IF NOT EXISTS idx_teammate_gap_qualifying_season_summary_drivers ON teammate_gap_qualifying_season_summary(driver_primary_id, driver_secondary_id);

-- ============================================================================
-- 5. CREATE UNIFIED DRIVER MATCHUP MATRIX TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS driver_matchup_matrix (
  driver_a_id TEXT NOT NULL,
  driver_b_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  season INTEGER NOT NULL,
  driver_a_wins INTEGER NOT NULL DEFAULT 0,
  driver_b_wins INTEGER NOT NULL DEFAULT 0,
  ties INTEGER NOT NULL DEFAULT 0,
  shared_events INTEGER NOT NULL DEFAULT 0,
  coverage_status TEXT NOT NULL DEFAULT 'insufficient',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (driver_a_id, driver_b_id, metric, season),
  CONSTRAINT chk_matchup_driver_ordering CHECK (driver_a_id < driver_b_id),
  CONSTRAINT chk_matchup_coverage_status CHECK (coverage_status IN ('valid', 'low_coverage', 'insufficient')),
  CONSTRAINT chk_matchup_metric_values CHECK (metric IN ('qualifying_position', 'race_finish_position'))
);

CREATE INDEX IF NOT EXISTS idx_driver_matchup_matrix_season ON driver_matchup_matrix(season);
CREATE INDEX IF NOT EXISTS idx_driver_matchup_matrix_drivers ON driver_matchup_matrix(driver_a_id, driver_b_id);
CREATE INDEX IF NOT EXISTS idx_driver_matchup_matrix_metric ON driver_matchup_matrix(metric);

-- ============================================================================
-- 6. MIGRATE EXISTING 2025 DATA TO UNIFIED TABLES
-- ============================================================================

-- Migrate race-level gaps
INSERT INTO teammate_gap_race_level (
  race_gap_id, season, round, team_id, driver_primary_id, driver_secondary_id,
  primary_median_lap_time_seconds, secondary_median_lap_time_seconds, shared_laps,
  gap_seconds, gap_percent, created_at
)
SELECT
  race_gap_id, season, round, team_id, driver_primary_id, driver_secondary_id,
  primary_median_lap_time_seconds, secondary_median_lap_time_seconds, shared_laps,
  gap_seconds, gap_percent, created_at
FROM teammate_gap_race_level_2025
ON CONFLICT (season, round, team_id, driver_primary_id, driver_secondary_id) DO NOTHING;

-- Migrate season summary
INSERT INTO teammate_gap_season_summary (
  season_summary_id, season, team_id, driver_primary_id, driver_secondary_id,
  driver_pair_gap_season, driver_pair_dispersion, total_shared_laps, num_valid_stints,
  driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races,
  faster_driver_primary_count, coverage_status, failure_reason, created_at
)
SELECT
  season_summary_id, season, team_id, driver_primary_id, driver_secondary_id,
  driver_pair_gap_season, driver_pair_dispersion, COALESCE(total_shared_laps, 0), COALESCE(num_valid_stints, 0),
  driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races,
  faster_driver_primary_count, coverage_status, failure_reason, created_at
FROM teammate_gap_season_summary_2025
ON CONFLICT (season, team_id, driver_primary_id, driver_secondary_id) DO NOTHING;

-- Migrate qualifying race-level
INSERT INTO teammate_gap_qualifying_race_level (
  race_gap_id, season, round, team_id, driver_primary_id, driver_secondary_id,
  session_used, primary_time_ms, secondary_time_ms, gap_seconds, gap_percent, created_at
)
SELECT
  race_gap_id, season, round, team_id, driver_primary_id, driver_secondary_id,
  session_used, primary_time_ms, secondary_time_ms, gap_seconds, gap_percent, created_at
FROM teammate_gap_qualifying_race_level_2025
ON CONFLICT (season, round, team_id, driver_primary_id, driver_secondary_id) DO NOTHING;

-- Migrate qualifying season summary
INSERT INTO teammate_gap_qualifying_season_summary (
  season_summary_id, season, team_id, driver_primary_id, driver_secondary_id,
  driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races,
  faster_driver_primary_count, coverage_status, failure_reason, session_used, created_at
)
SELECT
  season_summary_id, season, team_id, driver_primary_id, driver_secondary_id,
  driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, COALESCE(shared_races, 0),
  COALESCE(faster_driver_primary_count, 0), coverage_status, failure_reason, session_used, created_at
FROM teammate_gap_qualifying_season_summary_2025
ON CONFLICT (season, team_id, driver_primary_id, driver_secondary_id) DO NOTHING;

-- Migrate matchup matrix
INSERT INTO driver_matchup_matrix (
  driver_a_id, driver_b_id, metric, season, driver_a_wins, driver_b_wins,
  ties, shared_events, coverage_status, computed_at
)
SELECT
  driver_a_id, driver_b_id, metric, season, driver_a_wins, driver_b_wins,
  ties, shared_events, coverage_status, computed_at
FROM driver_matchup_matrix_2025
ON CONFLICT (driver_a_id, driver_b_id, metric, season) DO NOTHING;

-- ============================================================================
-- 7. CREATE BACKWARD-COMPATIBLE VIEWS FOR 2025 TABLES
-- ============================================================================
-- Note: We keep the original tables for now to avoid breaking anything.
-- The templates will be updated to use the unified tables.

-- Done! The migration is complete.
