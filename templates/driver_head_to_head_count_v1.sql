-- ============================================================================
-- DRIVER HEAD-TO-HEAD COUNT
-- ============================================================================
-- Template: driver_head_to_head_count_v1.sql
-- Parameters:
--   $1 = season (integer)
--   $2 = driver_primary_id (string) - F1DB driver.id (lexicographically first)
--   $3 = driver_secondary_id (string) - F1DB driver.id (lexicographically second)
--   $4 = metric (string) - 'qualifying_position' or 'race_finish_position'
--
-- Returns head-to-head win counts between ANY two drivers based on:
-- - Qualifying positions (who qualified ahead)
-- - Race finishing positions (who finished ahead)
--
-- METHODOLOGY:
--   - Counts events where BOTH drivers have a valid position
--   - Lower position = better (1st > 2nd > 3rd, etc.)
--   - Ties counted separately (same position = tie)
--   - Works for ANY two drivers (cross-team or teammates)
--
-- COVERAGE THRESHOLDS:
--   - valid: >= 8 shared events
--   - low_coverage: >= 4 shared events
--   - insufficient: < 4 shared events (fail-closed)
--
-- FAIL-CLOSED: Returns insufficient coverage if < 4 shared events.
-- ============================================================================

WITH race_events AS (
  SELECT DISTINCT r.id AS race_id, r.round
  FROM race r
  WHERE r.year = $1
),

-- Get positions for qualifying metric
qualifying_positions AS (
  SELECT
    re.race_id,
    re.round,
    MAX(CASE WHEN rd.driver_id = $2 THEN rd.position_number END) AS primary_pos,
    MAX(CASE WHEN rd.driver_id = $3 THEN rd.position_number END) AS secondary_pos
  FROM race_events re
  JOIN race_data rd ON rd.race_id = re.race_id
  WHERE rd.type = 'QUALIFYING_RESULT'
    AND rd.driver_id IN ($2, $3)
    AND rd.position_number IS NOT NULL
  GROUP BY re.race_id, re.round
  HAVING COUNT(DISTINCT rd.driver_id) = 2
),

-- Get positions for race metric
race_positions AS (
  SELECT
    re.race_id,
    re.round,
    MAX(CASE WHEN rd.driver_id = $2 THEN rd.position_number END) AS primary_pos,
    MAX(CASE WHEN rd.driver_id = $3 THEN rd.position_number END) AS secondary_pos
  FROM race_events re
  JOIN race_data rd ON rd.race_id = re.race_id
  WHERE rd.type = 'RACE_RESULT'
    AND rd.driver_id IN ($2, $3)
    AND rd.position_number IS NOT NULL
  GROUP BY re.race_id, re.round
  HAVING COUNT(DISTINCT rd.driver_id) = 2
),

-- Select based on metric parameter
selected_positions AS (
  SELECT * FROM qualifying_positions WHERE $4 = 'qualifying_position'
  UNION ALL
  SELECT * FROM race_positions WHERE $4 = 'race_finish_position'
),

-- Compute head-to-head counts
h2h_counts AS (
  SELECT
    COUNT(*) AS shared_events,
    COUNT(*) FILTER (WHERE primary_pos < secondary_pos) AS primary_wins,
    COUNT(*) FILTER (WHERE secondary_pos < primary_pos) AS secondary_wins,
    COUNT(*) FILTER (WHERE primary_pos = secondary_pos) AS ties
  FROM selected_positions
)

SELECT
  $2::text AS driver_primary_id,
  $3::text AS driver_secondary_id,
  $1::integer AS season,
  $4::text AS metric,
  hc.shared_events,
  hc.primary_wins,
  hc.secondary_wins,
  hc.ties,
  CASE
    WHEN hc.shared_events >= 8 THEN 'valid'
    WHEN hc.shared_events >= 4 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status
FROM h2h_counts hc;
