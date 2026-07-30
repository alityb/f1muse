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
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
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
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 30,
      input: {
        op: 'sort',
        keys: [
          { output_id: 'finishing_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
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
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
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
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'event_name', direction: 'desc', nulls: 'last' },
          { output_id: 'round', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'season', 2025)]
          },
          outputs: [
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'round'), as: 'round' }
          ]
        }
      }
    }
  };
}

function emptyScalarCountPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
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
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'points', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
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
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' }
          ]
        }
      }
    }
  };
}

function scalarCompositionPlan() {
  const aggregate = (sourceId: 'event_classification' | 'qualifying_classification', driverId: string) => {
    const conceptId = sourceId === 'event_classification' ? 'finishing_position' : 'qualifying_position';
    return {
      op: 'aggregate',
      input: {
        op: 'filter', input: { op: 'source', source_id: sourceId },
        predicates: [predicate(sourceId, 'driver_id', driverId), predicate(sourceId, 'season', 2025)]
      },
      group_by: [],
      measures: [{ concept: ref(sourceId, conceptId), function: 'count', as: `count_${conceptId}` }]
    };
  };
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort',
        keys: [{ output_id: 'event_classification__count_finishing_position', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'compose',
            inputs: [aggregate('event_classification', 'alpha-driver'), aggregate('qualifying_classification', 'beta-driver')]
          },
          outputs: [
            {
              kind: 'composed_aggregate', source_id: 'event_classification',
              measure_as: 'count_finishing_position', as: 'event_classification__count_finishing_position'
            },
            {
              kind: 'composed_aggregate', source_id: 'qualifying_classification',
              measure_as: 'count_qualifying_position', as: 'qualifying_classification__count_qualifying_position'
            }
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
    const composition = parsePlannedF1QLProgram(scalarCompositionPlan());
    expect(estimatePlannedF1QLCost(composition)).toEqual({
      version: 'planned-cost-v1', units: 60, sources: 2, joins: 0, depth: 6, requested_rows: 1
    });
    expect(decidePlannedParticipation(composition)).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['alpha-driver', 'beta-driver'] }]
    });
    const core = lowerPlannedF1QL(composition);
    expect(core).toMatchObject({ version: 2, dialect: 'planned_f1ql_v2' });
    expect(core.root.input.input.output_grain).toEqual([]);
    expect(core.root.input.input.integrity).toContain('scalar_input_cardinality');
  });

  it.each([
    ['catalog substitution', (plan: any) => { plan.catalog_hash = '0'.repeat(64); }],
    ['v1 surface downgrade', (plan: any) => { plan.version = 1; }],
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

  it.each([
    ['one input', (plan: any) => { plan.root.input.input.input.inputs.pop(); }],
    ['duplicate source', (plan: any) => { plan.root.input.input.input.inputs[1] = structuredClone(plan.root.input.input.input.inputs[0]); }],
    ['noncanonical source order', (plan: any) => { plan.root.input.input.input.inputs.reverse(); }],
    ['grouped child', (plan: any) => { plan.root.input.input.input.inputs[0].group_by = [ref('event_classification', 'driver_id')]; }],
    ['non-equality season', (plan: any) => { const season = plan.root.input.input.input.inputs[0].input.predicates[1]; season.operator = 'in'; season.values = [season.value]; delete season.value; }],
    ['different season', (plan: any) => { plan.root.input.input.input.inputs[1].input.predicates[1].value = 2024; }],
    ['mixed round scope', (plan: any) => { plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1)); }],
    ['different round scope', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1));
      plan.root.input.input.input.inputs[1].input.predicates.splice(1, 0, predicate('qualifying_classification', 'round', 2));
    }],
    ['singleton IN round', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, {
        concept: ref('event_classification', 'round'), operator: 'in', values: [1]
      });
    }],
    ['singleton range round', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, {
        concept: ref('event_classification', 'round'), operator: 'range', min: 1, max: 1
      });
    }],
    ['limit above one', (plan: any) => { plan.root.count = 2; }],
    ['unqualified output alias', (plan: any) => { plan.root.input.input.outputs[0].as = 'count_finishing_position'; }],
    ['missing child measure projection', (plan: any) => { plan.root.input.input.outputs.pop(); }],
    ['extra concept projection', (plan: any) => { plan.root.input.input.outputs.push({ kind: 'concept', concept: ref('event_classification', 'season'), as: 'season' }); }],
    ['substituted output source', (plan: any) => { plan.root.input.input.outputs[0].source_id = 'qualifying_classification'; }]
  ])('rejects scalar composition surface mutation: %s', (_name, mutate) => {
    const plan: any = structuredClone(scalarCompositionPlan());
    mutate(plan);
    expect(() => parsePlannedF1QLProgram(plan)).toThrow();
  });

  it('sums scalar child work and rejects compositions above the 60-unit bound', () => {
    const roundScoped: any = structuredClone(scalarCompositionPlan());
    roundScoped.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1));
    roundScoped.root.input.input.input.inputs[1].input.predicates.splice(1, 0, predicate('qualifying_classification', 'round', 1));
    expect(estimatePlannedF1QLCost(roundScoped)).toMatchObject({ units: 2, sources: 2, joins: 0, depth: 6 });

    const overBudget: any = structuredClone(scalarCompositionPlan());
    overBudget.root.input.input.input.inputs.unshift({
      op: 'aggregate',
      input: {
        op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
        predicates: [predicate('driver_standings', 'driver_id', 'alpha-driver'), predicate('driver_standings', 'season', 2025)]
      },
      group_by: [],
      measures: [{ concept: ref('driver_standings', 'championship_position'), function: 'min', as: 'min_championship_position' }]
    });
    overBudget.root.input.input.outputs.unshift({
      kind: 'composed_aggregate', source_id: 'driver_standings',
      measure_as: 'min_championship_position', as: 'driver_standings__min_championship_position'
    });
    expect(parsePlannedF1QLProgram(overBudget)).toBeTruthy();
    expect(() => estimatePlannedF1QLCost(overBudget)).toThrow('exceeds 60 units');
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

    const omittedResidualGrain: any = structuredClone(lowerPlannedF1QL(eventMetadataRowsPlan()));
    omittedResidualGrain.root.input.input.outputs = omittedResidualGrain.root.input.input.outputs
      .filter((output: any) => output.as !== 'round');
    omittedResidualGrain.root.input.keys = omittedResidualGrain.root.input.keys
      .filter((key: any) => key.output_id !== 'round');
    omittedResidualGrain.root.input.input.output_grain = [];
    omittedResidualGrain.result_schema = omittedResidualGrain.result_schema
      .filter((field: any) => field.id !== 'round');
    expect(() => validatePlannedCoreProgram(omittedResidualGrain)).toThrow('must include grain key round');
    expect(() => compilePlannedF1QL(omittedResidualGrain)).toThrow('must include grain key round');

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

  it.each([
    ['v1 version', (core: any) => { core.version = 1; }],
    ['v1 dialect', (core: any) => { core.dialect = 'planned_f1ql_v1'; }],
    ['source order', (core: any) => { core.root.input.input.input.inputs.reverse(); }],
    ['duplicate source', (core: any) => { core.root.input.input.input.inputs[1] = structuredClone(core.root.input.input.input.inputs[0]); }],
    ['grouped child', (core: any) => {
      const child = core.root.input.input.input.inputs[0];
      child.group_by = [structuredClone(child.input.input.grain[0])];
      child.output_grain = structuredClone(child.group_by);
    }],
    ['season scope', (core: any) => { core.root.input.input.input.inputs[1].input.predicates[1].value = 2024; }],
    ['singleton IN round', (core: any) => {
      const child = core.root.input.input.input.inputs[0].input;
      child.predicates.splice(1, 0, {
        concept: structuredClone(child.input.grain.find((item: any) => item.concept_id === 'round')),
        operator: 'in', values: [1]
      });
    }],
    ['singleton range round', (core: any) => {
      const child = core.root.input.input.input.inputs[0].input;
      child.predicates.splice(1, 0, {
        concept: structuredClone(child.input.grain.find((item: any) => item.concept_id === 'round')),
        operator: 'range', min: 1, max: 1
      });
    }],
    ['scalar marker', (core: any) => {
      core.root.input.input.input.integrity = core.root.input.input.input.integrity.filter((item: string) => item !== 'scalar_input_cardinality');
    }],
    ['output grain', (core: any) => { core.root.input.input.input.output_grain = [structuredClone(core.root.input.input.input.inputs[0].input.input.grain[0])]; }],
    ['child integrity', (core: any) => { core.root.input.input.input.inputs[0].integrity = []; }],
    ['output alias', (core: any) => { core.root.input.input.outputs[0].as = 'count_finishing_position'; }],
    ['output source', (core: any) => { core.root.input.input.outputs[0].source_id = 'qualifying_classification'; }],
    ['extra concept output', (core: any) => {
      core.root.input.input.outputs.push({
        kind: 'concept', as: 'season', concept: structuredClone(core.root.input.input.input.inputs[0].input.input.grain[2])
      });
      core.result_schema.push({ id: 'season', physical_type: 'integer', semantic_type: 'season', nullable: false });
    }],
    ['result schema', (core: any) => { core.result_schema[0].semantic_type = 'position'; }],
    ['limit', (core: any) => { core.root.count = 2; }]
  ])('independently rejects scalar composition Core mutation: %s', (_name, mutate) => {
    const core: any = structuredClone(lowerPlannedF1QL(scalarCompositionPlan()));
    mutate(core);
    expect(() => validatePlannedCoreProgram(core)).toThrow();
    expect(() => compilePlannedF1QL(core)).toThrow();
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

    const compositionParent = preparePlannedF1QLParent(scalarCompositionPlan());
    expect(verifyPlannedF1QLParent(compositionParent)).toBe(compositionParent);
    expect(compositionParent.core_program).toMatchObject({ version: 2, dialect: 'planned_f1ql_v2' });
    expect(() => parseF1QLProgram(compositionParent.program)).toThrow();
    expect(readFileSync('src/f1ql/planned-compiler.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);
    expect(readFileSync('src/f1ql/planned-interpreter.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);
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

  it('independently aggregates and CROSS JOINs scalar sources with differential integrity', async () => {
    const core = lowerPlannedF1QL(scalarCompositionPlan());
    const compiled = compilePlannedF1QL(core);
    expect(compiled.sql).toContain('CROSS JOIN');
    expect(compiled.sql).toContain('"planned_scalar_event_classification"');
    expect(compiled.sql).toContain('"planned_scalar_qualifying_classification"');
    expect(compiled.sql).toContain('AND');
    expect(compiled.params).toEqual([2025, 'alpha-driver', 2025, 'beta-driver', 1]);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' },
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' }
      ],
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 1,
      [PLANNED_INTEGRITY_FIELD]: true
    }]);

    const missingPlan: any = structuredClone(scalarCompositionPlan());
    missingPlan.root.input.input.input.inputs[1].input.predicates[0].value = 'missing-driver';
    const missingCore = lowerPlannedF1QL(missingPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 0,
      [PLANNED_INTEGRITY_FIELD]: false
    }]);
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
      { event_name: '\u00c9clair Grand Prix', round: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: 'Formula 1 Planned Grand Prix', round: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: null, round: 2, [PLANNED_INTEGRITY_FIELD]: true }
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
      { points: '9007199254740993', driver_id: 'alpha-driver', [PLANNED_INTEGRITY_FIELD]: true },
      { points: '9007199254740992', driver_id: 'beta-driver', [PLANNED_INTEGRITY_FIELD]: true }
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
