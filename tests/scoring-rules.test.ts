import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CHAMPIONSHIP_TOTALS_AUTHORITY,
  championshipScoringRulesRegistry,
  fastestLapBonusPoints,
  pointsForSprintPosition,
  pointsForStandardRacePosition,
  resolveChampionshipScoringRules
} from '../src/scoring/rules';

describe('championship scoring rules registry', () => {
  it('matches the real-registry golden fixture', () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/scoring-rules-golden.json'), 'utf8'));
    expect(fixture).toEqual(championshipScoringRulesRegistry);
  });

  it('covers every supported season exactly once and leaves both boundaries explicit', () => {
    for (let season = 2021; season <= 2026; season += 1) {
      const matches = championshipScoringRulesRegistry.filter((rule) => season >= rule.season_start && season <= rule.season_end);
      expect(matches).toHaveLength(1);
      expect(resolveChampionshipScoringRules(season)).toMatchObject({ status: 'supported', rules: matches[0] });
    }

    expect(resolveChampionshipScoringRules(2020)).toEqual({ status: 'unsupported', season: 2020, reason: 'before_registry' });
    expect(resolveChampionshipScoringRules(2027)).toEqual({ status: 'unsupported', season: 2027, reason: 'after_registry' });
  });

  it('preserves every scoring transition', () => {
    const rule2021 = resolveChampionshipScoringRules(2021);
    const rule2022 = resolveChampionshipScoringRules(2022);
    const rule2024 = resolveChampionshipScoringRules(2024);
    const rule2025 = resolveChampionshipScoringRules(2025);

    if (rule2021.status !== 'supported' || rule2022.status !== 'supported' || rule2024.status !== 'supported' || rule2025.status !== 'supported') {
      throw new Error('Expected supported registry transition seasons');
    }

    expect(rule2021.rules.sprint_points).toEqual([3, 2, 1]);
    expect(rule2022.rules.sprint_points).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rule2024.rules.fastest_lap).toEqual({ bonus_points: 1, eligible_finish_position_max: 10 });
    expect(rule2025.rules.fastest_lap).toEqual({ bonus_points: 0, eligible_finish_position_max: null });
  });

  it('applies only standard session schedules, never championship totals', () => {
    const resolution = resolveChampionshipScoringRules(2024);
    if (resolution.status !== 'supported') {
      throw new Error('Expected 2024 rules');
    }

    expect(CHAMPIONSHIP_TOTALS_AUTHORITY).toBe('season_driver_standing');
    expect(pointsForStandardRacePosition(resolution.rules, 1)).toBe(25);
    expect(pointsForStandardRacePosition(resolution.rules, 10)).toBe(1);
    expect(pointsForStandardRacePosition(resolution.rules, 11)).toBe(0);
    expect(pointsForSprintPosition(resolution.rules, 1)).toBe(8);
    expect(pointsForSprintPosition(resolution.rules, 9)).toBe(0);
    expect(fastestLapBonusPoints(resolution.rules, 10, true)).toBe(1);
    expect(fastestLapBonusPoints(resolution.rules, 11, true)).toBe(0);
    expect(fastestLapBonusPoints(resolution.rules, 1, false)).toBe(0);
  });

  it('removes the fastest-lap bonus without an eligibility workaround', () => {
    const resolution = resolveChampionshipScoringRules(2025);
    if (resolution.status !== 'supported') {
      throw new Error('Expected 2025 rules');
    }
    expect(fastestLapBonusPoints(resolution.rules, 1, true)).toBe(0);
    expect(fastestLapBonusPoints(resolution.rules, 10, true)).toBe(0);
  });
});
