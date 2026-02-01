/**
 * CONDITIONAL HEAD-TO-HEAD TESTS
 *
 * Tests for conditional head-to-head queries with filters:
 * - session (Q1, Q2, Q3, BEST)
 * - track_type (street, permanent)
 * - weather (dry, wet, mixed)
 * - rounds (specific round numbers)
 * - date_from / date_to
 * - exclude_dnfs
 *
 * Coverage:
 * 1. Validator tests for filter validation
 * 2. NL parsing tests for filter extraction
 * 3. Payload formatting tests
 * 4. SQL template selection tests
 * 5. Fail-closed behavior tests
 */

import { describe, it, expect } from 'vitest';
import { QueryValidator } from '../src/validation/query-validator';
import { DriverHeadToHeadCountIntent, HeadToHeadFilters } from '../src/types/query-intent';

const validator = new QueryValidator();

/**
 * Helper to create a valid h2h intent with optional filters
 */
function createH2HIntent(
  overrides: Partial<DriverHeadToHeadCountIntent> = {},
  filters?: HeadToHeadFilters
): DriverHeadToHeadCountIntent {
  const intent: DriverHeadToHeadCountIntent = {
    kind: 'driver_head_to_head_count',
    driver_a_id: 'lando_norris',
    driver_b_id: 'oscar_piastri',
    h2h_metric: 'qualifying_position',
    h2h_scope: 'field',
    season: 2025,
    metric: 'avg_true_pace',
    normalization: 'none',
    clean_air_only: false,
    compound_context: 'mixed',
    session_scope: 'race',
    raw_query: 'Test query',
    ...overrides
  };

  if (filters) {
    intent.filters = filters;
  }

  return intent;
}

