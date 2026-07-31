import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { compilePlannedF1QL, PLANNED_INTEGRITY_FIELD } from '../../src/f1ql/planned-compiler';
import {
  lowerPlannedF1QL,
  parsePlannedF1QLProgram,
  PlannedF1QLProgram
} from '../../src/f1ql/planned-f1ql';
import { interpretPlannedF1QL, PlannedReferenceDatabase } from '../../src/f1ql/planned-interpreter';
import {
  AnswerPlan,
  planSemanticAnswerFromResolution,
  verifyAnswerPlan
} from '../../src/f1ql/semantic-planner';
import {
  collectSemanticResolutionEvidence,
  SemanticDriverMention,
  verifySemanticResolutionEvidence
} from '../../src/f1ql/semantic-resolution-evidence';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticEvidence,
  SemanticLiteralSpan,
  verifySemanticEvidence,
  verifySemanticQueryAdmission
} from '../../src/f1ql/semantic-query';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import {
  plannedDenotationPopulations,
  PlannedDenotationPopulation
} from '../fixtures/planned-denotation-populations';

type Topology = AnswerPlan['topology'];
type MutationCategory = 'source' | 'scope' | 'filter' | 'aggregate' | 'order' | 'limit' | 'join' | 'grain';
type MutationOutcome = 'distinguished' | 'validator_killed' | 'not_applicable';
type DenotationComparison = 'named' | 'ordinal';

interface MutationCase {
  readonly category: MutationCategory;
  readonly outcome: MutationOutcome;
  readonly comparison?: DenotationComparison;
  readonly mutate?: (program: MutableProgram) => void;
}

type MutableProgram = Record<string, any>;

const QUESTIONS = {
  single_source_rows: 'List driver and championship points from final 2025 driver standings.',
  single_source_aggregate: 'Show count of qualifying position in final 2025 qualifying classification.',
  row_dimension_join: 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.',
  scalar_aggregate_compose: 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.'
} as const satisfies Record<Topology, string>;

const CATEGORIES: readonly MutationCategory[] = [
  'source', 'scope', 'filter', 'aggregate', 'order', 'limit', 'join', 'grain'
];

let pool: Pool;

describe.sequential('planned F1QL discriminating populations and denotation', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    await pool.query('ALTER TABLE qualifying_results DROP CONSTRAINT qualifying_results_pkey');
    await pool.query('ALTER TABLE season_driver_standing ALTER COLUMN points DROP NOT NULL');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('distinguishes or fail-closed rejects every promoted-topology mutation on both named populations', async () => {
    expect(plannedDenotationPopulations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(plannedDenotationPopulations.map(population => population.id)).size)
      .toBe(plannedDenotationPopulations.length);
    expect(new Set(plannedDenotationPopulations.map(population => JSON.stringify(referenceDatabase(population)))).size)
      .toBe(plannedDenotationPopulations.length);
    expect(new Set(plannedDenotationPopulations.flatMap(population => population.traits))).toEqual(new Set([
      'duplicate-event-metadata',
      'duplicate-logical-qualifying-row',
      'incomplete-event-metadata',
      'incomplete-qualifying-session-metadata',
      'metric-source-divergence',
      'missing-driver-event-row',
      'missing-driver-session-row',
      'null-points',
      'null-position',
      'sparse-prior-season',
      'sparse-season',
      'tied-points',
      'tied-positions'
    ]));

    const plans = await deriveCanonicalPlans();
    expect(Object.keys(plans).sort()).toEqual([...Object.keys(QUESTIONS)].sort());

    for (const topology of Object.keys(QUESTIONS) as Topology[]) {
      const plan = plans[topology];
      expect(plan.topology).toBe(topology);
      const mutations = mutationsFor(topology);
      expect(mutations.map(mutation => mutation.category)).toEqual(CATEGORIES);

      for (const population of plannedDenotationPopulations) {
        await loadPopulation(pool, population);
        const reference = referenceDatabase(population);
        const canonicalRows = await executeReadOnly(plan.planned_f1ql);
        expect(canonicalRows).toEqual(interpretPlannedF1QL(lowerPlannedF1QL(plan.planned_f1ql), reference));

        for (const mutation of mutations) {
          const raw = structuredClone(plan.planned_f1ql) as MutableProgram;
          if (mutation.outcome === 'not_applicable') {
            expect(mutation.mutate).toBeUndefined();
            continue;
          }
          expect(mutation.mutate).toBeTypeOf('function');
          mutation.mutate!(raw);
          if (mutation.outcome === 'validator_killed') {
            expect(() => parsePlannedF1QLProgram(raw), `${topology}/${mutation.category}`).toThrow();
            continue;
          }

          const mutated = parsePlannedF1QLProgram(raw);
          const mutatedRows = await executeReadOnly(mutated);
          expect(mutatedRows).toEqual(interpretPlannedF1QL(lowerPlannedF1QL(mutated), reference));
          const canonicalDenotation = denotation(canonicalRows, mutation.comparison ?? 'named');
          const mutatedDenotation = denotation(mutatedRows, mutation.comparison ?? 'named');
          expect(mutatedDenotation, `${topology}/${mutation.category}/${population.id}`).not.toEqual(canonicalDenotation);
        }
      }
    }
  }, 120_000);
});

