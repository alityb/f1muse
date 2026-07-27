-- Private append-only official timing evidence. No F1QL view or runtime grant is created here.
CREATE SCHEMA IF NOT EXISTS official_timing;

CREATE TABLE IF NOT EXISTS official_timing.dataset (
  dataset_sha256 TEXT PRIMARY KEY CHECK (dataset_sha256 ~ '^[a-f0-9]{64}$'),
  contract_version TEXT NOT NULL CHECK (contract_version = 'immutable_official_lap_event_v1'),
  authority TEXT NOT NULL CHECK (authority = 'FIA'),
  season INTEGER NOT NULL CHECK (season BETWEEN 1950 AND 2100),
  round INTEGER NOT NULL CHECK (round > 0),
  session_type TEXT NOT NULL CHECK (session_type IN ('R', 'S')),
  event_name TEXT NOT NULL CHECK (length(event_name) BETWEEN 1 AND 200),
  source_manifest_sha256 TEXT NOT NULL CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  identity_map_sha256 TEXT NOT NULL CHECK (identity_map_sha256 ~ '^[a-f0-9]{64}$'),
  identity_fingerprint TEXT NOT NULL CHECK (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  fact_fingerprint TEXT NOT NULL CHECK (fact_fingerprint ~ '^[a-f0-9]{64}$'),
  identity_count INTEGER NOT NULL CHECK (identity_count > 0),
  fact_count INTEGER NOT NULL CHECK (fact_count > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season, round, session_type),
  UNIQUE (source_manifest_sha256, identity_map_sha256, contract_version)
);

CREATE TABLE IF NOT EXISTS official_timing.artifact (
  dataset_sha256 TEXT NOT NULL,
  artifact_name TEXT NOT NULL CHECK (artifact_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_url TEXT NOT NULL CHECK (source_url ~ '^https://'),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  PRIMARY KEY (dataset_sha256, artifact_name),
  UNIQUE (dataset_sha256, artifact_sha256),
  FOREIGN KEY (dataset_sha256) REFERENCES official_timing.dataset(dataset_sha256)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS official_timing.driver_identity (
  dataset_sha256 TEXT NOT NULL,
  racing_number TEXT NOT NULL CHECK (racing_number ~ '^[0-9]{1,3}$'),
  official_name TEXT NOT NULL CHECK (length(official_name) BETWEEN 1 AND 100),
  driver_id TEXT NOT NULL CHECK (driver_id ~ '^[a-z0-9][a-z0-9_]{0,99}$'),
  canonical_full_name TEXT NOT NULL CHECK (length(canonical_full_name) BETWEEN 1 AND 100),
  classified_laps INTEGER NOT NULL CHECK (classified_laps >= 0),
  PRIMARY KEY (dataset_sha256, racing_number),
  UNIQUE (dataset_sha256, driver_id),
  UNIQUE (dataset_sha256, racing_number, driver_id),
  FOREIGN KEY (dataset_sha256) REFERENCES official_timing.dataset(dataset_sha256)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS official_timing.lap_fact (
  dataset_sha256 TEXT NOT NULL,
  racing_number TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  lap_number INTEGER NOT NULL CHECK (lap_number > 0),
  lap_time_seconds NUMERIC(10,3) NOT NULL CHECK (lap_time_seconds > 0),
  leader_gap_seconds NUMERIC(10,3) CHECK (leader_gap_seconds >= 0),
  official_deleted_lap BOOLEAN NOT NULL,
  official_pit_marker BOOLEAN NOT NULL,
  source_artifact_sha256 TEXT NOT NULL CHECK (source_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (dataset_sha256, driver_id, lap_number),
  UNIQUE (dataset_sha256, racing_number, lap_number),
  FOREIGN KEY (dataset_sha256, racing_number, driver_id)
    REFERENCES official_timing.driver_identity(dataset_sha256, racing_number, driver_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_sha256, source_artifact_sha256)
    REFERENCES official_timing.artifact(dataset_sha256, artifact_sha256)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS official_timing.coverage (
  dataset_sha256 TEXT NOT NULL,
  coverage_kind TEXT NOT NULL CHECK (coverage_kind ~ '^[a-z][a-z0-9_]{0,99}$'),
  expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
  actual_count INTEGER NOT NULL CHECK (actual_count >= 0),
  missing_keys JSONB NOT NULL CHECK (jsonb_typeof(missing_keys) = 'array'),
  unexpected_keys JSONB NOT NULL CHECK (jsonb_typeof(unexpected_keys) = 'array'),
  PRIMARY KEY (dataset_sha256, coverage_kind),
  FOREIGN KEY (dataset_sha256) REFERENCES official_timing.dataset(dataset_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (expected_count = actual_count),
  CHECK (missing_keys = '[]'::jsonb),
  CHECK (unexpected_keys = '[]'::jsonb)
);

CREATE OR REPLACE FUNCTION official_timing.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'official timing evidence is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION official_timing.reject_child_insert_after_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM official_timing.dataset WHERE dataset_sha256 = NEW.dataset_sha256) THEN
    RAISE EXCEPTION 'sealed official timing dataset cannot be extended';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['dataset', 'artifact', 'driver_identity', 'lap_fact', 'coverage'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS official_timing_immutable ON official_timing.%I', relation_name);
    EXECUTE format('CREATE TRIGGER official_timing_immutable BEFORE UPDATE OR DELETE ON official_timing.%I FOR EACH ROW EXECUTE FUNCTION official_timing.reject_mutation()', relation_name);
    EXECUTE format('DROP TRIGGER IF EXISTS official_timing_no_truncate ON official_timing.%I', relation_name);
    EXECUTE format('CREATE TRIGGER official_timing_no_truncate BEFORE TRUNCATE ON official_timing.%I FOR EACH STATEMENT EXECUTE FUNCTION official_timing.reject_mutation()', relation_name);
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['artifact', 'driver_identity', 'lap_fact', 'coverage'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS official_timing_no_insert_after_seal ON official_timing.%I', relation_name);
    EXECUTE format('CREATE TRIGGER official_timing_no_insert_after_seal BEFORE INSERT ON official_timing.%I FOR EACH ROW EXECUTE FUNCTION official_timing.reject_child_insert_after_seal()', relation_name);
  END LOOP;
END;
$$;

REVOKE ALL ON SCHEMA official_timing FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA official_timing FROM PUBLIC;
REVOKE ALL ON FUNCTION official_timing.reject_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION official_timing.reject_child_insert_after_seal() FROM PUBLIC;

COMMENT ON SCHEMA official_timing IS 'Private append-only official timing evidence; not an F1QL serving schema.';
COMMENT ON TABLE official_timing.dataset IS 'Seal-last immutable historical timing dataset registry.';
COMMENT ON TABLE official_timing.lap_fact IS 'Official printed lap facts. No clean-air or inferred race-state semantics.';
