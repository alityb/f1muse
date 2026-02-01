-- QUALIFYING GAP DRIVERS (CROSS-TEAM)
-- Parameters: $1=season, $2=driver_primary_id, $3=driver_secondary_id
--
-- Returns: Qualifying position gap between any two drivers
--
-- METHODOLOGY:
--   - Compares qualifying positions (not times) for cross-team drivers
--   - Position-based comparison avoids car performance confounding
--   - Reports average position gap and head-to-head count
--
-- COVERAGE:
--   - Requires both drivers to have qualifying data
--   - Returns coverage_status: 'valid', 'low_coverage', 'insufficient'
--
-- Output fields:
--   - driver_primary_id, driver_secondary_id: Driver IDs
--   - avg_position_gap: Average position gap (negative = primary typically higher)
--   - shared_sessions: Number of shared qualifying sessions
--   - primary_wins: Times primary qualified ahead
--   - secondary_wins: Times secondary qualified ahead
--   - ties: Number of ties
--   - primary_avg_position: Primary driver's average position
--   - secondary_avg_position: Secondary driver's average position
--   - coverage_status: Data quality indicator

WITH shared_sessions AS (
  SELECT
    qr1.round,
    qr1.track_id,
    qr1.driver_id AS driver_primary_id,
    qr2.driver_id AS driver_secondary_id,
    qr1.team_id AS primary_team_id,
    qr2.team_id AS secondary_team_id,
    qr1.qualifying_position AS primary_position,
    qr2.qualifying_position AS secondary_position,
    (qr1.qualifying_position - qr2.qualifying_position) AS position_gap
  FROM qualifying_results qr1
  JOIN qualifying_results qr2
    ON qr1.season = qr2.season
    AND qr1.round = qr2.round
  WHERE qr1.season = $1
    AND qr1.driver_id = $2
    AND qr2.driver_id = $3
    AND qr1.is_dns = FALSE
    AND qr2.is_dns = FALSE
    AND qr1.session_type = 'RACE_QUALIFYING'
    AND qr2.session_type = 'RACE_QUALIFYING'
),
aggregated AS (
  SELECT
    driver_primary_id,
    driver_secondary_id,
    COUNT(*) AS shared_sessions,
    -- Average position gap (negative = primary typically higher)
    ROUND(AVG(position_gap), 2) AS avg_position_gap,
    -- Win counts (lower position = better)
    COUNT(*) FILTER (WHERE primary_position < secondary_position) AS primary_wins,
    COUNT(*) FILTER (WHERE primary_position > secondary_position) AS secondary_wins,
    COUNT(*) FILTER (WHERE primary_position = secondary_position) AS ties,
    -- Individual averages
    ROUND(AVG(primary_position), 2) AS primary_avg_position,
    ROUND(AVG(secondary_position), 2) AS secondary_avg_position,
    -- Team info (for context)
    MODE() WITHIN GROUP (ORDER BY primary_team_id) AS primary_team_id,
    MODE() WITHIN GROUP (ORDER BY secondary_team_id) AS secondary_team_id
  FROM shared_sessions
  GROUP BY driver_primary_id, driver_secondary_id
)
SELECT
  a.driver_primary_id,
  a.driver_secondary_id,
  a.primary_team_id,
  a.secondary_team_id,
  a.avg_position_gap,
  a.shared_sessions,
  a.primary_wins,
  a.secondary_wins,
  a.ties,
  a.primary_avg_position,
  a.secondary_avg_position,
  CASE
    WHEN a.shared_sessions >= 10 THEN 'valid'
    WHEN a.shared_sessions >= 5 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status,
  $1::INTEGER AS season
FROM aggregated a;