async function deriveCanonicalPlans(): Promise<Record<Topology, AnswerPlan>> {
  const entries: Array<readonly [Topology, AnswerPlan]> = [];
  for (const [topology, question] of Object.entries(QUESTIONS) as Array<[Topology, string]>) {
    const entities = topology === 'scalar_aggregate_compose'
      ? [{ type: 'driver' as const, span: literalSpan(question, 'Norris') }]
      : [];
    const evidence = enumerateSemanticQueries(question, entities);
    expect(evidence.type).toBe('candidate_set');
    verifySemanticEvidence(evidence, question, entities);
    const candidates = (evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>).candidates;
    const admission = admitSemanticQueryCandidates({ version: 2, candidates }, question, evidence);
    expect(admission.type).toBe('admitted');
    if (admission.type !== 'admitted') throw new Error(`canonical ${topology} was not admitted`);
    verifySemanticQueryAdmission(admission, question);

    const mentions: readonly SemanticDriverMention[] = topology === 'scalar_aggregate_compose'
      ? [{
          ...literalSpan(question, 'Norris'),
          candidates: ['historical-norris', 'lando-norris'],
          active_candidates: ['lando-norris']
        }]
      : [];
    const resolution = await collectSemanticResolutionEvidence({
      question,
      admission,
      driver_resolver: { inventoryMentions: async () => mentions },
      event_resolver: {
        resolve: async season => ({ type: 'resolved' as const, season, round: 1 }),
        resolveRound: async (season, round) => ({ type: 'resolved' as const, season, round })
      }
    });
    verifySemanticResolutionEvidence(resolution, question, admission);
    const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
    verifyAnswerPlan(plan);
    entries.push([topology, plan]);
  }
  return Object.fromEntries(entries) as Record<Topology, AnswerPlan>;
}

