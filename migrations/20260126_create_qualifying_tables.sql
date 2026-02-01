-- Create qualifying tables for F1 Muse
-- Supports seasons 2022-2025
-- Migration: 20260126_create_qualifying_tables.sql

-- =============================================================================
-- 1. qualifying_sessions - Track qualifying session metadata
-- =============================================================================
CREATE TABLE IF NOT EXISTS qualifying_sessions (
  -- Primary key
  id SERIAL PRIMARY KEY,

  -- Session identification
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  track_id TEXT NOT NULL,

  -- Session metadata
  session_date DATE,
  weather_conditions TEXT,  -- 'dry', 'wet', 'mixed'
  track_temp_celsius NUMERIC(5,2),
  air_temp_celsius NUMERIC(5,2),

  -- Session status
  session_status TEXT DEFAULT 'completed',  -- 'completed', 'cancelled', 'red_flagged'

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint
  CONSTRAINT uq_qualifying_session_key UNIQUE (season, round)
);

CREATE INDEX IF NOT EXISTS idx_qualifying_sessions_season
  ON qualifying_sessions (season);

CREATE INDEX IF NOT EXISTS idx_qualifying_sessions_track
  ON qualifying_sessions (track_id);

COMMENT ON TABLE qualifying_sessions IS 'Qualifying session metadata per race weekend';

