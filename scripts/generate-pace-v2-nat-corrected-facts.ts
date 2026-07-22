import 'dotenv/config';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PaceV2FactRow } from '../src/etl/pace-v2-identity-repair';
import { fingerprintPaceV2FactRows, PACE_V2_NAT_REPLACEMENT_ID, PACE_V2_NAT_REPLACEMENT_METHODOLOGY, PaceV2NatReplacementArtifact, PaceV2NatReplacementManifest, parsePaceV2NatReplacementArtifact, parsePaceV2NatReplacementManifest, PACE_V2_NAT_REPLACEMENT_ROUNDS, replacementFactsByRound } from '../src/etl/pace-v2-nat-replacement';
import { computeCleanAir, computeStints, FastF1SessionPayload, fetchFastF1Session, finalizeLaps, normalizeLaps, RaceInfo } from '../src/etl/season-ingestion';
import { PaceV2NatIdentityMap } from './generate-pace-v2-nat-identity-map';

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function parsePaceV2NatSourceMap(input: unknown): PaceV2NatIdentityMap {
  if (!input || typeof input !== 'object') throw new Error('FAIL_CLOSED: approved FastF1 identity map must be an object');
  const source = input as Partial<PaceV2NatIdentityMap>;
  if (source.version !== 2 || source.source !== 'canonical_race_results_fastf1_identity_map' || source.season !== 2026 || !Array.isArray(source.rounds) || source.rounds.length !== PACE_V2_NAT_REPLACEMENT_ROUNDS.length) throw new Error('FAIL_CLOSED: canonical FastF1 identity map has an unsupported shape');
  const rounds = source.rounds;
  if (rounds.some((entry, index) => entry.round !== PACE_V2_NAT_REPLACEMENT_ROUNDS[index] || typeof entry.track_id !== 'string' || !entry.track_id || !entry.driver_ids || typeof entry.driver_ids !== 'object' || Object.entries(entry.driver_ids).some(([code, id]) => !/^[A-Z0-9]{3}$/.test(code) || typeof id !== 'string' || !id))) throw new Error('FAIL_CLOSED: approved FastF1 identity map must cover exactly the reviewed rounds');
  return { version: 2, source: 'canonical_race_results_fastf1_identity_map', season: 2026, rounds };
}

export function assertPaceV2NatTemporaryOutput(outputPath: string): string {
  if (!path.isAbsolute(outputPath)) throw new Error('FAIL_CLOSED: corrected-facts output must be an absolute temporary path');
  const temporaryDirectory = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(outputPath));
  if (parent !== temporaryDirectory && !parent.startsWith(`${temporaryDirectory}${path.sep}`)) throw new Error('FAIL_CLOSED: corrected-facts output must be outside the repository under the OS temporary directory');
  return outputPath;
}

export function generatePaceV2NatCorrectedFacts(manifest: PaceV2NatReplacementManifest, source: PaceV2NatIdentityMap, fetchSession: (season: number, round: number) => FastF1SessionPayload = fetchFastF1Session): PaceV2NatReplacementArtifact {
  const facts: PaceV2FactRow[] = [];
  for (const entry of manifest.rounds) {
    const identity = source.rounds.find((round) => round.round === entry.round);
    if (!identity) throw new Error(`FAIL_CLOSED: approved FastF1 identity map is missing round ${entry.round}`);
    const session = fetchSession(manifest.season, entry.round);
    if (session.season !== manifest.season || session.round !== entry.round || session.session_name !== 'Race') throw new Error(`FAIL_CLOSED: FastF1 source is not the requested race session for round ${entry.round}`);
    const race: RaceInfo = { race_id: entry.round, round: entry.round, circuit_id: identity.track_id, grand_prix_id: `round_${entry.round}`, official_name: session.event_name, has_session_mapping: true };
    const driverIds = new Map(Object.entries(identity.driver_ids));
    const normalized = finalizeLaps(computeCleanAir(computeStints(normalizeLaps(session, race, driverIds, new Set(driverIds.values())))));
    facts.push(...normalized.map((lap) => ({ ...lap, session_type: 'R', methodology_version: PACE_V2_NAT_REPLACEMENT_METHODOLOGY })));
  }
  const artifact = parsePaceV2NatReplacementArtifact({ version: 1, replacement_version: PACE_V2_NAT_REPLACEMENT_ID, methodology_version: PACE_V2_NAT_REPLACEMENT_METHODOLOGY, facts });
  const byRound = replacementFactsByRound(artifact.facts);
  for (const entry of manifest.rounds) {
    const corrected = byRound.get(entry.round) ?? [];
    if (corrected.length !== entry.fact_row_count) throw new Error(`FAIL_CLOSED: corrected round ${entry.round} row count ${corrected.length} does not match approved manifest ${entry.fact_row_count}`);
    if (corrected.every((row) => row.is_pit_lap && row.is_in_lap && row.is_out_lap)) throw new Error(`FAIL_CLOSED: corrected round ${entry.round} retains the NaT poison class`);
  }
  return artifact;
}

function readJson(filePath: string, label: string): unknown {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error(`FAIL_CLOSED: ${label} JSON is invalid`); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--identity-map' || args[4] !== '--output') throw new Error('Usage: npm run generate:pace-v2:nat-corrected-facts -- --manifest <approved.json> --identity-map <approved.json> --output <absolute-temp.json>');
  const manifest = parsePaceV2NatReplacementManifest(readJson(args[1], 'replacement manifest'));
  const source = parsePaceV2NatSourceMap(readJson(args[3], 'approved FastF1 identity map'));
  const output = assertPaceV2NatTemporaryOutput(args[5]);
  const artifact = generatePaceV2NatCorrectedFacts(manifest, source);
  const serialized = `${JSON.stringify(artifact)}\n`;
  fs.writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const rounds = replacementFactsByRound(artifact.facts);
  process.stdout.write(`${JSON.stringify({ status: 'generated', output, artifact_sha256: sha256(serialized), manifest_fingerprint: manifest.manifest_fingerprint, source_identity_map_sha256: sha256(JSON.stringify(source)), rounds: manifest.rounds.map((entry) => ({ round: entry.round, fact_row_count: rounds.get(entry.round)?.length ?? 0, replacement_fact_fingerprint: fingerprintPaceV2FactRows(rounds.get(entry.round) ?? []) })) })}\n`);
}

if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_nat_corrected_facts_failed' })}\n`); process.exitCode = 1; });
