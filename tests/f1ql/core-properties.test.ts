import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileF1QL } from '../../src/f1ql/compiler';
import { CoreAggregateNode, CoreFilterNode, CorePipelineNode, CoreProgram } from '../../src/f1ql/core';
import { validateCoreProgram } from '../../src/f1ql/validation';

const LIMIT_MAX = 20;
const RUNS = 100;

const driverId = fc.integer({ min: 1, max: 20 }).map((value) => `driver-${value}`);
const teamId = fc.integer({ min: 1, max: 10 }).map((value) => `team-${value}`);
const season = fc.integer({ min: 2020, max: 2026 });
const round = fc.integer({ min: 1, max: 24 });
const limit = fc.integer({ min: 1, max: LIMIT_MAX });

function applyFilters(input: CorePipelineNode, filters: CoreFilterNode['where'][]): CorePipelineNode {
  return filters.reduce<CorePipelineNode>((current, where) => ({ op: 'filter', input: current, where } as CoreFilterNode), input);
}

const standingsProgram = fc.record({
  season: fc.option(season, { nil: undefined }),
  driver: fc.option(driverId, { nil: undefined }),
  rank: fc.boolean(),
  measure: fc.constantFrom<CoreAggregateNode['measures'][number]>(
    { as: 'points', function: 'sum', field: 'points' },
    { as: 'entries', function: 'count' }
  ),
  limit
}).map(({ season: year, driver, rank, measure, limit: rowLimit }): CoreProgram => {
  const where = { ...(year === undefined ? {} : { season: year }), ...(driver === undefined ? {} : { driver_id: driver }) };
  const aggregate: CoreAggregateNode = {
    op: 'aggregate',
    input: Object.keys(where).length === 0
      ? { op: 'source', source: 'standings' }
      : { op: 'filter', input: { op: 'source', source: 'standings' }, where },
    group_by: ['driver_id'],
    measures: [measure]
  };
  return {
    version: 1,
    root: rank ? { op: 'limit', input: { op: 'sort', input: aggregate, by: measure.as, direction: 'desc' }, limit: rowLimit } : aggregate
  };
});

function classificationProgram(source: 'event_classification' | 'qualifying_classification'): fc.Arbitrary<CoreProgram> {
  return fc.record({
    season,
    round,
    statuses: fc.option(fc.uniqueArray(fc.constantFrom('classified', 'dnf', 'dns'), { minLength: 1, maxLength: 3 }), { nil: undefined }),
    driver: fc.option(driverId, { nil: undefined }),
    team: fc.option(teamId, { nil: undefined }),
    direction: fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
    nulls: fc.constantFrom<'first' | 'last'>('first', 'last'),
    limit
  }).map(({ season, round, statuses, driver, team, direction, nulls, limit }): CoreProgram => ({
    version: 1,
    root: {
      op: 'limit',
      input: {
        op: 'sort',
        input: applyFilters({ op: 'source', source }, [
          { season, round },
          ...(statuses === undefined ? [] : [{ classification_status: statuses }]),
          ...(driver === undefined ? [] : [{ driver_id: driver }]),
          ...(team === undefined ? [] : [{ team_id: team }])
        ]),
        by: source === 'event_classification' ? 'finishing_position' : 'qualifying_position',
        direction,
        nulls
      },
      limit
    }
  }));
}

const eventMetadataProgram = fc.record({ season, round, sessionScope: fc.constantFrom<'race' | 'qualifying'>('race', 'qualifying') })
  .map(({ season, round, sessionScope }): CoreProgram => ({
    version: 1,
    root: applyFilters({ op: 'source', source: 'event_metadata' }, [{ season, round }, { session_scope: sessionScope }]) as CoreFilterNode
  }));

const paceSummaryProgram = fc.record({ season, driver: driverId, rounds: fc.option(fc.uniqueArray(round, { minLength: 1, maxLength: 6 }), { nil: undefined }), cleanAirOnly: fc.boolean(), compound: fc.option(fc.constantFrom('MEDIUM', 'SOFT', 'HARD'), { nil: undefined }) })
  .map(({ season, driver, rounds, cleanAirOnly, compound }): CoreProgram => ({
    version: 1,
    root: {
      op: 'aggregate',
      input: {
        op: 'aggregate',
        input: {
          op: 'filter',
          input: { op: 'source', source: 'lap_pace' },
          where: {
            season,
            driver_id: driver,
            lap_time_seconds: 'not_null',
            is_valid_lap: true,
            is_pit_lap: false,
            is_in_lap: false,
            is_out_lap: false,
            clean_air_only: cleanAirOnly,
            ...(rounds === undefined ? {} : { rounds }),
            ...(compound === undefined ? {} : { compound })
          }
        },
        group_by: ['round'],
        measures: [{ as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }]
      },
      group_by: [],
      measures: [{ as: 'events', function: 'count' }, { as: 'avg_lap_time_seconds', function: 'avg', field: 'median_lap_time_seconds' }]
    }
  }));

const paceDeltaProgram = fc.record({ season, left: driverId, right: driverId.filter((value) => value !== 'driver-1'), rounds: fc.option(fc.uniqueArray(round, { minLength: 1, maxLength: 6 }), { nil: undefined }), cleanAirOnly: fc.boolean(), compound: fc.option(fc.constantFrom('MEDIUM', 'SOFT', 'HARD'), { nil: undefined }) })
  .map(({ season, left, right, rounds, cleanAirOnly, compound }): CoreProgram => {
    const median = (driver: string): CoreAggregateNode => ({
      op: 'aggregate',
      input: {
        op: 'filter',
        input: { op: 'source', source: 'lap_pace' },
        where: { season, driver_id: driver, lap_time_seconds: 'not_null', is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_only: cleanAirOnly, ...(rounds === undefined ? {} : { rounds }), ...(compound === undefined ? {} : { compound }) }
      },
      group_by: ['round'],
      measures: [{ as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }]
    });
    return {
      version: 1,
      root: {
        op: 'delta',
        input: { op: 'compare', input: { op: 'join', left: median(left), right: median(right), on: ['round'], type: 'inner' }, left: { field: 'median_lap_time_seconds', as: 'driver_a_median' }, right: { field: 'median_lap_time_seconds', as: 'driver_b_median' } },
        left_id: left,
        right_id: right
      }
    };
  });

const coreProgram = fc.oneof(
  standingsProgram,
  classificationProgram('event_classification'),
  classificationProgram('qualifying_classification'),
  eventMetadataProgram,
  paceSummaryProgram,
  paceDeltaProgram
);

describe('bounded core IR properties', () => {
  it('validates and compiles signature-approved programs without producing write SQL', () => {
    fc.assert(fc.property(coreProgram, (program) => {
      expect(() => validateCoreProgram(program)).not.toThrow();
      const compiled = compileF1QL(program);

      expect(compiled.sql).toMatch(/^\s*(WITH|SELECT)\b/i);
      expect(compiled.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE)\b/i);
      expect(compiled.sql).not.toContain(';');
      const placeholders = [...new Set(compiled.sql.match(/\$\d+/g) ?? [])].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
      expect(placeholders).toEqual(Array.from({ length: compiled.params.length }, (_, index) => `$${index + 1}`));
    }), { numRuns: RUNS, seed: 20260721 });
  });
});