-- =============================================================================
-- 2. qualifying_results - Driver results per qualifying session
-- =============================================================================
CREATE TABLE IF NOT EXISTS qualifying_results (
  -- Primary key (composite)
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  driver_id TEXT NOT NULL,

  -- Team info
  team_id TEXT NOT NULL,

  -- Track reference
  track_id TEXT NOT NULL,

  -- Qualifying times (milliseconds for precision)
  q1_time_ms INTEGER,          -- NULL if DNS/no time set
  q2_time_ms INTEGER,          -- NULL if eliminated in Q1 or DNS
  q3_time_ms INTEGER,          -- NULL if eliminated in Q1/Q2 or DNS

  -- Best qualifying time (best of Q1/Q2/Q3)
  best_time_ms INTEGER,
  best_session TEXT,           -- 'Q1', 'Q2', 'Q3'

  -- Positions
  qualifying_position INTEGER NOT NULL,  -- Final qualifying position (1-20)
  grid_position INTEGER,                 -- Actual grid position (may differ due to penalties)

  -- Elimination tracking
  eliminated_in_round TEXT,    -- 'Q1', 'Q2', NULL (if reached Q3)

  -- Status flags
  is_dnf BOOLEAN DEFAULT FALSE,         -- Did not finish qualifying
  is_dns BOOLEAN DEFAULT FALSE,         -- Did not start qualifying
  has_grid_penalty BOOLEAN DEFAULT FALSE,
  grid_penalty_positions INTEGER DEFAULT 0,

  -- Sector times (Q3 or best session, milliseconds)
  sector1_ms INTEGER,
  sector2_ms INTEGER,
  sector3_ms INTEGER,

  -- Tire compound used for best lap
  compound TEXT,

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Primary key
  PRIMARY KEY (season, round, driver_id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_qualifying_results_season_driver
  ON qualifying_results (season, driver_id);

CREATE INDEX IF NOT EXISTS idx_qualifying_results_team_season
  ON qualifying_results (team_id, season);

CREATE INDEX IF NOT EXISTS idx_qualifying_results_position
  ON qualifying_results (season, qualifying_position);

CREATE INDEX IF NOT EXISTS idx_qualifying_results_q3_times
  ON qualifying_results (season, q3_time_ms)
  WHERE q3_time_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qualifying_results_track
  ON qualifying_results (track_id, season);

COMMENT ON TABLE qualifying_results IS 'Driver qualifying results with Q1/Q2/Q3 times and grid positions';
COMMENT ON COLUMN qualifying_results.eliminated_in_round IS 'Q1 or Q2 if eliminated, NULL if reached Q3';
COMMENT ON COLUMN qualifying_results.qualifying_position IS 'Final qualifying position before penalties';
COMMENT ON COLUMN qualifying_results.grid_position IS 'Actual grid position after penalties applied';

-- =============================================================================
-- 3. driver_qualifying_stats_season - Aggregated qualifying stats per driver/season
-- =============================================================================
CREATE TABLE IF NOT EXISTS driver_qualifying_stats_season (
  -- Primary key (composite)
  season INTEGER NOT NULL,
  driver_id TEXT NOT NULL,

  -- Team info
  team_id TEXT NOT NULL,

  -- Pole count
  pole_positions INTEGER DEFAULT 0,

  -- Front row (P1-P2)
  front_row_count INTEGER DEFAULT 0,

  -- Top 3 (P1-P3)
  top_3_count INTEGER DEFAULT 0,

  -- Q3 appearances
  q3_appearances INTEGER DEFAULT 0,

  -- Q2 eliminations
  q2_eliminations INTEGER DEFAULT 0,

  -- Q1 eliminations
  q1_eliminations INTEGER DEFAULT 0,

  -- Total qualifying sessions
  total_sessions INTEGER DEFAULT 0,

  -- Average qualifying position
  avg_qualifying_position NUMERIC(5,2),

  -- Best qualifying position
  best_qualifying_position INTEGER,

  -- Worst qualifying position
  worst_qualifying_position INTEGER,

  -- Average gap to pole (percentage)
  avg_gap_to_pole_percent NUMERIC(6,3),

  -- Median Q3 time (milliseconds)
  median_q3_time_ms INTEGER,

  -- Teammate comparison (if applicable)
  teammate_id TEXT,                           -- NULL if no consistent teammate
  outqualified_teammate_count INTEGER,        -- Times finished ahead of teammate
  outqualified_by_teammate_count INTEGER,     -- Times finished behind teammate
  qualifying_gap_to_teammate_percent NUMERIC(6,3),  -- Avg % gap (negative = faster)

  -- Audit
  computed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Primary key
  PRIMARY KEY (season, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_qualifying_stats_poles
  ON driver_qualifying_stats_season (season, pole_positions DESC);

CREATE INDEX IF NOT EXISTS idx_driver_qualifying_stats_q3
  ON driver_qualifying_stats_season (season, q3_appearances DESC);

CREATE INDEX IF NOT EXISTS idx_driver_qualifying_stats_team
  ON driver_qualifying_stats_season (team_id, season);

COMMENT ON TABLE driver_qualifying_stats_season IS 'Aggregated qualifying statistics per driver per season';

-- =============================================================================
-- 4. qualifying_laps - Individual lap times from qualifying sessions
-- =============================================================================
CREATE TABLE IF NOT EXISTS qualifying_laps (
  -- Session identification
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  track_id TEXT NOT NULL,

  -- Driver identification
  driver_id TEXT NOT NULL,
  team_id TEXT NOT NULL,

  -- Session identification
  session_type TEXT NOT NULL,  -- 'Q1', 'Q2', 'Q3'

  -- Lap identification
  lap_number INTEGER NOT NULL,

  -- Lap time
  lap_time_ms INTEGER NOT NULL,

  -- Sector times (milliseconds)
  sector1_ms INTEGER,
  sector2_ms INTEGER,
  sector3_ms INTEGER,

  -- Validity
  is_valid_lap BOOLEAN DEFAULT TRUE,
  is_personal_best BOOLEAN DEFAULT FALSE,  -- Personal best at time of lap
  is_session_best BOOLEAN DEFAULT FALSE,   -- Session best at time of lap
  deleted_for_track_limits BOOLEAN DEFAULT FALSE,

  -- Tire info
  compound TEXT,
  tyre_age_laps INTEGER,

  -- Track conditions
  weather TEXT,  -- 'dry', 'wet', 'damp'

  -- Speed trap data (km/h)
  speed_trap_kmh NUMERIC(6,2),

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Primary key
  PRIMARY KEY (season, round, driver_id, session_type, lap_number)
);

CREATE INDEX IF NOT EXISTS idx_qualifying_laps_session
  ON qualifying_laps (season, round, session_type);

CREATE INDEX IF NOT EXISTS idx_qualifying_laps_driver
  ON qualifying_laps (driver_id, season);

CREATE INDEX IF NOT EXISTS idx_qualifying_laps_best
  ON qualifying_laps (season, round, session_type, lap_time_ms)
  WHERE is_valid_lap = TRUE;

COMMENT ON TABLE qualifying_laps IS 'Individual lap times from qualifying sessions (Q1/Q2/Q3)';

-- =============================================================================
-- 5. teammate_gap_qualifying_season_summary - Qualifying teammate gaps
-- =============================================================================
CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary (
  -- Primary key (composite)
  season INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  driver_primary_id TEXT NOT NULL,
  driver_secondary_id TEXT NOT NULL,

  -- Gap metrics (percentage, symmetric difference)
  gap_percent NUMERIC(6,3),               -- Primary - Secondary (negative = primary faster)
  driver_pair_gap_percent NUMERIC(6,3),   -- Alias for compatibility
  driver_pair_gap_seconds NUMERIC(8,3),   -- Absolute gap in seconds

  -- Comparison counts
  shared_races INTEGER NOT NULL,
  faster_driver_primary_count INTEGER NOT NULL,  -- Times primary qualified ahead
  faster_driver_secondary_count INTEGER NOT NULL,
  ties INTEGER DEFAULT 0,

  -- Coverage status
  coverage_status TEXT NOT NULL,          -- 'valid', 'low_coverage', 'insufficient'
  failure_reason TEXT,                    -- Reason if insufficient

  -- Audit
  computed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Primary key
  PRIMARY KEY (season, team_id, driver_primary_id, driver_secondary_id)
);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_qualifying_season
  ON teammate_gap_qualifying_season_summary (season);

CREATE INDEX IF NOT EXISTS idx_teammate_gap_qualifying_drivers
  ON teammate_gap_qualifying_season_summary (driver_primary_id, driver_secondary_id, season);

COMMENT ON TABLE teammate_gap_qualifying_season_summary IS 'Season-level qualifying gap between teammates';
COMMENT ON COLUMN teammate_gap_qualifying_season_summary.gap_percent IS 'Symmetric percent difference: 100 * (primary - secondary) / mean. Negative = primary faster';

-- =============================================================================
-- 6. Add session_type column to laps_normalized if not exists
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'laps_normalized'
    AND column_name = 'session_type'
  ) THEN
    ALTER TABLE laps_normalized ADD COLUMN session_type TEXT DEFAULT 'R';
    COMMENT ON COLUMN laps_normalized.session_type IS 'Session type: R=Race, Q1/Q2/Q3=Qualifying, S=Sprint';
  END IF;
END $$;

-- Update existing race laps to have session_type = 'R' if null
UPDATE laps_normalized
SET session_type = 'R'
WHERE session_type IS NULL;

-- =============================================================================
-- ETL audit table for qualifying ingestion
-- =============================================================================
CREATE TABLE IF NOT EXISTS etl_runs_qualifying (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  round INTEGER,  -- NULL if all rounds
  status TEXT NOT NULL,  -- 'success', 'partial_failure', 'failed'
  sessions_processed INTEGER NOT NULL,
  sessions_skipped INTEGER NOT NULL,
  sessions_failed INTEGER NOT NULL,
  total_laps_inserted INTEGER NOT NULL,
  total_results_inserted INTEGER NOT NULL,
  execution_hash TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_etl_runs_qualifying_season
  ON etl_runs_qualifying (season);

COMMENT ON TABLE etl_runs_qualifying IS 'Audit log for qualifying data ETL runs';
