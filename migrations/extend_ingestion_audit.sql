-- EXTEND INGESTION AUDIT TABLE
-- Adds additional tracking fields for better observability
--
-- New columns:
-- - metric_type: Identifies which metric was ingested (qualifying, race_pace, etc.)
-- - methodology_version: Version string for the methodology used
-- - input_fingerprint_hash: Hash of input data for change detection
-- - coverage_summary_json: JSON summary of coverage by status

-- Add new columns to ingestion_runs_teammate_gap
ALTER TABLE ingestion_runs_teammate_gap
  ADD COLUMN IF NOT EXISTS metric_type TEXT,
  ADD COLUMN IF NOT EXISTS methodology_version TEXT,
  ADD COLUMN IF NOT EXISTS input_fingerprint_hash TEXT,
  ADD COLUMN IF NOT EXISTS coverage_summary_json JSONB;

-- Add comment for documentation
COMMENT ON COLUMN ingestion_runs_teammate_gap.metric_type IS 'Metric type: qualifying, race_pace, etc.';
COMMENT ON COLUMN ingestion_runs_teammate_gap.methodology_version IS 'Version of the methodology used (e.g., symmetric_percent_diff_v2)';
COMMENT ON COLUMN ingestion_runs_teammate_gap.input_fingerprint_hash IS 'SHA-256 hash of input table fingerprints';
COMMENT ON COLUMN ingestion_runs_teammate_gap.coverage_summary_json IS 'JSON summary: {valid: N, low_coverage: N, insufficient: N}';

-- Create index for metric_type queries
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_metric_type
  ON ingestion_runs_teammate_gap(metric_type, season);

-- Backfill existing rows with default values
UPDATE ingestion_runs_teammate_gap
SET
  metric_type = 'race_pace',
  methodology_version = 'symmetric_percent_diff_v1'
WHERE metric_type IS NULL;
