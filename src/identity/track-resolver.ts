import { Pool } from 'pg';

/**
 * Track identity resolution result
 */
export interface TrackResolutionResult {
  success: boolean;
  f1db_track_id?: string;
  error?: string;
  match_mode?: 'literal' | 'ranked';
}

interface CircuitRow {
  id: string;
  name: string;
  full_name: string;
}

interface TrackRow {
  track_id: string;
  track_name: string | null;
}

// Map user inputs to laps_normalized.track_id (event names)
const TRACK_ALIAS_MAP: Record<string, string> = {
  // Circuit names → Event names (laps_normalized format)
  'monza': 'italian_grand_prix',
  'silverstone': 'british_grand_prix',
  'monaco': 'monaco_grand_prix',
  'spa': 'belgian_grand_prix',
  'spa-francorchamps': 'belgian_grand_prix',
  'suzuka': 'japanese_grand_prix',
  'bahrain': 'bahrain_grand_prix',
  'jeddah': 'saudi_arabian_grand_prix',
  'melbourne': 'australian_grand_prix',
  'albert park': 'australian_grand_prix',
  'imola': 'emilia_romagna_grand_prix',
  'miami': 'miami_grand_prix',
  'barcelona': 'spanish_grand_prix',
  'montreal': 'canadian_grand_prix',
  'spielberg': 'austrian_grand_prix',
  'red bull ring': 'austrian_grand_prix',
  'hungaroring': 'hungarian_grand_prix',
  'budapest': 'hungarian_grand_prix',
  'zandvoort': 'dutch_grand_prix',
  'baku': 'azerbaijan_grand_prix',
  'marina bay': 'singapore_grand_prix',
  'singapore': 'singapore_grand_prix',
  'cota': 'united_states_grand_prix',
  'austin': 'united_states_grand_prix',
  'mexico city': 'mexico_city_grand_prix',
  'autodromo hermanos rodriguez': 'mexico_city_grand_prix',
  'interlagos': 'são_paulo_grand_prix',
  'sao paulo': 'são_paulo_grand_prix',
  'las vegas': 'las_vegas_grand_prix',
  'lusail': 'qatar_grand_prix',
  'qatar': 'qatar_grand_prix',
  'yas marina': 'abu_dhabi_grand_prix',
  'abu dhabi': 'abu_dhabi_grand_prix',
  'shanghai': 'chinese_grand_prix',
  'china': 'chinese_grand_prix',
  // Also allow direct event name inputs (with spaces)
  'italian grand prix': 'italian_grand_prix',
  'british grand prix': 'british_grand_prix',
  'monaco grand prix': 'monaco_grand_prix',
  'belgian grand prix': 'belgian_grand_prix',
  'japanese grand prix': 'japanese_grand_prix',
  'bahrain grand prix': 'bahrain_grand_prix',
  'saudi arabian grand prix': 'saudi_arabian_grand_prix',
  'australian grand prix': 'australian_grand_prix',
  // Allow event IDs as-is (passthrough)
  'italian_grand_prix': 'italian_grand_prix',
  'british_grand_prix': 'british_grand_prix',
  'monaco_grand_prix': 'monaco_grand_prix',
  'belgian_grand_prix': 'belgian_grand_prix',
  'japanese_grand_prix': 'japanese_grand_prix',
  'bahrain_grand_prix': 'bahrain_grand_prix',
  'saudi_arabian_grand_prix': 'saudi_arabian_grand_prix',
  'australian_grand_prix': 'australian_grand_prix',
  'emilia_romagna_grand_prix': 'emilia_romagna_grand_prix',
  'miami_grand_prix': 'miami_grand_prix',
  'spanish_grand_prix': 'spanish_grand_prix',
  'canadian_grand_prix': 'canadian_grand_prix',
  'austrian_grand_prix': 'austrian_grand_prix',
  'hungarian_grand_prix': 'hungarian_grand_prix',
  'dutch_grand_prix': 'dutch_grand_prix',
  'azerbaijan_grand_prix': 'azerbaijan_grand_prix',
  'singapore_grand_prix': 'singapore_grand_prix',
  'united_states_grand_prix': 'united_states_grand_prix',
  'mexico_city_grand_prix': 'mexico_city_grand_prix',
  'são_paulo_grand_prix': 'são_paulo_grand_prix',
  'las_vegas_grand_prix': 'las_vegas_grand_prix',
  'qatar_grand_prix': 'qatar_grand_prix',
  'abu_dhabi_grand_prix': 'abu_dhabi_grand_prix',
  'chinese_grand_prix': 'chinese_grand_prix',
};

