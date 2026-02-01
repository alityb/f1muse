-- QUALIFYING GAP TEAMMATES
-- Parameters: $1=season, $2=driver_primary_id, $3=driver_secondary_id
--
-- Returns: Qualifying time gap between two teammates
--
-- METHODOLOGY:
--   - Compares qualifying times at deepest common round (Q3 > Q2 > Q1)
--   - If times unavailable, uses 250ms per grid position as proxy
--   - Symmetric percent difference: 100 * (primary - secondary) / mean
--   - Sign convention: Negative = primary faster, Positive = secondary faster
--
-- COVERAGE:
--   - Requires both drivers to have qualifying data
--   - Requires shared team in the season
--   - Returns coverage_status: 'valid', 'low_coverage', 'insufficient'
--
-- Output fields:
--   - driver_primary_id, driver_secondary_id: Driver IDs
--   - team_id: Shared team ID
--   - gap_percent: Symmetric percent gap (negative = primary faster)
--   - gap_seconds: Absolute time gap in seconds
--   - shared_races: Number of shared qualifying sessions
--   - primary_wins: Times primary qualified ahead
--   - secondary_wins: Times secondary qualified ahead
--   - ties: Number of ties (same position)
--   - coverage_status: Data quality indicator

WITH teammate_verification AS (
  -- Verify drivers were teammates in the season
  SELECT DISTINCT qr1.team_id
  FROM qualifying_results qr1
  JOIN qualifying_results qr2
    ON qr1.season = qr2.season
    AND qr1.round = qr2.round
    AND qr1.team_id = qr2.team_id
  WHERE qr1.season = $1
    AND qr1.driver_id = $2
    AND qr2.driver_id = $3
    AND qr1.session_type = 'RACE_QUALIFYING'
    AND qr2.session_type = 'RACE_QUALIFYING'
  LIMIT 1
),
shared_sessions AS (
  SELECT
    qr1.round,
    qr1.track_id,
    qr1.driver_id AS driver_primary_id,
    qr2.driver_id AS driver_secondary_id,
    tv.team_id,
    -- Use deepest common round time
    COALESCE(
      CASE
        WHEN qr1.q3_time_ms IS NOT NULL AND qr2.q3_time_ms IS NOT NULL
        THEN qr1.q3_time_ms
        WHEN qr1.q2_time_ms IS NOT NULL AND qr2.q2_time_ms IS NOT NULL
        THEN qr1.q2_time_ms
        ELSE qr1.q1_time_ms
      END,
      -- Fallback: 250ms per position proxy
      qr1.qualifying_position * 250
    ) AS primary_time_ms,
    COALESCE(
      CASE
        WHEN qr1.q3_time_ms IS NOT NULL AND qr2.q3_time_ms IS NOT NULL
        THEN qr2.q3_time_ms
        WHEN qr1.q2_time_ms IS NOT NULL AND qr2.q2_time_ms IS NOT NULL
        THEN qr2.q2_time_ms
        ELSE qr2.q1_time_ms
      END,
      qr2.qualifying_position * 250
    ) AS secondary_time_ms,
    qr1.qualifying_position AS primary_position,
    qr2.qualifying_position AS secondary_position,
    CASE
      WHEN qr1.q3_time_ms IS NOT NULL AND qr2.q3_time_ms IS NOT NULL THEN 'Q3'
      WHEN qr1.q2_time_ms IS NOT NULL AND qr2.q2_time_ms IS NOT NULL THEN 'Q2'
      WHEN qr1.q1_time_ms IS NOT NULL AND qr2.q1_time_ms IS NOT NULL THEN 'Q1'
      ELSE 'position_proxy'
    END AS comparison_method
  FROM qualifying_results qr1
  JOIN qualifying_results qr2
    ON qr1.season = qr2.season
    AND qr1.round = qr2.round
    AND qr1.team_id = qr2.team_id
  CROSS JOIN teammate_verification tv
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
    team_id,
    COUNT(*) AS shared_races,
    -- Symmetric percent difference
    ROUND(
      100.0 * AVG(
        (primary_time_ms - secondary_time_ms)::NUMERIC /
        NULLIF((primary_time_ms + secondary_time_ms) / 2.0, 0)
      ),
      3
    ) AS gap_percent,
    -- Average absolute gap in seconds
    ROUND(
      AVG((primary_time_ms - secondary_time_ms)::NUMERIC / 1000.0),
      3
    ) AS gap_seconds,
    -- Win counts
    COUNT(*) FILTER (WHERE primary_position < secondary_position) AS primary_wins,
    COUNT(*) FILTER (WHERE primary_position > secondary_position) AS secondary_wins,
    COUNT(*) FILTER (WHERE primary_position = secondary_position) AS ties
  FROM shared_sessions
  GROUP BY driver_primary_id, driver_secondary_id, team_id
)
SELECT
  a.driver_primary_id,
  a.driver_secondary_id,
  a.team_id,
  a.gap_percent,
  a.gap_seconds,
  a.shared_races,
  a.primary_wins,
  a.secondary_wins,
  a.ties,
  CASE
    WHEN a.shared_races >= 10 THEN 'valid'
    WHEN a.shared_races >= 5 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status,
  $1::INTEGER AS season
FROM aggregated a;
