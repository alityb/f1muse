-- TEAMMATE GAP DUAL COMPARISON
-- Parameters: $1=season, $2=driver_primary_id, $3=driver_secondary_id
--
-- Returns: Side-by-side comparison of qualifying gap vs race pace gap
--
-- METHODOLOGY:
--   - Qualifying gap: Symmetric percent difference from qualifying times
--     Formula: 100 * (primary_time - secondary_time) / ((primary_time + secondary_time) / 2)
--   - Race pace gap: Symmetric percent difference from median lap times
--     Formula: 100 * (primary_median - secondary_median) / ((primary_median + secondary_median) / 2)
--   - Symmetric percent difference is track-length invariant (primary - secondary over mean)
--   - Sign convention: Negative = primary faster, Positive = secondary faster
--
-- COVERAGE:
--   - Each metric evaluated independently
--   - Partial results returned if one metric has valid/low_coverage
--   - Both metrics must have coverage_status != 'insufficient' for full result
--
-- USE CASE: "Compare qualifying vs race pace between Norris and Piastri 2025"

WITH qualifying_data AS (
  -- Get qualifying gap from qualifying summary table
  SELECT
    season,
    team_id,
    driver_primary_id,
    driver_secondary_id,
    COALESCE(gap_percent, driver_pair_gap_percent) AS gap_percent,
    driver_pair_gap_seconds AS gap_seconds,
    shared_races,
    faster_driver_primary_count,
    coverage_status,
    failure_reason
  FROM teammate_gap_qualifying_season_summary
  WHERE season = $1
    AND (
      (driver_primary_id = $2 AND driver_secondary_id = $3)
      OR (driver_primary_id = $3 AND driver_secondary_id = $2)
    )
),
race_data AS (
  -- Get race pace gap from race summary table
  SELECT
    season,
    team_id,
    driver_primary_id,
    driver_secondary_id,
    COALESCE(gap_percent, driver_pair_gap_percent) AS gap_percent,
    driver_pair_gap_seconds AS gap_seconds,
    shared_races,
    faster_driver_primary_count,
    coverage_status,
    failure_reason
  FROM teammate_gap_season_summary
  WHERE season = $1
    AND (
      (driver_primary_id = $2 AND driver_secondary_id = $3)
      OR (driver_primary_id = $3 AND driver_secondary_id = $2)
    )
),
normalized_qualifying AS (
  -- Normalize driver order to match input parameters
  SELECT
    season,
    team_id,
    $2 AS driver_primary_id,
    $3 AS driver_secondary_id,
    CASE
      WHEN driver_primary_id = $2 THEN gap_percent
      ELSE -gap_percent  -- Flip sign if order was reversed
    END AS gap_percent,
    CASE
      WHEN driver_primary_id = $2 THEN gap_seconds
      ELSE -gap_seconds
    END AS gap_seconds,
    shared_races,
    CASE
      WHEN driver_primary_id = $2 THEN faster_driver_primary_count
      ELSE shared_races - faster_driver_primary_count
    END AS faster_driver_primary_count,
    coverage_status,
    failure_reason
  FROM qualifying_data
),
normalized_race AS (
  -- Normalize driver order to match input parameters
  SELECT
    season,
    team_id,
    $2 AS driver_primary_id,
    $3 AS driver_secondary_id,
    CASE
      WHEN driver_primary_id = $2 THEN gap_percent
      ELSE -gap_percent
    END AS gap_percent,
    CASE
      WHEN driver_primary_id = $2 THEN gap_seconds
      ELSE -gap_seconds
    END AS gap_seconds,
    shared_races,
    CASE
      WHEN driver_primary_id = $2 THEN faster_driver_primary_count
      ELSE shared_races - faster_driver_primary_count
    END AS faster_driver_primary_count,
    coverage_status,
    failure_reason
  FROM race_data
)
SELECT
  COALESCE(nq.season, nr.season, $1::INTEGER) AS season,
  COALESCE(nq.team_id, nr.team_id) AS team_id,
  $2 AS driver_primary_id,
  $3 AS driver_secondary_id,

  -- Qualifying metrics
  nq.gap_percent AS qualifying_gap_percent,
  nq.gap_seconds AS qualifying_gap_seconds,
  nq.shared_races AS qualifying_shared_races,
  nq.faster_driver_primary_count AS qualifying_faster_primary_count,
  nq.coverage_status AS qualifying_coverage_status,
  nq.failure_reason AS qualifying_failure_reason,

  -- Race pace metrics
  nr.gap_percent AS race_gap_percent,
  nr.gap_seconds AS race_gap_seconds,
  nr.shared_races AS race_shared_races,
  nr.faster_driver_primary_count AS race_faster_primary_count,
  nr.coverage_status AS race_coverage_status,
  nr.failure_reason AS race_failure_reason,

  -- Derived metrics: winner determination
  -- Qualifying winner (negative gap = primary faster)
  CASE
    WHEN nq.gap_percent IS NULL THEN NULL
    WHEN nq.gap_percent < -0.05 THEN $2  -- Primary faster by meaningful margin
    WHEN nq.gap_percent > 0.05 THEN $3   -- Secondary faster by meaningful margin
    ELSE 'equal'
  END AS qualifying_winner,

  -- Race winner
  CASE
    WHEN nr.gap_percent IS NULL THEN NULL
    WHEN nr.gap_percent < -0.05 THEN $2
    WHEN nr.gap_percent > 0.05 THEN $3
    ELSE 'equal'
  END AS race_winner,

  -- Same winner check
  CASE
    WHEN nq.gap_percent IS NULL OR nr.gap_percent IS NULL THEN NULL
    WHEN (nq.gap_percent < -0.05 AND nr.gap_percent < -0.05) THEN TRUE  -- Both primary
    WHEN (nq.gap_percent > 0.05 AND nr.gap_percent > 0.05) THEN TRUE    -- Both secondary
    WHEN (ABS(nq.gap_percent) <= 0.05 AND ABS(nr.gap_percent) <= 0.05) THEN TRUE  -- Both equal
    ELSE FALSE
  END AS same_winner,

  -- Advantage area
  CASE
    WHEN nq.gap_percent IS NULL OR nr.gap_percent IS NULL THEN 'partial'
    WHEN ABS(nq.gap_percent) > ABS(nr.gap_percent) * 1.1 THEN 'qualifying'
    WHEN ABS(nr.gap_percent) > ABS(nq.gap_percent) * 1.1 THEN 'race'
    ELSE 'mixed'
  END AS advantage_area,

  -- Availability flags
  CASE WHEN nq.coverage_status IN ('valid', 'low_coverage') THEN TRUE ELSE FALSE END AS qualifying_available,
  CASE WHEN nr.coverage_status IN ('valid', 'low_coverage') THEN TRUE ELSE FALSE END AS race_available

FROM normalized_qualifying nq
FULL OUTER JOIN normalized_race nr
  ON nq.season = nr.season
  AND nq.driver_primary_id = nr.driver_primary_id
  AND nq.driver_secondary_id = nr.driver_secondary_id;
