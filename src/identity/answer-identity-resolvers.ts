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
  participation_source?: 'entrant' | 'legacy_fallback' | null;
}

interface ParticipationRow {
  driver_id: string;
  participation_source: 'entrant' | 'legacy_fallback';
}

export const ANSWER_EVENT_IDENTITY_MAX_ROWS = 500;
export const ANSWER_DRIVER_IDENTITY_MAX_ROWS = 10_000;
const INACTIVE_NON_DRIVER_LITERALS = new Set([
  'all', 'and', 'date', 'did', 'driver', 'drivers', 'final', 'for', 'give', 'has', 'points',
  'qualifying', 'race', 'result', 'results', 'round', 'show', 'the', 'was', 'what', 'when',
  'where', 'who'
]);

export interface AnswerDriverLiteralMention {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly candidates: readonly string[];
  readonly active_candidates: readonly string[];
}

export class AnswerIdentityResolverError extends Error {
  constructor(readonly code: 'event_identity_overflow' | 'driver_identity_overflow' | 'participation_overflow') {
    super(code);
    this.name = 'AnswerIdentityResolverError';
  }
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
      WHERE season = $1 AND char_length(identity) BETWEEN 1 AND 200
      ORDER BY round, identity
      LIMIT $2
    `, [season, ANSWER_EVENT_IDENTITY_MAX_ROWS + 1]);
    if (result.rows.length > ANSWER_EVENT_IDENTITY_MAX_ROWS) {
      throw new AnswerIdentityResolverError('event_identity_overflow');
    }
    const accepted = acceptedEventNames(name, season);
    const candidates = result.rows.filter(row => accepted.has(normalizeEventName(row.identity)))
      .map(row => ({ season: Number(row.season), round: Number(row.round) }));
    const unique = [...new Map(candidates.map(candidate => [`${candidate.season}:${candidate.round}`, candidate])).values()];
    if (unique.length === 0) {
      return { type: 'missing' };
    }
    return unique.length === 1 ? { type: 'resolved', ...unique[0] } : { type: 'ambiguous', candidates: unique };
  }

  async resolveRound(season: number, round: number): Promise<EventResolution> {
    const result = await this.database.query<Pick<EventIdentityRow, 'season' | 'round'>>(`
      SELECT DISTINCT season, round
      FROM f1ql.answer_event_identity
      WHERE season = $1 AND round = $2
      ORDER BY round
      LIMIT $3
    `, [season, round, 2]);
    if (result.rows.length > 1) {
      throw new AnswerIdentityResolverError('event_identity_overflow');
    }
    const candidates = result.rows.map(row => ({ season: Number(row.season), round: Number(row.round) }));
    if (candidates.length === 0) {
      return { type: 'missing' };
    }
    return candidates.length === 1 ? { type: 'resolved', ...candidates[0] } : { type: 'ambiguous', candidates };
  }
}

export class AnswerDriverIdentityResolver {
  constructor(private readonly database: Queryable) {}

  async resolveUnambiguous(alias: string, season?: number): Promise<DriverResolutionResult> {
    const normalized = normalizeMatch(alias ?? '');
    if (!normalized) {
      return { success: false, error: 'unknown_driver' };
    }
    const identities = await this.database.query<DriverIdentityRow>(`
      SELECT driver_id, identity
      FROM f1ql.answer_driver_identity
      WHERE char_length(identity) BETWEEN 1 AND 200
      ORDER BY identity, driver_id
      LIMIT $1
    `, [ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1]);
    if (identities.rows.length > ANSWER_DRIVER_IDENTITY_MAX_ROWS) {
      throw new AnswerIdentityResolverError('driver_identity_overflow');
    }
    const candidates = [...new Set(identities.rows.filter(row => normalizeMatch(row.identity) === normalized).map(row => row.driver_id))].sort();
    if (candidates.length === 0) {
      return { success: false, error: 'unknown_driver' };
    }
    if (candidates.length === 1) {
      return { success: true, f1db_driver_id: candidates[0], candidates, match_mode: 'literal' };
    }
    const active = season ? await this.activeCandidates(candidates, season) : candidates;
    if (active.length === 1) {
      return { success: true, f1db_driver_id: active[0], candidates, match_mode: 'season' };
    }
    return { success: false, error: 'ambiguous_driver', candidates: (active.length > 1 ? active : candidates).sort() };
  }

  async inventoryMentions(question: string, season?: number): Promise<readonly AnswerDriverLiteralMention[]> {
    const result = season === undefined
      ? await this.database.query<DriverIdentityRow>(`
        SELECT driver_id, identity
        FROM f1ql.answer_driver_identity
        WHERE char_length(identity) BETWEEN 1 AND 200
        ORDER BY identity, driver_id
        LIMIT $1
      `, [ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1])
      : await this.database.query<DriverIdentityRow>(`
        SELECT i.driver_id, i.identity, p.participation_source
        FROM f1ql.answer_driver_identity i
        LEFT JOIN f1ql.answer_season_participation p
          ON p.driver_id = i.driver_id AND p.season = $1
        WHERE char_length(i.identity) BETWEEN 1 AND 200
        ORDER BY i.identity, i.driver_id, p.participation_source
        LIMIT $2
      `, [season, ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1]);
    if (result.rows.length > ANSWER_DRIVER_IDENTITY_MAX_ROWS) {
      throw new AnswerIdentityResolverError('driver_identity_overflow');
    }
    return inventoryLiteralMentions(question, result.rows, season === undefined);
  }

  private async activeCandidates(candidates: string[], season: number): Promise<string[]> {
    const result = await this.database.query<ParticipationRow>(`
      SELECT driver_id, participation_source
      FROM f1ql.answer_season_participation
      WHERE season = $1 AND driver_id = ANY($2::text[])
      ORDER BY driver_id, participation_source
      LIMIT $3
    `, [season, candidates, candidates.length * 2 + 1]);
    if (result.rows.length > candidates.length * 2) {
      throw new AnswerIdentityResolverError('participation_overflow');
    }
    const entrant = new Set(result.rows.filter(row => row.participation_source === 'entrant').map(row => row.driver_id));
    const fallback = new Set(result.rows.filter(row => row.participation_source === 'legacy_fallback').map(row => row.driver_id));
    const active = entrant.size > 0 ? entrant : fallback;
    return candidates.filter(candidate => active.has(candidate));
  }
}

function inventoryLiteralMentions(question: string, rows: readonly DriverIdentityRow[], unscoped = false): readonly AnswerDriverLiteralMention[] {
  const questionPoints = Array.from(question);
  const matches = new Map<string, { text: string; start: number; end: number; candidates: Set<string>; entrant: Set<string>; fallback: Set<string> }>();
  for (const row of rows) {
    const identityLength = Array.from(row.identity).length;
    if (identityLength === 0 || identityLength > questionPoints.length) {
      continue;
    }
    const normalizedIdentity = normalizeMatch(row.identity);
    for (let start = 0; start + identityLength <= questionPoints.length; start++) {
      const end = start + identityLength;
      const text = questionPoints.slice(start, end).join('');
      if (!isLiteralBoundary(questionPoints, start, end) || normalizeMatch(text) !== normalizedIdentity) {
        continue;
      }
      const key = `${start}:${end}`;
      const match = matches.get(key) ?? { text, start, end, candidates: new Set<string>(), entrant: new Set<string>(), fallback: new Set<string>() };
      match.candidates.add(row.driver_id);
      if (row.participation_source === 'entrant') {
        match.entrant.add(row.driver_id);
      } else if (row.participation_source === 'legacy_fallback') {
        match.fallback.add(row.driver_id);
      }
      matches.set(key, match);
    }
  }
  const longestFirst = [...matches.values()]
    .filter(match => match.entrant.size > 0 || match.fallback.size > 0 || !INACTIVE_NON_DRIVER_LITERALS.has(normalizeMatch(match.text)))
    .sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start || left.text.localeCompare(right.text));
  const selected: typeof longestFirst = [];
  for (const match of longestFirst) {
    if (selected.some(existing => match.start < existing.end && existing.start < match.end)) {
      continue;
    }
    selected.push(match);
  }
  return selected.sort((left, right) => left.start - right.start || left.end - right.end).map(match => {
    let active = match.fallback;
    if (unscoped) {
      active = match.candidates;
    } else if (match.entrant.size > 0) {
      active = match.entrant;
    }
    return {
      text: match.text,
      start: match.start,
      end: match.end,
      candidates: [...match.candidates].sort(),
      active_candidates: [...active].sort()
    };
  });
}

function isLiteralBoundary(question: readonly string[], start: number, end: number): boolean {
  const word = /[\p{L}\p{N}_]/u;
  return (start === 0 || !word.test(question[start - 1])) && (end === question.length || !word.test(question[end]));
}
