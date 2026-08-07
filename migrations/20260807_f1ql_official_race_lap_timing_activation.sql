-- Unapplied WP12 activation boundary. Preserve the broad legacy view as the
-- closed compiler regression source and expose only the reviewed semantic fields.
CREATE OR REPLACE VIEW f1ql.official_race_lap_timing
WITH (security_barrier = true)
AS
SELECT
  authority,
  contract_version,
  dataset_sha256,
  driver_id,
  event_name,
  fact_fingerprint,
  identity_fingerprint,
  identity_map_sha256,
  lap_number,
  lap_time_seconds,
  official_deleted_lap,
  official_pit_marker,
  round,
  season,
  session_type,
  source_artifact_sha256,
  source_manifest_sha256
FROM f1ql.official_lap_timing
WHERE authority = 'FIA'
  AND contract_version = 'immutable_official_lap_event_v1'
  AND season = 2022
  AND round = 14
  AND session_type = 'R'
  AND event_name = '2022 Belgian Grand Prix'
  AND dataset_sha256 = '81b7db4e84433ef879c1c6e0bfe08a1d7b36476d9d7f5a7b4cf414a5a0fbc37b'
  AND source_manifest_sha256 = '491c7a7b01c9aa32742cfbf5b1b2cf3704e2ec7b48b84fbc08cdf2ea4df4caab'
  AND identity_map_sha256 = '1b177167217c5ead145bbfb2669dde66e0c39296c09051a9d514a3ad1cc75cbd'
  AND identity_fingerprint = 'edc4d51451b2cd2cdaf87f9a0d8ee65a55cc10502345d7642731b389057682f3'
  AND fact_fingerprint = 'f31adb2eebb906017b9aaea2a63329e142012da7ed312cdfe26d19c7dce30d8f'
  AND source_artifact_sha256 = '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105';

REVOKE ALL ON f1ql.official_race_lap_timing FROM PUBLIC;
REVOKE ALL ON f1ql.official_race_lap_timing FROM f1ql_answer;
GRANT SELECT ON f1ql.official_race_lap_timing TO f1ql_answer;

COMMENT ON VIEW f1ql.official_race_lap_timing IS
  'Pinned FIA Belgian 2022 official raw race lap timing for the atomic WP12 semantic capability; no generic or clean-air pace semantics.';
