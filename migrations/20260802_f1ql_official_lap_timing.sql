-- Read-only serving projection over sealed, internally complete official timing datasets.
-- Runtime grants and F1QL answer authorization are intentionally absent.
CREATE SCHEMA IF NOT EXISTS f1ql;

CREATE OR REPLACE VIEW f1ql.official_lap_timing
WITH (security_barrier = true) AS
WITH identity_rollup AS (
  SELECT
    dataset_sha256,
    count(*)::integer AS actual_identity_count,
    sum(classified_laps)::bigint AS classified_fact_count
  FROM official_timing.driver_identity
  GROUP BY dataset_sha256
),
fact_rollup AS (
  SELECT dataset_sha256, count(*)::integer AS actual_fact_count
  FROM official_timing.lap_fact
  GROUP BY dataset_sha256
),
per_identity_rollup AS (
  SELECT
    identity.dataset_sha256,
    identity.driver_id,
    identity.classified_laps,
    count(fact.dataset_sha256)::integer AS actual_fact_count,
    min(fact.lap_number) AS minimum_lap_number,
    max(fact.lap_number) AS maximum_lap_number
  FROM official_timing.driver_identity AS identity
  LEFT JOIN official_timing.lap_fact AS fact
    ON fact.dataset_sha256 = identity.dataset_sha256
   AND fact.driver_id = identity.driver_id
   AND fact.racing_number = identity.racing_number
  GROUP BY identity.dataset_sha256, identity.driver_id, identity.classified_laps
),
complete_datasets AS (
  SELECT dataset.*
  FROM official_timing.dataset AS dataset
  JOIN identity_rollup USING (dataset_sha256)
  JOIN fact_rollup USING (dataset_sha256)
  WHERE dataset.contract_version = 'immutable_official_lap_event_v1'
    AND dataset.authority = 'FIA'
    AND dataset.identity_count = identity_rollup.actual_identity_count
    AND dataset.fact_count = fact_rollup.actual_fact_count
    AND dataset.fact_count::bigint = identity_rollup.classified_fact_count
    AND NOT EXISTS (
      SELECT 1
      FROM per_identity_rollup
      WHERE per_identity_rollup.dataset_sha256 = dataset.dataset_sha256
        AND (
          per_identity_rollup.actual_fact_count <> per_identity_rollup.classified_laps
          OR (
            per_identity_rollup.classified_laps > 0
            AND (
              per_identity_rollup.minimum_lap_number <> 1
              OR per_identity_rollup.maximum_lap_number <> per_identity_rollup.classified_laps
            )
          )
        )
    )
    AND (
      SELECT array_agg(artifact.artifact_name ORDER BY artifact.artifact_name)
      FROM official_timing.artifact AS artifact
      WHERE artifact.dataset_sha256 = dataset.dataset_sha256
    ) = ARRAY['deleted_race_lap_times', 'final_race_classification', 'race_history_chart']::text[]
    AND NOT EXISTS (
      SELECT 1
      FROM official_timing.lap_fact AS fact
      JOIN official_timing.artifact AS artifact
        ON artifact.dataset_sha256 = fact.dataset_sha256
       AND artifact.artifact_sha256 = fact.source_artifact_sha256
      WHERE fact.dataset_sha256 = dataset.dataset_sha256
        AND artifact.artifact_name <> 'race_history_chart'
    )
    AND (
      SELECT count(*)::integer
      FROM official_timing.coverage AS coverage
      WHERE coverage.dataset_sha256 = dataset.dataset_sha256
    ) = 3
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        ('final_classification_to_race_history'::text, dataset.fact_count),
        ('race_history_to_final_classification'::text, dataset.fact_count),
        ('official_identity_to_canonical_driver'::text, dataset.identity_count)
      ) AS required(coverage_kind, required_count)
      LEFT JOIN official_timing.coverage AS coverage
        ON coverage.dataset_sha256 = dataset.dataset_sha256
       AND coverage.coverage_kind = required.coverage_kind
      WHERE coverage.coverage_kind IS NULL
         OR coverage.expected_count <> required.required_count
         OR coverage.actual_count <> required.required_count
         OR coverage.missing_keys <> '[]'::jsonb
         OR coverage.unexpected_keys <> '[]'::jsonb
    )
)
SELECT
  dataset.dataset_sha256,
  dataset.contract_version,
  dataset.authority,
  dataset.season,
  dataset.round,
  dataset.session_type,
  dataset.event_name,
  dataset.source_manifest_sha256,
  dataset.identity_map_sha256,
  dataset.identity_fingerprint,
  dataset.fact_fingerprint,
  replace(fact.driver_id, '_', '-') AS driver_id,
  fact.racing_number,
  identity.official_name,
  fact.lap_number,
  fact.lap_time_seconds,
  fact.leader_gap_seconds,
  fact.official_deleted_lap,
  fact.official_pit_marker,
  fact.source_artifact_sha256
FROM complete_datasets AS dataset
JOIN official_timing.lap_fact AS fact USING (dataset_sha256)
JOIN official_timing.driver_identity AS identity
  ON identity.dataset_sha256 = fact.dataset_sha256
 AND identity.racing_number = fact.racing_number
 AND identity.driver_id = fact.driver_id;

REVOKE ALL ON f1ql.official_lap_timing FROM PUBLIC;

COMMENT ON VIEW f1ql.official_lap_timing IS
  'Official printed lap timing from sealed immutable_official_lap_event_v1 datasets with exact artifact, identity, fact, per-driver lap, and coverage completeness. No clean-air semantics.';
