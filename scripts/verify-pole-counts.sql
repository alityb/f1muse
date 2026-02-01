-- VERIFY POLE COUNTS
-- Run this script to validate pole position statistics match official FIA results

-- ============================================================================
-- 1. List all pole corrections
-- ============================================================================
SELECT
    'Pole Corrections Applied' as section,
    season,
    round,
    fastest_driver_id as "Fastest Qualifier",
    pole_driver_id as "Official Pole",
    correction_reason as "Reason"
FROM qualifying_pole_corrections
ORDER BY season, round;

-- ============================================================================
-- 2. Compare raw vs official pole counts
-- ============================================================================
WITH raw_poles AS (
    SELECT driver_id, COUNT(*) as raw_count
    FROM qualifying_results
    WHERE qualifying_position = 1 AND session_type = 'RACE_QUALIFYING'
    GROUP BY driver_id
),
official_poles AS (
    SELECT
        COALESCE(pc.pole_driver_id, qr.driver_id) as driver_id,
        COUNT(*) as official_count
    FROM qualifying_results qr
    LEFT JOIN qualifying_pole_corrections pc
        ON qr.season = pc.season AND qr.round = pc.round
    WHERE qr.qualifying_position = 1 AND qr.session_type = 'RACE_QUALIFYING'
    GROUP BY COALESCE(pc.pole_driver_id, qr.driver_id)
)
SELECT
    'All-Time Pole Count Comparison' as section,
    COALESCE(r.driver_id, o.driver_id) as driver,
    COALESCE(r.raw_count, 0) as "Fastest Times",
    COALESCE(o.official_count, 0) as "Official Poles",
    COALESCE(r.raw_count, 0) - COALESCE(o.official_count, 0) as "Difference"
FROM raw_poles r
FULL OUTER JOIN official_poles o ON r.driver_id = o.driver_id
ORDER BY COALESCE(o.official_count, 0) DESC
LIMIT 15;

-- ============================================================================
-- 3. Pole counts by season (top 5 per season)
-- ============================================================================
WITH ranked_poles AS (
    SELECT
        qr.season,
        COALESCE(pc.pole_driver_id, qr.driver_id) as driver_id,
        COUNT(*) as pole_count,
        ROW_NUMBER() OVER (PARTITION BY qr.season ORDER BY COUNT(*) DESC) as rank
    FROM qualifying_results qr
    LEFT JOIN qualifying_pole_corrections pc
        ON qr.season = pc.season AND qr.round = pc.round
    WHERE qr.qualifying_position = 1 AND qr.session_type = 'RACE_QUALIFYING'
    GROUP BY qr.season, COALESCE(pc.pole_driver_id, qr.driver_id)
)
SELECT
    season,
    driver_id,
    pole_count,
    rank
FROM ranked_poles
WHERE rank <= 5
ORDER BY season, rank;

-- ============================================================================
-- 4. Validate known values (will fail if data is incorrect)
-- ============================================================================
SELECT
    'Validation Check' as section,
    season,
    driver_id,
    pole_count,
    expected,
    CASE WHEN pole_count = expected THEN 'PASS' ELSE 'FAIL' END as result
FROM (
    SELECT
        qr.season,
        COALESCE(pc.pole_driver_id, qr.driver_id) as driver_id,
        COUNT(*) as pole_count,
        CASE
            -- 2022 Official Counts
            WHEN qr.season = 2022 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 7
            WHEN qr.season = 2022 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'charles_leclerc' THEN 9
            WHEN qr.season = 2022 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'carlos_sainz_jr' THEN 3
            -- 2023 Official Counts
            WHEN qr.season = 2023 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 12
            WHEN qr.season = 2023 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'charles_leclerc' THEN 5
            -- 2024 Official Counts
            WHEN qr.season = 2024 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 8
            WHEN qr.season = 2024 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'lando_norris' THEN 8
            WHEN qr.season = 2024 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'george_russell' THEN 4
            WHEN qr.season = 2024 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'charles_leclerc' THEN 3
            -- 2025 Official Counts
            WHEN qr.season = 2025 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 8
            WHEN qr.season = 2025 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'lando_norris' THEN 7
            WHEN qr.season = 2025 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'oscar_piastri' THEN 6
            ELSE -1  -- Unknown expectation
        END as expected
    FROM qualifying_results qr
    LEFT JOIN qualifying_pole_corrections pc
        ON qr.season = pc.season AND qr.round = pc.round
    WHERE qr.qualifying_position = 1 AND qr.session_type = 'RACE_QUALIFYING'
    GROUP BY qr.season, COALESCE(pc.pole_driver_id, qr.driver_id)
) sub
WHERE expected > 0
ORDER BY season, pole_count DESC;

-- ============================================================================
-- 5. List any mismatches (should be empty if data is correct)
-- ============================================================================
SELECT
    'MISMATCHES (should be empty)' as section,
    season,
    driver_id,
    pole_count,
    expected
FROM (
    SELECT
        qr.season,
        COALESCE(pc.pole_driver_id, qr.driver_id) as driver_id,
        COUNT(*) as pole_count,
        CASE
            WHEN qr.season = 2022 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 7
            WHEN qr.season = 2022 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'charles_leclerc' THEN 9
            WHEN qr.season = 2023 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 12
            WHEN qr.season = 2024 AND COALESCE(pc.pole_driver_id, qr.driver_id) = 'max_verstappen' THEN 8
            ELSE NULL
        END as expected
    FROM qualifying_results qr
    LEFT JOIN qualifying_pole_corrections pc
        ON qr.season = pc.season AND qr.round = pc.round
    WHERE qr.qualifying_position = 1 AND qr.session_type = 'RACE_QUALIFYING'
    GROUP BY qr.season, COALESCE(pc.pole_driver_id, qr.driver_id)
) sub
WHERE expected IS NOT NULL AND pole_count != expected;
