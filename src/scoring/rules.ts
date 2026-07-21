export interface ScoringAuthority {
  publisher: 'FIA' | 'StatsF1';
  document: string;
  url: string;
}

export interface FastestLapRule {
  bonus_points: number;
  eligible_finish_position_max: number | null;
  shared_fastest_lap: 'split_equally' | 'not_applicable';
}

export interface DroppedScoreRule {
  kind: 'best_results' | 'split_season_best_results';
  description: string;
}

export interface ShortenedRaceRule {
  kind: 'unknown' | 'half_points_thresholds' | 'graduated_scale';
  description: string;
}

export interface ChampionshipScoringRules {
  id: string;
  season_start: number;
  season_end: number;
  standard_race_points: readonly number[];
  fastest_lap: FastestLapRule;
  sprint_points: readonly number[];
  shared_drive_points: 'split_equally' | 'not_awarded';
  dropped_scores: DroppedScoreRule | null;
  shortened_race: ShortenedRaceRule;
  race_multiplier: number;
  race_multiplier_scope: 'none' | 'season_final_only';
  authority: readonly ScoringAuthority[];
}

export type ScoringRulesResolution =
  | { status: 'supported'; rules: ChampionshipScoringRules }
  | { status: 'unsupported'; season: number; reason: 'before_registry' | 'after_registry' };

// Championship totals are official standings, not sums derived from this registry.
export const CHAMPIONSHIP_TOTALS_AUTHORITY = 'season_driver_standing' as const;

const HISTORICAL: ScoringAuthority = {
  publisher: 'StatsF1',
  document: 'Formula 1 points system history (driver championship schedules and counting rules)',
  url: 'https://www.statsf1.com/en/statistiques/pilote/point/reglement.aspx'
};
const FIA_2021: ScoringAuthority = { publisher: 'FIA', document: '2021 Formula 1 Sporting Regulations, Issue 13, Articles 6.4-6.5', url: 'https://www.fia.com/sites/default/files/2021_formula_1_sporting_regulations_-_iss_13_-_2021-12-08.pdf' };
const FIA_2024: ScoringAuthority = { publisher: 'FIA', document: '2024 Formula 1 Sporting Regulations, Issue 7, Articles 6.4-6.5', url: 'https://www.fia.com/sites/default/files/fia_2024_formula_1_sporting_regulations_-_issue_7_-_2024-07-31.pdf' };
const FIA_2025: ScoringAuthority = { publisher: 'FIA', document: '2025 Formula 1 Sporting Regulations, Issue 5, Articles 6.4-6.5', url: 'https://www.fia.com/system/files/documents/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.pdf' };
const FIA_2026: ScoringAuthority = { publisher: 'FIA', document: '2026 F1 Regulations, Section B (Sporting), Issue 7, Articles 6.4-6.5', url: 'https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_b_sporting_-_iss_07_-_2026-06-25.pdf' };

const P8 = [8, 6, 4, 3, 2] as const;
const P8_SIX = [8, 6, 4, 3, 2, 1] as const;
const P9 = [9, 6, 4, 3, 2, 1] as const;
const P10_SIX = [10, 6, 4, 3, 2, 1] as const;
const P10_EIGHT = [10, 8, 6, 5, 4, 3, 2, 1] as const;
const P25 = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;
const NO_FASTEST: FastestLapRule = { bonus_points: 0, eligible_finish_position_max: null, shared_fastest_lap: 'not_applicable' };
const EARLY_FASTEST: FastestLapRule = { bonus_points: 1, eligible_finish_position_max: null, shared_fastest_lap: 'split_equally' };
const MODERN_FASTEST: FastestLapRule = { bonus_points: 1, eligible_finish_position_max: 10, shared_fastest_lap: 'not_applicable' };
const NO_SHORTENED: ShortenedRaceRule = { kind: 'unknown', description: 'No general reduced-distance schedule is represented for this interval; use the event final classification.' };
const HALF_1975: ShortenedRaceRule = { kind: 'half_points_thresholds', description: '1975-1976: no points below 30% distance, half points from 30% to below 60%, full points at 60% or more.' };
const HALF_1980: ShortenedRaceRule = { kind: 'half_points_thresholds', description: '1980-2021: no points below two laps, half points from two laps to below 75%, full points at 75% or more. Event regulations and classifications control.' };
const GRADUATED: ShortenedRaceRule = { kind: 'graduated_scale', description: '2022-2026: no points below two green-flag laps; 6-4-3-2-1 below 25%, 13-10-8-6-5-4-3-2-1 below 50%, 19-14-12-10-8-6-4-3-2-1 below 75%, then full scale. Full points may apply when the race ends under green.' };

function historical(
  id: string, start: number, end: number, points: readonly number[], dropped: DroppedScoreRule | null,
  options: Partial<Pick<ChampionshipScoringRules, 'fastest_lap' | 'shared_drive_points' | 'shortened_race' | 'race_multiplier'>> = {}
): ChampionshipScoringRules {
  const raceMultiplier = options.race_multiplier ?? 1;
  return { id, season_start: start, season_end: end, standard_race_points: points, fastest_lap: options.fastest_lap ?? NO_FASTEST, sprint_points: [], shared_drive_points: options.shared_drive_points ?? 'not_awarded', dropped_scores: dropped, shortened_race: options.shortened_race ?? NO_SHORTENED, race_multiplier: raceMultiplier, race_multiplier_scope: raceMultiplier === 2 ? 'season_final_only' : 'none', authority: [HISTORICAL] };
}

