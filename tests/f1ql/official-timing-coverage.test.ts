import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from '../../src/f1ql/official-event-mean';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from '../../src/f1ql/official-lap-window';
import {
  OfficialTimingCoverageError,
  readOfficialTimingCoverage
} from '../../src/f1ql/official-timing-coverage';
import {
  WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL,
  WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL
} from '../../src/f1ql/wp12-official-timing-activation-bundle';

const eventRequest = {
  metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
  season: 2022,
  round: 14,
  session_type: 'R',
  driver_ids: ['max-verstappen', 'fernando-alonso']
} as const;

const windowRequest = {
  metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
  season: 2022,
  round: 14,
  session_type: 'R',
  driver_ids: ['max-verstappen', 'fernando-alonso'],
  lap_start: 3,
  lap_end: 10
} as const;

function coverageRow(driverId: string, overrides: Record<string, unknown> = {}) {
  return {
    driver_id: driverId,
    completed_laps: 44,
    eligible_laps: 42,
    deleted_laps: 1,
    pit_marker_laps: 1,
    first_lap: 1,
    last_lap: 44,
    distinct_laps: 44,
    dataset_count: 1,
    ...overrides
  };
}

function fakeDatabase(rows: unknown[], failingSql?: string) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (failingSql === sql) {throw new Error('closed database failure');}
    return {
      command: sql.startsWith('SELECT') ? 'SELECT' : sql.split(' ')[0],
      rowCount: sql.startsWith('SELECT') ? rows.length : null,
      oid: 0,
      fields: [],
      rows: sql.startsWith('SELECT') ? rows : []
    };
  });
  return {
    database: { connect: vi.fn(async () => ({ query, release })) } as any,
    query,
    release
  };
}

