import { describe, expect, it } from 'vitest';
import { createPaceV2Expansion2025Manifest, parsePaceV2Expansion2025Manifest } from '../../src/etl/pace-v2-2025-expansion-manifest';
import { PaceV22025ExpansionPreparationError, paceV22025ExpansionPreparationRefusal, preparePaceV22025Expansion } from '../../scripts/prepare-pace-v2-2025-expansion';

const candidate = {
  round: 1,
  race_id: 202501,
  track_id: 'melbourne',
  race_date: '2025-03-16',
  canonical_starter_count: 20,
  canonical_starter_fingerprint: 'a'.repeat(64),
  existing_v2_fact_count: 0,
  existing_manifest_audit_count: 0
};

describe('2025 pace v2 expansion preparation', () => {
  it('binds a zero-coverage pilot to canonical starter evidence and external review', () => {
    const manifest = createPaceV2Expansion2025Manifest(candidate);
    expect(parsePaceV2Expansion2025Manifest(manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({ season: 2025, session_type: 'R', pilot_status: 'requires_external_source_review' });
    expect(() => createPaceV2Expansion2025Manifest({ ...candidate, existing_v2_fact_count: 1 })).toThrow('FAIL_CLOSED');
    expect(() => parsePaceV2Expansion2025Manifest({ ...manifest, pilot: { ...manifest.pilot, round: 2 } })).toThrow('FAIL_CLOSED');
  });

  it('uses one timeout-bound read-only transaction and chooses only an empty audited round', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (sql.includes('to_regclass')) return { rows: [{ relation: String(params?.[0]) }] };
            if (sql.includes('FROM pg_trigger')) return { rows: [{ immutable: true }] };
            if (sql.includes('FROM race r')) return { rows: [{ ...candidate, canonical_driver_ids: Array.from({ length: 10 }, (_, index) => `driver_${index}`) }] };
            return { rows: [] };
          },
          release() {}
        };
      },
      async end() {}
    };
    const manifest = await preparePaceV22025Expansion(pool, new Date('2025-03-20T00:00:00Z'));
    expect(manifest.pilot).toMatchObject({ round: 1, canonical_starter_count: 10, existing_v2_fact_count: 0, existing_manifest_audit_count: 0 });
    expect(calls[0]).toEqual({ sql: 'BEGIN READ ONLY', params: undefined });
    expect(calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", params: ['5000ms'] });
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
    expect(calls.slice(2, -1).every((call) => /^(SELECT|WITH)\b/i.test(call.sql.trim()))).toBe(true);
    expect(calls.slice(2, -1).every((call) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY)\b/i.test(call.sql))).toBe(true);
    expect(calls.find((call) => call.sql.includes('FROM race r'))?.sql).toContain("UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')");
  });

  it('refuses when no zero-coverage pilot or immutable audit contract is available', async () => {
    const unavailable = {
      async connect() {
        return { async query(sql: string) {
          if (sql.includes('to_regclass')) return { rows: [{ relation: null }] };
          return { rows: [] };
        }, release() {} };
      },
      async end() {}
    };
    await expect(preparePaceV22025Expansion(unavailable)).rejects.toMatchObject({ code: 'required_contract_relation_missing' });
    expect(paceV22025ExpansionPreparationRefusal(new PaceV22025ExpansionPreparationError('no_safe_pilot_candidate'))).toEqual({ status: 'refused', error: 'no_safe_pilot_candidate' });
  });
});
