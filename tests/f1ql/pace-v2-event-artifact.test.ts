import { describe, expect, it } from 'vitest';
import { requirePaceV2EventArtifactConfiguration, runPaceV2EventArtifact } from '../../scripts/validate-pace-v2-event-artifact';

describe('pace v2 event artifact', () => {
  it('requires explicit production flags and rejects loopback', () => {
    expect(() => requirePaceV2EventArtifactConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_EVENT_ARTIFACT_ENABLED');
    expect(() => requirePaceV2EventArtifactConfiguration({ PACE_V2_EVENT_ARTIFACT_ENABLED: 'true', PACE_V2_EVENT_ARTIFACT_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('emits bounded database observations without claiming external truth', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) { calls.push(sql); if (sql.includes('percentile_cont')) return { rows: [{ track_id: 'melbourne', driver_id: 'driver_one', eligible_laps: '3', median_lap_time_seconds: '91.234' }] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    const artifact = await runPaceV2EventArtifact(pool, 2026, 1);
    expect(artifact).toMatchObject({ status: 'observed', assertion_scope: 'database_observation_only', external_truth: 'unverified_without_authoritative_artifact', observations: [{ track_id: 'melbourne', eligible_laps: 3 }] });
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls.at(-1)).toBe('ROLLBACK');
  });
});
