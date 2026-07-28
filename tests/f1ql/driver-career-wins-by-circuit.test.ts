import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { canonicalProgramEntities } from '../../src/f1ql/answer-observations';
import { compileF1QL } from '../../src/f1ql/compiler';
import {
  DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID,
  DRIVER_CAREER_WIN_SEASONS,
  DRIVER_CAREER_WIN_SOURCE_ROUND_BRANCHES
} from '../../src/f1ql/driver-career-wins-by-circuit';
import { executeF1QL, executeF1QLReadOnly } from '../../src/f1ql/executor';
import { EventClassificationRow, EventMetadataRow, interpretDriverCareerWinsByCircuit } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';

function program(driverId = 'lewis-hamilton'): F1QLProgram {
  return {
    version: 1,
    root: {
      op: 'driver_career_wins_by_circuit',
      metric: DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID,
      seasons: [...DRIVER_CAREER_WIN_SEASONS],
      driver_id: driverId
    }
  };
}

function classification(season: number, round: number, position: number, driverId = 'lewis-hamilton'): EventClassificationRow {
  return {
    season, round, driver_id: driverId, team_id: null, finishing_position: position,
    points: 0, classification_status: 'classified', status_reason: null
  };
}

function metadata(season: number, round: number, circuitId: string | null, eventId = `event-${season}`): EventMetadataRow {
  return { season, round, circuit_id: circuitId, event_id: eventId, event_name: `Event ${season}`, date: `${season}-01-01` };
}

const classificationRows = [
  classification(2020, 1, 1), classification(2021, 1, 1), classification(2022, 1, 1), classification(2023, 1, 1),
  classification(2024, 1, 2), classification(2026, 1, 1), classification(2025, 1, 1, 'other-driver')
];
const metadataRows = [
  metadata(2020, 1, 'silverstone', 'british-grand-prix'),
  metadata(2021, 1, 'silverstone', 'seventy-anniversary-grand-prix'),
  metadata(2022, 1, 'monza', 'shared-name'),
  metadata(2023, 1, 'bahrain', 'shared-name'),
  metadata(2024, 1, 'spa'),
  metadata(2025, 1, 'suzuka'),
  metadata(2026, 1, 'future-circuit')
];

const validExpected = [
  { circuit_id: 'silverstone', wins: 2 },
  { circuit_id: 'bahrain', wins: 1 },
  { circuit_id: 'monza', wins: 1 }
].map(value => ({
  metric_id: DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID,
  driver_id: 'lewis-hamilton',
  ...value,
  winner_source_rows: 4,
  distinct_winner_event_keys: 4,
  duplicate_winner_rows: 0,
  metadata_source_rows: 4,
  distinct_metadata_event_keys: 4,
  missing_event_metadata_rows: 0,
  duplicate_event_metadata_rows: 0,
  missing_circuit_id_rows: 0,
  source_presence_ok: true,
  source_integrity_ok: true
}));

let pool: Pool;

