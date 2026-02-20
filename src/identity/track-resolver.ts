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

// Comprehensive map of user inputs to canonical track_id (event names)
// Includes: circuit names, city names, country names, abbreviations, common variations
const TRACK_ALIAS_MAP: Record<string, string> = {
  // ========== BAHRAIN ==========
  'bahrain': 'bahrain_grand_prix',
  'bahrain international circuit': 'bahrain_grand_prix',
  'sakhir': 'bahrain_grand_prix',
  'bahrain grand prix': 'bahrain_grand_prix',
  'bahrain_grand_prix': 'bahrain_grand_prix',
  'bhr': 'bahrain_grand_prix',

  // ========== SAUDI ARABIA ==========
  'saudi arabia': 'saudi_arabian_grand_prix',
  'saudi arabian': 'saudi_arabian_grand_prix',
  'saudi': 'saudi_arabian_grand_prix',
  'jeddah': 'saudi_arabian_grand_prix',
  'jeddah corniche': 'saudi_arabian_grand_prix',
  'jeddah street circuit': 'saudi_arabian_grand_prix',
  'saudi arabian grand prix': 'saudi_arabian_grand_prix',
  'saudi_arabian_grand_prix': 'saudi_arabian_grand_prix',
  'ksa': 'saudi_arabian_grand_prix',

  // ========== AUSTRALIA ==========
  'australia': 'australian_grand_prix',
  'australian': 'australian_grand_prix',
  'melbourne': 'australian_grand_prix',
  'albert park': 'australian_grand_prix',
  'australian grand prix': 'australian_grand_prix',
  'australian_grand_prix': 'australian_grand_prix',
  'aus': 'australian_grand_prix',

  // ========== JAPAN ==========
  'japan': 'japanese_grand_prix',
  'japanese': 'japanese_grand_prix',
  'suzuka': 'japanese_grand_prix',
  'suzuka circuit': 'japanese_grand_prix',
  'japanese grand prix': 'japanese_grand_prix',
  'japanese_grand_prix': 'japanese_grand_prix',
  'jpn': 'japanese_grand_prix',

  // ========== CHINA ==========
  'china': 'chinese_grand_prix',
  'chinese': 'chinese_grand_prix',
  'shanghai': 'chinese_grand_prix',
  'shanghai international circuit': 'chinese_grand_prix',
  'chinese grand prix': 'chinese_grand_prix',
  'chinese_grand_prix': 'chinese_grand_prix',
  'chn': 'chinese_grand_prix',

  // ========== MIAMI ==========
  'miami': 'miami_grand_prix',
  'miami international autodrome': 'miami_grand_prix',
  'miami gardens': 'miami_grand_prix',
  'miami grand prix': 'miami_grand_prix',
  'miami_grand_prix': 'miami_grand_prix',

  // ========== EMILIA ROMAGNA / IMOLA ==========
  'imola': 'emilia_romagna_grand_prix',
  'emilia romagna': 'emilia_romagna_grand_prix',
  'emilia-romagna': 'emilia_romagna_grand_prix',
  'emiliaromagna': 'emilia_romagna_grand_prix',
  'autodromo enzo e dino ferrari': 'emilia_romagna_grand_prix',
  'emilia romagna grand prix': 'emilia_romagna_grand_prix',
  'emilia_romagna_grand_prix': 'emilia_romagna_grand_prix',

  // ========== MONACO ==========
  'monaco': 'monaco_grand_prix',
  'monte carlo': 'monaco_grand_prix',
  'montecarlo': 'monaco_grand_prix',
  'circuit de monaco': 'monaco_grand_prix',
  'monaco grand prix': 'monaco_grand_prix',
  'monaco_grand_prix': 'monaco_grand_prix',
  'mon': 'monaco_grand_prix',

  // ========== CANADA ==========
  'canada': 'canadian_grand_prix',
  'canadian': 'canadian_grand_prix',
  'montreal': 'canadian_grand_prix',
  'circuit gilles villeneuve': 'canadian_grand_prix',
  'gilles villeneuve': 'canadian_grand_prix',
  'canadian grand prix': 'canadian_grand_prix',
  'canadian_grand_prix': 'canadian_grand_prix',
  'can': 'canadian_grand_prix',

  // ========== SPAIN ==========
  'spain': 'spanish_grand_prix',
  'spanish': 'spanish_grand_prix',
  'barcelona': 'spanish_grand_prix',
  'catalunya': 'spanish_grand_prix',
  'catalonia': 'spanish_grand_prix',
  'circuit de barcelona-catalunya': 'spanish_grand_prix',
  'montmelo': 'spanish_grand_prix',
  'spanish grand prix': 'spanish_grand_prix',
  'spanish_grand_prix': 'spanish_grand_prix',
  'esp': 'spanish_grand_prix',

  // ========== AUSTRIA ==========
  'austria': 'austrian_grand_prix',
  'austrian': 'austrian_grand_prix',
  'spielberg': 'austrian_grand_prix',
  'red bull ring': 'austrian_grand_prix',
  'redbullring': 'austrian_grand_prix',
  'a1 ring': 'austrian_grand_prix',
  'austrian grand prix': 'austrian_grand_prix',
  'austrian_grand_prix': 'austrian_grand_prix',
  'aut': 'austrian_grand_prix',

  // ========== GREAT BRITAIN ==========
  'britain': 'british_grand_prix',
  'british': 'british_grand_prix',
  'great britain': 'british_grand_prix',
  'uk': 'british_grand_prix',
  'england': 'british_grand_prix',
  'silverstone': 'british_grand_prix',
  'silverstone circuit': 'british_grand_prix',
  'british grand prix': 'british_grand_prix',
  'british_grand_prix': 'british_grand_prix',
  'gbr': 'british_grand_prix',

  // ========== HUNGARY ==========
  'hungary': 'hungarian_grand_prix',
  'hungarian': 'hungarian_grand_prix',
  'budapest': 'hungarian_grand_prix',
  'hungaroring': 'hungarian_grand_prix',
  'hungarian grand prix': 'hungarian_grand_prix',
  'hungarian_grand_prix': 'hungarian_grand_prix',
  'hun': 'hungarian_grand_prix',

  // ========== BELGIUM ==========
  'belgium': 'belgian_grand_prix',
  'belgian': 'belgian_grand_prix',
  'spa': 'belgian_grand_prix',
  'spa-francorchamps': 'belgian_grand_prix',
  'spa francorchamps': 'belgian_grand_prix',
  'stavelot': 'belgian_grand_prix',
  'belgian grand prix': 'belgian_grand_prix',
  'belgian_grand_prix': 'belgian_grand_prix',
  'bel': 'belgian_grand_prix',

  // ========== NETHERLANDS ==========
  'netherlands': 'dutch_grand_prix',
  'dutch': 'dutch_grand_prix',
  'holland': 'dutch_grand_prix',
  'zandvoort': 'dutch_grand_prix',
  'circuit zandvoort': 'dutch_grand_prix',
  'dutch grand prix': 'dutch_grand_prix',
  'dutch_grand_prix': 'dutch_grand_prix',
  'ned': 'dutch_grand_prix',

  // ========== ITALY ==========
  'italy': 'italian_grand_prix',
  'italian': 'italian_grand_prix',
  'monza': 'italian_grand_prix',
  'autodromo nazionale monza': 'italian_grand_prix',
  'italian grand prix': 'italian_grand_prix',
  'italian_grand_prix': 'italian_grand_prix',
  'ita': 'italian_grand_prix',

  // ========== AZERBAIJAN ==========
  'azerbaijan': 'azerbaijan_grand_prix',
  'baku': 'azerbaijan_grand_prix',
  'baku city circuit': 'azerbaijan_grand_prix',
  'baku street circuit': 'azerbaijan_grand_prix',
  'azerbaijan grand prix': 'azerbaijan_grand_prix',
  'azerbaijan_grand_prix': 'azerbaijan_grand_prix',
  'aze': 'azerbaijan_grand_prix',

  // ========== SINGAPORE ==========
  'singapore': 'singapore_grand_prix',
  'marina bay': 'singapore_grand_prix',
  'marina bay street circuit': 'singapore_grand_prix',
  'singapore grand prix': 'singapore_grand_prix',
  'singapore_grand_prix': 'singapore_grand_prix',
  'sgp': 'singapore_grand_prix',

  // ========== UNITED STATES ==========
  'usa': 'united_states_grand_prix',
  'us': 'united_states_grand_prix',
  'united states': 'united_states_grand_prix',
  'america': 'united_states_grand_prix',
  'austin': 'united_states_grand_prix',
  'texas': 'united_states_grand_prix',
  'cota': 'united_states_grand_prix',
  'circuit of the americas': 'united_states_grand_prix',
  'united states grand prix': 'united_states_grand_prix',
  'united_states_grand_prix': 'united_states_grand_prix',
  'us grand prix': 'united_states_grand_prix',
  'us_grand_prix': 'united_states_grand_prix',

  // ========== MEXICO ==========
  'mexico': 'mexico_city_grand_prix',
  'mexican': 'mexico_city_grand_prix',
  'mexico city': 'mexico_city_grand_prix',
  'autodromo hermanos rodriguez': 'mexico_city_grand_prix',
  'hermanos rodriguez': 'mexico_city_grand_prix',
  'mexico city grand prix': 'mexico_city_grand_prix',
  'mexico_city_grand_prix': 'mexico_city_grand_prix',
  'mexican grand prix': 'mexico_city_grand_prix',
  'mexican_grand_prix': 'mexico_city_grand_prix',
  'mex': 'mexico_city_grand_prix',

  // ========== BRAZIL / SAO PAULO ==========
  'brazil': 'são_paulo_grand_prix',
  'brazilian': 'são_paulo_grand_prix',
  'sao paulo': 'são_paulo_grand_prix',
  'são paulo': 'são_paulo_grand_prix',
  'interlagos': 'são_paulo_grand_prix',
  'autodromo jose carlos pace': 'são_paulo_grand_prix',
  'são paulo grand prix': 'são_paulo_grand_prix',
  'sao paulo grand prix': 'são_paulo_grand_prix',
  'são_paulo_grand_prix': 'são_paulo_grand_prix',
  'brazilian grand prix': 'são_paulo_grand_prix',
  'brazilian_grand_prix': 'são_paulo_grand_prix',
  'bra': 'são_paulo_grand_prix',

  // ========== LAS VEGAS ==========
  'las vegas': 'las_vegas_grand_prix',
  'vegas': 'las_vegas_grand_prix',
  'las vegas strip circuit': 'las_vegas_grand_prix',
  'las vegas grand prix': 'las_vegas_grand_prix',
  'las_vegas_grand_prix': 'las_vegas_grand_prix',

  // ========== QATAR ==========
  'qatar': 'qatar_grand_prix',
  'qatari': 'qatar_grand_prix',
  'lusail': 'qatar_grand_prix',
  'losail': 'qatar_grand_prix',
  'lusail international circuit': 'qatar_grand_prix',
  'qatar grand prix': 'qatar_grand_prix',
  'qatar_grand_prix': 'qatar_grand_prix',
  'qat': 'qatar_grand_prix',

  // ========== ABU DHABI ==========
  'abu dhabi': 'abu_dhabi_grand_prix',
  'abudhabi': 'abu_dhabi_grand_prix',
  'yas marina': 'abu_dhabi_grand_prix',
  'yas island': 'abu_dhabi_grand_prix',
  'yas marina circuit': 'abu_dhabi_grand_prix',
  'uae': 'abu_dhabi_grand_prix',
  'abu dhabi grand prix': 'abu_dhabi_grand_prix',
  'abu_dhabi_grand_prix': 'abu_dhabi_grand_prix',

  // ========== FRANCE (historical) ==========
  'france': 'french_grand_prix',
  'french': 'french_grand_prix',
  'paul ricard': 'french_grand_prix',
  'circuit paul ricard': 'french_grand_prix',
  'le castellet': 'french_grand_prix',
  'magny cours': 'french_grand_prix',
  'magny-cours': 'french_grand_prix',
  'french grand prix': 'french_grand_prix',
  'french_grand_prix': 'french_grand_prix',
  'fra': 'french_grand_prix',

  // ========== RUSSIA (historical) ==========
  'russia': 'russian_grand_prix',
  'russian': 'russian_grand_prix',
  'sochi': 'russian_grand_prix',
  'sochi autodrom': 'russian_grand_prix',
  'russian grand prix': 'russian_grand_prix',
  'russian_grand_prix': 'russian_grand_prix',
  'rus': 'russian_grand_prix',

  // ========== GERMANY (historical) ==========
  'germany': 'german_grand_prix',
  'german': 'german_grand_prix',
  'hockenheim': 'german_grand_prix',
  'hockenheimring': 'german_grand_prix',
  'nurburgring': 'german_grand_prix',
  'nürburgring': 'german_grand_prix',
  'german grand prix': 'german_grand_prix',
  'german_grand_prix': 'german_grand_prix',
  'ger': 'german_grand_prix',

  // ========== PORTUGAL (historical) ==========
  'portugal': 'portuguese_grand_prix',
  'portuguese': 'portuguese_grand_prix',
  'portimao': 'portuguese_grand_prix',
  'portimão': 'portuguese_grand_prix',
  'algarve': 'portuguese_grand_prix',
  'algarve international circuit': 'portuguese_grand_prix',
  'portuguese grand prix': 'portuguese_grand_prix',
  'portuguese_grand_prix': 'portuguese_grand_prix',
  'por': 'portuguese_grand_prix',

  // ========== TURKEY (historical) ==========
  'turkey': 'turkish_grand_prix',
  'turkish': 'turkish_grand_prix',
  'istanbul': 'turkish_grand_prix',
  'istanbul park': 'turkish_grand_prix',
  'turkish grand prix': 'turkish_grand_prix',
  'turkish_grand_prix': 'turkish_grand_prix',
  'tur': 'turkish_grand_prix',

  // ========== 2020 SPECIAL EVENTS ==========
  // Styrian GP (Red Bull Ring, second race)
  'styria': 'styrian_grand_prix',
  'styrian': 'styrian_grand_prix',
  'styrian grand prix': 'styrian_grand_prix',
  'styrian_grand_prix': 'styrian_grand_prix',

  // Eifel GP (Nürburgring)
  'eifel': 'eifel_grand_prix',
  'eifel grand prix': 'eifel_grand_prix',
  'eifel_grand_prix': 'eifel_grand_prix',

  // Tuscan GP (Mugello)
  'tuscan': 'tuscan_grand_prix',
  'tuscany': 'tuscan_grand_prix',
  'mugello': 'tuscan_grand_prix',
  'autodromo internazionale del mugello': 'tuscan_grand_prix',
  'tuscan grand prix': 'tuscan_grand_prix',
  'tuscan_grand_prix': 'tuscan_grand_prix',

  // 70th Anniversary GP (Silverstone, second race)
  '70th anniversary': '70th_anniversary_grand_prix',
  '70th anniversary grand prix': '70th_anniversary_grand_prix',
  '70th_anniversary_grand_prix': '70th_anniversary_grand_prix',

  // Sakhir GP (Bahrain outer circuit)
  'sakhir grand prix': 'sakhir_grand_prix',
  'sakhir_grand_prix': 'sakhir_grand_prix',
  'bahrain outer': 'sakhir_grand_prix',
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
