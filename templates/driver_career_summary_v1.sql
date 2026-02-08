-- Driver career summary (championships, seasons raced, podiums, wins, pace trend)
-- Parameters: $1=driver_id
--
-- seasons_raced comes from F1DB season_driver_standing table (complete history 1950-present)

WITH seasons_from_standings AS (
  -- Use season_driver_standing for accurate seasons count (F1DB authoritative)
  -- Handle both underscore and hyphen formats
  SELECT COUNT(DISTINCT year) AS seasons_raced
  FROM season_driver_standing
  WHERE driver_id = $1 OR driver_id = REPLACE($1, '_', '-')
),
championships AS (
  SELECT COUNT(*) AS championships
  FROM season_driver_standing sds
  WHERE (sds.driver_id = $1 OR sds.driver_id = REPLACE($1, '_', '-'))
    AND sds.position_number = 1
),
career_results AS (
  SELECT
    COUNT(*) FILTER (WHERE rd.position_number = 1) AS career_wins,
    COUNT(*) FILTER (WHERE rd.position_number IN (1, 2, 3)) AS career_podiums
  FROM race_data rd
  WHERE rd.driver_id = $1
    AND rd.type = 'race'
),
pace AS (
  SELECT
    pms.season,
    pms.metric_value
  FROM pace_metric_summary_driver_season pms
  WHERE pms.driver_id = $1
    AND pms.metric_name = 'driver_above_baseline'
    AND pms.normalization = 'car_baseline_adjusted'
    AND pms.clean_air_only = false
    AND pms.compound_context = 'mixed'
    AND pms.session_scope = 'all'
  ORDER BY pms.season
),
pace_bounds AS (
  SELECT
    (SELECT season FROM pace ORDER BY season ASC LIMIT 1) AS start_season,
    (SELECT metric_value FROM pace ORDER BY season ASC LIMIT 1) AS start_value,
    (SELECT season FROM pace ORDER BY season DESC LIMIT 1) AS end_season,
    (SELECT metric_value FROM pace ORDER BY season DESC LIMIT 1) AS end_value,
    (SELECT COUNT(*) FROM pace) AS seasons_with_pace
)
SELECT
  d.id AS driver_id,
  COALESCE(d.total_championship_wins, championships.championships, 0) AS championships,
  -- seasons_raced from F1DB season_driver_standing (authoritative, complete history)
  COALESCE(seasons_from_standings.seasons_raced, 0) AS seasons_raced,
  COALESCE(d.total_podiums, career_results.career_podiums, 0) AS career_podiums,
  COALESCE(d.total_race_wins, career_results.career_wins, 0) AS career_wins,
  COALESCE(d.total_pole_positions, 0) AS career_poles,
  d.total_race_starts AS total_race_entries,
  pace_bounds.start_season,
  pace_bounds.start_value,
  pace_bounds.end_season,
  pace_bounds.end_value,
  CASE
    WHEN pace_bounds.seasons_with_pace >= 2
      AND pace_bounds.end_season IS NOT NULL
      AND pace_bounds.start_season IS NOT NULL
      AND pace_bounds.end_season > pace_bounds.start_season
    THEN (pace_bounds.end_value - pace_bounds.start_value)
      / NULLIF((pace_bounds.end_season - pace_bounds.start_season), 0)
    ELSE NULL
  END AS pace_trend_per_season
FROM driver d
LEFT JOIN seasons_from_standings ON TRUE
LEFT JOIN championships ON TRUE
LEFT JOIN career_results ON TRUE
LEFT JOIN pace_bounds ON TRUE
WHERE d.id = $1;
