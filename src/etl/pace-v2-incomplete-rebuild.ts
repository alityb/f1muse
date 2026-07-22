import { createHash } from 'crypto';
import { PaceV2FactRow } from './pace-v2-identity-repair';

export const PACE_V2_INCOMPLETE_REBUILD_ID = 'fastf1_complete_race_v1' as const;
export const PACE_V2_INCOMPLETE_REBUILD_ROUNDS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY = 'clean_air_gap_2_0s_v1' as const;

export interface PaceV2IncompleteRebuildRound {
  round: number;
  original_fact_row_count: number;
  original_fact_fingerprint: string;
  canonical_driver_count: number;
  canonical_driver_fingerprint: string;
}

export interface PaceV2IncompleteRebuildManifest {
  version: 1;
  rebuild: 'pace_v2_incomplete_coverage';
  rebuild_version: typeof PACE_V2_INCOMPLETE_REBUILD_ID;
  season: 2026;
  session_type: 'R';
  methodology_version: typeof PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY;
  rounds: PaceV2IncompleteRebuildRound[];
  manifest_fingerprint: string;
}

export interface PaceV2IncompleteRebuildArtifact {
  version: 1;
  rebuild_version: typeof PACE_V2_INCOMPLETE_REBUILD_ID;
  identity_map_fingerprint: string;
  methodology_version: typeof PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY;
  facts: PaceV2FactRow[];
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function fingerprintDriverIds(ids: string[]): string {
  return hash(JSON.stringify([...new Set(ids)].sort()));
}

export function createPaceV2IncompleteRebuildManifest(rounds: PaceV2IncompleteRebuildRound[]): PaceV2IncompleteRebuildManifest {
  const stable = { version: 1 as const, rebuild: 'pace_v2_incomplete_coverage' as const, rebuild_version: PACE_V2_INCOMPLETE_REBUILD_ID,
    season: 2026 as const, session_type: 'R' as const, methodology_version: PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY,
    rounds: [...rounds].sort((a, b) => a.round - b.round) };
  return { ...stable, manifest_fingerprint: hash(JSON.stringify(stable)) };
}

export function parsePaceV2IncompleteRebuildManifest(input: unknown): PaceV2IncompleteRebuildManifest {
  const value = input as Partial<PaceV2IncompleteRebuildManifest>;
  if (!value || value.version !== 1 || value.rebuild !== 'pace_v2_incomplete_coverage' || value.rebuild_version !== PACE_V2_INCOMPLETE_REBUILD_ID ||
      value.season !== 2026 || value.session_type !== 'R' || value.methodology_version !== PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY || !Array.isArray(value.rounds) || !fingerprint(value.manifest_fingerprint)) { throw new Error('FAIL_CLOSED: incomplete rebuild manifest has an unsupported shape'); }
  const rounds = value.rounds as PaceV2IncompleteRebuildRound[];
  if (rounds.length !== PACE_V2_INCOMPLETE_REBUILD_ROUNDS.length || rounds.some((row, index) => row.round !== PACE_V2_INCOMPLETE_REBUILD_ROUNDS[index] || !Number.isInteger(row.original_fact_row_count) || row.original_fact_row_count < 1 || !Number.isInteger(row.canonical_driver_count) || row.canonical_driver_count < 1 || !fingerprint(row.original_fact_fingerprint) || !fingerprint(row.canonical_driver_fingerprint))) { throw new Error('FAIL_CLOSED: incomplete rebuild manifest must cover exactly the approved incomplete rounds'); }
  if (rounds.some((row) => row.canonical_driver_count <= 1)) { throw new Error('FAIL_CLOSED: incomplete rebuild manifest has invalid canonical coverage'); }
  const expected = createPaceV2IncompleteRebuildManifest(rounds);
  if (expected.manifest_fingerprint !== value.manifest_fingerprint) { throw new Error('FAIL_CLOSED: incomplete rebuild manifest fingerprint does not match its contract'); }
  return expected;
}

export function parsePaceV2IncompleteRebuildArtifact(input: unknown): PaceV2IncompleteRebuildArtifact {
  const value = input as Partial<PaceV2IncompleteRebuildArtifact>;
  if (!value || value.version !== 1 || value.rebuild_version !== PACE_V2_INCOMPLETE_REBUILD_ID || !fingerprint(value.identity_map_fingerprint) || value.methodology_version !== PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY || !Array.isArray(value.facts)) { throw new Error('FAIL_CLOSED: incomplete rebuild artifact has an unsupported shape'); }
  const facts = value.facts as PaceV2FactRow[];
  const keys = new Set(facts.map((row) => `${row.season}/${row.round}/${row.track_id}/${row.driver_id}/${row.session_type}/${row.lap_number}`));
  if (!facts.length || facts.length !== keys.size || facts.some((row) => row.season !== 2026 || !PACE_V2_INCOMPLETE_REBUILD_ROUNDS.includes(row.round as never) || row.session_type !== 'R' || row.methodology_version !== PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY || !Number.isInteger(row.lap_number) || !Number.isInteger(row.stint_id) || !Number.isInteger(row.stint_lap_index))) { throw new Error('FAIL_CLOSED: incomplete rebuild artifact facts are outside the approved contract'); }
  if (PACE_V2_INCOMPLETE_REBUILD_ROUNDS.some((round) => !facts.some((row) => row.round === round))) { throw new Error('FAIL_CLOSED: incomplete rebuild artifact is missing an approved round'); }
  return { version: 1, rebuild_version: PACE_V2_INCOMPLETE_REBUILD_ID, identity_map_fingerprint: value.identity_map_fingerprint as string, methodology_version: PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY, facts };
}

export function rebuildFactsByRound(facts: PaceV2FactRow[]): Map<number, PaceV2FactRow[]> {
  return new Map(PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => [round, facts.filter((fact) => fact.round === round)]));
}