function mutationsFor(topology: Topology): readonly MutationCase[] {
  if (topology === 'single_source_rows') {
    return [
      mutation('source', 'distinguished', sourceSubstituteRows),
      mutation('scope', 'distinguished', program => setSeason(program, 2024)),
      mutation('filter', 'distinguished', program => addPredicate(rowInput(program), 'driver_standings', 'driver_id', 'lando-norris')),
      mutation('aggregate', 'validator_killed', invalidRowsAggregate),
      mutation('order', 'distinguished', reverseOrder),
      mutation('limit', 'distinguished', program => { program.root.count = 1; }),
      mutation('join', 'validator_killed', invalidRowsJoin),
      mutation('grain', 'validator_killed', removeDriverOutput)
    ];
  }
  if (topology === 'single_source_aggregate') {
    return [
      mutation('source', 'distinguished', sourceSubstituteScalarAggregate, 'ordinal'),
      mutation('scope', 'distinguished', program => setSeason(program, 2024)),
      mutation('filter', 'distinguished', program => addPredicate(aggregateInput(program).input, 'qualifying_classification', 'classification_status', 'dns')),
      mutation('aggregate', 'distinguished', maxSubstituteSingleAggregate, 'ordinal'),
      { category: 'order', outcome: 'not_applicable' },
      { category: 'limit', outcome: 'not_applicable' },
      { category: 'join', outcome: 'not_applicable' },
      mutation('grain', 'distinguished', groupScalarByDriver)
    ];
  }
  if (topology === 'row_dimension_join') {
    return [
      mutation('source', 'validator_killed', invalidJoinSource),
      mutation('scope', 'distinguished', program => setSeason(program, 2024)),
      mutation('filter', 'distinguished', program => addPredicate(joinInput(program).left, 'event_classification', 'classification_status', 'classified')),
      mutation('aggregate', 'validator_killed', invalidJoinAggregate),
      mutation('order', 'distinguished', reverseOrder),
      mutation('limit', 'distinguished', program => { program.root.count = 1; }),
      mutation('join', 'validator_killed', program => { joinInput(program).relationship_id = 'event_identity_race_resolution'; }),
      mutation('grain', 'validator_killed', removeDriverOutput)
    ];
  }
  return [
    mutation('source', 'validator_killed', invalidCompositionSource),
    mutation('scope', 'distinguished', program => setSeason(program, 2024)),
    mutation('filter', 'distinguished', program => setDriver(program, 'oscar-piastri')),
    mutation('aggregate', 'distinguished', maxSubstituteComposition, 'ordinal'),
    { category: 'order', outcome: 'not_applicable' },
    mutation('limit', 'validator_killed', program => { program.root.count = 2; }),
    { category: 'join', outcome: 'not_applicable' },
    mutation('grain', 'validator_killed', program => {
      composeInput(program).inputs[0].group_by = [{ source_id: 'event_classification', concept_id: 'driver_id' }];
    })
  ];
}

function mutation(
  category: MutationCategory,
  outcome: Exclude<MutationOutcome, 'not_applicable'>,
  mutate: (program: MutableProgram) => void,
  comparison: DenotationComparison = 'named'
): MutationCase {
  return { category, outcome, mutate, comparison };
}

function sourceSubstituteRows(program: MutableProgram): void {
  const input = rowInput(program);
  input.input.source_id = 'event_classification';
  input.predicates = [
    predicate('event_classification', 'round', 1),
    predicate('event_classification', 'season', 2025)
  ];
  for (const output of project(program).outputs) output.concept.source_id = 'event_classification';
}

function sourceSubstituteScalarAggregate(program: MutableProgram): void {
  const aggregate = aggregateInput(program);
  replaceBranchSource(aggregate.input, 'event_classification');
  aggregate.measures[0].concept = { source_id: 'event_classification', concept_id: 'finishing_position' };
  renameMeasure(program, aggregate, 0, 'count_finishing_position');
}

function invalidCompositionSource(program: MutableProgram): void {
  composeInput(program).inputs[0].input.input.source_id = 'driver_standings';
}

function maxSubstituteSingleAggregate(program: MutableProgram): void {
  const aggregate = aggregateInput(program);
  aggregate.measures[0].function = 'max';
  renameMeasure(program, aggregate, 0, 'max_qualifying_position');
}

function maxSubstituteComposition(program: MutableProgram): void {
  const aggregate = composeInput(program).inputs[0];
  aggregate.measures[0].function = 'max';
  renameComposedMeasure(program, aggregate, 0, 'event_classification', 'max_finishing_position');
}

function groupScalarByDriver(program: MutableProgram): void {
  const aggregate = aggregateInput(program);
  aggregate.group_by = [{ source_id: 'qualifying_classification', concept_id: 'driver_id' }];
  project(program).outputs.push({
    kind: 'concept', concept: { source_id: 'qualifying_classification', concept_id: 'driver_id' }, as: 'driver_id'
  });
  program.root.input.keys.push({ output_id: 'driver_id', direction: 'asc', nulls: 'last' });
}

function invalidRowsAggregate(program: MutableProgram): void {
  const input = rowInput(program);
  project(program).input = {
    op: 'aggregate',
    input,
    group_by: [{ source_id: 'driver_standings', concept_id: 'driver_id' }],
    measures: [{
      concept: { source_id: 'driver_standings', concept_id: 'points' }, function: 'sum', as: 'sum_points'
    }]
  };
}

