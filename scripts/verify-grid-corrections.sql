-- VERIFY GRID CORRECTIONS
-- Run this script to validate FIA-accurate starting grid positions

-- ============================================================================
-- 1. Summary of grid corrections by season
-- ============================================================================
SELECT
    'Grid Corrections Summary' as section,
    season,
    COUNT(*) as total_corrections,
    COUNT(DISTINCT round) as rounds_affected,
    COUNT(DISTINCT driver_id) as drivers_affected
FROM qualifying_grid_corrections
GROUP BY season
ORDER BY season;

-- ============================================================================
-- 2. View sample corrections
-- ============================================================================
SELECT
    'Sample Corrections' as section,
    season,
    round,
    driver_id,
    qualifying_position as "Quali Pos",
    official_grid_position as "Grid Pos",
    reason,
    source
FROM qualifying_grid_corrections
WHERE season >= 2022
ORDER BY season, round, qualifying_position
LIMIT 30;

-- ============================================================================
-- 3. Validate official poles via the view
-- ============================================================================
SELECT
    'Official Poles by Season' as section,
    qro.season,
    qro.driver_id,
    COUNT(*) as pole_count
FROM qualifying_results_official qro
WHERE qro.official_grid_position = 1
GROUP BY qro.season, qro.driver_id
ORDER BY qro.season, pole_count DESC;

-- ============================================================================
-- 4. Compare raw vs official pole counts (2022-2025)
-- ============================================================================
WITH raw_poles AS (
    SELECT driver_id, season, COUNT(*) as raw_count
    FROM qualifying_results
    WHERE qualifying_position = 1
      AND session_type = 'RACE_QUALIFYING'
      AND season >= 2022
    GROUP BY driver_id, season
),
official_poles AS (
    SELECT driver_id, season, COUNT(*) as official_count
    FROM qualifying_results_official
    WHERE official_grid_position = 1
      AND season >= 2022
    GROUP BY driver_id, season
)
SELECT
    'Raw vs Official Pole Comparison' as section,
    COALESCE(r.season, o.season) as season,
    COALESCE(r.driver_id, o.driver_id) as driver,
    COALESCE(r.raw_count, 0) as "Fastest Times",
    COALESCE(o.official_count, 0) as "Official Poles",
    COALESCE(r.raw_count, 0) - COALESCE(o.official_count, 0) as "Difference"
FROM raw_poles r
FULL OUTER JOIN official_poles o
    ON r.driver_id = o.driver_id AND r.season = o.season
WHERE COALESCE(r.raw_count, 0) != COALESCE(o.official_count, 0)
ORDER BY season, "Difference" DESC;

-- ============================================================================
-- 5. Validate Verstappen's pole counts match expected
-- ============================================================================
SELECT
    'Verstappen Pole Validation' as section,
    season,
    COUNT(*) FILTER (WHERE official_grid_position = 1) as official_poles,
    COUNT(*) FILTER (WHERE qualifying_position = 1) as fastest_times,
    CASE season
        WHEN 2022 THEN 7
        WHEN 2023 THEN 12
        WHEN 2024 THEN 8
        WHEN 2025 THEN 8
    END as expected_poles,
    CASE
        WHEN COUNT(*) FILTER (WHERE official_grid_position = 1) =
             CASE season WHEN 2022 THEN 7 WHEN 2023 THEN 12 WHEN 2024 THEN 8 WHEN 2025 THEN 8 END
        THEN 'PASS'
        ELSE 'FAIL'
    END as validation
FROM qualifying_results_official
WHERE driver_id = 'max_verstappen'
  AND season >= 2022
GROUP BY season
ORDER BY season;

-- ============================================================================
-- 6. Belgium GP corrections validation (famous penalty races)
-- ============================================================================
SELECT
    'Belgium GP Corrections' as section,
    season,
    driver_id,
    qualifying_position as "Quali Pos",
    official_grid_position as "Grid Pos",
    has_grid_correction,
    correction_reason
FROM qualifying_results_official
WHERE track_id = 'spa-francorchamps'
  AND season >= 2022
  AND (has_grid_correction = true OR qualifying_position <= 3)
ORDER BY season, official_grid_position;

-- ============================================================================
-- 7. Drivers with most grid penalties (corrections)
-- ============================================================================
SELECT
    'Drivers with Most Grid Corrections' as section,
    driver_id,
    COUNT(*) as correction_count,
    AVG(official_grid_position - qualifying_position) as avg_positions_dropped
FROM qualifying_grid_corrections
WHERE season >= 2022
GROUP BY driver_id
HAVING COUNT(*) >= 3
ORDER BY correction_count DESC;