function normalizeLiteral(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeMatch(value: string): string {
  return normalizeLiteral(value).toLowerCase();
}

/**
 * Resolves track names to canonical track_id
 *
 * Rules:
 * - Strict literal matching only (case-insensitive, whitespace-collapsed)
 * - Winner-take-all ranking when multiple literal matches exist
 * - No fuzzy matching, no ambiguity prompts
 */
export class TrackResolver {
  constructor(private pool: Pool) {}

  async resolve(alias: string): Promise<TrackResolutionResult> {
    const rawInput = alias ?? '';
    const normalizedInput = normalizeMatch(rawInput);

    console.log(`[TrackResolver] Input: "${rawInput}" → Normalized: "${normalizedInput}"`);

    if (!normalizedInput) {
      return { success: false, error: 'unknown_track' };
    }

    const aliasMatch = TRACK_ALIAS_MAP[normalizedInput];
    if (aliasMatch) {
      console.log(`[TrackResolver] Alias match: "${normalizedInput}" → "${aliasMatch}"`);
      return { success: true, f1db_track_id: aliasMatch, match_mode: 'literal' };
    }

    console.log(`[TrackResolver] No alias match for "${normalizedInput}", falling back to DB lookup`);

    try {
      const circuitRows = await this.fetchCircuitRows();
      const trackRows = await this.fetchTrackRows();

      const candidates = this.findLiteralCandidates(normalizedInput, circuitRows, trackRows);

      if (candidates.length === 0) {
        return { success: false, error: 'unknown_track' };
      }

      const winner = await this.rankCandidates(candidates);
      const matchMode = candidates.length > 1 ? 'ranked' : 'literal';

      return {
        success: true,
        f1db_track_id: winner,
        match_mode: matchMode
      };
    } catch (err) {
      return {
        success: false,
        error: `Database error resolving track: ${err}`
      };
    }
  }

  /**
   * Batch resolve multiple tracks
   */
  async resolveMany(aliases: string[]): Promise<Map<string, TrackResolutionResult>> {
    const results = new Map<string, TrackResolutionResult>();

    for (const alias of aliases) {
      const result = await this.resolve(alias);
      results.set(alias, result);
    }

    return results;
  }

  private async fetchCircuitRows(): Promise<CircuitRow[]> {
    const result = await this.pool.query(
      `SELECT id, name, full_name FROM circuit`
    );
    return result.rows;
  }

  private async fetchTrackRows(): Promise<TrackRow[]> {
    try {
      const result = await this.pool.query(
        `SELECT track_id, track_name FROM tracks`
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  private findLiteralCandidates(
    normalizedInput: string,
    circuitRows: CircuitRow[],
    trackRows: TrackRow[]
  ): string[] {
    const matches = new Set<string>();

    const maybeMatch = (trackId: string, value?: string | null) => {
      if (!value) {
        return;
      }
      if (normalizeMatch(value) === normalizedInput) {
        matches.add(trackId);
      }
    };

    for (const row of circuitRows) {
      maybeMatch(row.id, row.id);
      maybeMatch(row.id, row.name);
      maybeMatch(row.id, row.full_name);
    }

    for (const row of trackRows) {
      maybeMatch(row.track_id, row.track_id);
      maybeMatch(row.track_id, row.track_name);
    }

    return Array.from(matches);
  }

  private async rankCandidates(candidateIds: string[]): Promise<string> {
    const uniqueIds = Array.from(new Set(candidateIds));

    if (uniqueIds.length === 1) {
      return uniqueIds[0];
    }

    const coverage = await this.fetchCoverageScores(uniqueIds);

    const scored = uniqueIds.map(id => ({
      id,
      coverage_score: coverage.get(id) || 0
    }));

    scored.sort((a, b) => {
      if (b.coverage_score !== a.coverage_score) {
        return b.coverage_score - a.coverage_score;
      }
      return a.id.localeCompare(b.id);
    });

    return scored[0].id;
  }

  private async fetchCoverageScores(candidateIds: string[]): Promise<Map<string, number>> {
    const coverage = new Map<string, number>();

    if (candidateIds.length === 0) {
      return coverage;
    }

    const addScore = (trackId: string, value: number) => {
      const current = coverage.get(trackId) || 0;
      coverage.set(trackId, current + value);
    };

    try {
      const metrics = await this.pool.query(
        `
        SELECT track_id, COUNT(*)::int AS row_count
        FROM pace_metric_summary_driver_track
        WHERE track_id = ANY($1)
        GROUP BY track_id
        `,
        [candidateIds]
      );
      for (const row of metrics.rows) {
        addScore(row.track_id, row.row_count);
      }
    } catch {
      // Ignore if table missing.
    }

    try {
      const laps = await this.pool.query(
        `
        SELECT track_id, COUNT(*)::int AS row_count
        FROM laps_normalized
        WHERE track_id = ANY($1)
        GROUP BY track_id
        `,
        [candidateIds]
      );
      for (const row of laps.rows) {
        addScore(row.track_id, Math.min(row.row_count, 1000));
      }
    } catch {
      // Ignore if table missing.
    }

    return coverage;
  }
}
