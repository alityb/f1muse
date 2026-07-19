CREATE SCHEMA IF NOT EXISTS f1ql;

CREATE OR REPLACE VIEW f1ql.driver_standings AS
SELECT
  s.year AS season,
  REPLACE(s.driver_id, '_', '-') AS driver_id,
  s.position_number AS championship_position,
  s.points AS points,
  s.championship_won
FROM season_driver_standing s;

CREATE OR REPLACE VIEW f1ql.lap_pace AS
SELECT
  l.season,
  l.round,
  l.track_id AS event_id,
  REPLACE(l.driver_id, '_', '-') AS driver_id,
  l.lap_time_seconds,
  l.is_valid_lap,
  l.is_pit_lap,
  l.is_in_lap,
  l.is_out_lap,
  l.clean_air_flag,
  l.compound,
  l.tyre_age_laps,
  l.session_type
FROM laps_normalized l;

CREATE OR REPLACE VIEW f1ql.event_classification AS
SELECT r.year AS season, r.round, REPLACE(rd.driver_id, '_', '-') AS driver_id,
  rd.position_number AS finishing_position, rd.race_points AS points,
  COALESCE(rd.race_reason_retired, 'classified') AS status
FROM race_data rd JOIN race r ON r.id = rd.race_id
WHERE LOWER(rd.type) IN ('race', 'race_result') AND rd.position_number IS NOT NULL;