const best = (count: number): DroppedScoreRule => ({ kind: 'best_results', description: `Only the best ${count} race results counted toward the Drivers' Championship.` });
const split = (first: number, firstCount: number, second: number, secondCount: number): DroppedScoreRule => ({ kind: 'split_season_best_results', description: `Best ${firstCount} results from the first ${first} races and best ${secondCount} results from the final ${second} races counted toward the Drivers' Championship.` });

export const championshipScoringRulesRegistry: readonly ChampionshipScoringRules[] = [
  historical('historical-1950-1953', 1950, 1953, P8, best(4), { fastest_lap: EARLY_FASTEST, shared_drive_points: 'split_equally' }),
  historical('historical-1954-1957', 1954, 1957, P8, best(5), { fastest_lap: EARLY_FASTEST, shared_drive_points: 'split_equally' }),
  historical('historical-1958', 1958, 1958, P8, best(6), { fastest_lap: EARLY_FASTEST }),
  historical('historical-1959', 1959, 1959, P8, best(5), { fastest_lap: EARLY_FASTEST }),
  historical('historical-1960', 1960, 1960, P8_SIX, best(6)),
  historical('historical-1961-1962', 1961, 1962, P9, best(5)),
  historical('historical-1963-1965', 1963, 1965, P9, best(6)),
  historical('historical-1966', 1966, 1966, P9, best(5)),
  historical('historical-1967', 1967, 1967, P9, split(6, 5, 5, 4)),
  historical('historical-1968', 1968, 1968, P9, split(6, 5, 6, 5)),
  historical('historical-1969', 1969, 1969, P9, split(6, 5, 5, 4)),
  historical('historical-1970', 1970, 1970, P9, split(7, 6, 6, 5)),
  historical('historical-1971', 1971, 1971, P9, split(6, 5, 5, 4)),
  historical('historical-1972', 1972, 1972, P9, split(6, 5, 6, 5)),
  historical('historical-1973-1974', 1973, 1974, P9, split(8, 7, 7, 6)),
  historical('historical-1975', 1975, 1975, P9, split(7, 6, 7, 6), { shortened_race: HALF_1975 }),
  historical('historical-1976', 1976, 1976, P9, split(8, 7, 8, 7), { shortened_race: HALF_1975 }),
  historical('historical-1977', 1977, 1977, P9, split(9, 8, 8, 7)),
  historical('historical-1978', 1978, 1978, P9, split(8, 7, 8, 7)),
  historical('historical-1979', 1979, 1979, P9, split(7, 4, 8, 4)),
  historical('historical-1980', 1980, 1980, P9, split(7, 5, 7, 5), { shortened_race: HALF_1980 }),
  historical('historical-1981-1990', 1981, 1990, P9, null, { shortened_race: HALF_1980 }),
  historical('historical-1991-2002', 1991, 2002, P10_SIX, null, { shortened_race: HALF_1980 }),
  historical('historical-2003-2009', 2003, 2009, P10_EIGHT, null, { shortened_race: HALF_1980 }),
  historical('historical-2010-2013', 2010, 2013, P25, null, { shortened_race: HALF_1980 }),
  historical('historical-2014-double-final', 2014, 2014, P25, null, { shortened_race: HALF_1980, race_multiplier: 2 }),
  historical('historical-2015-2018', 2015, 2018, P25, null, { shortened_race: HALF_1980 }),
  historical('historical-2019-2020-fastest-lap', 2019, 2020, P25, null, { fastest_lap: MODERN_FASTEST, shortened_race: HALF_1980 }),
  { ...historical('fia-2021-sprint-trial', 2021, 2021, P25, null, { fastest_lap: MODERN_FASTEST, shortened_race: HALF_1980 }), sprint_points: [3, 2, 1], authority: [FIA_2021] },
  { ...historical('fia-2022-2024-sprint-top-eight', 2022, 2024, P25, null, { fastest_lap: MODERN_FASTEST, shortened_race: GRADUATED }), sprint_points: [8, 7, 6, 5, 4, 3, 2, 1], authority: [FIA_2024] },
  { ...historical('fia-2025-no-fastest-lap-bonus', 2025, 2025, P25, null, { shortened_race: GRADUATED }), sprint_points: [8, 7, 6, 5, 4, 3, 2, 1], authority: [FIA_2025] },
  { ...historical('fia-2026-no-fastest-lap-bonus', 2026, 2026, P25, null, { shortened_race: GRADUATED }), sprint_points: [8, 7, 6, 5, 4, 3, 2, 1], authority: [FIA_2026] }
] as const;

export function resolveChampionshipScoringRules(season: number): ScoringRulesResolution {
  const rules = championshipScoringRulesRegistry.find((candidate) => season >= candidate.season_start && season <= candidate.season_end);
  return rules ? { status: 'supported', rules } : { status: 'unsupported', season, reason: season < 1950 ? 'before_registry' : 'after_registry' };
}

export function pointsForStandardRacePosition(rules: ChampionshipScoringRules, position: number): number {
  return rules.standard_race_points[position - 1] ?? 0;
}

export function pointsForSprintPosition(rules: ChampionshipScoringRules, position: number): number {
  return rules.sprint_points[position - 1] ?? 0;
}

export function fastestLapBonusPoints(rules: ChampionshipScoringRules, finishingPosition: number, setFastestLap: boolean): number {
  if (!setFastestLap || rules.fastest_lap.eligible_finish_position_max === null) {
    return 0;
  }
  return finishingPosition <= rules.fastest_lap.eligible_finish_position_max ? rules.fastest_lap.bonus_points : 0;
}
