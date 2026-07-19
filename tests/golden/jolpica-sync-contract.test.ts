import { describe, expect, it } from 'vitest';
import {
  classifyRaceResultStatus,
  mergeRacePage,
  parseResultPosition,
} from '../../src/sync/jolpica-sync';
import { getGoldenAssertion, getGoldenCase } from './golden-registry';

describe('Jolpica sync contracts', () => {
  it('merges a race split across result pages without duplicating the race', () => {
    const golden = getGoldenCase('jolpica-results-pagination');
    const paginationRequired = getGoldenAssertion(golden, 'sync', 'pagination_required');
    const target: any[] = [];

    mergeRacePage(target, [{
      season: '2026',
      round: '5',
      Results: [{ Driver: { driverId: 'driver-a' } }],
    }]);
    mergeRacePage(target, [{
      season: '2026',
      round: '5',
      Results: [{ Driver: { driverId: 'driver-b' } }],
    }]);

    expect(paginationRequired).toBe(true);
    expect(target).toHaveLength(1);
    expect(target[0].Results.map((result: any) => result.Driver.driverId))
      .toEqual(['driver-a', 'driver-b']);
  });

  it('keeps lapped and time-gap statuses classified rather than retired', () => {
    const golden = getGoldenCase('lapped-is-classified');
    const classified = getGoldenAssertion(golden, 'Lapped', 'is_classified_finish');

    expect(classified).toBe(true);
    expect(classifyRaceResultStatus('Finished')).toBeNull();
    expect(classifyRaceResultStatus('Lapped')).toBeNull();
    expect(classifyRaceResultStatus('+1 Lap')).toBeNull();
  });

  it('retains retirement status and leaves withdrawn/DNS positions null', () => {
    const golden = getGoldenCase('withdrawn-has-no-position');
    const withdrawnPosition = getGoldenAssertion(golden, 'W', 'position_number');

    expect(classifyRaceResultStatus('Retired')).toBe('Retired');
    expect(classifyRaceResultStatus('Did not start')).toBe('Did not start');
    expect(parseResultPosition('W')).toBe(withdrawnPosition);
    expect(parseResultPosition('DNS')).toBeNull();
    expect(parseResultPosition('13')).toBe(13);
  });
});
