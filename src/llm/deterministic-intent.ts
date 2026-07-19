import { QueryIntent } from '../types/query-intent';

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;

function extractSeason(question: string): number {
  const match = question.match(YEAR_PATTERN);
  return match ? parseInt(match[0], 10) : 2026;
}

function stripYear(value: string): string {
  return value.replace(YEAR_PATTERN, '').trim();
}

function cleanEntity(value: string): string {
  return stripYear(value)
    .replace(/\b(the|grand prix|gp|race|at|in|for|of|results|result|winner|won|who|did)\b/gi, ' ')
    .replace(/[?.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseIntent(question: string): Pick<QueryIntent, 'season' | 'raw_query'> {
  return { season: extractSeason(question), raw_query: question };
}

function withPaceDefaults(intent: Partial<QueryIntent>, question: string): QueryIntent {
  const cleanAir = /\b(clean air|clear air|without traffic)\b/i.test(question);
  return {
    metric: 'avg_true_pace',
    normalization: 'none',
    clean_air_only: cleanAir,
    compound_context: 'mixed',
    session_scope: 'race',
    ...intent,
  } as QueryIntent;
}

function extractTwoDrivers(question: string): { a: string; b: string } | null {
  const match = question.match(/(.+?)\s+(?:vs\.?|versus|v\.?|and|&)\s+(.+?)(?:\s+\b(?:at|in|on|for|qualifying|quali|race|head to head|h2h)\b|\s+\d{4}|$)/i);
  if (!match) {return null;}
  const a = cleanEntity(match[1]);
  const b = cleanEntity(match[2]);
  return a && b ? { a, b } : null;
}

function extractTrackAfter(question: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match?.[1]) {
      const track = cleanEntity(match[1]);
      if (track) {return track;}
    }
  }
  return null;
}

/**
 * Cheap, deterministic parser for the most common query shapes.
 * Claude remains the fallback for ambiguous or unusual phrasing.
 */
export function buildDeterministicIntent(question: string): QueryIntent | null {
  const lower = question.toLowerCase();
  const common = baseIntent(question);

  if (/\b(who won|winner of|race results|results of|podium|\bresults\b)\b/i.test(question)) {
    const track = extractTrackAfter(question, [
      /who won(?:\s+the)?\s+(.+)$/i,
      /winner of(?:\s+the)?\s+(.+)$/i,
      /race results(?:\s+for|\s+of)?\s+(.+)$/i,
      /results of\s+(.+)$/i,
      /podium(?:\s+at|\s+for)?\s+(.+)$/i,
      /^(.+?)\s+\d{4}\s+results$/i,
    ]);
    if (!track) {return null;}
    return withPaceDefaults({ ...common, kind: 'race_results_summary', track_id: track, clean_air_only: false }, question);
  }

  if (/\b(qualifying results|qualifying grid|quali results|who got pole|pole at|qualified on pole)\b/i.test(question)) {
    const track = extractTrackAfter(question, [
      /who got pole(?:\s+at|\s+in)?\s+(.+)$/i,
      /pole(?:\s+at|\s+in)\s+(.+)$/i,
      /qualifying results(?:\s+at|\s+in|\s+for|\s+of)?\s+(.+)$/i,
      /qualifying grid(?:\s+at|\s+in|\s+for|\s+of)?\s+(.+)$/i,
      /^(.+?)\s+\d{4}\s+qualifying\s+grid$/i,
    ]);
    if (!track) {return null;}
    return withPaceDefaults({ ...common, kind: 'qualifying_results_summary', track_id: track, clean_air_only: false }, question);
  }

  if (/\b(fastest drivers at|fastest driver at|fastest at|who was fastest at)\b/i.test(question)) {
    const track = extractTrackAfter(question, [
      /fastest drivers at\s+(.+)$/i,
      /fastest driver at\s+(.+)$/i,
      /fastest at\s+(.+)$/i,
      /who was fastest at\s+(.+)$/i,
    ]);
    if (!track) {return null;}
    return withPaceDefaults({ ...common, kind: 'track_fastest_drivers', track_id: track }, question);
  }

  if (/\b(wins by circuit|where has .+ won|circuit victories|track victories)\b/i.test(question)) {
    const driver = cleanEntity(question.replace(/wins by circuit|where has|won|circuit victories|track victories/gi, ''));
    if (!driver) {return null;}
    return withPaceDefaults({ ...common, kind: 'driver_career_wins_by_circuit', driver_id: driver, session_scope: 'all' }, question);
  }

  if (/\b(career poles|total poles|how many poles does|poles in (his|her|their) career)\b/i.test(question) && !YEAR_PATTERN.test(question)) {
    const driver = cleanEntity(question.replace(/career poles|total poles|how many poles does|have|poles in (his|her|their) career/gi, ''));
    if (!driver) {return null;}
    return withPaceDefaults({ ...common, kind: 'driver_career_pole_count', driver_id: driver, session_scope: 'qualifying' }, question);
  }

  if (/\b(head to head|h2h)\b/i.test(question)) {
    const drivers = extractTwoDrivers(question.replace(/head to head|h2h/gi, ''));
    if (!drivers) {return null;}
    return withPaceDefaults({
      ...common,
      kind: 'driver_vs_driver_comprehensive',
      driver_a_id: drivers.a,
      driver_b_id: drivers.b,
      session_scope: 'all',
    }, question);
  }

  if (/\bqualifying gap\b|\boutqualified\b|\bqualifies higher\b/i.test(question)) {
    const drivers = extractTwoDrivers(question);
    if (!drivers) {return null;}
    return withPaceDefaults({
      ...common,
      kind: 'qualifying_gap_drivers',
      driver_a_id: drivers.a,
      driver_b_id: drivers.b,
      session_scope: 'qualifying',
    }, question);
  }

  if (/\bqualifying\s*(vs\.?|versus|v\.?)\s*race|\bquali\s*(vs\.?|versus|v\.?)\s*race|\brace\s*(vs\.?|versus|v\.?)\s*qual/i.test(question)) {
    const drivers = extractTwoDrivers(question);
    if (!drivers) {return null;}
    return withPaceDefaults({
      ...common,
      kind: 'teammate_gap_dual_comparison',
      driver_a_id: drivers.a,
      driver_b_id: drivers.b,
      metric: 'teammate_gap_dual',
      normalization: 'team_baseline',
      session_scope: 'race',
    }, question);
  }

  if (lower.includes(' vs ') || lower.includes(' versus ') || /\bv\.\b/i.test(question)) {
    const drivers = extractTwoDrivers(question);
    if (!drivers) {return null;}

    const track = extractTrackAfter(question, [/\b(?:at|in|on)\s+(.+)$/i]);
    if (track) {
      return withPaceDefaults({
        ...common,
        kind: 'cross_team_track_scoped_driver_comparison',
        track_id: track,
        driver_a_id: drivers.a,
        driver_b_id: drivers.b,
      }, question);
    }

    return withPaceDefaults({
      ...common,
      kind: 'driver_vs_driver_comprehensive',
      driver_a_id: drivers.a,
      driver_b_id: drivers.b,
      session_scope: 'all',
    }, question);
  }

  if (/\b(points|standings points|championship points)\b/i.test(question)) {
    const driver = cleanEntity(question.replace(/championship points|standings points|how many|points|standings|does|did|has|have|score|scored|season|championship/gi, ''));
    if (!driver) {return null;}
    return withPaceDefaults({
      ...common,
      kind: 'driver_season_summary',
      driver_id: driver,
      session_scope: 'all',
    }, question);
  }

  return null;
}
