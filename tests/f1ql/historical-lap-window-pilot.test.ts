import { createHash } from 'crypto';
import fs from 'fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareHistoricalLapWindow,
  summarizeHistoricalLapWindowFacts,
  type HistoricalLapDataset,
  HISTORICAL_LAP_WINDOW_METRIC_ID,
  loadHistoricalLapPilot,
} from '../../src/etl/historical-lap-window-pilot';
import { emitHistoricalLapWindowPilot } from '../../scripts/snapshot-phase8-belgium-2022-window';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
const canonicalDrivers = [
  { driver_id: 'max_verstappen', full_name: 'Max Verstappen' },
  { driver_id: 'fernando_alonso', full_name: 'Fernando Alonso' }
];
let database: Pool;

function dataset(): HistoricalLapDataset {
  return loadHistoricalLapPilot(sourceContent, identityContent, canonicalDrivers);
}

function frozenDataset(facts: HistoricalLapDataset['facts']): HistoricalLapDataset {
  const frozenFacts = facts.map(fact => Object.freeze({ ...fact }));
  return Object.freeze({ version: 1, ingestion_contract: 'immutable_official_lap_pilot_v1', facts: Object.freeze(frozenFacts) });
}

beforeAll(async () => {
  database = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(database);
});

afterAll(async () => {
  await database.end();
});

describe('Phase 8 immutable historical lap-window pilot', () => {
  it('binds official rows to exact canonical identities as deeply frozen facts', () => {
    const loaded = dataset();
    expect(loaded.facts).toHaveLength(16);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.facts)).toBe(true);
    expect(loaded.facts.every(Object.isFrozen)).toBe(true);
    expect(new Set(loaded.facts.map(fact => fact.driver_id))).toEqual(new Set(['max_verstappen', 'fernando_alonso']));
  });

  it('fails closed for altered provenance or unresolved canonical identity', () => {
    expect(() => loadHistoricalLapPilot(Buffer.from(sourceContent.toString('utf8').replace('113.951', '113.952')), identityContent, canonicalDrivers)).toThrow('source-manifest hash mismatch');
    expect(() => loadHistoricalLapPilot(sourceContent, identityContent, canonicalDrivers.slice(0, 1))).toThrow('canonical identity coverage is incomplete');
    expect(() => loadHistoricalLapPilot(sourceContent, identityContent, [
      canonicalDrivers[0],
      { driver_id: 'fernando_alonso', full_name: 'Fernando Alonso Jr' }
    ])).toThrow('canonical identity mismatch');
  });

  it('computes the named complete-window metric without inventing context filters', () => {
    const result = compareHistoricalLapWindow(dataset(), {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 3,
      lap_end: 10
    });
    expect(result.metric.id).toBe(HISTORICAL_LAP_WINDOW_METRIC_ID);
    expect(result.metric.safety_car_weather_and_other_context).toBe('included_not_inferred');
    expect(result.drivers).toEqual([
      expect.objectContaining({ driver_id: 'max_verstappen', eligible_laps: 8, median_lap_time_seconds: 113.8495 }),
      expect.objectContaining({ driver_id: 'fernando_alonso', eligible_laps: 8, median_lap_time_seconds: 115.183 })
    ]);
    expect(result.winner_driver_id).toBe('max_verstappen');
    expect(result.median_delta_seconds).toBe(1.3335);
    expect(result.f1ql_operation).toBe('unsupported');
  });

  it('excludes only official deleted/PIT rows and refuses incomplete windows', () => {
    const loaded = dataset();
    const marked = frozenDataset(loaded.facts.map(fact => ({
      ...fact,
      official_deleted_lap: fact.lap_number === 3,
      official_pit_marker: fact.lap_number === 4
    })));
    const result = summarizeHistoricalLapWindowFacts(marked.facts, {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 3,
      lap_end: 10
    });
    expect(result.every(driver => driver.eligible_laps === 6 && driver.excluded_deleted_laps === 1 && driver.excluded_pit_marker_laps === 1)).toBe(true);
    expect(result).not.toHaveProperty('provenance');

    const incomplete = frozenDataset(loaded.facts.filter(fact => !(fact.driver_id === 'max_verstappen' && fact.lap_number === 5)));
    expect(() => summarizeHistoricalLapWindowFacts(incomplete.facts, {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 3,
      lap_end: 10
    })).toThrow('incomplete historical lap window for max_verstappen');
    expect(() => summarizeHistoricalLapWindowFacts(loaded.facts, {
      driver_ids: ['max_verstappen', 'fernando_alonso', 'max_verstappen'] as any,
      lap_start: 3,
      lap_end: 10
    })).toThrow('requires the two reviewed pilot drivers');
  });

  it('rejects temporary emission before SQL when the localhost target is not exact', async () => {
    await expect(emitHistoricalLapWindowPilot('postgresql://example.invalid/f1muse_test', sourceContent, identityContent)).rejects.toThrow('exact disposable localhost');
  });

  it('reruns the real localhost emitter through verified temporary rows', async () => {
    const emitted = await emitHistoricalLapWindowPilot(getTestDatabaseUrl(), sourceContent, identityContent);
    expect(emitted).toEqual(JSON.parse(fs.readFileSync('data/phase8-belgium-2022-window-result.json', 'utf8')));
    const persistent = await database.query<{ relation: string | null }>("SELECT to_regclass('public.phase8_historical_lap_pilot')::text AS relation");
    expect(persistent.rows).toEqual([{ relation: null }]);
  });

  it('retains the exact nonempty localhost emitter result', () => {
    const content = fs.readFileSync('data/phase8-belgium-2022-window-result.json');
    expect(createHash('sha256').update(content).digest('hex')).toBe('f7375690dfa95f4f159c65ad6c4ae025298d7c2cf2231478c5de9a8a40f1064b');
    const fixture = JSON.parse(content.toString('utf8')) as {
      emitter: string;
      staged_fact_count: number;
      comparison: { metric: { id: string }; winner_driver_id: string; f1ql_operation: string };
    };
    expect(fixture).toEqual(expect.objectContaining({
      emitter: 'localhost_temporary_historical_lap_pilot_v1',
      staged_fact_count: 16,
      comparison: expect.objectContaining({
        metric: expect.objectContaining({ id: HISTORICAL_LAP_WINDOW_METRIC_ID }),
        winner_driver_id: 'max_verstappen',
        f1ql_operation: 'unsupported'
      })
    }));
  });
});
