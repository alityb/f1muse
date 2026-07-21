export interface ScoringAuthority {
  publisher: 'FIA';
  document: string;
  url: string;
}

export interface FastestLapRule {
  bonus_points: number;
  eligible_finish_position_max: number | null;
}

export interface ChampionshipScoringRules {
  id: string;
  season_start: number;
  season_end: number;
  standard_race_points: readonly number[];
  fastest_lap: FastestLapRule;
  sprint_points: readonly number[];
  authority: ScoringAuthority;
}

export type ScoringRulesResolution =
  | { status: 'supported'; rules: ChampionshipScoringRules }
  | { status: 'unsupported'; season: number; reason: 'before_registry' | 'after_registry' };

// Championship totals are imported from official standings. These rules describe
// individual session schedules only and must never be used to reconstruct totals.
export const CHAMPIONSHIP_TOTALS_AUTHORITY = 'season_driver_standing' as const;

const STANDARD_RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;

export const championshipScoringRulesRegistry: readonly ChampionshipScoringRules[] = [
  {
    id: 'fia-2021-sprint-trial',
    season_start: 2021,
    season_end: 2021,
    standard_race_points: STANDARD_RACE_POINTS,
    fastest_lap: { bonus_points: 1, eligible_finish_position_max: 10 },
    sprint_points: [3, 2, 1],
    authority: {
      publisher: 'FIA',
      document: '2021 Formula 1 Sporting Regulations, Issue 13, Articles 6.4 and 6.5',
      url: 'https://www.fia.com/sites/default/files/2021_formula_1_sporting_regulations_-_iss_13_-_2021-12-08.pdf'
    }
  },
  {
    id: 'fia-2022-2024-sprint-top-eight',
    season_start: 2022,
    season_end: 2024,
    standard_race_points: STANDARD_RACE_POINTS,
    fastest_lap: { bonus_points: 1, eligible_finish_position_max: 10 },
    sprint_points: [8, 7, 6, 5, 4, 3, 2, 1],
    authority: {
      publisher: 'FIA',
      document: '2024 Formula 1 Sporting Regulations, Issue 7, Articles 6.4 and 6.5',
      url: 'https://www.fia.com/sites/default/files/fia_2024_formula_1_sporting_regulations_-_issue_7_-_2024-07-31.pdf'
    }
  },
  {
    id: 'fia-2025-2026-no-fastest-lap-bonus',
    season_start: 2025,
    season_end: 2026,
    standard_race_points: STANDARD_RACE_POINTS,
    fastest_lap: { bonus_points: 0, eligible_finish_position_max: null },
    sprint_points: [8, 7, 6, 5, 4, 3, 2, 1],
    authority: {
      publisher: 'FIA',
      document: '2025 Formula 1 Sporting Regulations, Issue 5, Articles 6.4 and 6.5',
      url: 'https://www.fia.com/system/files/documents/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.pdf'
    }
  }
] as const;

export function resolveChampionshipScoringRules(season: number): ScoringRulesResolution {
  const rules = championshipScoringRulesRegistry.find(
    (candidate) => season >= candidate.season_start && season <= candidate.season_end
  );
  if (rules) {
    return { status: 'supported', rules };
  }

  return {
    status: 'unsupported',
    season,
    reason: season < championshipScoringRulesRegistry[0].season_start ? 'before_registry' : 'after_registry'
  };
}

export function pointsForStandardRacePosition(rules: ChampionshipScoringRules, position: number): number {
  return rules.standard_race_points[position - 1] ?? 0;
}

export function pointsForSprintPosition(rules: ChampionshipScoringRules, position: number): number {
  return rules.sprint_points[position - 1] ?? 0;
}

export function fastestLapBonusPoints(
  rules: ChampionshipScoringRules,
  finishingPosition: number,
  setFastestLap: boolean
): number {
  if (!setFastestLap || rules.fastest_lap.eligible_finish_position_max === null) {
    return 0;
  }
  return finishingPosition <= rules.fastest_lap.eligible_finish_position_max
    ? rules.fastest_lap.bonus_points
    : 0;
}
