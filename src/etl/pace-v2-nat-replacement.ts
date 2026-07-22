import { createHash } from 'crypto';
import { PaceV2FactRow, fingerprintPaceV2FactRows } from './pace-v2-identity-repair';

export const PACE_V2_NAT_REPLACEMENT_VERSION = 1;
export const PACE_V2_NAT_REPLACEMENT_ID = 'nat_pit_flags_v1';
export const PACE_V2_NAT_REPLACEMENT_SEASON = 2026;
export const PACE_V2_NAT_REPLACEMENT_METHODOLOGY = 'clean_air_gap_2_0s_v1';
export const PACE_V2_NAT_REPLACEMENT_ROUNDS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export interface PaceV2NatReplacementRound {
  round: number;
  original_fact_fingerprint: string;
  fact_row_count: number;
}

export interface PaceV2NatReplacementManifest {
  version: number;
  replacement: 'pace_v2_nat_pit_flags';
  replacement_version: typeof PACE_V2_NAT_REPLACEMENT_ID;
  season: typeof PACE_V2_NAT_REPLACEMENT_SEASON;
  session_type: 'R';
  methodology_version: typeof PACE_V2_NAT_REPLACEMENT_METHODOLOGY;
  rounds: PaceV2NatReplacementRound[];
  manifest_fingerprint: string;
}

export interface PaceV2NatReplacementArtifact {
  version: number;
  replacement_version: typeof PACE_V2_NAT_REPLACEMENT_ID;
  methodology_version: typeof PACE_V2_NAT_REPLACEMENT_METHODOLOGY;
  facts: PaceV2FactRow[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function createPaceV2NatReplacementManifest(rounds: PaceV2NatReplacementRound[]): PaceV2NatReplacementManifest {
  const stable = {
    version: PACE_V2_NAT_REPLACEMENT_VERSION,
    replacement: 'pace_v2_nat_pit_flags' as const,
    replacement_version: PACE_V2_NAT_REPLACEMENT_ID as typeof PACE_V2_NAT_REPLACEMENT_ID,
    season: PACE_V2_NAT_REPLACEMENT_SEASON as typeof PACE_V2_NAT_REPLACEMENT_SEASON,
    session_type: 'R' as const,
    methodology_version: PACE_V2_NAT_REPLACEMENT_METHODOLOGY as typeof PACE_V2_NAT_REPLACEMENT_METHODOLOGY,
    rounds: [...rounds].sort((a, b) => a.round - b.round)
  };
  return { ...stable, manifest_fingerprint: sha256(JSON.stringify(stable)) };
}

export function parsePaceV2NatReplacementManifest(input: unknown): PaceV2NatReplacementManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('FAIL_CLOSED: replacement manifest must be an object');
  }
  const manifest = input as Partial<PaceV2NatReplacementManifest>;
  if (manifest.version !== PACE_V2_NAT_REPLACEMENT_VERSION || manifest.replacement !== 'pace_v2_nat_pit_flags' ||
      manifest.replacement_version !== PACE_V2_NAT_REPLACEMENT_ID || manifest.season !== PACE_V2_NAT_REPLACEMENT_SEASON ||
      manifest.session_type !== 'R' || manifest.methodology_version !== PACE_V2_NAT_REPLACEMENT_METHODOLOGY ||
      !Array.isArray(manifest.rounds) || !isFingerprint(manifest.manifest_fingerprint)) {
    throw new Error('FAIL_CLOSED: replacement manifest has an unsupported shape');
  }
  const rounds = manifest.rounds as PaceV2NatReplacementRound[];
  if (rounds.length !== PACE_V2_NAT_REPLACEMENT_ROUNDS.length || rounds.some((entry, index) =>
    entry.round !== PACE_V2_NAT_REPLACEMENT_ROUNDS[index] || !Number.isInteger(entry.fact_row_count) || entry.fact_row_count < 1 || !isFingerprint(entry.original_fact_fingerprint))) {
    throw new Error('FAIL_CLOSED: replacement manifest must cover exactly the reviewed poisoned rounds');
  }
  const expected = createPaceV2NatReplacementManifest(rounds);
  if (expected.manifest_fingerprint !== manifest.manifest_fingerprint) {
    throw new Error('FAIL_CLOSED: replacement manifest fingerprint does not match its contract');
  }
  return expected;
}

function parseFact(value: unknown): PaceV2FactRow {
  if (!value || typeof value !== 'object') {
    throw new Error('FAIL_CLOSED: replacement artifact contains an invalid fact');
  }
  const row = value as Partial<PaceV2FactRow>;
  if (row.season !== PACE_V2_NAT_REPLACEMENT_SEASON || !PACE_V2_NAT_REPLACEMENT_ROUNDS.includes(row.round as never) ||
      row.session_type !== 'R' || row.methodology_version !== PACE_V2_NAT_REPLACEMENT_METHODOLOGY ||
      typeof row.track_id !== 'string' || typeof row.driver_id !== 'string' || !Number.isInteger(row.lap_number) ||
      !Number.isInteger(row.stint_id) || !Number.isInteger(row.stint_lap_index) || typeof row.is_valid_lap !== 'boolean' ||
      typeof row.is_pit_lap !== 'boolean' || typeof row.is_in_lap !== 'boolean' || typeof row.is_out_lap !== 'boolean' ||
      typeof row.clean_air_flag !== 'boolean' || (row.lap_time_seconds !== null && typeof row.lap_time_seconds !== 'number') ||
      (row.compound !== null && typeof row.compound !== 'string') || (row.tyre_age_laps !== null && !Number.isInteger(row.tyre_age_laps))) {
    throw new Error('FAIL_CLOSED: replacement artifact fact is outside the reviewed contract');
  }
  return row as PaceV2FactRow;
}

export function parsePaceV2NatReplacementArtifact(input: unknown): PaceV2NatReplacementArtifact {
  if (!input || typeof input !== 'object') {
    throw new Error('FAIL_CLOSED: replacement artifact must be an object');
  }
  const artifact = input as Partial<PaceV2NatReplacementArtifact>;
  if (artifact.version !== PACE_V2_NAT_REPLACEMENT_VERSION || artifact.replacement_version !== PACE_V2_NAT_REPLACEMENT_ID ||
      artifact.methodology_version !== PACE_V2_NAT_REPLACEMENT_METHODOLOGY || !Array.isArray(artifact.facts)) {
    throw new Error('FAIL_CLOSED: replacement artifact has an unsupported shape');
  }
  const facts = artifact.facts.map(parseFact);
  const keys = new Set(facts.map((row) => `${row.season}/${row.round}/${row.track_id}/${row.driver_id}/${row.session_type}/${row.lap_number}`));
  if (facts.length !== keys.size || PACE_V2_NAT_REPLACEMENT_ROUNDS.some((round) => !facts.some((row) => row.round === round))) {
    throw new Error('FAIL_CLOSED: replacement artifact has duplicate or missing reviewed-round facts');
  }
  return { version: PACE_V2_NAT_REPLACEMENT_VERSION, replacement_version: PACE_V2_NAT_REPLACEMENT_ID, methodology_version: PACE_V2_NAT_REPLACEMENT_METHODOLOGY, facts };
}

export function replacementFactsByRound(facts: PaceV2FactRow[]): Map<number, PaceV2FactRow[]> {
  return new Map(PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => [round, facts.filter((row) => row.round === round)]));
}

export { fingerprintPaceV2FactRows };
