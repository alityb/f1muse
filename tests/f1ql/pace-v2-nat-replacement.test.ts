import { describe, expect, it } from 'vitest';
import { createPaceV2NatReplacementManifest, fingerprintPaceV2FactRows, parsePaceV2NatReplacementArtifact, parsePaceV2NatReplacementManifest, PACE_V2_NAT_REPLACEMENT_ROUNDS } from '../../src/etl/pace-v2-nat-replacement';
import { parseReplacementJson, replacementRefusalReason, requirePaceV2NatReplacementConfiguration, runPaceV2NatReplacement } from '../../scripts/replace-pace-v2-nat-pit-flags';
import { assertPaceV2NatTemporaryOutput, generatePaceV2NatCorrectedFacts, parsePaceV2NatSourceMap } from '../../scripts/generate-pace-v2-nat-corrected-facts';

const facts = PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => ({ season: 2026, round, track_id: `track_${round}`, driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 90, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: null, tyre_age_laps: null, methodology_version: 'clean_air_gap_2_0s_v1' }));
const manifest = createPaceV2NatReplacementManifest(PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => ({ round, fact_row_count: 1, original_fact_fingerprint: `${round}`.padStart(64, 'a') })));

describe('NaT pace replacement contract', () => {
  it('accepts only the complete reviewed scope and explicit primary flags', () => {
    expect(() => requirePaceV2NatReplacementConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_NAT_REPLACEMENT_ENABLED');
    expect(() => parsePaceV2NatReplacementManifest({ ...manifest, rounds: manifest.rounds.slice(0, -1) })).toThrow('reviewed poisoned rounds');
    expect(() => parsePaceV2NatReplacementArtifact({ version: 1, replacement_version: 'nat_pit_flags_v1', methodology_version: 'clean_air_gap_2_0s_v1', facts: facts.slice(0, -1) })).toThrow('missing reviewed-round facts');
  });

  it('rejects npm-polluted evidence with a diagnosable JSON reason', () => {
    expect(() => parseReplacementJson('> f1muse-api@1.0.0 generate\n{"version":1}', 'manifest')).toThrow('replacement manifest JSON is invalid');
    try {
      parseReplacementJson('not-json', 'facts');
    } catch (error) {
      expect(replacementRefusalReason(error)).toBe('replacement_facts_json_invalid');
    }
  });

  it('does not mislabel configuration or database failures as preflight refusals', () => {
    expect(replacementRefusalReason(new Error('Set PACE_V2_NAT_REPLACEMENT_ENABLED=true to write replacement facts.'))).toBe('replacement_not_explicitly_enabled');
    expect(replacementRefusalReason(Object.assign(new Error('permission denied'), { code: '42501' }))).toBe('replacement_permission_denied');
    expect(replacementRefusalReason(new Error('unexpected failure'))).toBe('replacement_runtime_failure');
  });

  it('generates only manifest rounds from fixed FastF1 pit flags and validates counts', () => {
    const manifest = createPaceV2NatReplacementManifest(PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => ({ round, fact_row_count: 10, original_fact_fingerprint: `${round}`.padStart(64, 'a') })));
    const source = parsePaceV2NatSourceMap({ version: 1, source: 'approved_fastf1_identity_map', season: 2026, rounds: PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => ({ round, track_id: `track_${round}`, driver_ids: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`D${`${index}`.padStart(2, '0')}`, `driver_${index}`])) })) });
    const artifact = generatePaceV2NatCorrectedFacts(manifest, source, (season, round) => ({
      season, round, session_name: 'Race', event_name: `Round ${round}`, session_uid: `${round}`, columns_present: { Driver: true, LapNumber: true, LapTime: true, Time: true, IsAccurate: true, PitInTime: true, PitOutTime: true, Compound: true, TyreLife: true, Position: true, GapToLeader: true },
      laps: Array.from({ length: 10 }, (_, index) => ({ driver_code: `D${`${index}`.padStart(2, '0')}`, lap_number: 1, lap_time_seconds: 90 + index, lap_end_time_seconds: 90 + index, is_accurate: true, pit_in: false, pit_out: false, compound: 'MEDIUM', tyre_life: 1, position: index + 1, gap_to_leader: index * 2 }))
    }));
    expect(artifact.facts).toHaveLength(90);
    expect(artifact.facts.every((fact) => !fact.is_pit_lap && !fact.is_in_lap && !fact.is_out_lap)).toBe(true);
    expect(() => assertPaceV2NatTemporaryOutput('facts.json')).toThrow('absolute temporary path');
  });

  it('inserts replacement facts and immutable approval without updating originals', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const poisoned = facts.map((row) => ({ ...row, is_pit_lap: true, is_in_lap: true, is_out_lap: true }));
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_lap_replacement' }, { relation: 'pace_v2_replacement_audit' }] }; if (sql.includes('COUNT(*) = 3')) return { rows: [{ enabled: true }] }; if (sql.includes('FROM laps_normalized_v2')) { const round = Number(params?.[1]); return { rows: poisoned.filter((row) => row.round === round) }; } if (sql.includes('SELECT 1 FROM pace_v2_replacement_audit')) return { rows: [] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    const artifact = parsePaceV2NatReplacementArtifact({ version: 1, replacement_version: 'nat_pit_flags_v1', methodology_version: 'clean_air_gap_2_0s_v1', facts });
    const correctedManifest = createPaceV2NatReplacementManifest(POISONED_ROUNDS_WITH_FINGERPRINTS(poisoned));
    await expect(runPaceV2NatReplacement(pool, correctedManifest, artifact)).resolves.toMatchObject({ replaced_rounds: 9 });
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO pace_v2_lap_replacement'))).toBe(true);
    expect(calls.some((call) => /UPDATE laps_normalized_v2|DELETE FROM laps_normalized_v2/.test(call.sql))).toBe(false);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });
});

function POISONED_ROUNDS_WITH_FINGERPRINTS(rows: typeof facts) {
  return PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => ({ round, fact_row_count: 1, original_fact_fingerprint: fingerprintPaceV2FactRows(rows.filter((row) => row.round === round)) }));
}
