-- ============================================================================
-- DRIVER VS DRIVER COMPREHENSIVE COMPARISON
-- ============================================================================
-- Template: driver_vs_driver_comprehensive_v1.sql
-- Parameters:
--   $1 = season (integer)
--   $2 = driver_a_id (string) - F1DB driver.id
--   $3 = driver_b_id (string) - F1DB driver.id
--
-- Combines pace data with achievement statistics for a comprehensive comparison.
-- Includes: pace metrics, head-to-head counts, season stats (wins, podiums, poles, DNFs, points)
--
-- METHODOLOGY:
--   - Pace: From laps_normalized
--   - H2H Qualifying: From qualifying_results table (ETL-populated)
--   - H2H Race: From race_data table (F1DB)
--   - Stats: From F1DB race_data aggregations
--
-- COVERAGE THRESHOLDS:
--   - valid: >= 8 shared races
--   - low_coverage: >= 4 shared races
--   - insufficient: < 4 shared races
-- ============================================================================

WITH race_events AS (
  SELECT DISTINCT r.id AS race_id, r.round
  FROM race r
  WHERE r.year = $1
),

-- SESSION MEDIANS: Compute session median per race (all drivers' valid laps)
-- This allows normalizing pace relative to field performance
session_medians AS (
  SELECT
    round,
    track_id,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS session_median
  FROM laps_normalized
  WHERE season = $1
    AND is_valid_lap = true
    AND is_pit_lap = false
    AND is_in_lap = false
    AND is_out_lap = false
    AND lap_time_seconds IS NOT NULL
  GROUP BY round, track_id
  HAVING COUNT(*) >= 20  -- minimum laps for reliable median
),

-- NORMALIZED PACE DATA: From laps_normalized, normalized by session median
-- Sign convention: negative = faster than field median, positive = slower
-- Units: percent
pace_data AS (
  SELECT
    ln.driver_id,
    AVG(((ln.lap_time_seconds - sm.session_median) / sm.session_median) * 100) AS avg_pace_pct,
    COUNT(DISTINCT ln.track_id) AS races
  FROM laps_normalized ln
  JOIN session_medians sm
    ON sm.round = ln.round
    AND sm.track_id = ln.track_id
  WHERE ln.season = $1
    AND (ln.driver_id IN ($2, $3) OR ln.driver_id IN (REPLACE($2, '-', '_'), REPLACE($3, '-', '_')))
    AND ln.is_valid_lap = true
    AND ln.is_pit_lap = false
    AND ln.is_in_lap = false
    AND ln.is_out_lap = false
    AND ln.lap_time_seconds IS NOT NULL
  GROUP BY ln.driver_id
),

shared_races AS (
  SELECT COUNT(DISTINCT ln.track_id) AS shared_race_count
  FROM laps_normalized ln
  JOIN session_medians sm
    ON sm.round = ln.round
    AND sm.track_id = ln.track_id
  WHERE ln.season = $1
    AND (ln.driver_id IN ($2, $3) OR ln.driver_id IN (REPLACE($2, '-', '_'), REPLACE($3, '-', '_')))
    AND ln.is_valid_lap = true
    AND ln.is_pit_lap = false
    AND ln.is_in_lap = false
    AND ln.is_out_lap = false
  GROUP BY ln.track_id
  HAVING COUNT(DISTINCT ln.driver_id) = 2
),

-- HEAD TO HEAD: Qualifying positions (from qualifying_results table)
-- Note: qualifying_results uses underscore format (lando_norris), F1DB uses hyphen (lando-norris)
qualifying_h2h AS (
  SELECT
    COUNT(*) AS shared,
    COUNT(*) FILTER (WHERE a_pos < b_pos) AS a_wins,
    COUNT(*) FILTER (WHERE b_pos < a_pos) AS b_wins,
    COUNT(*) FILTER (WHERE a_pos = b_pos) AS ties
  FROM (
    SELECT
      qr1.round,
      qr1.qualifying_position AS a_pos,
      qr2.qualifying_position AS b_pos
    FROM qualifying_results qr1
    JOIN qualifying_results qr2
      ON qr1.season = qr2.season
      AND qr1.round = qr2.round
    WHERE qr1.season = $1
      AND (qr1.driver_id = $2 OR qr1.driver_id = REPLACE($2, '-', '_'))
      AND (qr2.driver_id = $3 OR qr2.driver_id = REPLACE($3, '-', '_'))
      AND qr1.qualifying_position IS NOT NULL
      AND qr2.qualifying_position IS NOT NULL
      AND qr1.session_type = 'RACE_QUALIFYING'
      AND qr2.session_type = 'RACE_QUALIFYING'
  ) q
),

-- QUALIFYING GAP: Average qualifying time gap between drivers
-- Uses deepest common session (Q3 > Q2 > Q1)
qualifying_gap AS (
  SELECT
    AVG(gap_ms) AS avg_gap_ms,
    AVG(gap_pct) AS avg_gap_pct,
    COUNT(*) AS shared_sessions
  FROM (
    SELECT
      qr1.round,
      -- Use deepest common session
      CASE
        WHEN qr1.q3_time_ms IS NOT NULL AND qr2.q3_time_ms IS NOT NULL
          THEN qr1.q3_time_ms - qr2.q3_time_ms
        WHEN qr1.q2_time_ms IS NOT NULL AND qr2.q2_time_ms IS NOT NULL
          THEN qr1.q2_time_ms - qr2.q2_time_ms
        WHEN qr1.q1_time_ms IS NOT NULL AND qr2.q1_time_ms IS NOT NULL
          THEN qr1.q1_time_ms - qr2.q1_time_ms
        ELSE NULL
      END AS gap_ms,
      -- Calculate gap as percentage
      CASE
        WHEN qr1.q3_time_ms IS NOT NULL AND qr2.q3_time_ms IS NOT NULL AND qr2.q3_time_ms > 0
          THEN ((qr1.q3_time_ms - qr2.q3_time_ms)::numeric / qr2.q3_time_ms) * 100
        WHEN qr1.q2_time_ms IS NOT NULL AND qr2.q2_time_ms IS NOT NULL AND qr2.q2_time_ms > 0
          THEN ((qr1.q2_time_ms - qr2.q2_time_ms)::numeric / qr2.q2_time_ms) * 100
        WHEN qr1.q1_time_ms IS NOT NULL AND qr2.q1_time_ms IS NOT NULL AND qr2.q1_time_ms > 0
          THEN ((qr1.q1_time_ms - qr2.q1_time_ms)::numeric / qr2.q1_time_ms) * 100
        ELSE NULL
      END AS gap_pct
    FROM qualifying_results qr1
    JOIN qualifying_results qr2
      ON qr1.season = qr2.season
      AND qr1.round = qr2.round
    WHERE qr1.season = $1
      AND (qr1.driver_id = $2 OR qr1.driver_id = REPLACE($2, '-', '_'))
      AND (qr2.driver_id = $3 OR qr2.driver_id = REPLACE($3, '-', '_'))
      AND qr1.session_type = 'RACE_QUALIFYING'
      AND qr2.session_type = 'RACE_QUALIFYING'
  ) gaps
  WHERE gap_ms IS NOT NULL
),

-- HEAD TO HEAD: Race finish positions (from race_data table)
-- Note: race_data uses underscore format, F1DB uses hyphen
race_h2h AS (
  SELECT
    COUNT(*) AS shared,
    COUNT(*) FILTER (WHERE a_pos < b_pos) AS a_wins,
    COUNT(*) FILTER (WHERE b_pos < a_pos) AS b_wins,
    COUNT(*) FILTER (WHERE a_pos = b_pos) AS ties
  FROM (
    SELECT
      re.race_id,
      MAX(CASE WHEN rd.driver_id = $2 OR rd.driver_id = REPLACE($2, '-', '_') THEN rd.position_number END) AS a_pos,
      MAX(CASE WHEN rd.driver_id = $3 OR rd.driver_id = REPLACE($3, '-', '_') THEN rd.position_number END) AS b_pos
    FROM race_events re
    JOIN race_data rd ON rd.race_id = re.race_id
    WHERE rd.type IN ('RACE_RESULT', 'race')
      AND (rd.driver_id IN ($2, $3) OR rd.driver_id IN (REPLACE($2, '-', '_'), REPLACE($3, '-', '_')))
      AND rd.position_number IS NOT NULL
    GROUP BY re.race_id
    HAVING COUNT(DISTINCT rd.driver_id) = 2
  ) r
),

-- SEASON STATS: Driver A
-- Note: race_data uses underscore format, F1DB uses hyphen
driver_a_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE rd.position_number = 1 AND rd.type IN ('RACE_RESULT', 'race')) AS wins,
    COUNT(*) FILTER (WHERE rd.position_number <= 3 AND rd.type IN ('RACE_RESULT', 'race')) AS podiums,
    COUNT(*) FILTER (WHERE rd.position_text IN ('DNF', 'DSQ', 'DNS', 'NC') AND rd.type IN ('RACE_RESULT', 'race')) AS dnfs,
    COALESCE(SUM(rd.race_points) FILTER (WHERE rd.type IN ('RACE_RESULT', 'race')), 0) AS points,
    COUNT(*) FILTER (WHERE rd.type IN ('RACE_RESULT', 'race')) AS race_count,
    COUNT(*) FILTER (WHERE rd.race_fastest_lap = true AND rd.type IN ('RACE_RESULT', 'race')) AS fastest_laps,
    COALESCE(SUM(rd.race_points) FILTER (WHERE rd.type = 'SPRINT_RACE_RESULT'), 0) AS sprint_points
  FROM race_events re
  JOIN race_data rd ON rd.race_id = re.race_id
  WHERE rd.driver_id = $2 OR rd.driver_id = REPLACE($2, '-', '_')
),

