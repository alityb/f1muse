-- Approved full FastF1 race-session replacements for incomplete 2026 v2 coverage.
-- Original v2 facts and their existing audits are retained, never repaired in place.
CREATE TABLE IF NOT EXISTS pace_v2_lap_rebuild (
  rebuild_version TEXT NOT NULL CHECK (rebuild_version = 'fastf1_complete_race_v1'), season INTEGER NOT NULL CHECK (season = 2026),
  round INTEGER NOT NULL CHECK (round BETWEEN 2 AND 10), track_id TEXT NOT NULL, driver_id TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type = 'R'), lap_number INTEGER NOT NULL, stint_id INTEGER NOT NULL, stint_lap_index INTEGER NOT NULL,
  lap_time_seconds NUMERIC(8,3), is_valid_lap BOOLEAN NOT NULL, is_pit_lap BOOLEAN NOT NULL, is_out_lap BOOLEAN NOT NULL,
  is_in_lap BOOLEAN NOT NULL, clean_air_flag BOOLEAN NOT NULL, compound TEXT, tyre_age_laps INTEGER,
  methodology_version TEXT NOT NULL CHECK (methodology_version = 'clean_air_gap_2_0s_v1'), recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rebuild_version, season, round, track_id, driver_id, session_type, lap_number)
);
CREATE TABLE IF NOT EXISTS pace_v2_rebuild_audit (
  rebuild_version TEXT NOT NULL CHECK (rebuild_version = 'fastf1_complete_race_v1'), season INTEGER NOT NULL CHECK (season = 2026),
  round INTEGER NOT NULL CHECK (round BETWEEN 2 AND 10), session_type TEXT NOT NULL CHECK (session_type = 'R'),
  rebuild_manifest_fingerprint TEXT NOT NULL, identity_map_fingerprint TEXT NOT NULL, original_fact_fingerprint TEXT NOT NULL,
  replacement_fact_fingerprint TEXT NOT NULL, original_fact_row_count INTEGER NOT NULL CHECK (original_fact_row_count > 0),
  replacement_fact_row_count INTEGER NOT NULL CHECK (replacement_fact_row_count > 0), canonical_driver_fingerprint TEXT NOT NULL,
  canonical_driver_count INTEGER NOT NULL CHECK (canonical_driver_count > 0), methodology_version TEXT NOT NULL CHECK (methodology_version = 'clean_air_gap_2_0s_v1'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (rebuild_version, season, round, session_type),
  CHECK (original_fact_fingerprint <> replacement_fact_fingerprint)
);
CREATE OR REPLACE FUNCTION reject_pace_v2_rebuild_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pace v2 rebuild facts and audits are immutable'; END; $$;
CREATE TRIGGER pace_v2_lap_rebuild_immutable BEFORE UPDATE OR DELETE ON pace_v2_lap_rebuild FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_rebuild_mutation();
CREATE TRIGGER pace_v2_rebuild_audit_immutable BEFORE UPDATE OR DELETE ON pace_v2_rebuild_audit FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_rebuild_mutation();
CREATE OR REPLACE FUNCTION reject_pace_v2_rebuild_after_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM pace_v2_rebuild_audit a WHERE a.rebuild_version = NEW.rebuild_version AND a.season = NEW.season AND a.round = NEW.round AND a.session_type = NEW.session_type) THEN RAISE EXCEPTION 'approved pace v2 rebuild facts cannot be extended'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER pace_v2_lap_rebuild_no_insert_after_approval BEFORE INSERT ON pace_v2_lap_rebuild FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_rebuild_after_approval();
CREATE OR REPLACE VIEW f1ql.lap_pace AS
WITH approved_rebuilds AS (SELECT l.* FROM pace_v2_lap_rebuild l JOIN pace_v2_rebuild_audit a USING (rebuild_version, season, round, session_type) WHERE a.rebuild_version = 'fastf1_complete_race_v1'),
approved_replacements AS (SELECT l.* FROM pace_v2_lap_replacement l JOIN pace_v2_replacement_audit a USING (replacement_version, season, round, session_type) WHERE a.replacement_version = 'nat_pit_flags_v1'),
selected_laps AS (
 SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM approved_rebuilds
 UNION ALL SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM approved_replacements l WHERE NOT EXISTS (SELECT 1 FROM pace_v2_rebuild_audit a WHERE a.season=l.season AND a.round=l.round AND a.session_type=l.session_type AND a.rebuild_version='fastf1_complete_race_v1')
 UNION ALL SELECT season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 l WHERE NOT EXISTS (SELECT 1 FROM pace_v2_rebuild_audit a WHERE a.season=l.season AND a.round=l.round AND a.session_type=l.session_type AND a.rebuild_version='fastf1_complete_race_v1') AND NOT EXISTS (SELECT 1 FROM pace_v2_replacement_audit a WHERE a.season=l.season AND a.round=l.round AND a.session_type=l.session_type AND a.replacement_version='nat_pit_flags_v1')
) SELECT season, round, track_id AS event_id, REPLACE(driver_id, '_', '-') AS driver_id, lap_time_seconds::numeric, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, session_type::varchar(5), methodology_version FROM selected_laps;