function invalidRowsJoin(program: MutableProgram): void {
  const left = rowInput(program);
  project(program).input = {
    op: 'join', relationship_id: 'race_event_metadata', left,
    right: {
      op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
      predicates: [predicate('event_metadata', 'round', 1), predicate('event_metadata', 'season', 2025)]
    }
  };
}

function invalidJoinSource(program: MutableProgram): void {
  const right = joinInput(program).right;
  replaceBranchSource(right, 'qualifying_classification');
}

function invalidJoinAggregate(program: MutableProgram): void {
  const left = joinInput(program).left;
  project(program).input = {
    op: 'aggregate',
    input: left,
    group_by: [{ source_id: 'event_classification', concept_id: 'driver_id' }],
    measures: [{
      concept: { source_id: 'event_classification', concept_id: 'finishing_position' },
      function: 'min',
      as: 'min_finishing_position'
    }]
  };
}

function removeDriverOutput(program: MutableProgram): void {
  project(program).outputs = project(program).outputs.filter((output: MutableProgram) => output.as !== 'driver_id');
  program.root.input.keys = program.root.input.keys.filter((key: MutableProgram) => key.output_id !== 'driver_id');
}

function reverseOrder(program: MutableProgram): void {
  const key = program.root.input.keys[0];
  key.direction = key.direction === 'asc' ? 'desc' : 'asc';
}

function setSeason(program: MutableProgram, season: number): void {
  for (const branch of branches(program)) {
    const scope = branch.predicates.find((item: MutableProgram) => item.concept.concept_id === 'season');
    scope.value = season;
  }
}

function setDriver(program: MutableProgram, driverId: string): void {
  for (const branch of branches(program)) {
    const driver = branch.predicates.find((item: MutableProgram) => item.concept.concept_id === 'driver_id');
    driver.value = driverId;
  }
}

function addPredicate(
  branch: MutableProgram,
  sourceId: string,
  conceptId: string,
  value: string | number
): void {
  branch.predicates.push(predicate(sourceId, conceptId, value));
  branch.predicates.sort((left: MutableProgram, right: MutableProgram) =>
    compareText(
      `${left.concept.source_id}.${left.concept.concept_id}`,
      `${right.concept.source_id}.${right.concept.concept_id}`
    ));
}

function replaceBranchSource(branch: MutableProgram, sourceId: string): void {
  branch.input.source_id = sourceId;
  for (const item of branch.predicates) item.concept.source_id = sourceId;
}

function renameMeasure(program: MutableProgram, aggregate: MutableProgram, index: number, alias: string): void {
  const previous = aggregate.measures[index].as;
  aggregate.measures[index].as = alias;
  const output = project(program).outputs.find((item: MutableProgram) => item.measure_as === previous);
  output.measure_as = alias;
  output.as = alias;
  for (const key of program.root.input.keys) if (key.output_id === previous) key.output_id = alias;
}

function renameComposedMeasure(
  program: MutableProgram,
  aggregate: MutableProgram,
  index: number,
  sourceId: string,
  alias: string
): void {
  const previousSource = aggregate.input.input.source_id;
  const previousAlias = aggregate.measures[index].as;
  aggregate.measures[index].as = alias;
  const output = project(program).outputs.find((item: MutableProgram) =>
    item.source_id === previousSource && item.measure_as === previousAlias);
  const previousOutput = output.as;
  output.source_id = sourceId;
  output.measure_as = alias;
  output.as = `${sourceId}__${alias}`;
  for (const key of program.root.input.keys) if (key.output_id === previousOutput) key.output_id = output.as;
  project(program).outputs.sort((left: MutableProgram, right: MutableProgram) => compareText(left.as, right.as));
}

function branches(program: MutableProgram): MutableProgram[] {
  const input = project(program).input;
  if (input.op === 'join') return [input.left, input.right];
  if (input.op === 'compose') return input.inputs.map((item: MutableProgram) => item.input);
  if (input.op === 'aggregate') return [input.input];
  return [input];
}

function project(program: MutableProgram): MutableProgram {
  return program.root.input.input;
}

function rowInput(program: MutableProgram): MutableProgram {
  return project(program).input;
}

function aggregateInput(program: MutableProgram): MutableProgram {
  return project(program).input;
}

