-- QUALIFYING SESSION TYPE VERIFICATION QUERIES
-- Run these after applying the migration to verify correct data

-- ============================================================================
-- 1. Check session_type column exists and has expected values
-- ============================================================================
SELECT
    session_type,
    COUNT(*) as row_count
FROM qualifying_results
GROUP BY session_type
ORDER BY session_type;

-- Expected: All rows should be RACE_QUALIFYING (since ETL only loads 'Q' sessions)

-- ============================================================================
-- 2. Verify Verstappen 2024 pole count = 8 (race qualifying only)
-- ============================================================================
SELECT
    driver_id,
    season,
    COUNT(*) FILTER (WHERE qualifying_position = 1) as race_pole_count,
    COUNT(*) as total_sessions
FROM qualifying_results
WHERE season = 2024
  AND driver_id = 'max_verstappen'
  AND is_dns = FALSE
  AND session_type = 'RACE_QUALIFYING'
GROUP BY driver_id, season;

-- Expected: race_pole_count = 8

-- ============================================================================
-- 3. Compare with unfiltered count (to see the difference)
-- ============================================================================
SELECT
    driver_id,
    season,
    session_type,
    COUNT(*) FILTER (WHERE qualifying_position = 1) as pole_count,
    COUNT(*) as total_sessions
FROM qualifying_results
WHERE season = 2024
  AND driver_id = 'max_verstappen'
  AND is_dns = FALSE
GROUP BY driver_id, season, session_type;

-- ============================================================================
-- 4. Sprint weekends table verification
-- ============================================================================
SELECT * FROM sprint_weekends ORDER BY season, round;

-- ============================================================================
-- 5. Count qualifying sessions by season and type
-- ============================================================================
SELECT
    season,
    session_type,
    COUNT(DISTINCT round) as rounds,
    COUNT(*) as driver_results
FROM qualifying_results
GROUP BY season, session_type
ORDER BY season, session_type;

-- ============================================================================
-- 6. Verify 2024 season-wide pole counts match official F1 data
-- ============================================================================
WITH pole_stats AS (
    SELECT
        driver_id,
        COUNT(*) as pole_count
    FROM qualifying_results
    WHERE season = 2024
      AND qualifying_position = 1
      AND is_dns = FALSE
      AND session_type = 'RACE_QUALIFYING'
    GROUP BY driver_id
)
SELECT
    driver_id,
    pole_count
FROM pole_stats
ORDER BY pole_count DESC, driver_id;

-- Expected top poles for 2024:
-- max_verstappen: 8
-- lando_norris: 6
-- charles_leclerc: 5
-- george_russell: 3
-- lewis_hamilton: 1
-- oscar_piastri: 1

-- ============================================================================
-- 7. Check for any data inconsistencies
-- ============================================================================

-- Any qualifying positions outside valid range?
SELECT COUNT(*)
FROM qualifying_results
WHERE qualifying_position < 1 OR qualifying_position > 20;

-- Any rounds with duplicate drivers in same session type?
SELECT season, round, driver_id, session_type, COUNT(*)
FROM qualifying_results
GROUP BY season, round, driver_id, session_type
HAVING COUNT(*) > 1;
