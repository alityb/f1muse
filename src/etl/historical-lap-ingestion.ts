import type { HistoricalLapDataset, HistoricalLapFact, HistoricalLapIdentity } from './historical-lap-window-pilot';
import { assertVerifiedHistoricalLapDataset } from './historical-lap-window-pilot';

interface Client {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}

interface QueryPool {
  connect(): Promise<Client>;
}

export type HistoricalLapIngestionResult = {
  dataset_sha256: string;
  status: 'committed' | 'already_committed';
  identity_count: number;
  fact_count: number;
};

function asIdentityRows(rows: Record<string, unknown>[]): HistoricalLapIdentity[] {
  return rows.map(row => ({
    racing_number: String(row.racing_number),
    official_name: String(row.official_name),
    driver_id: String(row.driver_id),
    canonical_full_name: String(row.canonical_full_name),
    classified_laps: Number(row.classified_laps)
  }));
}

function asFactRows(rows: Record<string, unknown>[], dataset: HistoricalLapDataset): HistoricalLapFact[] {
  const scope = dataset.facts[0];
  return rows.map(row => ({
    season: scope.season,
    round: scope.round,
    session_type: scope.session_type,
    event: scope.event,
    driver_id: String(row.driver_id),
    racing_number: String(row.racing_number),
    official_name: String(row.official_name),
    lap_number: Number(row.lap_number),
    lap_time_seconds: Number(row.lap_time_seconds),
    leader_gap_seconds: row.leader_gap_seconds === null ? null : Number(row.leader_gap_seconds),
    official_deleted_lap: Boolean(row.official_deleted_lap),
    official_pit_marker: Boolean(row.official_pit_marker),
    source_manifest_sha256: dataset.source_manifest_sha256,
    source_artifact_sha256: String(row.source_artifact_sha256)
  }));
}

async function existingDatasetResult(client: Client, dataset: HistoricalLapDataset): Promise<HistoricalLapIngestionResult | null> {
  const scope = dataset.facts[0];
  const existing = await client.query<{
    dataset_sha256: string;
    source_manifest_sha256: string;
    identity_map_sha256: string;
    identity_fingerprint: string;
    fact_fingerprint: string;
    identity_count: number;
    fact_count: number;
  }>(`
    SELECT dataset_sha256, source_manifest_sha256, identity_map_sha256, identity_fingerprint,
      fact_fingerprint, identity_count, fact_count
    FROM official_timing.dataset
    WHERE season = $1 AND round = $2 AND session_type = $3
    FOR SHARE
  `, [scope.season, scope.round, scope.session_type]);
  if (!existing.rows.length) {
    return null;
  }
  const row = existing.rows[0];
  if (existing.rows.length !== 1 || row.dataset_sha256 !== dataset.dataset_sha256 ||
      row.source_manifest_sha256 !== dataset.source_manifest_sha256 || row.identity_map_sha256 !== dataset.identity_map_sha256 ||
      row.identity_fingerprint !== dataset.identity_fingerprint || row.fact_fingerprint !== dataset.fact_fingerprint ||
      Number(row.identity_count) !== dataset.identities.length || Number(row.fact_count) !== dataset.facts.length) {
    throw new Error('FAIL_CLOSED: historical event scope already has different sealed evidence');
  }
  return {
    dataset_sha256: dataset.dataset_sha256,
    status: 'already_committed',
    identity_count: dataset.identities.length,
    fact_count: dataset.facts.length
  };
}

