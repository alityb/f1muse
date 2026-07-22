import { createHash } from 'crypto';
import { PACE_V2_APPROVED_TRACK_ID_RECONCILIATION } from './pace-v2-manifest';

export const PACE_V2_IDENTITY_REPAIR_VERSION = 1;
export const PACE_V2_IDENTITY_REPAIR_METHOD = 'track_identity_exact_alias_v1';
export const PACE_V2_IDENTITY_REPAIR_SEASON = 2026;
export const PACE_V2_IDENTITY_REPAIR_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

export interface PaceV2IdentityRepairManifest {
  version: number;
  repair: 'pace_v2_track_identity';
  season: number;
  round: number;
  session_type: 'R';
  methodology_version: string;
  from_track_id: string;
  to_track_id: string;
  fact_row_count: number;
  source_fact_fingerprint: string;
  target_fact_fingerprint: string;
  manifest_fingerprint: string;
}

export interface PaceV2FactRow {
  season: number;
  round: number;
  track_id: string;
  driver_id: string;
  session_type: string;
  lap_number: number;
  stint_id: number;
  stint_lap_index: number;
  lap_time_seconds: number | null;
  is_valid_lap: boolean;
  is_pit_lap: boolean;
  is_out_lap: boolean;
  is_in_lap: boolean;
  clean_air_flag: boolean;
  compound: string | null;
  tyre_age_laps: number | null;
  methodology_version: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintPaceV2FactRows(rows: PaceV2FactRow[]): string {
  const normalized = rows.map((row) => [
    row.season, row.round, row.track_id, row.driver_id, row.session_type, row.lap_number,
    row.stint_id, row.stint_lap_index, row.lap_time_seconds === null ? null : Number(row.lap_time_seconds).toFixed(3),
    row.is_valid_lap, row.is_pit_lap, row.is_out_lap, row.is_in_lap, row.clean_air_flag,
    row.compound, row.tyre_age_laps, row.methodology_version
  ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256(JSON.stringify(normalized));
}

export function parsePaceV2IdentityRepairManifest(input: unknown): PaceV2IdentityRepairManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('FAIL_CLOSED: repair manifest must be an object');
  }
  const manifest = input as Partial<PaceV2IdentityRepairManifest>;
  if (manifest.version !== PACE_V2_IDENTITY_REPAIR_VERSION || manifest.repair !== 'pace_v2_track_identity' ||
      manifest.season !== PACE_V2_IDENTITY_REPAIR_SEASON || !Number.isInteger(manifest.round) || manifest.round !== 1 ||
      manifest.session_type !== 'R' || manifest.methodology_version !== PACE_V2_IDENTITY_REPAIR_METHODOLOGY_VERSION ||
      typeof manifest.from_track_id !== 'string' || typeof manifest.to_track_id !== 'string' ||
      typeof manifest.fact_row_count !== 'number' || !Number.isInteger(manifest.fact_row_count) || manifest.fact_row_count < 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.source_fact_fingerprint ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.target_fact_fingerprint ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.manifest_fingerprint ?? '')) {
    throw new Error('FAIL_CLOSED: repair manifest has an unsupported shape');
  }
  if (PACE_V2_APPROVED_TRACK_ID_RECONCILIATION[manifest.from_track_id] !== manifest.to_track_id) {
    throw new Error('FAIL_CLOSED: repair manifest alias is not exactly approved');
  }
  const validated = manifest as PaceV2IdentityRepairManifest;
  const stable = {
    version: validated.version, repair: validated.repair, season: validated.season, round: validated.round,
    session_type: validated.session_type, methodology_version: validated.methodology_version,
    from_track_id: validated.from_track_id, to_track_id: validated.to_track_id, fact_row_count: validated.fact_row_count,
    source_fact_fingerprint: validated.source_fact_fingerprint, target_fact_fingerprint: validated.target_fact_fingerprint
  };
  if (sha256(JSON.stringify(stable)) !== validated.manifest_fingerprint) {
    throw new Error('FAIL_CLOSED: repair manifest fingerprint does not match its contract');
  }
  return manifest as PaceV2IdentityRepairManifest;
}

export function createPaceV2IdentityRepairManifest(contract: Omit<PaceV2IdentityRepairManifest, 'version' | 'repair' | 'manifest_fingerprint'>): PaceV2IdentityRepairManifest {
  const stable = { version: PACE_V2_IDENTITY_REPAIR_VERSION, repair: 'pace_v2_track_identity' as const, ...contract };
  return { ...stable, manifest_fingerprint: sha256(JSON.stringify(stable)) };
}