function joinInput(program: MutableProgram): MutableProgram {
  return project(program).input;
}

function composeInput(program: MutableProgram): MutableProgram {
  return project(program).input;
}

function predicate(source_id: string, concept_id: string, value: string | number): MutableProgram {
  return { concept: { source_id, concept_id }, operator: 'eq', value };
}

function denotation(rows: Array<Record<string, unknown>>, comparison: DenotationComparison): unknown {
  const accepted = rows.every(row => row[PLANNED_INTEGRITY_FIELD] === true);
  const visibleRows = rows.map(row => Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== PLANNED_INTEGRITY_FIELD)
  ));
  if (comparison === 'named') return { accepted, rows: visibleRows };
  return {
    accepted,
    rows: visibleRows.map(row => Object.values(row))
  };
}

async function executeReadOnly(program: PlannedF1QLProgram): Promise<Array<Record<string, unknown>>> {
  const compiled = compilePlannedF1QL(lowerPlannedF1QL(program));
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['2000ms']);
    const result = await client.query(compiled.sql, compiled.params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original query failure.
  }
}

async function loadPopulation(database: Pool, population: PlannedDenotationPopulation): Promise<void> {
  await database.query('TRUNCATE race_data, race, qualifying_results, season_driver_standing');
  for (let index = 0; index < population.standings.length; index += 1) {
    const row = population.standings[index];
    await database.query(`INSERT INTO season_driver_standing
      (year, position_display_order, position_number, driver_id, points, championship_won)
      VALUES ($1, $2, $3, $4, $5, $6)`, [
      row.season, index + 1, row.championship_position, databaseDriverId(row.driver_id), row.points, row.championship_won
    ]);
  }
  for (let eventIndex = 0; eventIndex < population.events.length; eventIndex += 1) {
    const event = population.events[eventIndex];
    const raceId = 90_000 + eventIndex;
    await database.query(`INSERT INTO race
      (id, year, round, circuit_id, grand_prix_id, official_name, date)
      VALUES ($1, $2, $3, $4, NULL, $5, $6)`, [
      raceId, event.season, event.round, event.circuit_id, event.event_name, event.date
    ]);
    for (let rowIndex = 0; rowIndex < event.classifications.length; rowIndex += 1) {
      const row = event.classifications[rowIndex];
      await database.query(`INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number,
          position_text, race_reason_retired, race_points)
        VALUES ($1, 'race', $2, $3, $4, $5, $6, $7, $8)`, [
        raceId,
        databaseDriverId(row.driver_id),
        row.team_id,
        rowIndex + 1,
        row.finishing_position,
        row.classification_status === 'dns' ? 'DNS' : null,
        row.classification_status === 'dnf' ? row.status_reason ?? 'dnf' : null,
        row.points
      ]);
    }
  }
  for (const row of population.qualifying) {
    await database.query(`INSERT INTO qualifying_results
      (season, round, driver_id, team_id, qualifying_position, session_type, best_time_ms,
        best_session, eliminated_in_round, is_dnf, is_dns)
      VALUES ($1, $2, $3, $4, $5, 'RACE_QUALIFYING', $6, $7, $8, $9, $10)`, [
      row.season,
      row.round,
      databaseDriverId(row.driver_id),
      row.team_id,
      row.qualifying_position,
      row.best_time_ms,
      row.best_session,
      row.eliminated_in_round,
      row.classification_status === 'dnf',
      row.classification_status === 'dns'
    ]);
  }
}

function referenceDatabase(population: PlannedDenotationPopulation): PlannedReferenceDatabase {
  return {
    driver_standings: population.standings.map(row => ({ ...row })),
    event_classification: population.events.flatMap(event => event.classifications.map(row => ({
      season: event.season,
      round: event.round,
      ...row
    }))),
    event_metadata: population.events.map(event => ({
      season: event.season,
      round: event.round,
      event_id: event.event_id,
      event_name: event.event_name,
      circuit_id: event.circuit_id,
      date: event.date
    })),
    qualifying_classification: population.qualifying.map(row => ({ ...row }))
  };
}

function literalSpan(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}

function databaseDriverId(driverId: string): string {
  return driverId.replaceAll('-', '_');
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  if (left > right) {return 1;}
  return 0;
}