async function assertPersistentReadback(client: Client, dataset: HistoricalLapDataset): Promise<void> {
  const artifacts = await client.query(`
    SELECT artifact_name, source_url, artifact_sha256, bytes
    FROM official_timing.artifact
    WHERE dataset_sha256 = $1
    ORDER BY artifact_name
  `, [dataset.dataset_sha256]);
  const artifactRows = artifacts.rows.map(row => ({
    artifact_name: String(row.artifact_name),
    source_url: String(row.source_url),
    artifact_sha256: String(row.artifact_sha256),
    bytes: Number(row.bytes)
  }));
  if (JSON.stringify(artifactRows) !== JSON.stringify([...dataset.artifacts].sort((left, right) => left.artifact_name.localeCompare(right.artifact_name)))) {
    throw new Error('FAIL_CLOSED: persisted historical artifacts differ from verified input');
  }
  const identities = await client.query(`
    SELECT racing_number, official_name, driver_id, canonical_full_name, classified_laps
    FROM official_timing.driver_identity
    WHERE dataset_sha256 = $1
    ORDER BY racing_number::integer
  `, [dataset.dataset_sha256]);
  if (JSON.stringify(asIdentityRows(identities.rows)) !== JSON.stringify(dataset.identities)) {
    throw new Error('FAIL_CLOSED: persisted historical identities differ from verified input');
  }
  const facts = await client.query(`
    SELECT f.racing_number, i.official_name, f.driver_id, f.lap_number, f.lap_time_seconds::text,
      f.leader_gap_seconds::text, f.official_deleted_lap, f.official_pit_marker, f.source_artifact_sha256
    FROM official_timing.lap_fact f
    JOIN official_timing.driver_identity i
      ON i.dataset_sha256 = f.dataset_sha256 AND i.racing_number = f.racing_number AND i.driver_id = f.driver_id
    WHERE f.dataset_sha256 = $1
    ORDER BY f.driver_id, f.lap_number
  `, [dataset.dataset_sha256]);
  if (JSON.stringify(asFactRows(facts.rows, dataset)) !== JSON.stringify(dataset.facts)) {
    throw new Error('FAIL_CLOSED: persisted historical facts differ from verified input');
  }
  const coverage = await client.query(`
    SELECT coverage_kind, expected_count, actual_count, missing_keys, unexpected_keys
    FROM official_timing.coverage
    WHERE dataset_sha256 = $1
    ORDER BY coverage_kind
  `, [dataset.dataset_sha256]);
  const coverageRows = coverage.rows.map(row => ({
    coverage_kind: String(row.coverage_kind),
    expected_count: Number(row.expected_count),
    actual_count: Number(row.actual_count),
    missing_keys: row.missing_keys as string[],
    unexpected_keys: row.unexpected_keys as string[]
  }));
  if (JSON.stringify(coverageRows) !== JSON.stringify(dataset.coverage)) {
    throw new Error('FAIL_CLOSED: persisted historical coverage differs from verified input');
  }
}

