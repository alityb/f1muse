-- ============================================================================
-- DRIVER TREND SUMMARY (TIER 2)
-- ============================================================================
-- Template: driver_trend_summary_v1.sql
-- Parameters:
--   $1 = driver_id (string) - F1DB driver.id
--   $2 = start_season (integer) - Start of analysis period
--   $3 = end_season (integer) - End of analysis period
--
-- Returns multi-season performance trend:
-- - Per-season teammate gap data
-- - Trend slope (improvement/decline rate)
-- - Volatility measure
-- - Classification: improving | declining | stable
--
-- METHODOLOGY:
--   - Uses teammate gap as primary performance metric (track-length invariant)
--   - Trend calculated via linear regression over seasons
--   - Negative slope = improving (faster), Positive slope = declining
--   - Classification thresholds:
--     * |slope| < 0.05 → stable
--     * slope < -0.05 → improving
--     * slope > 0.05 → declining
--
-- FAIL-CLOSED: Returns NULL if insufficient seasons have data.
-- ============================================================================

WITH season_gaps AS (
  -- Collect teammate gaps for each season in the analysis period
  SELECT
    tg.season,
    CASE
      WHEN tg.driver_primary_id = $1 THEN tg.gap_percent
      ELSE -tg.gap_percent
    END AS teammate_gap_percent,
    tg.shared_races,
    tg.coverage_status
  FROM (
    -- Check 2025 table
    SELECT season, driver_primary_id, driver_secondary_id, gap_percent, shared_races, coverage_status
    FROM teammate_gap_season_summary_2025
    WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
      AND season BETWEEN $2 AND $3
      AND coverage_status IN ('valid', 'low_coverage')
  ) tg
),

qualifying_gaps AS (
  -- Collect qualifying gaps for each season
  SELECT
    tq.season,
    CASE
      WHEN tq.driver_primary_id = $1 THEN tq.gap_percent
      ELSE -tq.gap_percent
    END AS qualifying_gap_percent
  FROM (
    SELECT season, driver_primary_id, driver_secondary_id, gap_percent
    FROM teammate_gap_qualifying_season_summary_2025
    WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
      AND season BETWEEN $2 AND $3
      AND coverage_status IN ('valid', 'low_coverage')
  ) tq
),

season_results AS (
  -- Collect race results for each season
  SELECT
    r.year AS season,
    COUNT(*) FILTER (WHERE rd.position_number = 1) AS wins,
    COUNT(*) FILTER (WHERE rd.position_number <= 3) AS podiums,
    COUNT(*) FILTER (WHERE rd.race_reason_retired IS NOT NULL) AS dnfs
  FROM race_data rd
  JOIN race r ON rd.race_id = r.id
  WHERE rd.driver_id = $1
    AND rd.type = 'RACE_RESULT'
    AND r.year BETWEEN $2 AND $3
  GROUP BY r.year
),

combined_seasons AS (
  -- Combine all season data
  SELECT
    COALESCE(sg.season, qg.season, sr.season) AS season,
    sg.teammate_gap_percent,
    qg.qualifying_gap_percent,
    COALESCE(sr.wins, 0) AS wins,
    COALESCE(sr.podiums, 0) AS podiums,
    COALESCE(sr.dnfs, 0) AS dnfs
  FROM season_gaps sg
  FULL OUTER JOIN qualifying_gaps qg ON sg.season = qg.season
  FULL OUTER JOIN season_results sr ON COALESCE(sg.season, qg.season) = sr.season
  ORDER BY season
),

trend_calc AS (
  -- Calculate linear regression for trend
  SELECT
    COUNT(*) AS n,
    CASE
      WHEN COUNT(*) >= 2 AND STDDEV(teammate_gap_percent) > 0 THEN
        REGR_SLOPE(teammate_gap_percent, season)
      ELSE NULL
    END AS slope,
    CASE
      WHEN COUNT(*) >= 2 AND STDDEV(teammate_gap_percent) > 0 THEN
        REGR_R2(teammate_gap_percent, season)
      ELSE NULL
    END AS r_squared,
    STDDEV(teammate_gap_percent) AS volatility
  FROM combined_seasons
  WHERE teammate_gap_percent IS NOT NULL
)

SELECT
  d.id AS driver_id,
  d.full_name AS driver_name,
  $2::integer AS start_season,
  $3::integer AS end_season,
  tc.n AS seasons_analyzed,
  tc.slope AS slope_per_season,
  tc.volatility,
  tc.r_squared,
  CASE
    WHEN tc.slope IS NULL THEN 'stable'
    WHEN tc.slope < -0.05 THEN 'improving'
    WHEN tc.slope > 0.05 THEN 'declining'
    ELSE 'stable'
  END AS classification,
  (SELECT json_agg(row_to_json(cs) ORDER BY cs.season) FROM combined_seasons cs) AS season_data
FROM driver d
CROSS JOIN trend_calc tc
WHERE d.id = $1;
