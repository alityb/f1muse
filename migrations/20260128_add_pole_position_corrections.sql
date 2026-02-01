-- MIGRATION: Add pole position corrections
--
-- Purpose: Track official pole position when grid penalties affect who starts P1
-- FastF1 doesn't include post-session grid penalties in qualifying data
--
-- The "pole position" in official F1 statistics is who STARTS P1 on the grid,
-- not who sets the fastest qualifying time.
--
-- IDEMPOTENT: Safe to run multiple times
--
-- Date: 2026-01-28

-- ============================================================================
-- STEP 1: Create pole corrections table
-- ============================================================================

CREATE TABLE IF NOT EXISTS qualifying_pole_corrections (
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    -- Driver who set fastest time (qualifying classification P1)
    fastest_driver_id TEXT NOT NULL,
    -- Driver who actually starts P1 (official pole)
    pole_driver_id TEXT NOT NULL,
    -- Reason for correction
    correction_reason TEXT NOT NULL,
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, round)
);

COMMENT ON TABLE qualifying_pole_corrections IS
'Corrections for pole position when grid penalties affect who starts P1.
FastF1 data shows qualifying classification, not race starting grid.';

-- ============================================================================
-- STEP 2: Insert known corrections for 2024
-- ============================================================================

-- Belgium 2024: Verstappen fastest but 10-place engine penalty
INSERT INTO qualifying_pole_corrections (season, round, fastest_driver_id, pole_driver_id, correction_reason)
VALUES (2024, 14, 'max_verstappen', 'charles_leclerc', 'Engine penalty (10 places)')
ON CONFLICT (season, round) DO UPDATE SET
    fastest_driver_id = EXCLUDED.fastest_driver_id,
    pole_driver_id = EXCLUDED.pole_driver_id,
    correction_reason = EXCLUDED.correction_reason,
    updated_at = NOW();

-- Qatar 2024: Verstappen fastest but 1-place penalty
INSERT INTO qualifying_pole_corrections (season, round, fastest_driver_id, pole_driver_id, correction_reason)
VALUES (2024, 23, 'max_verstappen', 'george_russell', 'Grid penalty (1 place) for impeding')
ON CONFLICT (season, round) DO UPDATE SET
    fastest_driver_id = EXCLUDED.fastest_driver_id,
    pole_driver_id = EXCLUDED.pole_driver_id,
    correction_reason = EXCLUDED.correction_reason,
    updated_at = NOW();

-- ============================================================================
-- STEP 3: Create view for official poles
-- ============================================================================

CREATE OR REPLACE VIEW qualifying_official_poles AS
SELECT
    qr.season,
    qr.round,
    qr.track_id,
    -- Use corrected pole driver if correction exists, otherwise qualifying P1
    COALESCE(pc.pole_driver_id, qr.driver_id) AS pole_driver_id,
    qr.driver_id AS fastest_driver_id,
    pc.correction_reason,
    qr.best_time_ms AS pole_time_ms,
    qr.session_type
FROM qualifying_results qr
LEFT JOIN qualifying_pole_corrections pc
    ON qr.season = pc.season AND qr.round = pc.round
WHERE qr.qualifying_position = 1
  AND qr.session_type = 'RACE_QUALIFYING';

COMMENT ON VIEW qualifying_official_poles IS
'Official pole positions accounting for grid penalties.
pole_driver_id = who started P1 (official pole), fastest_driver_id = who set fastest time.';

-- ============================================================================
-- STEP 4: Verification
-- ============================================================================

DO $$
DECLARE
    correction_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO correction_count FROM qualifying_pole_corrections;
    RAISE NOTICE 'Pole corrections added: %', correction_count;
END $$;
