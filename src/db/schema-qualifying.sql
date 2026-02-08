-- Schema for qualifying data tables
-- Run this before running the qualifying ETL scripts

-- Drop existing tables if they exist (for clean setup)
-- Uncomment these lines if you want to reset the data
-- DROP TABLE IF EXISTS etl_runs_qualifying;
-- DROP TABLE IF EXISTS qualifying_laps;
-- DROP TABLE IF EXISTS qualifying_sessions;
-- DROP TABLE IF EXISTS qualifying_results;

-- Primary qualifying results table
CREATE TABLE IF NOT EXISTS qualifying_results (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    driver_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    q1_time_ms INTEGER,
    q2_time_ms INTEGER,
    q3_time_ms INTEGER,
    best_time_ms INTEGER,
    best_session TEXT, -- 'Q1', 'Q2', 'Q3'
    qualifying_position INTEGER NOT NULL,
    grid_position INTEGER NOT NULL,
    eliminated_in_round TEXT, -- 'Q1', 'Q2', or NULL (made Q3)
    is_dnf BOOLEAN DEFAULT FALSE,
    is_dns BOOLEAN DEFAULT FALSE,
    has_grid_penalty BOOLEAN DEFAULT FALSE,
    grid_penalty_positions INTEGER DEFAULT 0,
    sector1_ms INTEGER,
    sector2_ms INTEGER,
    sector3_ms INTEGER,
    compound TEXT,
    session_type TEXT NOT NULL DEFAULT 'RACE_QUALIFYING', -- 'RACE_QUALIFYING' or 'SPRINT_QUALIFYING'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (season, round, driver_id)
);

-- Qualifying sessions metadata
CREATE TABLE IF NOT EXISTS qualifying_sessions (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    session_date DATE,
    weather_conditions TEXT,
    track_temp_celsius NUMERIC,
    air_temp_celsius NUMERIC,
    session_status TEXT DEFAULT 'completed',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (season, round)
);

-- Individual qualifying laps
CREATE TABLE IF NOT EXISTS qualifying_laps (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    session_type TEXT NOT NULL, -- 'Q1', 'Q2', 'Q3'
    lap_number INTEGER NOT NULL,
    lap_time_ms INTEGER NOT NULL,
    sector1_ms INTEGER,
    sector2_ms INTEGER,
    sector3_ms INTEGER,
    is_valid_lap BOOLEAN DEFAULT TRUE,
    is_personal_best BOOLEAN DEFAULT FALSE,
    is_session_best BOOLEAN DEFAULT FALSE,
    deleted_for_track_limits BOOLEAN DEFAULT FALSE,
    compound TEXT,
    tyre_age_laps INTEGER,
    weather TEXT,
    speed_trap_kmh NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (season, round, driver_id, session_type, lap_number)
);

-- ETL audit log for qualifying ingestion
CREATE TABLE IF NOT EXISTS etl_runs_qualifying (
    run_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    season INTEGER NOT NULL,
    round INTEGER, -- NULL if all rounds
    status TEXT NOT NULL, -- 'success', 'partial_failure', 'failed'
    sessions_processed INTEGER DEFAULT 0,
    sessions_skipped INTEGER DEFAULT 0,
    sessions_failed INTEGER DEFAULT 0,
    total_laps_inserted INTEGER DEFAULT 0,
    total_results_inserted INTEGER DEFAULT 0,
    execution_hash TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_qualifying_results_season ON qualifying_results(season);
CREATE INDEX IF NOT EXISTS idx_qualifying_results_track ON qualifying_results(track_id);
CREATE INDEX IF NOT EXISTS idx_qualifying_results_driver ON qualifying_results(driver_id);
CREATE INDEX IF NOT EXISTS idx_qualifying_results_team ON qualifying_results(team_id);
CREATE INDEX IF NOT EXISTS idx_qualifying_results_position ON qualifying_results(qualifying_position);
CREATE INDEX IF NOT EXISTS idx_qualifying_results_session_type ON qualifying_results(session_type);

CREATE INDEX IF NOT EXISTS idx_qualifying_laps_season ON qualifying_laps(season);
CREATE INDEX IF NOT EXISTS idx_qualifying_laps_driver ON qualifying_laps(driver_id);

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT ON qualifying_results TO f1muse_reader;
-- GRANT SELECT, INSERT, UPDATE ON qualifying_results TO f1muse_writer;
