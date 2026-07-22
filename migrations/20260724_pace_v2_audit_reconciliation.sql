-- Reviewed forward-only evidence for immutable v2 manifest-audit fingerprint reconciliation.
-- This never changes pace_v2_round_audit; apply through an approved primary migration channel.
CREATE TABLE IF NOT EXISTS pace_v2_round_audit_reconciliation (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  session_type TEXT NOT NULL,
  reconciliation_method TEXT NOT NULL,
  reconciliation_manifest_fingerprint TEXT NOT NULL,
  original_manifest_fact_fingerprint TEXT NOT NULL,
  reconciled_fact_fingerprint TEXT NOT NULL,
  fact_row_count INTEGER NOT NULL CHECK (fact_row_count > 0),
  methodology_version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season, round, session_type),
  CHECK (original_manifest_fact_fingerprint <> reconciled_fact_fingerprint)
);

CREATE OR REPLACE FUNCTION reject_pace_v2_round_audit_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pace_v2_round_audit_reconciliation is immutable';
END;
$$;

DROP TRIGGER IF EXISTS pace_v2_round_audit_reconciliation_immutable ON pace_v2_round_audit_reconciliation;
CREATE TRIGGER pace_v2_round_audit_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON pace_v2_round_audit_reconciliation
  FOR EACH ROW EXECUTE FUNCTION reject_pace_v2_round_audit_reconciliation_mutation();

COMMENT ON TABLE pace_v2_round_audit_reconciliation IS 'Append-only immutable evidence for an original manifest fact-fingerprint-only mismatch; original pace audit remains unchanged.';
