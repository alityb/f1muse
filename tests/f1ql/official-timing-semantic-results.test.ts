import { createHash } from 'node:crypto';
import fs from 'fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitOfficialTimingSemanticResults, OFFICIAL_TIMING_SEMANTIC_RESULTS_EMITTER } from '../../scripts/snapshot-official-timing-semantic-results';
import { prepareOfficialTimingTestDatabase } from '../../scripts/prepare-official-timing-test-db';
import { getTestDatabaseUrl } from '../../src/test/setup';

const FIXTURE_PATH = 'tests/fixtures/f1ql-official-timing-semantic-results.json';
const LEGACY_EVENT_MEAN_ORACLE = 'data/phase9-belgium-2022-event-mean-result.json';
const LEGACY_WINDOW_MEDIAN_ORACLE = 'data/phase8-belgium-2022-f1ql-result.json';

let pool: Pool | undefined;
let answerPool: Pool | undefined;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await prepareOfficialTimingTestDatabase(pool);
  answerPool = new Pool({ connectionString: getTestDatabaseUrl(), options: '-c role=f1ql_answer', max: 1 });
});

afterAll(async () => {
  await answerPool?.end();
  if (pool) {
    await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
    await pool.query('DROP TABLE IF EXISTS driver_aliases');
    await pool.end();
  }
});

describe('official timing semantic v32 emitted results', () => {
  it('regenerates the committed fixture byte-exactly from the real emitter over the real sealed view', async () => {
    const committed = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const regenerated = {
      emitter: OFFICIAL_TIMING_SEMANTIC_RESULTS_EMITTER,
      generated_at: null,
      results: await emitOfficialTimingSemanticResults(answerPool as Pool)
    };
    expect(`${JSON.stringify(regenerated, null, 2)}\n`).toBe(committed);
    expect(createHash('sha256').update(committed).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the legacy regression oracle values exactly at scale 4', async () => {
    const results = (JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as any).results;
    const meanEnvelope = results.find((result: any) => result.id === 'official_event_mean_verstappen_alonso').envelope;
    const legacyMean = JSON.parse(fs.readFileSync(LEGACY_EVENT_MEAN_ORACLE, 'utf8'));
    const legacyRow = legacyMean.rows[0];
    const semanticRow = meanEnvelope.rows[0];
    expect(semanticRow.driver_a_mean_lap_time_seconds).toBe(legacyRow.driver_a_mean_lap_time_seconds.toFixed(4));
    expect(semanticRow.driver_b_mean_lap_time_seconds).toBe(legacyRow.driver_b_mean_lap_time_seconds.toFixed(4));
    expect(semanticRow.mean_delta_seconds).toBe(legacyRow.mean_delta_seconds.toFixed(4));
    expect(semanticRow.winner_driver_id).toBe(legacyRow.winner_driver_id);
    expect(semanticRow.driver_a_eligible_laps).toBe(legacyRow.driver_a_eligible_laps);
    expect(semanticRow.driver_b_eligible_laps).toBe(legacyRow.driver_b_eligible_laps);
    expect(semanticRow.driver_a_completed_laps).toBe(legacyRow.driver_a_completed_laps);
    expect(semanticRow.driver_a_excluded_pit_marker_laps).toBe(legacyRow.driver_a_excluded_pit_marker_laps);
    expect(semanticRow.dataset_sha256).toBe(legacyRow.dataset_sha256);
    expect(meanEnvelope.mode).toBe('proven_semantic_result');
    expect(meanEnvelope.format_version).toBe('semantic-result-format-v32');

    const medianEnvelope = results.find((result: any) => result.id === 'official_window_median_verstappen_alonso_laps_3_10').envelope;
    const legacyMedian = JSON.parse(fs.readFileSync(LEGACY_WINDOW_MEDIAN_ORACLE, 'utf8'));
    const legacyMedianRow = legacyMedian.rows[0];
    const semanticMedianRow = medianEnvelope.rows[0];
    expect(semanticMedianRow.driver_a_median_lap_time_seconds).toBe(legacyMedianRow.driver_a_median_lap_time_seconds.toFixed(4));
    expect(semanticMedianRow.driver_b_median_lap_time_seconds).toBe(legacyMedianRow.driver_b_median_lap_time_seconds.toFixed(4));
    expect(semanticMedianRow.median_delta_seconds).toBe(legacyMedianRow.median_delta_seconds.toFixed(4));
    expect(semanticMedianRow.winner_driver_id).toBe(legacyMedianRow.winner_driver_id);
    expect(semanticMedianRow.requested_laps_per_driver).toBe(legacyMedianRow.requested_laps_per_driver);
  });
});