-- Driver A poles (from qualifying_results)
-- Note: qualifying_results uses underscore format, F1DB uses hyphen
driver_a_poles AS (
  SELECT COUNT(*) AS poles
  FROM qualifying_results
  WHERE season = $1
    AND (driver_id = $2 OR driver_id = REPLACE($2, '-', '_'))
    AND qualifying_position = 1
    AND session_type = 'RACE_QUALIFYING'
),

-- SEASON STATS: Driver B
-- Note: race_data uses underscore format, F1DB uses hyphen
driver_b_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE rd.position_number = 1 AND rd.type IN ('RACE_RESULT', 'race')) AS wins,
    COUNT(*) FILTER (WHERE rd.position_number <= 3 AND rd.type IN ('RACE_RESULT', 'race')) AS podiums,
    COUNT(*) FILTER (WHERE rd.position_text IN ('DNF', 'DSQ', 'DNS', 'NC') AND rd.type IN ('RACE_RESULT', 'race')) AS dnfs,
    COALESCE(SUM(rd.race_points) FILTER (WHERE rd.type IN ('RACE_RESULT', 'race')), 0) AS points,
    COUNT(*) FILTER (WHERE rd.type IN ('RACE_RESULT', 'race')) AS race_count,
    COUNT(*) FILTER (WHERE rd.race_fastest_lap = true AND rd.type IN ('RACE_RESULT', 'race')) AS fastest_laps,
    COALESCE(SUM(rd.race_points) FILTER (WHERE rd.type = 'SPRINT_RACE_RESULT'), 0) AS sprint_points
  FROM race_events re
  JOIN race_data rd ON rd.race_id = re.race_id
  WHERE rd.driver_id = $3 OR rd.driver_id = REPLACE($3, '-', '_')
),

