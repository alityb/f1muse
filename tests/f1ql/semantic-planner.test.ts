import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AnswerPlannerError,
  planSemanticAnswer,
  SemanticDriverMention,
  verifyAnswerPlan
} from '../../src/f1ql/semantic-planner';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticEvidence,
  SemanticLiteralSpan
} from '../../src/f1ql/semantic-query';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const QUALIFYING_METADATA = 'List driver, qualifying position, race date, event name, and circuit identifier for Lando Norris and Oscar Piastri from round 1 of final 2025 qualifying classification and event metadata.';
const NAMED_RACE_METADATA = 'List driver and finishing position and event name from final 2025 race classification and event metadata at Monaco.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const UNFILTERED_COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification in final 2025.';
const SCALAR_COUNT = 'Show count of qualifying position in final 2025 qualifying classification.';
const RACE_SCALAR_COUNT = 'Show count of finishing position in final 2025 race classification.';
const FILTERED_RACE_SCALAR_COUNT = 'Show count of finishing position for Norris in final 2025 race classification.';
const FILTERED_QUALIFYING_SCALAR_COUNT = 'Show count of qualifying position for Norris in final 2025 qualifying classification.';
const QUALIFYING_COUNT_RANK = 'Show top 10 drivers by count of qualifying position in final 2025 qualifying classification.';
const RACE_COUNT_RANK = 'Show top 10 drivers by count of finishing position in final 2025 race classification.';
const SINGLETON_STANDINGS_POSITION = 'List driver and championship position for Norris from final 2025 driver standings.';
const MULTI_STANDINGS_POSITION = 'List driver and championship position for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const MULTI_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const EVENT_DATE_NAME = 'List race date and event name from round 1 of final 2025 event metadata.';
const NAMED_EVENT_DATE_NAME = 'List event name and race date from final 2025 event metadata at Monaco.';
const EVENT_DATE_CIRCUIT = 'List circuit identifier and race date from round 1 of final 2025 event metadata.';
const EVENT_NAME_CIRCUIT = 'List circuit identifier and event name from round 1 of final 2025 event metadata.';
const EVENT_ALL_METADATA = 'List circuit identifier, event name, and race date from round 1 of final 2025 event metadata.';

