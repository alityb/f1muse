import 'dotenv/config';
import { createHash } from 'crypto';
import fs from 'fs';
import { PaceV2NatIdentityMap } from './generate-pace-v2-nat-identity-map';
import { computeCleanAir, computeStints, FastF1SessionPayload, finalizeLaps, normalizeLaps, RaceInfo } from '../src/etl/season-ingestion';
import { PaceV2IncompleteRebuildArtifact, PaceV2IncompleteRebuildManifest, PACE_V2_INCOMPLETE_REBUILD_ID, PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY, parsePaceV2IncompleteRebuildArtifact, parsePaceV2IncompleteRebuildManifest, rebuildFactsByRound } from '../src/etl/pace-v2-incomplete-rebuild';

export const fingerprintIdentityMap = (map: PaceV2NatIdentityMap) => createHash('sha256').update(JSON.stringify(map)).digest('hex');
export function parsePaceV2IncompleteRebuildIdentityMap(input: unknown): PaceV2NatIdentityMap {
  const map = input as Partial<PaceV2NatIdentityMap>;
  if (!map || map.version !== 2 || map.source !== 'canonical_race_results_fastf1_identity_map' || map.season !== 2026 || !Array.isArray(map.rounds) || map.rounds.length !== 9 || map.rounds.some((row, index) => row.round !== index + 2 || !row.track_id || !row.driver_ids || Object.entries(row.driver_ids).some(([code, id]) => !/^[A-Z0-9]{3}$/.test(code) || !id))) throw new Error('FAIL_CLOSED: canonical FastF1 identity map has an unsupported shape');
  return map as PaceV2NatIdentityMap;
}
export function generatePaceV2IncompleteRebuildFacts(manifest: PaceV2IncompleteRebuildManifest, map: PaceV2NatIdentityMap, fetchSession: (season: number, round: number) => FastF1SessionPayload): PaceV2IncompleteRebuildArtifact {
  const facts = manifest.rounds.flatMap((entry) => {
    const identity = map.rounds.find((round) => round.round === entry.round);
    if (!identity || Object.keys(identity.driver_ids).length !== entry.canonical_driver_count) throw new Error(`FAIL_CLOSED: canonical identity map coverage disagrees for round ${entry.round}`);
    const session = fetchSession(2026, entry.round);
    if (session.season !== 2026 || session.round !== entry.round || session.session_name !== 'Race') throw new Error(`FAIL_CLOSED: FastF1 source is not the requested race session for round ${entry.round}`);
    const ids = new Map(Object.entries(identity.driver_ids));
    const race: RaceInfo = { race_id: entry.round, round: entry.round, circuit_id: identity.track_id, grand_prix_id: `round_${entry.round}`, official_name: session.event_name, has_session_mapping: true };
    return finalizeLaps(computeCleanAir(computeStints(normalizeLaps(session, race, ids, new Set(ids.values()))))).map((row) => ({ ...row, session_type: 'R', methodology_version: PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY }));
  });
  const artifact = parsePaceV2IncompleteRebuildArtifact({ version: 1, rebuild_version: PACE_V2_INCOMPLETE_REBUILD_ID, identity_map_fingerprint: fingerprintIdentityMap(map), methodology_version: PACE_V2_INCOMPLETE_REBUILD_METHODOLOGY, facts });
  for (const entry of manifest.rounds) {
    const rows = rebuildFactsByRound(artifact.facts).get(entry.round) ?? [];
    if (new Set(rows.map((row) => row.driver_id)).size !== entry.canonical_driver_count || rows.every((row) => row.is_pit_lap && row.is_in_lap && row.is_out_lap)) throw new Error(`FAIL_CLOSED: rebuilt FastF1 coverage is incomplete or poisoned for round ${entry.round}`);
  }
  return artifact;
}
if (require.main === module) { const args = process.argv.slice(2); try { if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--identity-map') throw new Error('Usage: --manifest <approved.json> --identity-map <approved.json>'); const artifact = generatePaceV2IncompleteRebuildFacts(parsePaceV2IncompleteRebuildManifest(JSON.parse(fs.readFileSync(args[1], 'utf8'))), parsePaceV2IncompleteRebuildIdentityMap(JSON.parse(fs.readFileSync(args[3], 'utf8'))), require('../src/etl/season-ingestion').fetchFastF1Session); process.stdout.write(`${JSON.stringify(artifact)}\n`); } catch { process.stdout.write('{"status":"refused","error":"pace_v2_incomplete_rebuild_facts_failed"}\n'); process.exitCode = 1; } }
