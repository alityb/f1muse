import { createHash } from 'crypto';

export const PACE_V2_MANIFEST_VERSION = 1;
export const PACE_V2_STABILIZATION_HOURS = 24;

// Exact, reviewed source identities only. Do not add normalized or fuzzy matching here.
export const PACE_V2_APPROVED_TRACK_ID_RECONCILIATION: Readonly<Record<string, string>> = {
  australian_grand_prix: 'melbourne'
};

export function reconcilePaceV2TrackId(trackId: string): string {
  return PACE_V2_APPROVED_TRACK_ID_RECONCILIATION[trackId] ?? trackId;
}

export interface PaceV2ApprovedRound {
  season: number;
  round: number;
  race_id: number;
  track_id: string;
  race_date: string;
  result_count: number;
}

export interface PaceV2Manifest {
  version: number;
  season: number;
  generated_at: string;
  stabilization_hours: number;
  approved_rounds: PaceV2ApprovedRound[];
  manifest_fingerprint: string;
}

interface QueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

function fingerprintInput(manifest: Omit<PaceV2Manifest, 'generated_at' | 'manifest_fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function createPaceV2Manifest(season: number, rounds: PaceV2ApprovedRound[], generatedAt: Date): PaceV2Manifest {
  const approved_rounds = [...rounds].sort((a, b) => a.round - b.round);
  const stable = { version: PACE_V2_MANIFEST_VERSION, season, stabilization_hours: PACE_V2_STABILIZATION_HOURS, approved_rounds };
  return { ...stable, generated_at: generatedAt.toISOString(), manifest_fingerprint: fingerprintInput(stable) };
}

export async function generatePaceV2Manifest(client: QueryClient, season: number, now: Date): Promise<PaceV2Manifest> {
  const result = await client.query<{
    season: number; round: number; race_id: number; track_id: string | null; race_date: string; result_count: string;
  }>(`
    SELECT r.year AS season, r.round, r.id AS race_id, r.circuit_id AS track_id,
      r.date::text AS race_date, COUNT(rd.driver_id)::text AS result_count
    FROM race r
    JOIN race_data rd ON rd.race_id = r.id AND LOWER(rd.type) IN ('race', 'race_result')
    WHERE r.year = $1
      AND r.date IS NOT NULL
      AND r.date::timestamptz <= $2::timestamptz - ($3::text || ' hours')::interval
    GROUP BY r.year, r.round, r.id, r.circuit_id, r.date
    HAVING COUNT(rd.driver_id) >= 10
    ORDER BY r.round
  `, [season, now.toISOString(), String(PACE_V2_STABILIZATION_HOURS)]);

  const rounds = result.rows.map((row) => {
    if (!row.track_id) {
      throw new Error(`FAIL_CLOSED: completed round ${row.round} has no circuit mapping`);
    }
    return { season: Number(row.season), round: Number(row.round), race_id: Number(row.race_id), track_id: reconcilePaceV2TrackId(row.track_id), race_date: row.race_date, result_count: Number(row.result_count) };
  });
  return createPaceV2Manifest(season, rounds, now);
}

export function parsePaceV2Manifest(input: unknown): PaceV2Manifest {
  if (!input || typeof input !== 'object') {
    throw new Error('FAIL_CLOSED: manifest must be an object');
  }
  const manifest = input as Partial<PaceV2Manifest>;
  if (manifest.version !== PACE_V2_MANIFEST_VERSION || !Number.isInteger(manifest.season) ||
      manifest.stabilization_hours !== PACE_V2_STABILIZATION_HOURS || !Array.isArray(manifest.approved_rounds) ||
      typeof manifest.manifest_fingerprint !== 'string') {
    throw new Error('FAIL_CLOSED: manifest has an unsupported shape or version');
  }
  const rounds = manifest.approved_rounds as PaceV2ApprovedRound[];
  const seen = new Set<number>();
  for (const round of rounds) {
    if (!Number.isInteger(round.round) || round.season !== manifest.season || !Number.isInteger(round.race_id) ||
        !round.track_id || !Number.isInteger(round.result_count) || round.result_count < 10 || seen.has(round.round)) {
      throw new Error('FAIL_CLOSED: manifest contains an invalid approved round');
    }
    seen.add(round.round);
  }
  const stable = { version: PACE_V2_MANIFEST_VERSION, season: manifest.season as number, stabilization_hours: PACE_V2_STABILIZATION_HOURS, approved_rounds: rounds };
  if (fingerprintInput(stable) !== manifest.manifest_fingerprint) {
    throw new Error('FAIL_CLOSED: manifest fingerprint does not match approved rounds');
  }
  return manifest as PaceV2Manifest;
}
