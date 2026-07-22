import { describe, expect, it } from 'vitest';
import { createPaceV2Manifest, generatePaceV2Manifest, parsePaceV2Manifest, reconcilePaceV2TrackId } from '../../src/etl/pace-v2-manifest';
import { processPaceV2RoundsFailFast } from '../../src/etl/pace-v2-writer-safety';
import { runPaceV2ManifestGenerator } from '../../scripts/generate-pace-v2-manifest';

describe('pace v2 approved-round manifest', () => {
  it('selects only stabilized calendar rounds with complete result sets', async () => {
    const calls: string[] = [];
    const manifest = await generatePaceV2Manifest({
      async query(sql) {
        calls.push(sql);
        return { rows: [{ season: 2026, round: 2, race_id: 12, track_id: 'shanghai', race_date: '2026-03-15', result_count: '20' }] };
      }
    }, 2026, new Date('2026-03-17T00:00:00Z'));
    expect(manifest.approved_rounds).toEqual([{ season: 2026, round: 2, race_id: 12, track_id: 'shanghai', race_date: '2026-03-15', result_count: 20 }]);
    expect(calls[0]).toContain("LOWER(rd.type) IN ('race', 'race_result')");
    expect(calls[0]).toContain('HAVING COUNT(rd.driver_id) >= 10');
  });

  it('rejects modified or duplicate approval input', () => {
    const manifest = createPaceV2Manifest(2026, [{ season: 2026, round: 1, race_id: 1, track_id: 'melbourne', race_date: '2026-03-08', result_count: 20 }], new Date());
    expect(parsePaceV2Manifest(manifest)).toEqual(manifest);
    expect(() => parsePaceV2Manifest({ ...manifest, approved_rounds: [...manifest.approved_rounds, manifest.approved_rounds[0]] })).toThrow('FAIL_CLOSED');
  });

  it('reconciles only the reviewed Australian source identity', () => {
    expect(reconcilePaceV2TrackId('australian_grand_prix')).toBe('melbourne');
    expect(reconcilePaceV2TrackId('albert_park')).toBe('albert_park');
    expect(reconcilePaceV2TrackId('unknown_source_track')).toBe('unknown_source_track');
  });

  it('emits canonical track IDs in a generated manifest', async () => {
    const manifest = await generatePaceV2Manifest({
      async query() {
        return { rows: [{ season: 2026, round: 1, race_id: 1, track_id: 'australian_grand_prix', race_date: '2026-03-08', result_count: '20' }] };
      }
    }, 2026, new Date('2026-03-10T00:00:00Z'));
    expect(manifest.approved_rounds[0].track_id).toBe('melbourne');
  });

  it('stops at the first writer failure and reports remaining approved rounds', async () => {
    const attempted: number[] = [];
    const result = await processPaceV2RoundsFailFast([1, 2, 3], async (round) => {
      attempted.push(round);
      return { status: round === 1 ? 'failed' as const : 'success' as const };
    });
    expect(attempted).toEqual([1]);
    expect(result.failure?.round).toBe(1);
    expect(result.unprocessed).toEqual([2, 3]);
  });

  it('stops on a thrown writer error and reports remaining approved rounds', async () => {
    const attempted: number[] = [];
    const result = await processPaceV2RoundsFailFast([1, 2, 3], async (round) => {
      attempted.push(round);
      if (round === 1) throw new Error('immutable audit mismatch');
      return { status: 'success' as const };
    });
    expect(attempted).toEqual([1]);
    expect(String(result.failure?.error)).toContain('immutable audit mismatch');
    expect(result.unprocessed).toEqual([2, 3]);
  });

  it('runs the generator in one read-only transaction', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) { calls.push(sql); return sql.includes('SELECT r.year') ? { rows: [] } : { rows: [] }; }, release() {} }; } } as any;
    await runPaceV2ManifestGenerator(pool, 2026, new Date());
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.slice(2, -1).every((sql) => /^(SELECT|WITH)\b/i.test(sql.trim()))).toBe(true);
  });
});