-- Driver B poles (from qualifying_results)
-- Note: qualifying_results uses underscore format, F1DB uses hyphen
driver_b_poles AS (
  SELECT COUNT(*) AS poles
  FROM qualifying_results
  WHERE season = $1
    AND (driver_id = $3 OR driver_id = REPLACE($3, '-', '_'))
    AND qualifying_position = 1
    AND session_type = 'RACE_QUALIFYING'
)

SELECT
  $1::integer AS season,
  $2::text AS driver_a_id,
  $3::text AS driver_b_id,

  -- Normalized pace data (% relative to session median)
  -- Negative = faster than field, Positive = slower than field
  (SELECT avg_pace_pct FROM pace_data WHERE driver_id = $2 OR driver_id = REPLACE($2, '-', '_') LIMIT 1) AS driver_a_avg_pace_pct,
  (SELECT avg_pace_pct FROM pace_data WHERE driver_id = $3 OR driver_id = REPLACE($3, '-', '_') LIMIT 1) AS driver_b_avg_pace_pct,
  (SELECT avg_pace_pct FROM pace_data WHERE driver_id = $2 OR driver_id = REPLACE($2, '-', '_') LIMIT 1) -
    (SELECT avg_pace_pct FROM pace_data WHERE driver_id = $3 OR driver_id = REPLACE($3, '-', '_') LIMIT 1) AS pace_delta_pct,
  COALESCE((SELECT COUNT(*) FROM shared_races), 0)::integer AS shared_races,

  -- H2H Qualifying (from qualifying_results table)
  COALESCE((SELECT a_wins FROM qualifying_h2h), 0)::integer AS qual_h2h_a_wins,
  COALESCE((SELECT b_wins FROM qualifying_h2h), 0)::integer AS qual_h2h_b_wins,
  COALESCE((SELECT ties FROM qualifying_h2h), 0)::integer AS qual_h2h_ties,

  -- Qualifying gap (average gap in ms and %)
  -- Positive = driver A slower, Negative = driver A faster
  (SELECT avg_gap_ms FROM qualifying_gap) AS qual_gap_ms,
  (SELECT avg_gap_pct FROM qualifying_gap) AS qual_gap_pct,
  COALESCE((SELECT shared_sessions FROM qualifying_gap), 0)::integer AS qual_shared_sessions,

  -- H2H Race (from race_data table)
  COALESCE((SELECT a_wins FROM race_h2h), 0)::integer AS race_h2h_a_wins,
  COALESCE((SELECT b_wins FROM race_h2h), 0)::integer AS race_h2h_b_wins,
  COALESCE((SELECT ties FROM race_h2h), 0)::integer AS race_h2h_ties,

  -- Driver A stats
  COALESCE((SELECT wins FROM driver_a_stats), 0)::integer AS driver_a_wins,
  COALESCE((SELECT podiums FROM driver_a_stats), 0)::integer AS driver_a_podiums,
  COALESCE((SELECT poles FROM driver_a_poles), 0)::integer AS driver_a_poles,
  COALESCE((SELECT dnfs FROM driver_a_stats), 0)::integer AS driver_a_dnfs,
  COALESCE((SELECT points FROM driver_a_stats), 0)::numeric AS driver_a_points,
  COALESCE((SELECT race_count FROM driver_a_stats), 0)::integer AS driver_a_race_count,
  COALESCE((SELECT fastest_laps FROM driver_a_stats), 0)::integer AS driver_a_fastest_laps,
  COALESCE((SELECT sprint_points FROM driver_a_stats), 0)::numeric AS driver_a_sprint_points,

  -- Driver B stats
  COALESCE((SELECT wins FROM driver_b_stats), 0)::integer AS driver_b_wins,
  COALESCE((SELECT podiums FROM driver_b_stats), 0)::integer AS driver_b_podiums,
  COALESCE((SELECT poles FROM driver_b_poles), 0)::integer AS driver_b_poles,
  COALESCE((SELECT dnfs FROM driver_b_stats), 0)::integer AS driver_b_dnfs,
  COALESCE((SELECT points FROM driver_b_stats), 0)::numeric AS driver_b_points,
  COALESCE((SELECT race_count FROM driver_b_stats), 0)::integer AS driver_b_race_count,
  COALESCE((SELECT fastest_laps FROM driver_b_stats), 0)::integer AS driver_b_fastest_laps,
  COALESCE((SELECT sprint_points FROM driver_b_stats), 0)::numeric AS driver_b_sprint_points,

  -- Coverage status
  CASE
    WHEN COALESCE((SELECT COUNT(*) FROM shared_races), 0) >= 8 THEN 'valid'
    WHEN COALESCE((SELECT COUNT(*) FROM shared_races), 0) >= 4 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status;
