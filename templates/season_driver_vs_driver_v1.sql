-- Season driver vs driver comparison (raw pace from laps_normalized)
-- Parameters: $1=driver_a_id, $2=driver_b_id, $3=season, $4=metric_name, $5=normalization, $6=clean_air_only, $7=compound_context, $8=session_scope
--
-- Note: This template queries laps_normalized directly for raw pace comparison.
-- Pre-aggregated pace_metric_summary tables only have baseline-adjusted data.

WITH driver_a_metrics AS (
  SELECT
    driver_id,
    AVG(lap_time_seconds) AS metric_value,
    COUNT(*) AS laps_considered
  FROM laps_normalized
  WHERE season = $3
    AND driver_id = $1
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue
  GROUP BY driver_id
  HAVING COUNT(*) >= 10  -- Minimum 10 laps for comparison
),
driver_b_metrics AS (
  SELECT
    driver_id,
    AVG(lap_time_seconds) AS metric_value,
    COUNT(*) AS laps_considered
  FROM laps_normalized
  WHERE season = $3
    AND driver_id = $2
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue
  GROUP BY driver_id
  HAVING COUNT(*) >= 10  -- Minimum 10 laps for comparison
)
SELECT
  a.driver_id AS driver_a_id,
  a.metric_value AS driver_a_value,
  a.laps_considered AS driver_a_laps,
  b.driver_id AS driver_b_id,
  b.metric_value AS driver_b_value,
  b.laps_considered AS driver_b_laps
FROM driver_a_metrics a
CROSS JOIN driver_b_metrics b;
