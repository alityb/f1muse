import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { compilePlannedF1QL, PLANNED_INTEGRITY_FIELD } from '../../src/f1ql/planned-compiler';
import {
  decidePlannedParticipation,
  estimatePlannedF1QLCost,
  getPlannedCoreProgramHash,
  getPlannedF1QLProgramHash,
  lowerPlannedF1QL,
  parsePlannedF1QLProgram,
  validatePlannedCoreProgram
} from '../../src/f1ql/planned-f1ql';
import { interpretPlannedF1QL, PlannedReferenceDatabase } from '../../src/f1ql/planned-interpreter';
import { preparePlannedF1QLParent, verifyPlannedF1QLParent } from '../../src/f1ql/planned-pipeline';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

const ref = (source_id: string, concept_id: string) => ({ source_id, concept_id });
const predicate = (source_id: string, concept_id: string, value: string | number) => ({
  concept: ref(source_id, concept_id), operator: 'eq', value
});

function qualifyingRankPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort',
        keys: [
          { output_id: 'count_qualifying_position', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: 'qualifying_classification' },
              predicates: [
                { concept: ref('qualifying_classification', 'qualifying_position'), operator: 'range', min: 1, max: 10 },
                predicate('qualifying_classification', 'season', 2025)
              ]
            },
            group_by: [ref('qualifying_classification', 'driver_id')],
            measures: [{ concept: ref('qualifying_classification', 'qualifying_position'), function: 'count', as: 'count_qualifying_position' }]
          },
          outputs: [
            { kind: 'concept', concept: ref('qualifying_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'aggregate', measure_as: 'count_qualifying_position', as: 'count_qualifying_position' }
          ]
        }
      }
    }
  };
}

function raceMetadataPlan() {
  const raceScope = [
    predicate('event_classification', 'round', 1),
    predicate('event_classification', 'season', 2025)
  ];
  const metadataScope = [
    predicate('event_metadata', 'round', 1),
    predicate('event_metadata', 'season', 2025)
  ];
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 30,
      input: {
        op: 'sort',
        keys: [
          { output_id: 'finishing_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' },
          { output_id: 'round', direction: 'asc', nulls: 'last' },
          { output_id: 'season', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'join', relationship_id: 'race_event_metadata',
            left: { op: 'filter', input: { op: 'source', source_id: 'event_classification' }, predicates: raceScope },
            right: { op: 'filter', input: { op: 'source', source_id: 'event_metadata' }, predicates: metadataScope }
          },
          outputs: [
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('event_classification', 'finishing_position'), as: 'finishing_position' },
            { kind: 'concept', concept: ref('event_classification', 'round'), as: 'round' },
            { kind: 'concept', concept: ref('event_classification', 'season'), as: 'season' },
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'circuit_id'), as: 'circuit_id' }
          ]
        }
      }
    }
  };
}

function standingsRankPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 2,
      input: {
        op: 'sort', keys: [
          { output_id: 'min_championship_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
              predicates: [
                { concept: ref('driver_standings', 'driver_id'), operator: 'in', values: ['alpha-driver', 'beta-driver'] },
                predicate('driver_standings', 'season', 2025)
              ]
            },
            group_by: [ref('driver_standings', 'driver_id')],
            measures: [{ concept: ref('driver_standings', 'championship_position'), function: 'min', as: 'min_championship_position' }]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'aggregate', measure_as: 'min_championship_position', as: 'min_championship_position' }
          ]
        }
      }
    }
  };
}

function eventMetadataRowsPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'event_name', direction: 'desc', nulls: 'last' },
          { output_id: 'round', direction: 'asc', nulls: 'last' },
          { output_id: 'season', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'season', 2025)]
          },
          outputs: [
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'round'), as: 'round' },
            { kind: 'concept', concept: ref('event_metadata', 'season'), as: 'season' }
          ]
        }
      }
    }
  };
}

function emptyScalarCountPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: 'count_qualifying_position', direction: 'desc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: 'qualifying_classification' },
              predicates: [
                predicate('qualifying_classification', 'classification_status', 'dns'),
                predicate('qualifying_classification', 'season', 2025)
              ]
            },
            group_by: [],
            measures: [{ concept: ref('qualifying_classification', 'qualifying_position'), function: 'count', as: 'count_qualifying_position' }]
          },
          outputs: [{ kind: 'aggregate', measure_as: 'count_qualifying_position', as: 'count_qualifying_position' }]
        }
      }
    }
  };
}

function eventPointsPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 1, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'points', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' },
          { output_id: 'round', direction: 'asc', nulls: 'last' },
          { output_id: 'season', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_classification' },
            predicates: [
              predicate('event_classification', 'round', 1),
              predicate('event_classification', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('event_classification', 'points'), as: 'points' },
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('event_classification', 'round'), as: 'round' },
            { kind: 'concept', concept: ref('event_classification', 'season'), as: 'season' }
          ]
        }
      }
    }
  };
}

describe('internal planned F1QL and Core pipeline', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    await pool.query(`
      INSERT INTO driver (id, name, full_name, abbreviation) VALUES
        ('alpha_driver', 'Alpha', 'Alpha Driver', 'ALP'), ('beta_driver', 'Beta', 'Beta Driver', 'BET');
      INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
        ('planned_gp', 'Planned GP', 'Formula 1 Planned Grand Prix', 'Planned', 'PLN'),
        ('unicode_gp', 'Unicode GP', chr(201) || 'clair Grand Prix', 'Unicode', 'UNI');
      INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES
          (9801, 2025, 1, 'planned_gp', 'planned-circuit', 'FORMULA 1 PLANNED GRAND PRIX', '2025-01-01'),
          (9802, 2025, 2, NULL, 'empty-circuit', NULL, '2025-02-01'),
          (9803, 2025, 3, 'unicode_gp', 'unicode-circuit', NULL, '2025-03-01');
      INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points) VALUES
        (9801, 'race', 'beta_driver', 'planned-team', 2, 2, 9007199254740992),
        (9801, 'race', 'alpha_driver', 'planned-team', 1, 1, 9007199254740993);
      INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type) VALUES
        (2025, 1, 'beta_driver', 'planned-team', 2, 'RACE_QUALIFYING'),
        (2025, 1, 'alpha_driver', 'planned-team', 1, 'RACE_QUALIFYING'),
        (2025, 2, 'outside_driver', 'planned-team', 11, 'RACE_QUALIFYING');
      INSERT INTO season_driver_standing
        (year, position_display_order, position_number, driver_id, points, championship_won) VALUES
        (2025, 1, 1, 'alpha_driver', 100, true),
        (2025, 2, 2, 'beta_driver', 90, false);
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('strictly parses, freezes, hashes, costs, and derives participation for promoted plans', () => {
    const ranking = parsePlannedF1QLProgram(qualifyingRankPlan());
    expect(Object.isFrozen(ranking)).toBe(true);
    expect(Object.isFrozen(ranking.root.input.keys)).toBe(true);
    expect(getPlannedF1QLProgramHash(ranking)).toMatch(/^[a-f0-9]{64}$/);
    expect(estimatePlannedF1QLCost(ranking)).toEqual({
      version: 'planned-cost-v1', units: 30, sources: 1, joins: 0, depth: 5, requested_rows: 10
    });
    expect(decidePlannedParticipation(ranking)).toEqual({ type: 'not_required' });

    expect(estimatePlannedF1QLCost(raceMetadataPlan())).toMatchObject({ units: 2, sources: 2, joins: 1, requested_rows: 30 });
    expect(decidePlannedParticipation(standingsRankPlan())).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['alpha-driver', 'beta-driver'] }]
    });
  });

  it.each([
    ['catalog substitution', (plan: any) => { plan.catalog_hash = '0'.repeat(64); }],
    ['extra field', (plan: any) => { plan.sql = 'SELECT 1'; }],
    ['source substitution', (plan: any) => { plan.root.input.input.input.input.input.source_id = 'event_metadata'; }],
    ['predicate source substitution', (plan: any) => { plan.root.input.input.input.input.predicates[0].concept.source_id = 'event_metadata'; }],
    ['unapproved aggregation', (plan: any) => { const aggregate = plan.root.input.input.input; aggregate.measures[0] = { concept: ref('driver_standings', 'points'), function: 'sum', as: 'sum_points' }; }],
    ['noncanonical measure ID', (plan: any) => { plan.root.input.input.input.measures[0].as = 'position'; }],
    ['missing grain output', (plan: any) => { plan.root.input.input.outputs = plan.root.input.input.outputs.filter((item: any) => item.as !== 'driver_id'); }],
    ['missing grain tie key', (plan: any) => { plan.root.input.keys = plan.root.input.keys.filter((item: any) => item.output_id !== 'driver_id'); }],
    ['duplicate sort key', (plan: any) => { plan.root.input.keys.push(structuredClone(plan.root.input.keys[0])); }],
    ['uncanonical IN values', (plan: any) => { plan.root.input.input.input.input.predicates[0].values = ['beta-driver', 'alpha-driver']; }],
    ['uncanonical predicate order', (plan: any) => { plan.root.input.input.input.input.predicates.reverse(); }]
  ])('rejects %s', (_name, mutate) => {
    const plan: any = structuredClone(standingsRankPlan());
    mutate(plan);
    expect(() => parsePlannedF1QLProgram(plan)).toThrow();
  });

  it('rejects join scope, direction, source, and relationship mutations', () => {
    const wrongScope: any = structuredClone(raceMetadataPlan());
    wrongScope.root.input.input.input.right.predicates[0].value = 2;
    expect(() => parsePlannedF1QLProgram(wrongScope)).toThrow('same exact event scope');

    const wrongRelationship: any = structuredClone(raceMetadataPlan());
    wrongRelationship.root.input.input.input.relationship_id = 'event_identity_race_resolution';
    expect(() => parsePlannedF1QLProgram(wrongRelationship)).toThrow('not a promoted row join');

    const core: any = structuredClone(lowerPlannedF1QL(raceMetadataPlan()));
    core.root.input.input.input.type = 'inner';
    expect(() => validatePlannedCoreProgram(core)).toThrow('catalog relationship');
    const wrongView: any = structuredClone(lowerPlannedF1QL(raceMetadataPlan()));
    wrongView.root.input.input.input.left.input.view = 'f1ql.qualifying_classification';
    expect(() => validatePlannedCoreProgram(wrongView)).toThrow('active catalog');
  });

  it('rejects out-of-domain literals before lowering', () => {
    const badPosition: any = structuredClone(qualifyingRankPlan());
    badPosition.root.input.input.input.input.predicates[0].max = 31;
    expect(() => parsePlannedF1QLProgram(badPosition)).toThrow('position literal is outside supported bounds');

    const badRound: any = structuredClone(raceMetadataPlan());
    badRound.root.input.input.input.left.predicates[0].value = 31;
    badRound.root.input.input.input.right.predicates[0].value = 31;
    expect(() => parsePlannedF1QLProgram(badRound)).toThrow('round literal is outside supported bounds');

    const badDate: any = structuredClone(eventMetadataRowsPlan());
    badDate.root.input.input.input.predicates.unshift({
      concept: ref('event_metadata', 'date'), operator: 'eq', value: '2025-02-30'
    });
    expect(() => parsePlannedF1QLProgram(badDate)).toThrow('date literal is invalid');
  });

  it('independently rejects forged Core before SQL compilation', () => {
    const injectedSort: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    injectedSort.root.input.keys[0].direction = 'desc; drop table race';
    expect(() => compilePlannedF1QL(injectedSort)).toThrow();

    const omittedIntegrity: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    omittedIntegrity.root.input.input.input.input.integrity = [];
    expect(() => compilePlannedF1QL(omittedIntegrity)).toThrow();

    const substitutedField: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    substitutedField.root.input.input.input.input.predicates[0].concept.physical_field = 'points';
    expect(() => compilePlannedF1QL(substitutedField)).toThrow();

    const substitutedSchema: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    substitutedSchema.result_schema[0].semantic_type = 'team_id';
    expect(() => compilePlannedF1QL(substitutedSchema)).toThrow();

    const accessorCore: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    let directionReads = 0;
    accessorCore.root.input.keys[0] = new Proxy(accessorCore.root.input.keys[0], {
      get(target, property, receiver) {
        if (property === 'direction') return directionReads++ === 0 ? 'desc' : 'desc; drop table race';
        return Reflect.get(target, property, receiver);
      }
    });
    expect(compilePlannedF1QL(accessorCore).sql).not.toContain('drop table');
  });

  it('prepares only runtime-provenance parents and never exposes the planned dialect through public F1QL', () => {
    const parent = preparePlannedF1QLParent(qualifyingRankPlan());
    expect(verifyPlannedF1QLParent(parent)).toBe(parent);
    expect(parent.program_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parent.core_hash).toBe(getPlannedCoreProgramHash(parent.core_program));
    expect(Object.isFrozen(parent)).toBe(true);
    expect(() => verifyPlannedF1QLParent({ ...parent })).toThrow('provenance');
    expect(() => parseF1QLProgram(parent.program)).toThrow();

    const executorSource = readFileSync('src/f1ql/executor.ts', 'utf8');
    const routeSource = readFileSync('src/api/routes/program.ts', 'utf8');
    expect(executorSource).not.toMatch(/planned-(f1ql|compiler|pipeline)/);
    expect(routeSource).not.toMatch(/planned-(f1ql|compiler|pipeline)/);
    expect(readFileSync('src/f1ql/planned-pipeline.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);
  });

  it('compiles only catalog identifiers and parameterizes every literal and limit', () => {
    const compiled = compilePlannedF1QL(lowerPlannedF1QL(raceMetadataPlan()));
    expect(compiled.sql).toContain('f1ql.event_classification');
    expect(compiled.sql).toContain('f1ql.event_metadata');
    expect(compiled.sql).toContain('LEFT JOIN');
    expect(compiled.sql).toContain('COLLATE "C"');
    expect(compiled.sql).not.toContain('2025');
    expect(compiled.params).toEqual([1, 2025, 1, 2025, 30]);
    expect(compiled.sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3', '$4', '$5']);
  });

  it('matches PostgreSQL for a catalog-bound single-source aggregate rank', async () => {
    const core = lowerPlannedF1QL(qualifyingRankPlan());
    const compiled = compilePlannedF1QL(core);
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', team_id: 'planned-team', qualifying_position: 2, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', team_id: 'planned-team', qualifying_position: 1, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' },
        { season: 2025, round: 2, driver_id: 'outside-driver', team_id: 'planned-team', qualifying_position: 11, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' }
      ]
    };
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL for standings ranking with participation-bound drivers', async () => {
    const core = lowerPlannedF1QL(standingsRankPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: 100 },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: 90 }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', min_championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', min_championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL row projection under descending nulls-last and UTF-8 byte ordering', async () => {
    const core = lowerPlannedF1QL(eventMetadataRowsPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [
        { season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix', circuit_id: 'planned-circuit', date: '2025-01-01' },
        { season: 2025, round: 2, event_id: 'empty-circuit', event_name: null, circuit_id: 'empty-circuit', date: '2025-02-01' },
        { season: 2025, round: 3, event_id: 'unicode-gp', event_name: '\u00c9clair Grand Prix', circuit_id: 'unicode-circuit', date: '2025-03-01' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { event_name: '\u00c9clair Grand Prix', round: 3, season: 2025, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: 'Formula 1 Planned Grand Prix', round: 1, season: 2025, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: null, round: 2, season: 2025, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL exact numeric projection and ordering beyond safe integers', async () => {
    const core = lowerPlannedF1QL(eventPointsPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { points: '9007199254740993', driver_id: 'alpha-driver', round: 1, season: 2025, [PLANNED_INTEGRITY_FIELD]: true },
      { points: '9007199254740992', driver_id: 'beta-driver', round: 1, season: 2025, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('preserves valid source integrity for a scalar zero-count result', async () => {
    const core = lowerPlannedF1QL(emptyScalarCountPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingDriverPlan: any = structuredClone(emptyScalarCountPlan());
    missingDriverPlan.root.input.input.input.input.predicates.splice(1, 0,
      predicate('qualifying_classification', 'driver_id', 'missing-driver'));
    const missingCore = lowerPlannedF1QL(missingDriverPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);
  });

  it('propagates relevant-position corruption globally before ranking and limit', async () => {
    const plan: any = structuredClone(qualifyingRankPlan());
    plan.root.count = 1;
    plan.root.input.input.input.input.predicates.unshift(
      predicate('qualifying_classification', 'driver_id', 'alpha-driver'));
    const core = lowerPlannedF1QL(plan);
    const compiled = compilePlannedF1QL(core);
    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2025, 1, 'gamma_driver', 'planned-team', 2, 'RACE_QUALIFYING')`);
      const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
      const reference: PlannedReferenceDatabase = {
        qualifying_classification: [
          { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
          { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
          { season: 2025, round: 1, driver_id: 'gamma-driver', qualifying_position: 2, classification_status: 'classified' }
        ]
      };
      expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
      expect(sqlRows).toHaveLength(1);
      expect(sqlRows[0][PLANNED_INTEGRITY_FIELD]).toBe(false);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for the typed many-to-one metadata join and exposes duplicate-target failure', async () => {
    const core = lowerPlannedF1QL(raceMetadataPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', team_id: 'planned-team', finishing_position: 2, points: '9007199254740992', classification_status: 'classified', status_reason: null },
        { season: 2025, round: 1, driver_id: 'alpha-driver', team_id: 'planned-team', finishing_position: 1, points: '9007199254740993', classification_status: 'classified', status_reason: null }
      ],
      event_metadata: [
        { season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix', circuit_id: 'planned-circuit', date: '2025-01-01' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows.map(row => row[PLANNED_INTEGRITY_FIELD])).toEqual([true, true]);

    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9804, 2025, 1, 'planned_gp', 'other-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
      const duplicateRows = (await pool.query(compiled.sql, compiled.params)).rows;
      expect(duplicateRows).toHaveLength(4);
      expect(duplicateRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
    } finally {
      await pool.query('ROLLBACK');
    }
  });
});
