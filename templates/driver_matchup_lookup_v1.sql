-- PART 6: Driver matchup lookup from precomputed matrix
-- Parameters: $1=season, $2=driver_a_id, $3=driver_b_id, $4=metric
--
-- Returns: Precomputed head-to-head results from driver_matchup_matrix
-- Normalizes driver order to always use lexicographic ordering.
-- Supports seasons 2022-2025 via unified driver_matchup_matrix table
--
-- Output fields:
--   - driver_primary_id: Lexicographically first driver
--   - driver_secondary_id: Lexicographically second driver
--   - driver_a_wins: Wins by the lexicographically first driver
--   - driver_b_wins: Wins by the lexicographically second driver
--   - ties: Number of ties
--   - shared_events: Total shared events
--   - coverage_status: 'valid' | 'low_coverage' | 'insufficient'
--   - computed_at: When the matchup was computed

WITH ordered_drivers AS (
  SELECT
    CASE WHEN $2::TEXT < $3::TEXT THEN $2::TEXT ELSE $3::TEXT END AS driver_a_id,
    CASE WHEN $2::TEXT < $3::TEXT THEN $3::TEXT ELSE $2::TEXT END AS driver_b_id
)
SELECT
  mm.driver_a_id AS driver_primary_id,
  mm.driver_b_id AS driver_secondary_id,
  mm.driver_a_wins AS primary_wins,
  mm.driver_b_wins AS secondary_wins,
  mm.ties,
  mm.shared_events,
  mm.coverage_status,
  mm.computed_at,
  $4::TEXT AS metric
FROM driver_matchup_matrix mm
CROSS JOIN ordered_drivers od
WHERE mm.driver_a_id = od.driver_a_id
  AND mm.driver_b_id = od.driver_b_id
  AND mm.season = $1
  AND mm.metric = $4;
