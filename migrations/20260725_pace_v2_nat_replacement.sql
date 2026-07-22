-- Reviewed forward-only replacement facts for the 2026 NaT pit-flag poisoning.
-- Original laps_normalized_v2 and all existing audits remain immutable and untouched.
CREATE TABLE IF NOT EXISTS pace_v2_lap_replacement (
  replacement_version TEXT NOT NULL CHECK (replacement_version = 'nat_pit_flags_v1'),
  season INTEGER NOT NULL CHECK (season = 2026),
  round INTEGER NOT NULL CHECK (round BETWEEN 2 AND 10),
  track_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type = 'R'),
  lap_number INTEGER NOT NULL,
  stint_id INTEGER NOT NULL,
  stint_lap_index INTEGER NOT NULL,
  lap_time_seconds NUMERIC(8,3),
  is_valid_lap BOOLEAN NOT NULL,
  is_pit_lap BOOLEAN NOT NULL,
  is_out_lap BOOLEAN NOT NULL,
  is_in_lap BOOLEAN NOT NULL,
  clean_air_flag BOOLEAN NOT NULL,
  compound TEXT,
  tyre_age_laps INTEGER,
  methodology_version TEXT NOT NULL CHECK (methodology_version = 'clean_air_gap_2_0s_v1'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (replacement_version, season, round, track_id, driver_id, session_type, lap_number)
);

CREATE TABLE IF NOT EXISTS pace_v2_replacement_audit (
  replacement_version TEXT NOT NULL CHECK (replacement_version = 'nat_pit_flags_v1'),
  season INTEGER NOT NULL CHECK (season = 2026),
  round INTEGER NOT NULL CHECK (round BETWEEN 2 AND 10),
  session_type TEXT NOT NULL CHECK (session_type = 'R'),
  replacement_manifest_fingerprint TEXT NOT NULL,
  original_fact_fingerprint TEXT NOT NULL,
  replacement_fact_fingerprint TEXT NOT NULL,
  fact_row_count INTEGER NOT NULL CHECK (fact_row_count > 0),
  methodology_version TEXT NOT NULL CHECK (methodology_version = 'clean_air_gap_2_0s_v1'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (replacement_version, season, round, session_type),
  CHECK (original_fact_fingerprint <> replacement_fact_fingerprint)
);

CREATE OR REPLACE FUNCTION reject_pace_v2_replacement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pace v2 replacement facts and audits are immutable'; END; $$;

CREATE TRIGGER pace_v2_lap_replacement_immutable BEFORE UPDATE OR DELETE ON pace_v2_lap_replacement
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_replacement_mutation();
CREATE TRIGGER pace_v2_replacement_audit_immutable BEFORE UPDATE OR DELETE ON pace_v2_replacement_audit
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_replacement_mutation();

CREATE OR REPLACE FUNCTION reject_pace_v2_replacement_after_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pace_v2_replacement_audit a WHERE a.replacement_version = NEW.replacement_version AND a.season = NEW.season AND a.round = NEW.round AND a.session_type = NEW.session_type) THEN
    RAISE EXCEPTION 'approved pace v2 replacement facts cannot be extended';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pace_v2_lap_replacement_no_insert_after_approval BEFORE INSERT ON pace_v2_lap_replacement
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_replacement_after_approval();

CREATE OR REPLACE VIEW f1ql.lap_pace AS
WITH approved_replacements AS (
  SELECT l.*
  FROM pace_v2_lap_replacement l
  JOIN pace_v2_replacement_audit a ON a.replacement_version = l.replacement_version AND a.season = l.season AND a.round = l.round AND a.session_type = l.session_type
  WHERE a.replacement_version = 'nat_pit_flags_v1'
), selected_laps AS (
  SELECT NULL::text AS replacement_version, l.season, l.round, l.track_id, l.driver_id, l.session_type, l.lap_number, l.lap_time_seconds, l.is_valid_lap, l.is_pit_lap, l.is_in_lap, l.is_out_lap, l.clean_air_flag, l.compound, l.tyre_age_laps, l.methodology_version
  FROM laps_normalized_v2 l
  WHERE NOT EXISTS (SELECT 1 FROM pace_v2_replacement_audit a WHERE a.replacement_version = 'nat_pit_flags_v1' AND a.season = l.season AND a.round = l.round AND a.session_type = l.session_type)
  UNION ALL
  SELECT replacement_version, season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, methodology_version
  FROM approved_replacements
)
SELECT season, round, track_id AS event_id, REPLACE(driver_id, '_', '-') AS driver_id, lap_time_seconds::numeric, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, tyre_age_laps, session_type::varchar(5), methodology_version
FROM selected_laps;

COMMENT ON TABLE pace_v2_lap_replacement IS 'Immutable approved replacement facts only for 2026 rounds 2-10 NaT pit-flag poisoning; original v2 facts are retained.';
COMMENT ON TABLE pace_v2_replacement_audit IS 'Immutable manifest and original/replacement fingerprint evidence for approved pace replacement facts.';