describe('official timing fixed coverage reader', () => {
  it('reads complete event coverage once and restores request driver order', async () => {
    const harness = fakeDatabase([
      coverageRow('fernando-alonso', { completed_laps: 44, eligible_laps: 42, deleted_laps: 0, pit_marker_laps: 2 }),
      coverageRow('max-verstappen')
    ]);
    const decision = await readOfficialTimingCoverage(harness.database, eventRequest);
    expect(decision).toMatchObject({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
      coverage_query_id: 'official_event_coverage_v1',
      coverage_query_sha256: createHash('sha256').update(WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL).digest('hex'),
      query_calls: 1,
      driver_coverage: [
        {
          driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 42,
          excluded_deleted_laps: 1, excluded_pit_marker_laps: 1
        },
        {
          driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 42,
          excluded_deleted_laps: 0, excluded_pit_marker_laps: 2
        }
      ]
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.type === 'eligible' && decision.driver_coverage[0])).toBe(true);
    expect(harness.query.mock.calls).toEqual([
      ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],
      ["SET LOCAL statement_timeout = '2000ms'"],
      [WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL, [2022, 14, ['max-verstappen', 'fernando-alonso']]],
      ['COMMIT']
    ]);
    expect(harness.release).toHaveBeenCalledWith(undefined);
  });

  it('accepts asymmetric complete event counts and the exact two-lap eligibility minimum', async () => {
    const asymmetric = fakeDatabase([
      coverageRow('max-verstappen'),
      coverageRow('nicholas-latifi', {
        completed_laps: 43, eligible_laps: 2, deleted_laps: 41, pit_marker_laps: 0,
        last_lap: 43, distinct_laps: 43
      })
    ]);
    await expect(readOfficialTimingCoverage(asymmetric.database, {
      ...eventRequest,
      driver_ids: ['nicholas-latifi', 'max-verstappen']
    })).resolves.toMatchObject({
      type: 'eligible',
      driver_coverage: [
        { driver_id: 'nicholas-latifi', completed_laps: 43, eligible_laps: 2, excluded_deleted_laps: 41 },
        { driver_id: 'max-verstappen', completed_laps: 44 }
      ]
    });
  });

  it('uses only the fixed bounded window statement and exact parameter order', async () => {
    const rows = [
      coverageRow('fernando-alonso', { completed_laps: 8, eligible_laps: 8, deleted_laps: 0, pit_marker_laps: 0, first_lap: 3, last_lap: 10, distinct_laps: 8 }),
      coverageRow('max-verstappen', { completed_laps: 8, eligible_laps: 7, deleted_laps: 0, pit_marker_laps: 1, first_lap: 3, last_lap: 10, distinct_laps: 8 })
    ];
    const harness = fakeDatabase(rows);
    await expect(readOfficialTimingCoverage(harness.database, windowRequest)).resolves.toMatchObject({
      type: 'eligible',
      coverage_query_id: 'official_window_coverage_v1',
      query_calls: 1
    });
    expect(harness.query).toHaveBeenNthCalledWith(3, WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL, [
      2022, 14, ['max-verstappen', 'fernando-alonso'], 3, 10
    ]);
  });

  it.each([
    ['insufficient event eligibility', [coverageRow('fernando-alonso', { eligible_laps: 1, deleted_laps: 42, pit_marker_laps: 1 }), coverageRow('max-verstappen')]],
    ['incomplete window', [
      coverageRow('fernando-alonso', { completed_laps: 7, eligible_laps: 7, deleted_laps: 0, pit_marker_laps: 0, first_lap: 3, last_lap: 9, distinct_laps: 7 }),
      coverageRow('max-verstappen', { completed_laps: 8, eligible_laps: 8, deleted_laps: 0, pit_marker_laps: 0, first_lap: 3, last_lap: 10, distinct_laps: 8 })
    ]]
  ])('returns source coverage abstention for %s', async (_name, rows) => {
    const request = _name === 'incomplete window' ? windowRequest : eventRequest;
    await expect(readOfficialTimingCoverage(fakeDatabase(rows).database, request)).resolves.toEqual({
      type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1
    });
  });

  it('treats the certified zero-lap identity as missing coverage without accepting disappearance of positive coverage', async () => {
    await expect(readOfficialTimingCoverage(fakeDatabase([coverageRow('fernando-alonso')]).database, {
      ...eventRequest,
      driver_ids: ['fernando-alonso', 'lewis-hamilton']
    })).resolves.toEqual({
      type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1
    });
    await expect(readOfficialTimingCoverage(fakeDatabase([coverageRow('max-verstappen')]).database, eventRequest)).resolves.toEqual({
      type: 'abstain', reason: 'source_integrity_failed', stage: 'official_timing_integrity', query_calls: 1
    });
  });

  it.each([
    ['unknown field', [coverageRow('fernando-alonso', { extra: true }), coverageRow('max-verstappen')]],
    ['unexpected driver', [coverageRow('other-driver'), coverageRow('max-verstappen')]],
    ['duplicate driver', [coverageRow('max-verstappen'), coverageRow('max-verstappen')]],
    ['multiple datasets', [coverageRow('fernando-alonso', { dataset_count: 2 }), coverageRow('max-verstappen')]],
    ['overlapping exclusion arithmetic', [coverageRow('fernando-alonso', { deleted_laps: 2 }), coverageRow('max-verstappen')]],
    ['duplicate lap count', [coverageRow('fernando-alonso', { distinct_laps: 43 }), coverageRow('max-verstappen')]],
    ['broken event sequence', [coverageRow('fernando-alonso', { first_lap: 2 }), coverageRow('max-verstappen')]],
    ['truncated event sequence', [
      coverageRow('fernando-alonso', { completed_laps: 43, eligible_laps: 41, deleted_laps: 1, pit_marker_laps: 1, last_lap: 43, distinct_laps: 43 }),
      coverageRow('max-verstappen')
    ]],
    ['truncated event below eligibility minimum', [
      coverageRow('fernando-alonso', { completed_laps: 1, eligible_laps: 1, deleted_laps: 0, pit_marker_laps: 0, last_lap: 1, distinct_laps: 1 }),
      coverageRow('max-verstappen')
    ]],
    ['unsafe integer', [coverageRow('fernando-alonso', { eligible_laps: Number.MAX_SAFE_INTEGER + 1 }), coverageRow('max-verstappen')]],
    ['too many rows', [coverageRow('fernando-alonso'), coverageRow('max-verstappen'), coverageRow('other-driver')]]
  ])('returns source integrity abstention for %s', async (_name, rows) => {
    await expect(readOfficialTimingCoverage(fakeDatabase(rows).database, eventRequest)).resolves.toEqual({
      type: 'abstain', reason: 'source_integrity_failed', stage: 'official_timing_integrity', query_calls: 1
    });
  });

  it('rejects requests outside the exact certified metric and scope before connection acquisition', async () => {
    const harness = fakeDatabase([]);
    await expect(readOfficialTimingCoverage(harness.database, { ...eventRequest, season: 2021 })).rejects.toThrow();
    await expect(readOfficialTimingCoverage(harness.database, { ...eventRequest, driver_ids: ['max-verstappen', 'max-verstappen'] })).rejects.toThrow();
    await expect(readOfficialTimingCoverage(harness.database, { ...windowRequest, lap_end: 53 })).rejects.toThrow();
    await expect(readOfficialTimingCoverage(harness.database, { ...eventRequest, extra: true })).rejects.toThrow();
    await expect(readOfficialTimingCoverage(harness.database, { ...eventRequest, driver_ids: ['unknown-driver', 'max-verstappen'] })).rejects.toThrow();
    await expect(readOfficialTimingCoverage(harness.database, { ...windowRequest, lap_start: 2147483648, lap_end: 2147483649 })).rejects.toThrow();
    expect(harness.database.connect).not.toHaveBeenCalled();
  });

  it('rolls back and discards the client when the fixed coverage query fails', async () => {
    const harness = fakeDatabase([], WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL);
    await expect(readOfficialTimingCoverage(harness.database, eventRequest)).rejects.toEqual(
      new OfficialTimingCoverageError('coverage_query_failed')
    );
    expect(harness.query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL,
      'ROLLBACK'
    ]);
    expect(harness.release).toHaveBeenCalledWith(expect.any(OfficialTimingCoverageError));
  });

  it('closes connection failures without exposing database details', async () => {
    const database = { connect: vi.fn(async () => {throw new Error('credential-bearing failure');}) } as any;
    await expect(readOfficialTimingCoverage(database, eventRequest)).rejects.toEqual(
      new OfficialTimingCoverageError('connection_failed')
    );
  });

  it('wall-clock bounds a stalled coverage read and discards without queuing rollback', async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      const query = vi.fn((sql: string) => {
        if (sql.startsWith('SELECT')) {return new Promise(() => undefined);}
        return Promise.resolve({ command: 'OK', rowCount: null, oid: 0, fields: [], rows: [] });
      });
      const pending = readOfficialTimingCoverage({ connect: vi.fn(async () => ({ query, release })) } as any, eventRequest);
      const rejection = expect(pending).rejects.toMatchObject({ code: 'coverage_query_failed' });
      await vi.advanceTimersByTimeAsync(2001);
      await rejection;
      expect(query.mock.calls.map(call => call[0])).toEqual([
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        "SET LOCAL statement_timeout = '2000ms'",
        WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL
      ]);
      expect(release).toHaveBeenCalledWith(expect.any(OfficialTimingCoverageError));
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no translated-result execution dependency', () => {
    const source = fs.readFileSync('src/f1ql/official-timing-coverage.ts', 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const forbidden of ['executor', 'interpreter', 'semantic-plan-execution', 'semantic-result-format']) {
      expect(imports.some(specifier => specifier.includes(forbidden))).toBe(false);
    }
  });
});