async function executeCore(input: F1QLProgram): Promise<Array<Record<string, unknown>>> {
  const core = lowerF1QL(input);
  validateCoreProgram(core);
  const compiled = compileF1QL(core);
  return (await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  for (const row of metadataRows) {
    await pool.query(
      `INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.season, row.season, row.round, row.circuit_id, row.event_id, row.event_name, row.date]
    );
  }
  for (const row of classificationRows) {
    const raceId = row.season;
    await pool.query(
      `INSERT INTO race_data (race_id, type, driver_id, position_number, position_text, race_points) VALUES ($1, 'RACE', $2, $3, $4, 0)`,
      [raceId, row.driver_id.replaceAll('-', '_'), row.finishing_position, String(row.finishing_position)]
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe('canonical driver career race wins by circuit foundation', () => {
  it('closes the surface to one canonical driver, metric, and exact ordered completed-season scope', () => {
    const parsed = parseF1QLProgram(program());
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, seasons: DRIVER_CAREER_WIN_SEASONS.slice(1) } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, seasons: [...DRIVER_CAREER_WIN_SEASONS].reverse() } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, seasons: [...DRIVER_CAREER_WIN_SEASONS.slice(0, -1), 2026] } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, metric: 'other' } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, driver_id: 'Lewis Hamilton' } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, round: 1 } })).toThrow();
    expect(() => parseF1QLProgramCandidate(program())).toThrow();
    expect(authorizeAnswerProgram(parsed)).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
  });

  it('lowers through generic filters, left join, and aggregate with fail-closed integrity', () => {
    const core = lowerF1QL(program('driver-z'));
    expect(core.root).toEqual({
      op: 'aggregate',
      input: {
        op: 'join', type: 'left', on: ['season', 'round'],
        left: {
          op: 'filter',
          input: { op: 'filter', input: { op: 'source', source: 'event_classification' }, where: { season: DRIVER_CAREER_WIN_SEASONS, finishing_position: [1] } },
          where: { driver_id: 'driver-z' }
        },
        right: { op: 'filter', input: { op: 'source', source: 'event_metadata' }, where: { season: DRIVER_CAREER_WIN_SEASONS } }
      },
      group_by: ['circuit_id'],
      measures: [{ as: 'wins', function: 'count' }],
      source_integrity: {
        left_key: ['season', 'round'], left_key_scope: 'before_outer_filter', right_key: ['season', 'round'], require_unique_left_keys: true,
        require_exactly_one_right_match: true, require_non_null_right_fields: ['circuit_id']
      }
    });
    validateCoreProgram(core);
    const compiled = compileF1QL(core);
    expect(compiled.params).toEqual([DRIVER_CAREER_WIN_SEASONS, 'driver-z', DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID]);
    expect(compiled.sql).toContain('FROM f1ql.event_classification');
    expect(compiled.sql).toContain('FROM f1ql.event_metadata');
    expect(compiled.sql).not.toContain('driver-z');
    expect(compiled.sql).not.toContain('race_data');
    expect(canonicalProgramEntities(program('driver-z'))).toEqual(['driver:driver-z']);
    expect(renderF1QL(program('driver-z'))).toContain('grouped only by canonical circuit_id');
  });

  it('independently rejects source, join, scope, grouping, measure, and integrity mutations', () => {
    const mutate = (change: (root: any) => void) => {
      const core = lowerF1QL(program());
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
      expect(() => compileF1QL(core)).toThrow();
      expect(() => interpretDriverCareerWinsByCircuit(core, classificationRows, metadataRows)).toThrow();
    };
    mutate(root => { root.input.left.input.input.source = 'qualifying_classification'; });
    mutate(root => { root.input.right.input.source = 'event_classification'; });
    mutate(root => { root.input.type = 'inner'; });
    mutate(root => { root.input.on = ['round']; });
    mutate(root => { root.input.left.input.where.finishing_position = [1, 2]; });
    mutate(root => { root.input.right.where.season = DRIVER_CAREER_WIN_SEASONS.slice(1); });
    mutate(root => { root.group_by = ['event_id']; });
    mutate(root => { root.measures[0].as = 'total'; });
    mutate(root => { root.source_integrity.require_unique_left_keys = false; });
    mutate(root => { root.source_integrity.left_key_scope = undefined; });
    mutate(root => { root.source_integrity.require_exactly_one_right_match = false; });
    mutate(root => { root.source_integrity.require_non_null_right_fields = []; });
  });

  it('charges both complete 76-season source branches without a caller bypass', () => {
    const parsed = parseF1QLProgram(program());
    expect(DRIVER_CAREER_WIN_SOURCE_ROUND_BRANCHES).toBe(4560);
    expect(estimateF1QLCost(parsed)).toEqual({ source_round_branches: 4560 });
    expect(() => enforceF1QLCostLimits(parsed)).not.toThrow();
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 4559 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 4561 })).toThrow(F1QLCostLimitError);
  });

  it('groups only by circuit_id, excludes non-P1 and 2026 rows, and matches SQL/reference ordering', async () => {
    const core = lowerF1QL(program());
    expect(interpretDriverCareerWinsByCircuit(core, classificationRows, metadataRows)).toEqual(validExpected);
    expect(await executeCore(program())).toEqual(validExpected);
    await expect(executeF1QL(pool, program())).resolves.toMatchObject({ rows: validExpected });
  });

  it('invalidates duplicate winners, missing or duplicate metadata, and missing circuit identity globally', async () => {
    const core = lowerF1QL(program());
    const duplicateWinner = interpretDriverCareerWinsByCircuit(core, [...classificationRows, classification(2020, 1, 1, 'other-winner')], metadataRows);
    expect(duplicateWinner).toEqual([expect.objectContaining({ duplicate_winner_rows: 1, source_integrity_ok: false, circuit_id: null, wins: null })]);
    expect(interpretDriverCareerWinsByCircuit(core, classificationRows, metadataRows.filter(row => row.season !== 2020)))
      .toEqual([expect.objectContaining({ missing_event_metadata_rows: 1, source_integrity_ok: false })]);
    expect(interpretDriverCareerWinsByCircuit(core, classificationRows, [...metadataRows, metadata(2020, 1, 'silverstone', 'duplicate')]))
      .toEqual([expect.objectContaining({ duplicate_event_metadata_rows: 1, source_integrity_ok: false })]);
    expect(interpretDriverCareerWinsByCircuit(core, classificationRows, metadataRows.map(row => row.season === 2020 ? { ...row, circuit_id: null } : row)))
      .toEqual([expect.objectContaining({ missing_circuit_id_rows: 1, source_integrity_ok: false })]);

    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, position_text, race_points) VALUES (2020, 'RACE_RESULT', 'other_winner', 1, '1', 0)`);
    expect(await executeCore(program())).toEqual([expect.objectContaining({ duplicate_winner_rows: 1, source_integrity_ok: false, circuit_id: null, wins: null })]);
  });
});
