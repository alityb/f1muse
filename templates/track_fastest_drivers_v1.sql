-- Driver ranking at a specific track and season
-- Parameters: $1=season, $2=f1db_track_id, $3=metric_name, $4=normalization, $5=clean_air_only, $6=compound_context, $7=session_scope
--
-- Returns: all drivers ranked by the specified metric at the track
-- Ordering: ASC for avg_true_pace (lower is faster), metric-dependent otherwise

SELECT
  pms.driver_id AS driver_id,
  pms.metric_value AS value,
  pms.laps_considered
FROM pace_metric_summary_driver_track pms
WHERE pms.season = $1
  AND pms.track_id = $2
  AND pms.metric_name = $3
  AND pms.normalization = $4
  AND pms.clean_air_only = $5
  AND pms.compound_context = $6
  AND pms.session_scope = $7
ORDER BY pms.metric_value ASC;  -- Lower is faster for avg_true_pace
