import { Pool } from 'pg';
import { DriverResolutionResult, normalizeMatch } from './driver-resolver';
import { acceptedEventNames, EventResolution, normalizeEventName } from './event-resolver';

type Queryable = Pick<Pool, 'query'>;

interface EventIdentityRow {
  season: number;
  round: number;
  identity: string;
}

interface DriverIdentityRow {
  driver_id: string;
  identity: string;
}

interface ParticipationRow {
  driver_id: string;
  participation_source: 'entrant' | 'legacy_fallback';
}

export class AnswerEventIdentityResolver {
  constructor(private readonly database: Queryable) {}

  async resolve(season: number, name: string): Promise<EventResolution> {
    const normalized = normalizeEventName(name);
    if (!normalized) {
      return { type: 'missing' };
    }
    const result = await this.database.query<EventIdentityRow>(`
      SELECT season, round, identity
      FROM f1ql.answer_event_identity
      WHERE season = $1
      ORDER BY round
    `, [season]);
    const accepted = acceptedEventNames(name);
    const candidates = result.rows.filter(row => accepted.has(normalizeEventName(row.identity)))
      .map(row => ({ season: Number(row.season), round: Number(row.round) }));
    const unique = [...new Map(candidates.map(candidate => [`${candidate.season}:${candidate.round}`, candidate])).values()];
    if (unique.length === 0) {
      return { type: 'missing' };
    }
    return unique.length === 1 ? { type: 'resolved', ...unique[0] } : { type: 'ambiguous', candidates: unique };
  }
}

export class AnswerDriverIdentityResolver {
  constructor(private readonly database: Queryable) {}

  async resolveUnambiguous(alias: string, season?: number): Promise<DriverResolutionResult> {
    const normalized = normalizeMatch(alias ?? '');
    if (!normalized) {
      return { success: false, error: 'unknown_driver' };
    }
    try {
      const identities = await this.database.query<DriverIdentityRow>('SELECT driver_id, identity FROM f1ql.answer_driver_identity');
      const candidates = [...new Set(identities.rows.filter(row => normalizeMatch(row.identity) === normalized).map(row => row.driver_id))].sort();
      if (candidates.length === 0) {
        return { success: false, error: 'unknown_driver' };
      }
      if (candidates.length === 1) {
        return { success: true, f1db_driver_id: candidates[0], match_mode: 'literal' };
      }
      const active = season ? await this.activeCandidates(candidates, season) : candidates;
      if (active.length === 1) {
        return { success: true, f1db_driver_id: active[0], match_mode: 'season' };
      }
      return { success: false, error: 'ambiguous_driver', candidates: (active.length > 1 ? active : candidates).sort() };
    } catch (error) {
      return { success: false, error: `Database error resolving driver: ${error}` };
    }
  }

  private async activeCandidates(candidates: string[], season: number): Promise<string[]> {
    const result = await this.database.query<ParticipationRow>(`
      SELECT driver_id, participation_source
      FROM f1ql.answer_season_participation
      WHERE season = $1 AND driver_id = ANY($2::text[])
    `, [season, candidates]);
    const entrant = new Set(result.rows.filter(row => row.participation_source === 'entrant').map(row => row.driver_id));
    const fallback = new Set(result.rows.filter(row => row.participation_source === 'legacy_fallback').map(row => row.driver_id));
    const active = entrant.size > 0 ? entrant : fallback;
    return candidates.filter(candidate => active.has(candidate));
  }
}
