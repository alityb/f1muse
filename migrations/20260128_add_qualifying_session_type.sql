-- MIGRATION: Add session_type to qualifying_results
--
-- Purpose: Distinguish between race qualifying and sprint qualifying
-- This allows correct pole counting (race poles vs sprint poles)
--
-- IDEMPOTENT: Safe to run multiple times
--
-- Date: 2026-01-28

-- ============================================================================
-- STEP 1: Create sprint_weekends reference table (if not using F1DB race table)
-- ============================================================================

-- Note: The F1DB 'race' table has sprint_qualifying_date which we can use directly.
-- However, we create a lightweight reference table for clarity and performance.

CREATE TABLE IF NOT EXISTS sprint_weekends (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    track_id TEXT,
    sprint_format TEXT DEFAULT 'standard',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, round)
);

-- Populate sprint weekends for 2022-2025
-- These are the actual F1 sprint weekends

-- 2022 Sprint Weekends (3 sprints - old format with Saturday quali)
INSERT INTO sprint_weekends (season, round, track_id) VALUES
    (2022, 4, 'imola'),           -- Emilia Romagna GP
    (2022, 11, 'red_bull_ring'),  -- Austrian GP
    (2022, 21, 'interlagos')      -- São Paulo GP
ON CONFLICT (season, round) DO NOTHING;

-- 2023 Sprint Weekends (6 sprints - new format with Friday quali)
INSERT INTO sprint_weekends (season, round, track_id) VALUES
    (2023, 4, 'baku'),            -- Azerbaijan GP
    (2023, 10, 'red_bull_ring'),  -- Austrian GP
    (2023, 12, 'spa'),            -- Belgian GP
    (2023, 17, 'lusail'),         -- Qatar GP
    (2023, 19, 'austin'),         -- United States GP
    (2023, 21, 'interlagos')      -- São Paulo GP
ON CONFLICT (season, round) DO NOTHING;

-- 2024 Sprint Weekends (6 sprints)
INSERT INTO sprint_weekends (season, round, track_id) VALUES
    (2024, 5, 'shanghai'),        -- Chinese GP
    (2024, 6, 'miami'),           -- Miami GP
    (2024, 11, 'red_bull_ring'),  -- Austrian GP
    (2024, 19, 'austin'),         -- United States GP
    (2024, 21, 'interlagos'),     -- São Paulo GP
    (2024, 22, 'lusail')          -- Qatar GP
ON CONFLICT (season, round) DO NOTHING;

-- 2025 Sprint Weekends (6 sprints - confirmed)
-- China (Mar 21-23), Miami (May 2-4), Belgium (Jul 25-27),
-- USA Austin (Oct 17-19), Brazil (Nov 7-9), Qatar (Nov 28-30)
INSERT INTO sprint_weekends (season, round, track_id) VALUES
    (2025, 2, 'shanghai'),        -- Chinese GP (March)
    (2025, 6, 'miami'),           -- Miami GP
    (2025, 14, 'spa'),            -- Belgian GP
    (2025, 19, 'austin'),         -- United States GP
    (2025, 21, 'interlagos'),     -- São Paulo GP
    (2025, 24, 'lusail')          -- Qatar GP
ON CONFLICT (season, round) DO NOTHING;

-- Index for sprint weekend lookups
CREATE INDEX IF NOT EXISTS idx_sprint_weekends_season ON sprint_weekends(season);

-- ============================================================================
-- STEP 2: Add session_type column to qualifying_results
-- ============================================================================

-- Add the session_type column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'qualifying_results'
        AND column_name = 'session_type'
    ) THEN
        ALTER TABLE qualifying_results
        ADD COLUMN session_type TEXT NOT NULL DEFAULT 'RACE_QUALIFYING';

        RAISE NOTICE 'Added session_type column to qualifying_results';
    ELSE
        RAISE NOTICE 'session_type column already exists';
    END IF;
END $$;

-- Add CHECK constraint for valid session types
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.constraint_column_usage
        WHERE table_name = 'qualifying_results'
        AND constraint_name = 'chk_qualifying_session_type'
    ) THEN
        ALTER TABLE qualifying_results
        ADD CONSTRAINT chk_qualifying_session_type
        CHECK (session_type IN ('RACE_QUALIFYING', 'SPRINT_QUALIFYING'));

        RAISE NOTICE 'Added session_type CHECK constraint';
    END IF;
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'CHECK constraint already exists';
END $$;

-- ============================================================================
-- STEP 3: Ensure all existing data is RACE_QUALIFYING
-- ============================================================================

-- NOTE: The ETL (ingest-qualifying.py) only loads 'Q' sessions from FastF1,
-- which are always RACE_QUALIFYING regardless of whether it's a sprint weekend.
-- Sprint qualifying data would need to be loaded separately using 'SQ' sessions.
--
-- Therefore, ALL existing qualifying_results data should be RACE_QUALIFYING.
-- The default value handles this correctly - no backfill needed.

-- Verify the data (for informational purposes)
DO $$
DECLARE
    sprint_count INTEGER;
    race_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO sprint_count
    FROM qualifying_results
    WHERE session_type = 'SPRINT_QUALIFYING';

    SELECT COUNT(*) INTO race_count
    FROM qualifying_results
    WHERE session_type = 'RACE_QUALIFYING';

    RAISE NOTICE 'Current data: % sprint qualifying rows, % race qualifying rows', sprint_count, race_count;
    RAISE NOTICE 'All existing data should be RACE_QUALIFYING since ETL loads Q sessions only';
END $$;

-- ============================================================================
-- STEP 4: Add index for session_type queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_qualifying_results_session_type
ON qualifying_results(season, session_type);

CREATE INDEX IF NOT EXISTS idx_qualifying_results_race_qualifying
ON qualifying_results(season, driver_id, qualifying_position)
WHERE session_type = 'RACE_QUALIFYING';

-- ============================================================================
-- STEP 5: Verification queries (for manual review)
-- ============================================================================

-- This comment section contains verification queries to run after migration:

/*
-- Count sprint vs race qualifying rows by season:
SELECT
    season,
    session_type,
    COUNT(*) as row_count
FROM qualifying_results
GROUP BY season, session_type
ORDER BY season, session_type;

-- Verify Verstappen 2024 race poles = 8:
SELECT
    driver_id,
    season,
    COUNT(*) FILTER (WHERE qualifying_position = 1) as pole_count,
    session_type
FROM qualifying_results
WHERE season = 2024
  AND driver_id = 'max_verstappen'
  AND is_dns = FALSE
GROUP BY driver_id, season, session_type;

-- Sprint weekends with qualifying data:
SELECT
    sw.season,
    sw.round,
    sw.track_id,
    COUNT(qr.driver_id) as driver_count,
    qr.session_type
FROM sprint_weekends sw
LEFT JOIN qualifying_results qr
    ON sw.season = qr.season
    AND sw.round = qr.round
GROUP BY sw.season, sw.round, sw.track_id, qr.session_type
ORDER BY sw.season, sw.round;
*/

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
