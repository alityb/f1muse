import { Pool } from 'pg';

type DriverMatchMode = 'literal' | 'ranked';

interface DriverRow {
  id: string;
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
  abbreviation?: string | null;
}

/**
 * Driver identity resolution result
 */
export interface DriverResolutionResult {
  success: boolean;
  f1db_driver_id?: string;
  error?: string;
  match_mode?: DriverMatchMode;
}

export interface DriverResolveOptions {
  season?: number;
  teammate_id?: string;
}

/**
 * Normalize a string for matching:
 * 1. Unicode NFD decomposition + diacritic stripping
 * 2. Convert underscores and hyphens to spaces
 * 3. Collapse whitespace
 * 4. Remove punctuation (except apostrophes in names)
 * 5. Lowercase
 *
 * Examples:
 * - "Max Verstappen" → "max verstappen"
 * - "max_verstappen" → "max verstappen"
 * - "Pérez" → "perez"
 * - "MAX" → "max"
 * - "  Max   Verstappen  " → "max verstappen"
 */
function normalizeMatch(value: string): string {
  return value
    // NFD decomposition to separate base characters from diacritics
    .normalize('NFD')
    // Remove diacritics (combining marks)
    .replace(/[\u0300-\u036f]/g, '')
    // Convert underscores and hyphens to spaces
    .replace(/[_-]/g, ' ')
    // Remove punctuation except apostrophes (for names like O'Sullivan)
    .replace(/[^\w\s']/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    // Trim
    .trim()
    // Lowercase
    .toLowerCase();
}

/**
 * Resolves driver names to canonical driver_id
 *
 * Rules:
 * - Strict literal matching only (case-insensitive, whitespace-collapsed)
 * - Winner-take-all ranking when multiple literal matches exist
 * - No fuzzy matching, no typo inference, no ambiguity prompts
 */
export class DriverResolver {
  constructor(private pool: Pool) {}

  async resolve(alias: string, options?: DriverResolveOptions): Promise<DriverResolutionResult> {
    const rawInput = alias ?? '';
    const normalizedInput = normalizeMatch(rawInput);

    if (!normalizedInput) {
      return { success: false, error: 'unknown_driver' };
    }

    try {
      const driverRows = await this.fetchDriverRows();
      const candidates = this.findLiteralCandidates(normalizedInput, driverRows);

      if (candidates.length === 0) {
        return { success: false, error: 'unknown_driver' };
      }

      const winner = await this.rankCandidates(candidates, options);
      const matchMode: DriverMatchMode = candidates.length > 1 ? 'ranked' : 'literal';

      return {
        success: true,
        f1db_driver_id: winner,
        match_mode: matchMode
      };
    } catch (err) {
      return {
        success: false,
        error: `Database error resolving driver: ${err}`
      };
    }
  }

  /**
   * Batch resolve multiple drivers
   */
  async resolveMany(aliases: string[], options?: DriverResolveOptions): Promise<Map<string, DriverResolutionResult>> {
    const results = new Map<string, DriverResolutionResult>();

    for (const alias of aliases) {
      const result = await this.resolve(alias, options);
      results.set(alias, result);
    }

    return results;
  }

  private async fetchDriverRows(): Promise<DriverRow[]> {
    const result = await this.pool.query(
      `SELECT id, full_name, first_name, last_name, abbreviation FROM driver`
    );
    return result.rows;
  }

  private findLiteralCandidates(normalizedInput: string, rows: DriverRow[]): string[] {
    const matches = new Set<string>();

    const maybeMatch = (driverId: string, value?: string | null) => {
      if (!value) {
        return;
      }
      if (normalizeMatch(value) === normalizedInput) {
        matches.add(driverId);
      }
    };

    for (const row of rows) {
      maybeMatch(row.id, row.id);
      maybeMatch(row.id, row.full_name);
      maybeMatch(row.id, row.first_name || null);
      maybeMatch(row.id, row.last_name || null);
      maybeMatch(row.id, row.abbreviation || null);
    }

    return Array.from(matches);
  }

  private async rankCandidates(candidateIds: string[], options?: DriverResolveOptions): Promise<string> {
    const uniqueIds = Array.from(new Set(candidateIds));

    if (uniqueIds.length === 1) {
      return uniqueIds[0];
    }

    const seasonParticipation = await this.fetchSeasonParticipation(uniqueIds, options?.season);
    const teammateOverlap = await this.fetchTeammateOverlap(
      uniqueIds,
      options?.season,
      options?.teammate_id
    );
    const coverage = await this.fetchCoverageScores(uniqueIds);

    const scored = uniqueIds.map(id => ({
      id,
      season_participation: seasonParticipation.get(id) || 0,
      teammate_overlap: teammateOverlap.get(id) || 0,
      coverage_score: coverage.get(id) || 0
    }));

    scored.sort((a, b) => {
      if (b.season_participation !== a.season_participation) {
        return b.season_participation - a.season_participation;
      }
      if (b.teammate_overlap !== a.teammate_overlap) {
        return b.teammate_overlap - a.teammate_overlap;
      }
      if (b.coverage_score !== a.coverage_score) {
        return b.coverage_score - a.coverage_score;
      }
      return a.id.localeCompare(b.id);
    });

    return scored[0].id;
  }

  private async fetchSeasonParticipation(
    candidateIds: string[],
    season?: number
  ): Promise<Map<string, number>> {
    const participation = new Map<string, number>();

    if (!season || candidateIds.length === 0) {
      return participation;
    }

    try {
      const result = await this.pool.query(
        `
        SELECT driver_id, COUNT(*)::int AS entry_count
        FROM season_entrant_driver
        WHERE year = $1
          AND driver_id = ANY($2)
          AND test_driver = false
        GROUP BY driver_id
        `,
        [season, candidateIds]
      );

      for (const row of result.rows) {
        participation.set(row.driver_id, row.entry_count);
      }
    } catch {
      // Ignore if table missing.
    }

    if (participation.size > 0) {
      return participation;
    }

    try {
      const fallback = await this.pool.query(
        `
        SELECT driver_id, COUNT(*)::int AS entry_count
        FROM driver_season_entries
        WHERE year = $1
          AND driver_id = ANY($2)
        GROUP BY driver_id
        `,
        [season, candidateIds]
      );

      for (const row of fallback.rows) {
        participation.set(row.driver_id, row.entry_count);
      }
    } catch {
      // Ignore if fallback table missing.
    }

    return participation;
  }

  private async fetchTeammateOverlap(
    candidateIds: string[],
    season?: number,
    teammateId?: string
  ): Promise<Map<string, number>> {
    const overlap = new Map<string, number>();

    if (!season || !teammateId || candidateIds.length === 0) {
      return overlap;
    }

    try {
      const result = await this.pool.query(
        `
        SELECT a.driver_id, COUNT(*)::int AS overlap_count
        FROM season_entrant_driver a
        JOIN season_entrant_driver b
          ON a.year = b.year
         AND a.constructor_id = b.constructor_id
         AND b.driver_id = $2
         AND b.test_driver = false
        WHERE a.year = $1
          AND a.driver_id = ANY($3)
          AND a.test_driver = false
        GROUP BY a.driver_id
        `,
        [season, teammateId, candidateIds]
      );

      for (const row of result.rows) {
        overlap.set(row.driver_id, row.overlap_count);
      }
    } catch {
      // Ignore if table missing.
    }

    return overlap;
  }

  private async fetchCoverageScores(candidateIds: string[]): Promise<Map<string, number>> {
    const coverage = new Map<string, number>();

    if (candidateIds.length === 0) {
      return coverage;
    }

    const addScore = (driverId: string, value: number) => {
      const current = coverage.get(driverId) || 0;
      coverage.set(driverId, current + value);
    };

    try {
      const seasonMetrics = await this.pool.query(
        `
        SELECT driver_id, COUNT(*)::int AS row_count
        FROM pace_metric_summary_driver_season
        WHERE driver_id = ANY($1)
        GROUP BY driver_id
        `,
        [candidateIds]
      );
      for (const row of seasonMetrics.rows) {
        addScore(row.driver_id, row.row_count);
      }
    } catch {
      // Ignore if table missing.
    }

    try {
      const trackMetrics = await this.pool.query(
        `
        SELECT driver_id, COUNT(*)::int AS row_count
        FROM pace_metric_summary_driver_track
        WHERE driver_id = ANY($1)
        GROUP BY driver_id
        `,
        [candidateIds]
      );
      for (const row of trackMetrics.rows) {
        addScore(row.driver_id, row.row_count);
      }
    } catch {
      // Ignore if table missing.
    }

    try {
      const laps = await this.pool.query(
        `
        SELECT driver_id, COUNT(*)::int AS row_count
        FROM laps_normalized
        WHERE driver_id = ANY($1)
        GROUP BY driver_id
        `,
        [candidateIds]
      );
      for (const row of laps.rows) {
        addScore(row.driver_id, Math.min(row.row_count, 1000));
      }
    } catch {
      // Ignore if table missing.
    }

    return coverage;
  }
}
