import { describe, expect, it } from 'vitest';
import { createPaceV2AuditReconciliationManifest, parsePaceV2AuditReconciliationManifest } from '../../src/etl/pace-v2-audit-reconciliation';
import { fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { requirePaceV2AuditReconciliationConfiguration, runPaceV2AuditReconciliation } from '../../scripts/reconcile-pace-v2-audit';

const facts = [{ season: 2026, round: 2, track_id: 'shanghai', driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 91.234, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: 'SOFT', tyre_age_laps: 1, methodology_version: 'clean_air_gap_2_0s_v1' }];
const current = fingerprintPaceV2FactRows(facts);
const manifest = createPaceV2AuditReconciliationManifest({ season: 2026, round: 2, session_type: 'R', methodology_version: 'clean_air_gap_2_0s_v1', fact_row_count: 1, original_manifest_fact_fingerprint: 'a'.repeat(64), current_fact_fingerprint: current });

function mockPool(originalFingerprint = manifest.original_manifest_fact_fingerprint) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return { calls, pool: { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_round_audit_reconciliation' }] }; if (sql.includes('FROM pg_trigger')) return { rows: [{ immutable: true }] }; if (sql.includes('SELECT 1 FROM pace_v2_round_audit_reconciliation')) return { rows: [] }; if (sql.includes('FROM pace_v2_round_audit WHERE')) return { rows: [{ session_type: 'R', fact_fingerprint: originalFingerprint, fact_row_count: 1, methodology_version: 'clean_air_gap_2_0s_v1' }] }; if (sql.includes('FROM laps_normalized_v2')) return { rows: facts }; return { rows: [] }; }, release() {} }; }, async end() {} } };
}

describe('pace v2 audit reconciliation', () => {
  it('requires explicit primary-only flags and an untampered fingerprint-only manifest', () => {
    expect(() => requirePaceV2AuditReconciliationConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_AUDIT_RECONCILIATION_ENABLED');
    expect(() => requirePaceV2AuditReconciliationConfiguration({ PACE_V2_AUDIT_RECONCILIATION_ENABLED: 'true', DATABASE_URL: 'postgres://db.example/f1' })).toThrow('TARGET=primary');
    expect(() => parsePaceV2AuditReconciliationManifest({ ...manifest, current_fact_fingerprint: manifest.original_manifest_fact_fingerprint, manifest_fingerprint: manifest.manifest_fingerprint })).toThrow('mismatch');
  });

  it('inserts immutable evidence without updating facts or the original audit', async () => {
    const { pool, calls } = mockPool();
    await expect(runPaceV2AuditReconciliation(pool, manifest)).resolves.toMatchObject({ reconciled_row_count: 1 });
    expect(calls[0].sql).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO pace_v2_round_audit_reconciliation'))).toBe(true);
    expect(calls.some((call) => /UPDATE laps_normalized_v2|UPDATE pace_v2_round_audit\b/.test(call.sql))).toBe(false);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });

  it('refuses evidence when the original audit has any non-approved mismatch', async () => {
    const { pool, calls } = mockPool('b'.repeat(64));
    await expect(runPaceV2AuditReconciliation(pool, manifest)).rejects.toThrow('approved fingerprint mismatch class');
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO pace_v2_round_audit_reconciliation'))).toBe(false);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });
});
