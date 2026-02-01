-- PHASE L1: Cross-team track-scoped driver comparison (different teams, specific track, specific season)
-- Parameters: $1=f1db_driver_a_id, $2=f1db_driver_b_id, $3=season, $4=f1db_track_id, $5=metric_name, $6=normalization, $7=clean_air_only, $8=compound_context, $9=session_scope
--
-- Returns: driver_a metrics, driver_b metrics at the specified track
-- Track-bounded, cross-team only, normalization=none (raw pace)
-- Use case: "Verstappen vs Norris at Silverstone 2025" (different teams)

WITH driver_a_metrics AS (
  SELECT
    pms.driver_id AS driver_id,
    pms.metric_value,
    pms.laps_considered
  FROM pace_metric_summary_driver_track pms
  WHERE pms.season = $3
    AND pms.driver_id = $1
    AND pms.track_id = $4
    AND pms.metric_name = $5
    AND pms.normalization = $6
    AND pms.clean_air_only = $7
    AND pms.compound_context = $8
    AND pms.session_scope = $9
),
driver_b_metrics AS (
  SELECT
    pms.driver_id AS driver_id,
    pms.metric_value,
    pms.laps_considered
  FROM pace_metric_summary_driver_track pms
  WHERE pms.season = $3
    AND pms.driver_id = $2
    AND pms.track_id = $4
    AND pms.metric_name = $5
    AND pms.normalization = $6
    AND pms.clean_air_only = $7
    AND pms.compound_context = $8
    AND pms.session_scope = $9
),
shared_laps AS (
  SELECT COUNT(*) AS shared_valid_laps
  FROM laps_normalized la
  JOIN laps_normalized lb
    ON la.season = lb.season
   AND la.round = lb.round
   AND la.track_id = lb.track_id
   AND la.lap_number = lb.lap_number
  WHERE la.season = $3
    AND la.track_id = $4
    AND la.driver_id = $1
    AND lb.driver_id = $2
    AND la.is_valid_lap = true
    AND lb.is_valid_lap = true
)
SELECT
  a.driver_id AS driver_a_id,
  a.metric_value AS driver_a_value,
  a.laps_considered AS driver_a_laps,
  b.driver_id AS driver_b_id,
  b.metric_value AS driver_b_value,
  b.laps_considered AS driver_b_laps,
  shared_laps.shared_valid_laps
FROM driver_a_metrics a
CROSS JOIN driver_b_metrics b
CROSS JOIN shared_laps;
