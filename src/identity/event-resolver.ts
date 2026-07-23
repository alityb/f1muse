import { Pool } from 'pg';

interface EventRow {
  season: number;
  round: number;
  event_id: string | null;
  name: string | null;
  event_name: string | null;
  short_name: string | null;
  abbreviation: string | null;
  official_name: string | null;
}

export type EventResolution =
  | { type: 'resolved'; season: number; round: number }
  | { type: 'missing' }
  | { type: 'ambiguous'; candidates: Array<{ season: number; round: number }> };

const EVENT_NAME_ALIASES: Record<string, string[]> = {
  belgium: ['belgian grand prix']
};

function normalizeEventName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_-]/g, ' ')
    .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export class EventResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(season: number, name: string): Promise<EventResolution> {
    const normalized = normalizeEventName(name);
    if (!normalized) {
      return { type: 'missing' };
    }
    const result = await this.pool.query<EventRow>(`
      SELECT r.year AS season, r.round,
        gp.id AS event_id, gp.name, gp.full_name AS event_name, gp.short_name, gp.abbreviation,
        r.official_name
      FROM race r
      LEFT JOIN grand_prix gp ON gp.id = r.grand_prix_id
      WHERE r.year = $1
      ORDER BY r.round
    `, [season]);
    const acceptedNames = new Set([normalized, ...(EVENT_NAME_ALIASES[normalized] || [])]);
    const candidates = result.rows.filter(row => [row.event_id, row.name, row.event_name, row.short_name, row.abbreviation, row.official_name]
      .some(value => value !== null && acceptedNames.has(normalizeEventName(value))))
      .map(row => ({ season: Number(row.season), round: Number(row.round) }));
    const unique = Array.from(new Map(candidates.map(candidate => [`${candidate.season}:${candidate.round}`, candidate])).values());
    if (unique.length === 0) {
      return { type: 'missing' };
    }
    if (unique.length > 1) {
      return { type: 'ambiguous', candidates: unique };
    }
    return { type: 'resolved', ...unique[0] };
  }
}