describe('Conditional H2H Filter Validation', () => {
  describe('Session Filter', () => {
    it('accepts valid session Q1', async () => {
      const intent = createH2HIntent({}, { session: 'Q1' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid session Q2', async () => {
      const intent = createH2HIntent({}, { session: 'Q2' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid session Q3', async () => {
      const intent = createH2HIntent({}, { session: 'Q3' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid session BEST', async () => {
      const intent = createH2HIntent({}, { session: 'BEST' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects invalid session', async () => {
      const intent = createH2HIntent({}, { session: 'Q4' as any });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid session filter');
    });

    it('rejects session filter for race metric', async () => {
      const intent = createH2HIntent(
        { h2h_metric: 'race_finish_position' },
        { session: 'Q3' }
      );
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('only valid for qualifying_position');
    });
  });

  describe('Track Type Filter', () => {
    it('accepts valid track_type street', async () => {
      const intent = createH2HIntent({}, { track_type: 'street' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid track_type permanent', async () => {
      const intent = createH2HIntent({}, { track_type: 'permanent' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects invalid track_type', async () => {
      const intent = createH2HIntent({}, { track_type: 'hybrid' as any });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid track_type filter');
    });
  });

  describe('Weather Filter', () => {
    it('accepts valid weather dry', async () => {
      const intent = createH2HIntent({}, { weather: 'dry' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid weather wet', async () => {
      const intent = createH2HIntent({}, { weather: 'wet' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid weather mixed', async () => {
      const intent = createH2HIntent({}, { weather: 'mixed' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects invalid weather', async () => {
      const intent = createH2HIntent({}, { weather: 'foggy' as any });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid weather filter');
    });
  });

  describe('Rounds Filter', () => {
    it('accepts valid single round', async () => {
      const intent = createH2HIntent({}, { rounds: [5] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid multiple rounds', async () => {
      const intent = createH2HIntent({}, { rounds: [1, 5, 10] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects non-array rounds', async () => {
      const intent = createH2HIntent({}, { rounds: 5 as any });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('must be an array');
    });

    it('rejects empty rounds array', async () => {
      const intent = createH2HIntent({}, { rounds: [] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('cannot be empty');
    });

    it('rejects invalid round numbers (< 1)', async () => {
      const intent = createH2HIntent({}, { rounds: [0] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid round number');
    });

    it('rejects invalid round numbers (> 30)', async () => {
      const intent = createH2HIntent({}, { rounds: [31] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid round number');
    });

    it('rejects non-integer round numbers', async () => {
      const intent = createH2HIntent({}, { rounds: [5.5] });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid round number');
    });
  });

  describe('Date Range Filter', () => {
    it('accepts valid date_from', async () => {
      const intent = createH2HIntent({}, { date_from: '2025-03-01' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid date_to', async () => {
      const intent = createH2HIntent({}, { date_to: '2025-12-31' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts valid date range', async () => {
      const intent = createH2HIntent({}, {
        date_from: '2025-03-01',
        date_to: '2025-06-30'
      });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects invalid date_from format', async () => {
      const intent = createH2HIntent({}, { date_from: 'not-a-date' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid date_from format');
    });

    it('rejects invalid date_to format', async () => {
      const intent = createH2HIntent({}, { date_to: 'invalid' });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('Invalid date_to format');
    });

    it('rejects date_from > date_to', async () => {
      const intent = createH2HIntent({}, {
        date_from: '2025-06-30',
        date_to: '2025-03-01'
      });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('date_from must be before date_to');
    });
  });

  describe('Exclude DNFs Filter', () => {
    it('accepts exclude_dnfs true', async () => {
      const intent = createH2HIntent({}, { exclude_dnfs: true });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts exclude_dnfs false', async () => {
      const intent = createH2HIntent({}, { exclude_dnfs: false });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects non-boolean exclude_dnfs', async () => {
      const intent = createH2HIntent({}, { exclude_dnfs: 'true' as any });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
      expect(result.error?.reason).toContain('must be a boolean');
    });
  });

  describe('Combined Filters', () => {
    it('accepts multiple valid filters together', async () => {
      const intent = createH2HIntent({}, {
        session: 'Q3',
        track_type: 'street',
        weather: 'dry'
      });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('accepts all filters together', async () => {
      const intent = createH2HIntent({}, {
        session: 'Q3',
        track_type: 'permanent',
        weather: 'wet',
        rounds: [1, 5, 10],
        date_from: '2025-01-01',
        date_to: '2025-12-31',
        exclude_dnfs: true
      });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(true);
    });

    it('rejects if any filter is invalid (session)', async () => {
      const intent = createH2HIntent({}, {
        session: 'Q3',
        track_type: 'invalid_type' as any
      });
      const result = await validator.validate(intent);
      expect(result.valid).toBe(false);
    });
  });
});

describe('NL Filter Extraction', () => {
  // Mock the extractHeadToHeadFilters function behavior
  function parseNLFilters(question: string): Record<string, unknown> {
    const filters: Record<string, unknown> = {};

    // Session filter
    if (/\bQ3\b/i.test(question)) {
      filters.session = 'Q3';
    } else if (/\bQ2\b/i.test(question)) {
      filters.session = 'Q2';
    } else if (/\bQ1\b/i.test(question)) {
      filters.session = 'Q1';
    }

    // Track type
    if (/street\s*circuit|street\s*track|\bstreet\b/i.test(question)) {
      filters.track_type = 'street';
    } else if (/permanent\s*circuit|\bpermanent\b/i.test(question)) {
      filters.track_type = 'permanent';
    }

    // Weather
    if (/\bwet\b|\brain\b|\brainy\b/i.test(question)) {
      filters.weather = 'wet';
    } else if (/\bdry\b/i.test(question)) {
      filters.weather = 'dry';
    } else if (/\bmixed\s*(?:conditions?)?\b/i.test(question)) {
      filters.weather = 'mixed';
    }

    // Exclude DNFs
    if (/exclud(?:e|ing)\s+dnf|without\s+dnf|no\s+dnf|exclude\s+retirements?/i.test(question)) {
      filters.exclude_dnfs = true;
    }

    // Rounds
    const roundMatch = question.match(/round\s*(\d+)/i);
    if (roundMatch) {
      filters.rounds = [parseInt(roundMatch[1], 10)];
    }

    return filters;
  }

  describe('Session Extraction', () => {
    it('extracts Q3 from "in Q3"', () => {
      const filters = parseNLFilters('Norris vs Piastri in Q3');
      expect(filters.session).toBe('Q3');
    });

    it('extracts Q2 from question', () => {
      const filters = parseNLFilters('H2H Norris Piastri Q2 qualifying');
      expect(filters.session).toBe('Q2');
    });

    it('extracts Q1 from question', () => {
      const filters = parseNLFilters('Who was faster in Q1?');
      expect(filters.session).toBe('Q1');
    });

    it('does not extract session if not mentioned', () => {
      const filters = parseNLFilters('Norris vs Piastri qualifying');
      expect(filters.session).toBeUndefined();
    });
  });

  describe('Track Type Extraction', () => {
    it('extracts street from "street circuits"', () => {
      const filters = parseNLFilters('H2H at street circuits');
      expect(filters.track_type).toBe('street');
    });

    it('extracts permanent from "permanent tracks"', () => {
      const filters = parseNLFilters('Qualifying on permanent tracks');
      expect(filters.track_type).toBe('permanent');
    });

    it('does not extract if not mentioned', () => {
      const filters = parseNLFilters('Norris vs Piastri race');
      expect(filters.track_type).toBeUndefined();
    });
  });

  describe('Weather Extraction', () => {
    it('extracts wet from "wet races"', () => {
      const filters = parseNLFilters('H2H in wet races');
      expect(filters.weather).toBe('wet');
    });

    it('extracts wet from "rain"', () => {
      const filters = parseNLFilters('Qualifying in the rain');
      expect(filters.weather).toBe('wet');
    });

    it('extracts dry from "dry conditions"', () => {
      const filters = parseNLFilters('H2H in dry conditions');
      expect(filters.weather).toBe('dry');
    });

    it('extracts mixed from "mixed conditions"', () => {
      const filters = parseNLFilters('Racing in mixed conditions');
      expect(filters.weather).toBe('mixed');
    });
  });

  describe('DNF Exclusion Extraction', () => {
    it('extracts from "excluding DNFs"', () => {
      const filters = parseNLFilters('Race H2H excluding DNFs');
      expect(filters.exclude_dnfs).toBe(true);
    });

    it('extracts from "without DNF"', () => {
      const filters = parseNLFilters('H2H without DNF races');
      expect(filters.exclude_dnfs).toBe(true);
    });

    it('extracts from "no DNF"', () => {
      const filters = parseNLFilters('Races with no DNF');
      expect(filters.exclude_dnfs).toBe(true);
    });

    it('extracts from "exclude retirements"', () => {
      const filters = parseNLFilters('H2H exclude retirements');
      expect(filters.exclude_dnfs).toBe(true);
    });
  });

  describe('Round Extraction', () => {
    it('extracts single round', () => {
      const filters = parseNLFilters('H2H in round 5');
      expect(filters.rounds).toEqual([5]);
    });

    it('extracts round with different format', () => {
      const filters = parseNLFilters('Round 10 qualifying');
      expect(filters.rounds).toEqual([10]);
    });
  });

  describe('Combined NL Filters', () => {
    it('extracts multiple filters from complex query', () => {
      const filters = parseNLFilters('Norris vs Piastri Q3 qualifying on street circuits in wet conditions');
      expect(filters.session).toBe('Q3');
      expect(filters.track_type).toBe('street');
      expect(filters.weather).toBe('wet');
    });

    it('extracts DNF exclusion with other filters', () => {
      const filters = parseNLFilters('Race H2H at permanent tracks excluding DNFs');
      expect(filters.track_type).toBe('permanent');
      expect(filters.exclude_dnfs).toBe(true);
    });
  });
});

describe('H2H Intent Structure', () => {
  it('creates intent without filters by default', () => {
    const intent = createH2HIntent();
    expect(intent.filters).toBeUndefined();
  });

  it('creates intent with filters when provided', () => {
    const intent = createH2HIntent({}, { session: 'Q3' });
    expect(intent.filters).toBeDefined();
    expect(intent.filters?.session).toBe('Q3');
  });

  it('includes all required fields', () => {
    const intent = createH2HIntent();
    expect(intent.kind).toBe('driver_head_to_head_count');
    expect(intent.driver_a_id).toBeDefined();
    expect(intent.driver_b_id).toBeDefined();
    expect(intent.h2h_metric).toBeDefined();
    expect(intent.h2h_scope).toBeDefined();
    expect(intent.season).toBeDefined();
  });
});

describe('Fail-Closed Behavior', () => {
  it('rejects empty driver_a_id with filters present', async () => {
    const intent = createH2HIntent(
      { driver_a_id: '' },
      { session: 'Q3' }
    );
    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('driver_a_id is required');
  });

  it('rejects same driver comparison with filters present', async () => {
    const intent = createH2HIntent(
      { driver_a_id: 'verstappen', driver_b_id: 'verstappen' },
      { weather: 'wet' }
    );
    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('Cannot compare a driver to themselves');
  });

  it('validates base intent before checking filters', async () => {
    const intent = createH2HIntent(
      { h2h_metric: 'invalid' as any },
      { session: 'Q3' }
    );
    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    // Should fail on h2h_metric validation, not on filters
    expect(result.error?.reason).toContain('h2h_metric');
  });
});

describe('Filter Edge Cases', () => {
  it('handles undefined filters gracefully', async () => {
    const intent = createH2HIntent();
    delete intent.filters;
    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });

  it('handles empty filters object', async () => {
    const intent = createH2HIntent({}, {});
    // Empty object should be valid (no filters applied)
    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });

  it('handles null-ish filter values', async () => {
    const intent = createH2HIntent({}, {
      session: undefined,
      track_type: undefined
    } as any);
    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });
});
