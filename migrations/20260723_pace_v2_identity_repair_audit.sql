-- Forward-only audit evidence for the separately authorized v2 track-identity repair.
CREATE TABLE IF NOT EXISTS pace_v2_identity_repair_audit (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  session_type TEXT NOT NULL,
  repair_method TEXT NOT NULL,
  manifest_fingerprint TEXT NOT NULL,
  source_fact_fingerprint TEXT NOT NULL,
  target_fact_fingerprint TEXT NOT NULL,
  fact_row_count INTEGER NOT NULL CHECK (fact_row_count > 0),
  methodology_version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season, round, session_type)
);

CREATE OR REPLACE FUNCTION reject_pace_v2_identity_repair_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pace_v2_identity_repair_audit is immutable';
END;
$$;

CREATE TRIGGER pace_v2_identity_repair_audit_immutable
  BEFORE UPDATE OR DELETE ON pace_v2_identity_repair_audit
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_identity_repair_audit_mutation();

COMMENT ON TABLE pace_v2_identity_repair_audit IS 'Immutable evidence for one explicitly approved v2 track identity repair.';
