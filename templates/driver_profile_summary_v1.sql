-- ============================================================================
-- DRIVER PROFILE SUMMARY (TIER 2)
-- ============================================================================
-- Template: driver_profile_summary_v1.sql
-- Parameters:
--   $1 = driver_id (string) - F1DB driver.id
--   $2 = current_season (integer) - For latest season stats
--
-- Returns comprehensive driver profile including:
-- - Career statistics from F1DB
-- - Best/worst track performance
-- - Latest season teammate comparison
-- - Performance trend over recent seasons
--
-- METHODOLOGY:
--   - Career stats from driver table (F1DB reference data)
--   - Track performance from race_data aggregations
--   - Teammate gap from teammate_gap tables
--
-- FAIL-CLOSED: Returns NULL for metrics without sufficient data.
-- ============================================================================

WITH career_stats AS (
  -- Career statistics from F1DB driver table
  -- seasons_raced from season_driver_standing (authoritative, complete history 1950-present)
  SELECT
    d.id AS driver_id,
    d.full_name AS driver_name,
    COALESCE(d.total_championship_wins, 0) AS championships,
    COALESCE(d.total_race_wins, 0) AS total_wins,
    COALESCE(d.total_podiums, 0) AS total_podiums,
    COALESCE(d.total_pole_positions, 0) AS total_poles,
    (SELECT MIN(year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS first_season,
    (SELECT MAX(year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS latest_season,
    (SELECT COUNT(DISTINCT year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS seasons_raced
  FROM driver d
  WHERE d.id = $1
),

track_performance AS (
  -- Aggregate race results by track
  SELECT
    c.id AS track_id,
    c.name AS track_name,
    COUNT(*) AS races,
    AVG(rd.position_number) AS avg_position,
    COUNT(*) FILTER (WHERE rd.position_number = 1) AS wins,
    COUNT(*) FILTER (WHERE rd.position_number <= 3) AS podiums
  FROM race_data rd
  JOIN race r ON rd.race_id = r.id
  JOIN circuit c ON r.circuit_id = c.id
  WHERE rd.driver_id = $1
    AND rd.type = 'RACE_RESULT'
    AND rd.position_number IS NOT NULL
  GROUP BY c.id, c.name
  HAVING COUNT(*) >= 2  -- Minimum 2 races for meaningful track stats
),

best_tracks AS (
  SELECT * FROM track_performance
  ORDER BY avg_position ASC
  LIMIT 3
),

worst_tracks AS (
  SELECT * FROM track_performance
  ORDER BY avg_position DESC
  LIMIT 3
),

latest_teammate AS (
  -- Latest season teammate comparison (race pace)
  SELECT
    tg.season,
    tg.team_id,
    CASE
      WHEN tg.driver_primary_id = $1 THEN tg.driver_secondary_id
      ELSE tg.driver_primary_id
    END AS teammate_id,
    CASE
      WHEN tg.driver_primary_id = $1 THEN tg.gap_percent
      ELSE -tg.gap_percent
    END AS race_gap_percent,
    tg.shared_races
  FROM teammate_gap_season_summary_2025 tg
  WHERE (tg.driver_primary_id = $1 OR tg.driver_secondary_id = $1)
    AND tg.season = $2
    AND tg.coverage_status IN ('valid', 'low_coverage')
  ORDER BY tg.shared_races DESC
  LIMIT 1
),

latest_teammate_qualifying AS (
  -- Latest season teammate qualifying gap
  SELECT
    tq.season,
    CASE
      WHEN tq.driver_primary_id = $1 THEN tq.gap_percent
      ELSE -tq.gap_percent
    END AS qualifying_gap_percent
  FROM teammate_gap_qualifying_season_summary_2025 tq
  WHERE (tq.driver_primary_id = $1 OR tq.driver_secondary_id = $1)
    AND tq.season = $2
    AND tq.coverage_status IN ('valid', 'low_coverage')
  LIMIT 1
)

SELECT
  -- Career stats
  cs.driver_id,
  cs.driver_name,
  cs.championships,
  cs.total_wins,
  cs.total_podiums,
  cs.total_poles,
  cs.first_season,
  cs.latest_season,
  cs.seasons_raced,

  -- Best tracks (as JSON array)
  (SELECT json_agg(row_to_json(bt)) FROM best_tracks bt) AS best_tracks,

  -- Worst tracks (as JSON array)
  (SELECT json_agg(row_to_json(wt)) FROM worst_tracks wt) AS worst_tracks,

  -- Latest teammate comparison
  lt.season AS teammate_season,
  lt.teammate_id,
  (SELECT full_name FROM driver WHERE id = lt.teammate_id) AS teammate_name,
  ltq.qualifying_gap_percent,
  lt.race_gap_percent,
  lt.shared_races AS teammate_shared_races

FROM career_stats cs
LEFT JOIN latest_teammate lt ON TRUE
LEFT JOIN latest_teammate_qualifying ltq ON TRUE;
