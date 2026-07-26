-- Expose selected lap identity without changing pace eligibility or methodology.
-- This is structural groundwork only; it does not authorize raw lap-window queries.
CREATE OR REPLACE VIEW f1ql.lap_pace AS
WITH approved_rebuilds AS (
  SELECT l.*
  FROM pace_v2_lap_rebuild l
  JOIN pace_v2_rebuild_audit a USING (rebuild_version, season, round, session_type)
  WHERE a.rebuild_version = 'fastf1_complete_race_v1'
), approved_replacements AS (
  SELECT l.*
  FROM pace_v2_lap_replacement l
  JOIN pace_v2_replacement_audit a USING (replacement_version, season, round, session_type)
  WHERE a.replacement_version = 'nat_pit_flags_v1'
), selected_laps AS (
  SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds,
    is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound,
    tyre_age_laps, methodology_version
  FROM approved_rebuilds
  UNION ALL
  SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds,
    is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound,
    tyre_age_laps, methodology_version
  FROM approved_replacements l
  WHERE NOT EXISTS (
    SELECT 1 FROM pace_v2_rebuild_audit a
    WHERE a.season = l.season AND a.round = l.round AND a.session_type = l.session_type
      AND a.rebuild_version = 'fastf1_complete_race_v1'
  )
  UNION ALL
  SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds,
    is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound,
    tyre_age_laps, methodology_version
  FROM laps_normalized_v2 l
  WHERE NOT EXISTS (
    SELECT 1 FROM pace_v2_rebuild_audit a
    WHERE a.season = l.season AND a.round = l.round AND a.session_type = l.session_type
      AND a.rebuild_version = 'fastf1_complete_race_v1'
  ) AND NOT EXISTS (
    SELECT 1 FROM pace_v2_replacement_audit a
    WHERE a.season = l.season AND a.round = l.round AND a.session_type = l.session_type
      AND a.replacement_version = 'nat_pit_flags_v1'
  )
)
SELECT season, round, track_id AS event_id, REPLACE(driver_id, '_', '-') AS driver_id,
  lap_time_seconds::numeric, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap,
  clean_air_flag, compound, tyre_age_laps, session_type::varchar(5), methodology_version,
  lap_number
FROM selected_laps;

COMMENT ON VIEW f1ql.lap_pace IS
  'Selected lap facts. Compiled F1QL applies the active methodology filter; lap_number preserves source identity but does not authorize an official raw-timing or historical pace claim.';
