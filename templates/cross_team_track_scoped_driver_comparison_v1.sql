-- PHASE L1: Cross-team track-scoped driver comparison (different teams, specific track, specific season)
-- Parameters: $1=f1db_driver_a_id, $2=f1db_driver_b_id, $3=season, $4=f1db_track_id, $5=metric_name, $6=normalization, $7=clean_air_only, $8=compound_context, $9=session_scope
--
-- Returns: driver_a metrics, driver_b metrics at the specified track
-- Track-bounded, cross-team only, normalization=none (raw pace)
-- Use case: "Verstappen vs Norris at Silverstone 2025" (different teams)
--
-- Coverage model:
--   - Each driver's pace is computed from their own valid laps
--   - basis_laps = min(driver_a_valid_laps, driver_b_valid_laps)
--   - Confidence: high (>=30), medium (10-29), low (<10)

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
)
SELECT
  a.driver_id AS driver_a_id,
  a.metric_value AS driver_a_value,
  a.laps_considered AS driver_a_valid_laps,
  b.driver_id AS driver_b_id,
  b.metric_value AS driver_b_value,
  b.laps_considered AS driver_b_valid_laps
FROM driver_a_metrics a
CROSS JOIN driver_b_metrics b;
