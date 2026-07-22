-- Reviewed forward-only migration for manifest-controlled v2 pace ingestion.
-- Apply through an approved primary migration channel; never from application ETL.
CREATE TABLE IF NOT EXISTS pace_v2_round_audit (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  session_type TEXT NOT NULL,
  manifest_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  fact_row_count INTEGER NOT NULL CHECK (fact_row_count > 0),
  methodology_version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season, round, session_type)
);

CREATE OR REPLACE FUNCTION reject_pace_v2_round_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pace_v2_round_audit is immutable';
END;
$$;

DROP TRIGGER IF EXISTS pace_v2_round_audit_immutable ON pace_v2_round_audit;
CREATE TRIGGER pace_v2_round_audit_immutable
  BEFORE UPDATE OR DELETE ON pace_v2_round_audit
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_round_audit_mutation();

COMMENT ON TABLE pace_v2_round_audit IS 'Immutable manifest, source, and complete v2 fact fingerprints for a race session.';