describe('deterministic semantic planner', () => {
  it('materializes a frozen deterministic single-source row plan from a live admission', async () => {
    const admission = admitted(STANDINGS);
    const dependencies = resolvers([]);
    const first = await planSemanticAnswer({ question: STANDINGS, admission, ...dependencies });
    const second = await planSemanticAnswer({ question: STANDINGS, admission, ...dependencies });

    expect(first).toMatchObject({
      topology: 'single_source_rows',
      source_graph: { source_ids: ['driver_standings'], row_relationship_ids: [] },
      output_grain: ['driver_id'],
      work: { source_scan_units: 1, resolver_reads: 1, sources: 1, row_joins: 0, compositions: 0, operator_depth: 4 }
    });
    expect(first.branches[0]).toMatchObject({
      source_id: 'driver_standings', fixed_grain: ['season'], residual_grain: ['driver_id']
    });
    expect(first.answer_plan_hash).toBe(second.answer_plan_hash);
    expect(first.planned_f1ql_hash).toBe(second.planned_f1ql_hash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.planned_f1ql.root)).toBe(true);
    expect(verifyAnswerPlan(first)).toBe(first);
    expect(() => verifyAnswerPlan({ ...first })).toThrow('provenance');
  });

  it('binds one resolved driver to one recorded final championship-position row', async () => {
    const norris = span(SINGLETON_STANDINGS_POSITION, 'Norris');
    const admission = admitted(SINGLETON_STANDINGS_POSITION, [{ type: 'driver', span: norris }]);
    const plan = await planSemanticAnswer({
      question: SINGLETON_STANDINGS_POSITION,
      admission,
      ...resolvers([{
        ...norris,
        candidates: ['historical-norris', 'lando-norris'],
        active_candidates: ['lando-norris']
      }])
    });
    expect(plan).toMatchObject({
      topology: 'single_source_rows',
      source_graph: { source_ids: ['driver_standings'] },
      output_grain: [],
      work: { source_scan_units: 1, resolver_reads: 1, requested_rows: 1 }
    });
    expect(plan.linked_entities[0]).toMatchObject({
      selected_id: 'lando-norris',
      resolution_relationship_ids: ['driver_identity_standings_resolution', 'driver_participation_resolution']
    });
    expect(plan.branches[0].predicates).toMatchObject([
      { concept: { concept_id: 'driver_id' }, operator: 'eq', value: 'lando-norris' },
      { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
    ]);
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 1,
      input: { keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }] }
    });
  });

  it.each([MULTI_STANDINGS_POSITION, MULTI_STANDINGS_SUMMARY])(
    'binds multiple resolved drivers to non-ranking recorded standings rows: %s', async question => {
    const lando = span(question, 'Lando Norris');
    const oscar = span(question, 'Oscar Piastri');
    const admission = admitted(question, [
      { type: 'driver', span: lando }, { type: 'driver', span: oscar }
    ]);
    const plan = await planSemanticAnswer({
      question,
      admission,
      ...resolvers([
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ])
    });
    expect(plan).toMatchObject({
      topology: 'single_source_rows',
      source_graph: { source_ids: ['driver_standings'] },
      output_grain: ['driver_id'],
      work: { source_scan_units: 1, resolver_reads: 1, requested_rows: 100 }
    });
    expect(plan.branches[0]).toMatchObject({
      fixed_grain: ['season'], residual_grain: ['driver_id'],
      predicates: [
        {
          concept: { concept_id: 'driver_id' }, operator: 'in',
          values: ['lando-norris', 'oscar-piastri']
        },
        { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
      ]
    });
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 100,
      input: { keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }] }
    });
  });

  it('selects only the reviewed many-to-one metadata edge and verifies the round', async () => {
    const admission = admitted(RACE_METADATA);
    const plan = await planSemanticAnswer({
      question: RACE_METADATA,
      admission,
      ...resolvers([], { type: 'resolved', season: 2025, round: 1 })
    });
    expect(plan).toMatchObject({
      topology: 'row_dimension_join',
      source_graph: {
        source_ids: ['event_classification', 'event_metadata'],
        row_relationship_ids: ['race_event_metadata']
      },
      output_grain: ['driver_id'],
      work: { source_scan_units: 2, resolver_reads: 2, sources: 2, row_joins: 1, operator_depth: 5 }
    });
    expect(plan.branches.map(branch => branch.fixed_grain)).toEqual([
      ['round', 'season'], ['round', 'season']
    ]);
  });

  it('orients qualifying metadata from the relationship endpoint, not canonical source order', async () => {
    const lando = span(QUALIFYING_METADATA, 'Lando Norris');
    const oscar = span(QUALIFYING_METADATA, 'Oscar Piastri');
    const admission = admitted(QUALIFYING_METADATA, [
      { type: 'driver', span: lando }, { type: 'driver', span: oscar }
    ]);
    const plan = await planSemanticAnswer({
      question: QUALIFYING_METADATA,
      admission,
      ...resolvers([
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ], { type: 'resolved', season: 2025, round: 1 })
    });
    expect(plan).toMatchObject({
      topology: 'row_dimension_join',
      source_graph: {
        source_ids: ['event_metadata', 'qualifying_classification'],
        row_relationship_ids: ['qualifying_event_metadata']
      },
      output_grain: ['driver_id'],
      work: { requested_rows: 100 }
    });
    expect(plan.planned_f1ql.root.input.input.input).toMatchObject({
      relationship_id: 'qualifying_event_metadata',
      left: { input: { source_id: 'qualifying_classification' } },
      right: { input: { source_id: 'event_metadata' } }
    });
  });

  it('links a named event and binds every retained resolver candidate into the plan hash', async () => {
    const event = { type: 'event', span: span(NAMED_RACE_METADATA, 'Monaco') };
    const admission = admitted(NAMED_RACE_METADATA, [event]);
    const plan = await planSemanticAnswer({
      question: NAMED_RACE_METADATA,
      admission,
      ...resolvers([], { type: 'resolved', season: 2025, round: 8 })
    });
    expect(plan.linked_entities).toEqual([
      expect.objectContaining({
        type: 'event', selected_id: 'event:2025:8', candidate_ids: ['event:2025:8'],
        resolution_relationship_ids: ['event_identity_metadata_resolution', 'event_identity_race_resolution']
      })
    ]);
    expect(plan.branches.every(branch => branch.predicates.some(predicate =>
      predicate.concept.concept_id === 'round' && predicate.operator === 'eq' && predicate.value === 8))).toBe(true);
  });

  it.each([
    [EVENT_DATE_NAME, [], ['date', 'event_name']],
    [NAMED_EVENT_DATE_NAME, [{ type: 'event', span: span(NAMED_EVENT_DATE_NAME, 'Monaco') }], ['date', 'event_name']],
    [EVENT_DATE_CIRCUIT, [], ['date', 'circuit_id']],
    [EVENT_NAME_CIRCUIT, [], ['event_name', 'circuit_id']],
    [EVENT_ALL_METADATA, [], ['date', 'event_name', 'circuit_id']]
  ])('plans one canonical event metadata row: %s', async (question, entities, outputIds) => {
    const admission = admitted(question, entities);
    const plan = await planSemanticAnswer({
      question,
      admission,
      ...resolvers([], { type: 'resolved', season: 2025, round: 1 })
    });
    expect(plan).toMatchObject({
      topology: 'single_source_rows',
      source_graph: { source_ids: ['event_metadata'], row_relationship_ids: [] },
      output_grain: [],
      work: { source_scan_units: 1, requested_rows: 1 }
    });
    expect(plan.planned_f1ql.root.input.input.outputs.map(output => output.as))
      .toEqual(outputIds);
    expect(plan.branches[0]).toMatchObject({
      fixed_grain: ['round', 'season'], residual_grain: [],
      predicates: [
        { concept: { concept_id: 'round' }, operator: 'eq', value: 1 },
        { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
      ]
    });
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 1,
      input: { keys: [{ output_id: outputIds[0], direction: 'asc', nulls: 'last' }] }
    });
  });

  it('aggregates each source before composing one bounded scalar row', async () => {
    const norrisSpan = span(COMPOSE, 'Norris');
    const admission = admitted(COMPOSE, [{ type: 'driver', span: norrisSpan }]);
    const mention: SemanticDriverMention = {
      ...norrisSpan,
      candidates: ['historical-norris', 'lando-norris'],
      active_candidates: ['lando-norris']
    };
    const plan = await planSemanticAnswer({ question: COMPOSE, admission, ...resolvers([mention]) });

    expect(plan).toMatchObject({
      topology: 'scalar_aggregate_compose',
      source_graph: { source_ids: ['event_classification', 'qualifying_classification'], row_relationship_ids: [] },
      output_grain: [],
      work: { source_scan_units: 60, resolver_reads: 1, sources: 2, row_joins: 0, compositions: 1, operator_depth: 6, requested_rows: 1 }
    });
    expect(plan.linked_entities[0]).toMatchObject({
      selected_id: 'lando-norris', candidate_ids: ['historical-norris', 'lando-norris'],
      resolution_relationship_ids: [
        'driver_identity_qualifying_resolution', 'driver_identity_race_resolution', 'driver_participation_resolution'
      ]
    });
    expect(plan.branches.every(branch => branch.aggregate?.group_by.length === 0)).toBe(true);
    expect(plan.planned_f1ql.root.input.input.input.op).toBe('compose');
  });

  it('aggregates each unfiltered source independently before composing one scalar row', async () => {
    const admission = admitted(UNFILTERED_COMPOSE);
    const plan = await planSemanticAnswer({
      question: UNFILTERED_COMPOSE,
      admission,
      ...resolvers([])
    });

    expect(plan).toMatchObject({
      topology: 'scalar_aggregate_compose',
      source_graph: {
        source_ids: ['event_classification', 'qualifying_classification'],
        row_relationship_ids: []
      },
      linked_entities: [],
      output_grain: [],
      work: {
        source_scan_units: 60, resolver_reads: 1, sources: 2, row_joins: 0,
        compositions: 1, operator_depth: 6, requested_rows: 1
      }
    });
    expect(plan.branches).toMatchObject([
      {
        source_id: 'event_classification', fixed_grain: ['season'], residual_grain: [],
        predicates: [{ concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }],
        aggregate: { group_by: [], measures: ['count_finishing_position'] }
      },
      {
        source_id: 'qualifying_classification', fixed_grain: ['season'], residual_grain: [],
        predicates: [{ concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }],
        aggregate: { group_by: [], measures: ['count_qualifying_position'] }
      }
    ]);
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 1,
      input: {
        keys: [{
          output_id: 'event_classification__count_finishing_position',
          direction: 'asc', nulls: 'last'
        }],
        input: { input: { op: 'compose' } }
      }
    });
  });

  it('adds deterministic ordering for a single-source scalar aggregate', async () => {
    const admission = admitted(SCALAR_COUNT);
    const plan = await planSemanticAnswer({ question: SCALAR_COUNT, admission, ...resolvers([]) });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate', output_grain: [],
      work: { source_scan_units: 30, requested_rows: 1 }
    });
    expect(plan.planned_f1ql.root.input.keys).toEqual([
      { output_id: 'count_qualifying_position', direction: 'asc', nulls: 'last' }
    ]);
  });

  it('groups recorded qualifying-position counts before applying the exact top-10 ordering', async () => {
    const admission = admitted(QUALIFYING_COUNT_RANK);
    const plan = await planSemanticAnswer({
      question: QUALIFYING_COUNT_RANK,
      admission,
      ...resolvers([])
    });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['qualifying_classification'], row_relationship_ids: [] },
      linked_entities: [],
      output_grain: ['driver_id'],
      work: {
        source_scan_units: 30, resolver_reads: 1, sources: 1, row_joins: 0,
        compositions: 0, operator_depth: 5, requested_rows: 10
      }
    });
    expect(plan.branches[0]).toMatchObject({
      fixed_grain: ['season'],
      residual_grain: ['driver_id'],
      predicates: [{ concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }],
      aggregate: { group_by: ['driver_id'], measures: ['count_qualifying_position'] }
    });
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 10,
      input: {
        keys: [
          { output_id: 'count_qualifying_position', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
  });

  it('groups recorded race finishing-position counts before applying the exact top-10 ordering', async () => {
    const admission = admitted(RACE_COUNT_RANK);
    const plan = await planSemanticAnswer({ question: RACE_COUNT_RANK, admission, ...resolvers([]) });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'], row_relationship_ids: [] },
      linked_entities: [],
      output_grain: ['driver_id'],
      work: { source_scan_units: 30, requested_rows: 10 }
    });
    expect(plan.branches[0]).toMatchObject({
      fixed_grain: ['season'], residual_grain: ['driver_id'],
      predicates: [{ concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }],
      aggregate: { group_by: ['driver_id'], measures: ['count_finishing_position'] }
    });
    expect(plan.planned_f1ql.root).toMatchObject({
      count: 10,
      input: { keys: [
        { output_id: 'count_finishing_position', direction: 'desc', nulls: 'last' },
        { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
      ] }
    });
  });

  it('uses the same bounded scalar topology for race finishing-position counts', async () => {
    const admission = admitted(RACE_SCALAR_COUNT);
    const plan = await planSemanticAnswer({ question: RACE_SCALAR_COUNT, admission, ...resolvers([]) });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'] },
      output_grain: [],
      work: { source_scan_units: 30, requested_rows: 1 }
    });
    expect(plan.planned_f1ql.root.input.keys).toEqual([
      { output_id: 'count_finishing_position', direction: 'asc', nulls: 'last' }
    ]);
  });

  it('binds one resolved driver without changing the scalar race-count topology', async () => {
    const norris = span(FILTERED_RACE_SCALAR_COUNT, 'Norris');
    const admission = admitted(FILTERED_RACE_SCALAR_COUNT, [{ type: 'driver', span: norris }]);
    const plan = await planSemanticAnswer({
      question: FILTERED_RACE_SCALAR_COUNT,
      admission,
      ...resolvers([{
        ...norris,
        candidates: ['historical-norris', 'lando-norris'],
        active_candidates: ['lando-norris']
      }])
    });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'] },
      output_grain: [],
      work: { source_scan_units: 30, resolver_reads: 1, requested_rows: 1 }
    });
    expect(plan.linked_entities[0]).toMatchObject({
      selected_id: 'lando-norris',
      resolution_relationship_ids: ['driver_identity_race_resolution', 'driver_participation_resolution']
    });
    expect(plan.branches[0].predicates).toMatchObject([
      { concept: { concept_id: 'driver_id' }, operator: 'eq', value: 'lando-norris' },
      { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
    ]);
  });

  it('binds one resolved driver without changing the scalar qualifying-count topology', async () => {
    const norris = span(FILTERED_QUALIFYING_SCALAR_COUNT, 'Norris');
    const admission = admitted(FILTERED_QUALIFYING_SCALAR_COUNT, [{ type: 'driver', span: norris }]);
    const plan = await planSemanticAnswer({
      question: FILTERED_QUALIFYING_SCALAR_COUNT,
      admission,
      ...resolvers([{
        ...norris,
        candidates: ['historical-norris', 'lando-norris'],
        active_candidates: ['lando-norris']
      }])
    });
    expect(plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['qualifying_classification'] },
      output_grain: [],
      work: { source_scan_units: 30, resolver_reads: 1, requested_rows: 1 }
    });
    expect(plan.linked_entities[0]).toMatchObject({
      selected_id: 'lando-norris',
      resolution_relationship_ids: ['driver_identity_qualifying_resolution', 'driver_participation_resolution']
    });
    expect(plan.branches[0].predicates).toMatchObject([
      { concept: { concept_id: 'driver_id' }, operator: 'eq', value: 'lando-norris' },
      { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
    ]);
  });

  it('rejects forged admission, linker omission, ambiguity, missing coverage, and duplicate identities', async () => {
    const admission = admitted(STANDINGS);
    await expect(planSemanticAnswer({ question: STANDINGS, admission: { ...admission }, ...resolvers([]) }))
      .rejects.toMatchObject({ reason: 'admission_invalid' });

    const norrisSpan = span(COMPOSE, 'Norris');
    const driverAdmission = admitted(COMPOSE, [{ type: 'driver', span: norrisSpan }]);
    await expect(planSemanticAnswer({ question: COMPOSE, admission: driverAdmission, ...resolvers([]) }))
      .rejects.toMatchObject({ reason: 'entity_inventory_mismatch' });
    await expect(planSemanticAnswer({
      question: COMPOSE,
      admission: driverAdmission,
      ...resolvers([{ ...norrisSpan, candidates: ['a', 'b'], active_candidates: ['a', 'b'] }])
    })).rejects.toMatchObject({ reason: 'entity_ambiguous' });
    await expect(planSemanticAnswer({
      question: COMPOSE,
      admission: driverAdmission,
      ...resolvers([{ ...norrisSpan, candidates: ['a'], active_candidates: [] }])
    })).rejects.toMatchObject({ reason: 'source_coverage_missing' });
    await expect(planSemanticAnswer({
      question: COMPOSE,
      admission: driverAdmission,
      ...resolvers([{ ...norrisSpan, candidates: ['other-driver'], active_candidates: ['not-a-candidate'] }])
    })).rejects.toMatchObject({ reason: 'entity_inventory_mismatch' });

    const duplicateQuestion = 'List driver and championship position for Norris and Lando from final 2025 driver standings.';
    const norris = span(duplicateQuestion, 'Norris');
    const lando = span(duplicateQuestion, 'Lando');
    const duplicateAdmission = admitted(duplicateQuestion, [{ type: 'driver', span: norris }, { type: 'driver', span: lando }]);
    await expect(planSemanticAnswer({
      question: duplicateQuestion,
      admission: duplicateAdmission,
      ...resolvers([
        { ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] }
      ])
    })).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
  });

  it('has no executor or database result-query path', () => {
    const planner = readFileSync('src/f1ql/semantic-planner.ts', 'utf8');
    expect(planner).not.toMatch(/from ['"](?:pg|\.\/executor)['"]/u);
    expect(planner).not.toMatch(/executeF1QL|database\.query|\.compiled\.sql/u);
    expect(() => new AnswerPlannerError('planned_program_invalid')).not.toThrow();
  });
});

function admitted(question: string, entities: readonly unknown[] = []) {
  const evidence = enumerateSemanticQueries(question, entities);
  expect(evidence.type).toBe('candidate_set');
  const candidates = (evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>).candidates;
  const admission = admitSemanticQueryCandidates({ version: 2, candidates }, question, evidence);
  expect(admission.type).toBe('admitted');
  return admission;
}

function resolvers(
  mentions: readonly SemanticDriverMention[],
  eventResolution: { readonly type: 'resolved'; readonly season: number; readonly round: number } |
    { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] } |
    { readonly type: 'missing' } = { type: 'missing' }
) {
  return {
    driver_resolver: { inventoryMentions: async () => mentions },
    event_resolver: {
      resolve: async () => eventResolution,
      resolveRound: async () => eventResolution
    }
  };
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}
