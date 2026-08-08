import fs from 'fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareOfficialTimingTestDatabase } from '../../scripts/prepare-official-timing-test-db';
import { emitOfficialTimingSemanticResults } from '../../scripts/snapshot-official-timing-semantic-results';
import { OFFICIAL_TIMING_BENCHMARK_EMITTER } from '../../scripts/benchmark-official-timing';
import { executeF1QL } from '../../src/f1ql/executor';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from '../../src/f1ql/official-event-mean';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from '../../src/f1ql/official-lap-window';
import { getTestDatabaseUrl } from '../../src/test/setup';

let pool: Pool | undefined;
let answerPool: Pool | undefined;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await prepareOfficialTimingTestDatabase(pool);
  answerPool = new Pool({ connectionString: getTestDatabaseUrl(), options: '-c role=f1ql_answer', max: 2 });
});

afterAll(async () => {
  await answerPool?.end();
  if (pool) {
    await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
    await pool.query('DROP TABLE IF EXISTS driver_aliases');
    await pool.end();
  }
});

describe('planned compiler v3 reference parity', () => {
  it('matches the legacy reference implementation on the certified event mean', async () => {
    const legacy = await executeF1QL(pool as Pool, {
      version: 1,
      root: {
        op: 'official_event_mean_compare',
        metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso'
      }
    }, { maxRows: 1 });
    expect(legacy.rows).toHaveLength(1);
    const legacyRow = legacy.rows[0] as Record<string, number | string | null>;
    const emitted = await emitOfficialTimingSemanticResults(answerPool as Pool);
    const semanticRow = emitted.find(result => result.id === 'official_event_mean_verstappen_alonso')!.envelope.rows[0];
    expect(semanticRow.driver_a_mean_lap_time_seconds).toBe(Number(legacyRow.driver_a_mean_lap_time_seconds).toFixed(4));
    expect(semanticRow.driver_b_mean_lap_time_seconds).toBe(Number(legacyRow.driver_b_mean_lap_time_seconds).toFixed(4));
    expect(semanticRow.mean_delta_seconds).toBe(Number(legacyRow.mean_delta_seconds).toFixed(4));
    expect(semanticRow.winner_driver_id).toBe(legacyRow.winner_driver_id);
    expect(semanticRow.driver_a_eligible_laps).toBe(legacyRow.driver_a_eligible_laps);
    expect(semanticRow.driver_b_eligible_laps).toBe(legacyRow.driver_b_eligible_laps);
    expect(semanticRow.driver_a_completed_laps).toBe(legacyRow.driver_a_completed_laps);
    expect(semanticRow.driver_a_excluded_pit_marker_laps).toBe(legacyRow.driver_a_excluded_pit_marker_laps);
    expect(semanticRow.dataset_sha256).toBe(legacyRow.dataset_sha256);
  });

  it('matches the legacy reference implementation on the certified window median', async () => {
    const legacy = await executeF1QL(pool as Pool, {
      version: 1,
      root: {
        op: 'official_lap_window_median_compare',
        metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso',
        lap_start: 3,
        lap_end: 10
      }
    }, { maxRows: 1 });
    expect(legacy.rows).toHaveLength(1);
    const legacyRow = legacy.rows[0] as Record<string, number | string | null>;
    const emitted = await emitOfficialTimingSemanticResults(answerPool as Pool);
    const semanticRow = emitted.find(result => result.id === 'official_window_median_verstappen_alonso_laps_3_10')!.envelope.rows[0];
    expect(semanticRow.driver_a_median_lap_time_seconds).toBe(Number(legacyRow.driver_a_median_lap_time_seconds).toFixed(4));
    expect(semanticRow.driver_b_median_lap_time_seconds).toBe(Number(legacyRow.driver_b_median_lap_time_seconds).toFixed(4));
    expect(semanticRow.median_delta_seconds).toBe(Number(legacyRow.median_delta_seconds).toFixed(4));
    expect(semanticRow.winner_driver_id).toBe(legacyRow.winner_driver_id);
    expect(semanticRow.requested_laps_per_driver).toBe(legacyRow.requested_laps_per_driver);
    expect(semanticRow.driver_a_eligible_laps).toBe(legacyRow.driver_a_eligible_laps);
  });
});

describe('official timing worst-case benchmark artifact', () => {
  it('is a bounded sealed-scale measurement emitted by the real collector', () => {
    const artifact = JSON.parse(fs.readFileSync('tests/fixtures/wp12-official-timing-benchmark.json', 'utf8'));
    expect(artifact.emitter).toBe(OFFICIAL_TIMING_BENCHMARK_EMITTER);
    expect(artifact.target).toBe('localhost_disposable_docker');
    expect(artifact.sealed_fact_count).toBe(790);
    expect(artifact.iterations_per_statement).toBe(25);
    expect(artifact.statements.map((statement: { statement_id: string }) => statement.statement_id)).toEqual([
      'official_event_coverage_v1', 'official_event_mean_v3', 'official_window_median_v3'
    ]);
    for (const statement of artifact.statements) {
      expect(statement.iterations).toBe(25);
      // Every measurement must stay far below the sealed 2000ms statement timeout.
      expect(statement.max_ms).toBeGreaterThan(0);
      expect(statement.max_ms).toBeLessThan(2000);
      expect(statement.p50_ms).toBeLessThanOrEqual(statement.p95_ms);
      expect(statement.p95_ms).toBeLessThanOrEqual(statement.max_ms);
    }
  });
});
