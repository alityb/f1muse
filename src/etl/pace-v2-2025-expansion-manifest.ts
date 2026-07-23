import { createHash } from 'crypto';

export const PACE_V2_2025_EXPANSION_MANIFEST_VERSION = 1 as const;
export const PACE_V2_2025_EXPANSION_SEASON = 2025 as const;
export const PACE_V2_2025_EXPANSION_METHODOLOGY = 'clean_air_gap_2_0s_v1' as const;
export const PACE_V2_2025_EXPANSION_STABILIZATION_HOURS = 24 as const;

export interface PaceV2Expansion2025Pilot {
  round: number;
  race_id: number;
  track_id: string;
  race_date: string;
  canonical_starter_count: number;
  canonical_starter_fingerprint: string;
  existing_v2_fact_count: number;
  existing_manifest_audit_count: number;
}

export interface PaceV2Expansion2025Manifest {
  version: 1;
  purpose: 'pace_v2_2025_expansion_preparation';
  season: 2025;
  session_type: 'R';
  methodology_version: typeof PACE_V2_2025_EXPANSION_METHODOLOGY;
  stabilization_hours: 24;
  pilot_status: 'requires_external_source_review';
  pilot: PaceV2Expansion2025Pilot;
  manifest_fingerprint: string;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function fingerprintPaceV2CanonicalStarters(driverIds: readonly string[]): string {
  const sorted = [...new Set(driverIds)].sort();
  if (!sorted.length || sorted.some((driverId) => !driverId)) {
    throw new Error('FAIL_CLOSED: canonical starter evidence is empty or invalid');
  }
  return hash(sorted);
}

export function createPaceV2Expansion2025Manifest(pilot: PaceV2Expansion2025Pilot): PaceV2Expansion2025Manifest {
  if (!Number.isInteger(pilot.round) || pilot.round < 1 || !Number.isInteger(pilot.race_id) || !pilot.track_id ||
      !pilot.race_date || !Number.isInteger(pilot.canonical_starter_count) || pilot.canonical_starter_count < 10 ||
      !fingerprint(pilot.canonical_starter_fingerprint) || pilot.existing_v2_fact_count !== 0 || pilot.existing_manifest_audit_count !== 0) {
    throw new Error('FAIL_CLOSED: 2025 pace expansion pilot does not satisfy the preparation contract');
  }
  const stable = {
    version: PACE_V2_2025_EXPANSION_MANIFEST_VERSION,
    purpose: 'pace_v2_2025_expansion_preparation' as const,
    season: PACE_V2_2025_EXPANSION_SEASON,
    session_type: 'R' as const,
    methodology_version: PACE_V2_2025_EXPANSION_METHODOLOGY,
    stabilization_hours: PACE_V2_2025_EXPANSION_STABILIZATION_HOURS,
    pilot_status: 'requires_external_source_review' as const,
    pilot
  };
  return { ...stable, manifest_fingerprint: hash(stable) };
}

export function parsePaceV2Expansion2025Manifest(input: unknown): PaceV2Expansion2025Manifest {
  const manifest = input as Partial<PaceV2Expansion2025Manifest>;
  if (!manifest || manifest.version !== PACE_V2_2025_EXPANSION_MANIFEST_VERSION ||
      manifest.purpose !== 'pace_v2_2025_expansion_preparation' || manifest.season !== PACE_V2_2025_EXPANSION_SEASON ||
      manifest.session_type !== 'R' || manifest.methodology_version !== PACE_V2_2025_EXPANSION_METHODOLOGY ||
      manifest.stabilization_hours !== PACE_V2_2025_EXPANSION_STABILIZATION_HOURS ||
      manifest.pilot_status !== 'requires_external_source_review' || !manifest.pilot || !fingerprint(manifest.manifest_fingerprint)) {
    throw new Error('FAIL_CLOSED: 2025 pace expansion manifest has an unsupported shape');
  }
  const expected = createPaceV2Expansion2025Manifest(manifest.pilot);
  if (expected.manifest_fingerprint !== manifest.manifest_fingerprint) {
    throw new Error('FAIL_CLOSED: 2025 pace expansion manifest fingerprint does not match its contract');
  }
  return expected;
}
