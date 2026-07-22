import { describe, expect, it } from 'vitest';
import { fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { generatePaceV2AuditReconciliationManifest, requirePaceV2AuditReconciliationManifestConfiguration } from '../../scripts/generate-pace-v2-audit-reconciliation-manifest';

const facts = [{ season: 2026, round: 2, track_id: 'shanghai', driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 91.234, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: 'SOFT', tyre_age_laps: 1, methodology_version: 'clean_air_gap_2_0s_v1' }];

function mockPool(audit = { session_type: 'R', fact_fingerprint: 'a'.repeat(64), fact_row_count: 1, methodology_version: 'clean_air_gap_2_0s_v1' }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return { calls, pool: { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); if (sql.includes('FROM pace_v2_round_audit')) return { rows: [audit] }; if (sql.includes('FROM laps_normalized_v2')) return { rows: facts }; return { rows: [] }; }, release() {} }; }, async end() {} } };
}

describe('pace v2 audit reconciliation manifest generator', () => {
  it('requires dual production flags and rejects loopback', () => {
    expect(() => requirePaceV2AuditReconciliationManifestConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('MANIFEST_ENABLED');
    expect(() => requirePaceV2AuditReconciliationManifestConfiguration({ PACE_V2_AUDIT_RECONCILIATION_MANIFEST_ENABLED: 'true', PACE_V2_AUDIT_RECONCILIATION_MANIFEST_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('observes one exact fingerprint-only mismatch in a read-only rolled-back transaction', async () => {
    const { pool, calls } = mockPool();
    const manifest = await generatePaceV2AuditReconciliationManifest(pool, 2026, 2);
    expect(manifest.current_fact_fingerprint).toBe(fingerprintPaceV2FactRows(facts));
    expect(calls[0].sql).toBe('BEGIN READ ONLY');
    expect(calls.slice(2, -1).every((call) => /^SELECT\b/i.test(call.sql.trim()))).toBe(true);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('refuses a count or methodology mismatch instead of broadening the evidence class', async () => {
    const { pool } = mockPool({ session_type: 'R', fact_fingerprint: 'a'.repeat(64), fact_row_count: 2, methodology_version: 'clean_air_gap_2_0s_v1' });
    await expect(generatePaceV2AuditReconciliationManifest(pool, 2026, 2)).rejects.toThrow('approved fingerprint mismatch class');
  });
});