async function assertImmutabilityTriggers(client: Client): Promise<void> {
  const triggers = await client.query<{ relation_name: string; trigger_name: string; function_schema: string; function_name: string; trigger_type: number }>(`
    SELECT n.nspname || '.' || c.relname AS relation_name, t.tgname AS trigger_name,
      pn.nspname AS function_schema, p.proname AS function_name, t.tgtype::integer AS trigger_type
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = 'official_timing' AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    ORDER BY relation_name, trigger_name
  `);
  const childRelations = ['artifact', 'driver_identity', 'lap_fact', 'coverage'];
  const expected = ['dataset', ...childRelations].flatMap(relation => [
    `official_timing.${relation}/official_timing_immutable/official_timing.reject_mutation/27`,
    `official_timing.${relation}/official_timing_no_truncate/official_timing.reject_mutation/34`,
    ...(childRelations.includes(relation) ? [`official_timing.${relation}/official_timing_no_insert_after_seal/official_timing.reject_child_insert_after_seal/7`] : [])
  ]).sort();
  const actual = triggers.rows.map(row => `${row.relation_name}/${row.trigger_name}/${row.function_schema}.${row.function_name}/${Number(row.trigger_type)}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('FAIL_CLOSED: official timing immutability triggers are unavailable');
  }
}

// eslint-disable-next-line max-lines-per-function
export async function ingestHistoricalLapDataset(pool: QueryPool, dataset: HistoricalLapDataset): Promise<HistoricalLapIngestionResult> {
  assertVerifiedHistoricalLapDataset(dataset);
  const scope = dataset.facts[0];
  if (!scope || dataset.facts.some(fact => fact.season !== scope.season || fact.round !== scope.round ||
      fact.session_type !== scope.session_type || fact.event !== scope.event)) {
    throw new Error('FAIL_CLOSED: historical dataset contains mixed event scope');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    await client.query("SELECT set_config('lock_timeout', $1, true)", ['2000ms']);
    const relations = await client.query<{ relation: string | null }>(`
      SELECT to_regclass(name)::text AS relation
      FROM unnest($1::text[]) AS name
    `, [[
      'official_timing.dataset', 'official_timing.artifact', 'official_timing.driver_identity',
      'official_timing.lap_fact', 'official_timing.coverage'
    ]]);
    if (relations.rows.length !== 5 || relations.rows.some(row => !row.relation)) {
      throw new Error('FAIL_CLOSED: official timing migration is missing');
    }
    await assertImmutabilityTriggers(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${scope.season}/${scope.round}/${scope.session_type}`
    ]);
    const replay = await existingDatasetResult(client, dataset);
    if (replay) {
      await assertPersistentReadback(client, dataset);
      await client.query('COMMIT');
      return replay;
    }

    const artifactValues = dataset.artifacts.flatMap(artifact => [
      dataset.dataset_sha256, artifact.artifact_name, artifact.source_url, artifact.artifact_sha256, artifact.bytes
    ]);
    const artifactPlaceholders = dataset.artifacts.map((_, row) => `(${Array.from({ length: 5 }, (__, column) => `$${row * 5 + column + 1}`).join(', ')})`);
    await client.query(`INSERT INTO official_timing.artifact
      (dataset_sha256, artifact_name, source_url, artifact_sha256, bytes) VALUES ${artifactPlaceholders.join(', ')}`, artifactValues);

    const identityValues = dataset.identities.flatMap(identity => [
      dataset.dataset_sha256, identity.racing_number, identity.official_name, identity.driver_id,
      identity.canonical_full_name, identity.classified_laps
    ]);
    const identityPlaceholders = dataset.identities.map((_, row) => `(${Array.from({ length: 6 }, (__, column) => `$${row * 6 + column + 1}`).join(', ')})`);
    await client.query(`INSERT INTO official_timing.driver_identity
      (dataset_sha256, racing_number, official_name, driver_id, canonical_full_name, classified_laps)
      VALUES ${identityPlaceholders.join(', ')}`, identityValues);

    const factValues = dataset.facts.flatMap(fact => [
      dataset.dataset_sha256, fact.racing_number, fact.driver_id, fact.lap_number, fact.lap_time_seconds,
      fact.leader_gap_seconds, fact.official_deleted_lap, fact.official_pit_marker, fact.source_artifact_sha256
    ]);
    const factPlaceholders = dataset.facts.map((_, row) => `(${Array.from({ length: 9 }, (__, column) => `$${row * 9 + column + 1}`).join(', ')})`);
    await client.query(`INSERT INTO official_timing.lap_fact
      (dataset_sha256, racing_number, driver_id, lap_number, lap_time_seconds, leader_gap_seconds,
       official_deleted_lap, official_pit_marker, source_artifact_sha256)
      VALUES ${factPlaceholders.join(', ')}`, factValues);

    const coverageValues = dataset.coverage.flatMap(entry => [
      dataset.dataset_sha256, entry.coverage_kind, entry.expected_count, entry.actual_count,
      JSON.stringify(entry.missing_keys), JSON.stringify(entry.unexpected_keys)
    ]);
    const coveragePlaceholders = dataset.coverage.map((_, row) => `(${Array.from({ length: 6 }, (__, column) => `$${row * 6 + column + 1}`).join(', ')})`);
    await client.query(`INSERT INTO official_timing.coverage
      (dataset_sha256, coverage_kind, expected_count, actual_count, missing_keys, unexpected_keys)
      VALUES ${coveragePlaceholders.join(', ')}`, coverageValues);

    await assertPersistentReadback(client, dataset);
    await client.query(`INSERT INTO official_timing.dataset
      (dataset_sha256, contract_version, authority, season, round, session_type, event_name,
       source_manifest_sha256, identity_map_sha256, identity_fingerprint, fact_fingerprint, identity_count, fact_count)
      VALUES ($1, $2, 'FIA', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
      dataset.dataset_sha256, dataset.ingestion_contract, scope.season, scope.round, scope.session_type, scope.event,
      dataset.source_manifest_sha256, dataset.identity_map_sha256, dataset.identity_fingerprint, dataset.fact_fingerprint,
      dataset.identities.length, dataset.facts.length
    ]);
    await client.query('COMMIT');
    return {
      dataset_sha256: dataset.dataset_sha256,
      status: 'committed',
      identity_count: dataset.identities.length,
      fact_count: dataset.facts.length
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
