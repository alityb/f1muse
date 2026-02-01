-- QUALIFYING DATA VERIFICATION QUERIES
-- Run these to verify qualifying data integrity and pole position accuracy

-- ============================================================================
-- 1. Season pole positions (official vs fastest time)
-- ============================================================================
SELECT
    season,
    pole_driver_id AS official_pole,
    fastest_driver_id AS fastest_time,
    CASE WHEN pole_driver_id != fastest_driver_id THEN correction_reason ELSE NULL END AS penalty_applied,
    track_id
FROM qualifying_official_poles
WHERE season = 2024
ORDER BY season, round;

-- ============================================================================
-- 2. Driver pole counts for 2024 (official)
-- ============================================================================
SELECT
    pole_driver_id AS driver,
    COUNT(*) AS official_pole_count
FROM qualifying_official_poles
WHERE season = 2024
GROUP BY pole_driver_id
ORDER BY official_pole_count DESC;

-- ============================================================================
-- 3. Verstappen 2024 breakdown (poles vs fastest times)
-- ============================================================================
SELECT
    'max_verstappen' AS driver,
    (SELECT COUNT(*) FROM qualifying_official_poles WHERE season = 2024 AND pole_driver_id = 'max_verstappen') AS official_poles,
    (SELECT COUNT(*) FROM qualifying_results WHERE season = 2024 AND driver_id = 'max_verstappen' AND qualifying_position = 1 AND session_type = 'RACE_QUALIFYING') AS fastest_times,
    '8 official poles, 10 fastest times (2 penalties)' AS expected;

-- ============================================================================
-- 4. Pole corrections applied
-- ============================================================================
SELECT
    season,
    round,
    fastest_driver_id AS set_fastest,
    pole_driver_id AS got_pole,
    correction_reason
FROM qualifying_pole_corrections
ORDER BY season, round;

-- ============================================================================
-- 5. Data completeness check for 2024
-- ============================================================================
SELECT
    round,
    COUNT(*) AS drivers,
    COUNT(*) FILTER (WHERE qualifying_position = 1) AS has_p1
FROM qualifying_results
WHERE season = 2024 AND session_type = 'RACE_QUALIFYING'
GROUP BY round
ORDER BY round;

-- ============================================================================
-- 6. Grid position vs qualifying position differences
-- (Should be empty if no penalties in base data)
-- ============================================================================
SELECT
    season, round, driver_id, qualifying_position, grid_position
FROM qualifying_results
WHERE qualifying_position != grid_position
  AND season = 2024
LIMIT 10;

-- ============================================================================
-- 7. Session type distribution
-- ============================================================================
SELECT
    season,
    session_type,
    COUNT(*) AS rows
FROM qualifying_results
GROUP BY season, session_type
ORDER BY season, session_type;
