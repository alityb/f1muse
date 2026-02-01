-- PHASE M: Teammate gap summary season (Race pace)
-- Parameters: $1=season, $2=driver_primary_id, $3=driver_secondary_id
--
-- Returns: Season-level teammate gap summary from teammate_gap_season_summary
-- Track-agnostic (full season rollup), season-bounded, team-bounded
-- Use case: "Who won the teammate battle at Ferrari 2025?"
--
-- METHODOLOGY:
--   - Race pace from median lap times
--   - Filter to valid, non-pit, non-in/out laps
--   - gap_percent = 100 * (primary_time - secondary_time) / ((primary_time + secondary_time) / 2)
--   - Season median of race-level gaps
--   - Negative = primary faster, Positive = secondary faster
--
-- Supports seasons 2022-2025 via unified teammate_gap_season_summary table

WITH summary_data AS (
  SELECT
    season,
    team_id,
    driver_primary_id,
    driver_secondary_id,
    driver_pair_gap_seconds AS gap_seconds,
    driver_pair_gap_percent AS gap_percent,
    shared_races,
    faster_driver_primary_count,
    coverage_status
  FROM teammate_gap_season_summary
  WHERE season = $1
    AND driver_primary_id = $2
    AND driver_secondary_id = $3
    AND COALESCE(failure_reason, '') = ''
    AND driver_pair_gap_percent IS NOT NULL
),
normalized_summary AS (
  -- Normalize team_id variants (e.g., MCL/mclaren, FER/ferrari) for consistent output
  SELECT
    sd.season,
    CASE
      WHEN normalized_team_id IN ('mcl', 'mclaren') THEN 'mclaren'
      WHEN normalized_team_id IN ('fer', 'ferrari') THEN 'ferrari'
      WHEN normalized_team_id IN ('rbr', 'red-bull', 'redbull') THEN 'red-bull'
      WHEN normalized_team_id IN ('amr', 'aston', 'aston-martin') THEN 'aston-martin'
      WHEN normalized_team_id IN ('rb', 'racing-bulls', 'racingbulls', 'visa-cash-app-rb') THEN 'racing-bulls'
      WHEN normalized_team_id IN ('sauber', 'kick-sauber', 'kicksauber', 'stake') THEN 'kick-sauber'
      ELSE normalized_team_id
    END AS team_id,
    sd.driver_primary_id,
    sd.driver_secondary_id,
    sd.gap_seconds,
    sd.gap_percent,
    sd.shared_races,
    sd.faster_driver_primary_count,
    sd.coverage_status
  FROM (
    SELECT
      sd.*,
      REGEXP_REPLACE(
        LOWER(TRIM(REPLACE(COALESCE(team_id, ''), '_', '-'))),
        '-f1-team$',
        ''
      ) AS normalized_team_id
    FROM summary_data sd
  ) sd
)
SELECT
  ns.season,
  ns.team_id,
  ns.driver_primary_id,
  ns.driver_secondary_id,
  ns.gap_seconds,
  ns.gap_percent AS gap_pct,
  ns.shared_races,
  ns.faster_driver_primary_count,
  ns.coverage_status,
  NULL::NUMERIC AS reference_lap_time_seconds
FROM normalized_summary ns;
