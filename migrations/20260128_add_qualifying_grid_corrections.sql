-- MIGRATION: Add qualifying grid corrections for FIA-accurate starting positions
--
-- Purpose: Store official FIA starting grid positions that differ from qualifying classification
-- FastF1 returns qualifying classification (by lap time), not actual starting grid (after penalties)
--
-- IDEMPOTENT: Safe to run multiple times
--
-- Date: 2026-01-28

-- ============================================================================
-- STEP 1: Create grid corrections table
-- ============================================================================

CREATE TABLE IF NOT EXISTS qualifying_grid_corrections (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    driver_id TEXT NOT NULL,
    qualifying_position INTEGER NOT NULL,  -- Original position by lap time
    official_grid_position INTEGER NOT NULL,  -- Actual FIA starting position
    reason TEXT NOT NULL,  -- e.g., "Engine penalty (10 places)", "Lap deleted"
    source TEXT DEFAULT 'FIA',  -- Data source: FIA, F1.com, gpracingstats
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, round, driver_id)
);

COMMENT ON TABLE qualifying_grid_corrections IS
'FIA-accurate starting grid positions that differ from qualifying classification.
Only stores rows where official_grid_position != qualifying_position.';

-- ============================================================================
-- STEP 2: Create indexes for efficient lookups
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_grid_corrections_season_round
ON qualifying_grid_corrections(season, round);

CREATE INDEX IF NOT EXISTS idx_grid_corrections_driver
ON qualifying_grid_corrections(driver_id);

-- ============================================================================
-- STEP 3: Create view for official qualifying results
-- ============================================================================

CREATE OR REPLACE VIEW qualifying_results_official AS
SELECT
    qr.season,
    qr.round,
    qr.driver_id,
    qr.team_id,
    qr.track_id,
    qr.qualifying_position,
    -- Use corrected grid position if available, otherwise qualifying position
    COALESCE(gc.official_grid_position, qr.qualifying_position) AS official_grid_position,
    -- Flag if this position was corrected
    gc.official_grid_position IS NOT NULL AS has_grid_correction,
    gc.reason AS correction_reason,
    qr.q1_time_ms,
    qr.q2_time_ms,
    qr.q3_time_ms,
    qr.best_time_ms,
    qr.best_session,
    qr.eliminated_in_round,
    qr.is_dnf,
    qr.is_dns,
    qr.session_type
FROM qualifying_results qr
LEFT JOIN qualifying_grid_corrections gc
    ON qr.season = gc.season
    AND qr.round = gc.round
    AND qr.driver_id = gc.driver_id
WHERE qr.session_type = 'RACE_QUALIFYING';

COMMENT ON VIEW qualifying_results_official IS
'Qualifying results with FIA-accurate starting grid positions.
official_grid_position = actual race starting position after penalties.
qualifying_position = classification by lap time (fastest = P1).';

-- ============================================================================
-- STEP 4: Create helper view for official pole positions
-- ============================================================================

CREATE OR REPLACE VIEW qualifying_official_poles AS
SELECT
    qro.season,
    qro.round,
    qro.track_id,
    qro.driver_id AS pole_driver_id,
    qro.team_id AS pole_team_id,
    qro.best_time_ms AS pole_time_ms,
    qro.has_grid_correction,
    qro.correction_reason
FROM qualifying_results_official qro
WHERE qro.official_grid_position = 1;

-- ============================================================================
-- STEP 5: Migrate existing pole corrections to grid corrections
-- ============================================================================

-- Insert existing pole corrections into the new table
-- For pole corrections, the fastest driver gets demoted, someone else gets P1
INSERT INTO qualifying_grid_corrections (season, round, driver_id, qualifying_position, official_grid_position, reason, source)
SELECT
    pc.season,
    pc.round,
    pc.fastest_driver_id,
    1,  -- They were P1 in qualifying
    -- Estimate their actual grid position based on penalty type
    CASE
        WHEN pc.correction_reason LIKE '%back of grid%' THEN 20
        WHEN pc.correction_reason LIKE '%10 place%' THEN 11
        WHEN pc.correction_reason LIKE '%5 place%' THEN 6
        WHEN pc.correction_reason LIKE '%1 place%' THEN 2
        ELSE 15  -- Default for unknown penalties
    END,
    pc.correction_reason,
    'pole_corrections_migration'
FROM qualifying_pole_corrections pc
ON CONFLICT (season, round, driver_id) DO NOTHING;

-- ============================================================================
-- STEP 6: Verification
-- ============================================================================

DO $$
DECLARE
    correction_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO correction_count FROM qualifying_grid_corrections;
    RAISE NOTICE 'Grid corrections table created with % initial rows', correction_count;
END $$;
