-- ============================================================================
-- DRIVER HEAD-TO-HEAD COUNT (CONDITIONAL)
-- ============================================================================
-- Template: driver_head_to_head_count_conditional_v1.sql
-- Parameters:
--   $1 = season (integer)
--   $2 = driver_primary_id (string) - F1DB driver.id (lexicographically first)
--   $3 = driver_secondary_id (string) - F1DB driver.id (lexicographically second)
--   $4 = metric (string) - 'qualifying_position' or 'race_finish_position'
--   $5 = session_filter (string or null) - 'Q1', 'Q2', 'Q3', 'BEST', or null
--   $6 = track_type (string or null) - 'street', 'permanent', or null
--   $7 = weather (string or null) - 'dry', 'wet', 'mixed', or null
--   $8 = rounds (integer[] or null) - specific round numbers, or null
--   $9 = date_from (date or null) - start date filter
--   $10 = date_to (date or null) - end date filter
--   $11 = exclude_dnfs (boolean) - whether to exclude DNF/DNS results
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
--   - Applies optional filters to narrow scope
--
-- COVERAGE THRESHOLDS:
--   - valid: >= 8 shared events
--   - low_coverage: >= 4 shared events
--   - insufficient: < 4 shared events (fail-closed)
--
-- FAIL-CLOSED: Returns insufficient coverage if < 4 shared events.
-- ============================================================================

-- PHASE 4 OPTIMIZATION: Merged race_events, race_weather, and filtered_events into single CTE
-- This reduces temp table creation and improves query planner efficiency
WITH filtered_events AS (
  SELECT DISTINCT
    r.id AS race_id,
    r.round
  FROM race r
  JOIN circuit c ON c.id = r.circuit_id
  WHERE r.year = $1
    -- Round filter
    AND ($8 IS NULL OR r.round = ANY($8))
    -- Date range filter
    AND ($9 IS NULL OR r.date >= $9::date)
    AND ($10 IS NULL OR r.date <= $10::date)
    -- Track type filter (circuit.type values: STREET, ROAD, RACE)
    AND ($6 IS NULL OR (
      ($6 = 'street' AND c.type = 'STREET') OR
      ($6 = 'permanent' AND c.type IN ('RACE', 'ROAD'))
    ))
    -- Weather filter: not directly available in race_data, skip for now
    AND ($7 IS NULL)
),

-- Get qualifying positions with session filter
qualifying_positions AS (
  SELECT
    fe.race_id,
    fe.round,
    MAX(CASE WHEN rd.driver_id = $2 THEN rd.position_number END) AS primary_pos,
    MAX(CASE WHEN rd.driver_id = $3 THEN rd.position_number END) AS secondary_pos
  FROM filtered_events fe
  JOIN race_data rd ON rd.race_id = fe.race_id
  WHERE rd.type = 'QUALIFYING_RESULT'
    AND rd.driver_id IN ($2, $3)
    AND rd.position_number IS NOT NULL
    -- Session filter for qualifying (Q1/Q2/Q3 results based on which times are set)
    AND (
      $5 IS NULL
      OR $5 = 'BEST'
      OR (
        ($5 = 'Q1' AND rd.qualifying_q1 IS NOT NULL) OR
        ($5 = 'Q2' AND rd.qualifying_q2 IS NOT NULL) OR
        ($5 = 'Q3' AND rd.qualifying_q3 IS NOT NULL)
      )
    )
    -- DNF filter (for qualifying, exclude if no position)
    AND (NOT $11 OR rd.position_number IS NOT NULL)
  GROUP BY fe.race_id, fe.round
  HAVING COUNT(DISTINCT rd.driver_id) = 2
),

-- Get race positions with optional DNF exclusion
race_positions AS (
  SELECT
    fe.race_id,
    fe.round,
    MAX(CASE WHEN rd.driver_id = $2 THEN rd.position_number END) AS primary_pos,
    MAX(CASE WHEN rd.driver_id = $3 THEN rd.position_number END) AS secondary_pos
  FROM filtered_events fe
  JOIN race_data rd ON rd.race_id = fe.race_id
  WHERE rd.type = 'RACE_RESULT'
    AND rd.driver_id IN ($2, $3)
    AND rd.position_number IS NOT NULL
    -- DNF filter (exclude if position_text contains DNF, DNS, DSQ, etc.)
    AND (NOT $11 OR (
      rd.position_text IS NULL OR
      (
        rd.position_text NOT LIKE '%DNF%' AND
        rd.position_text NOT LIKE '%DNS%' AND
        rd.position_text NOT LIKE '%DSQ%' AND
        rd.position_text NOT LIKE '%NC%'
      )
    ))
  GROUP BY fe.race_id, fe.round
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
  END AS coverage_status,
  -- Return applied filters for transparency
  CASE WHEN $5 IS NOT NULL THEN $5 END AS session_filter_applied,
  CASE WHEN $6 IS NOT NULL THEN $6 END AS track_type_filter_applied,
  CASE WHEN $7 IS NOT NULL THEN $7 END AS weather_filter_applied,
  CASE WHEN $8 IS NOT NULL THEN array_to_string($8, ',') END AS rounds_filter_applied,
  CASE WHEN $9 IS NOT NULL THEN $9::text END AS date_from_filter_applied,
  CASE WHEN $10 IS NOT NULL THEN $10::text END AS date_to_filter_applied,
  $11 AS exclude_dnfs_applied
FROM h2h_counts hc;
