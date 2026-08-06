import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  planSemanticAnswerFromResolution,
  SemanticDriverMention
} from '../../src/f1ql/semantic-planner';
import {
  collectSemanticResolutionEvidence,
  verifySemanticResolutionEvidence
} from '../../src/f1ql/semantic-resolution-evidence';
import {
  getSemanticPlanProofParent,
  proveSemanticAnswerPlan,
  verifySemanticPlanProof
} from '../../src/f1ql/semantic-plan-proof';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticEvidence,
  SemanticLiteralSpan,
  verifySemanticEvidence
} from '../../src/f1ql/semantic-query';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const QUALIFYING_METADATA = 'List driver, qualifying position, and race date for Norris from round 1 of final 2025 qualifying classification and event metadata.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const UNFILTERED_COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification in final 2025.';
const SCALAR_COUNT = 'Show count of qualifying position in final 2025 qualifying classification.';
const RACE_SCALAR_COUNT = 'Show count of finishing position in final 2025 race classification.';
const FILTERED_RACE_SCALAR_COUNT = 'Show count of finishing position for Norris in final 2025 race classification.';
const FILTERED_QUALIFYING_SCALAR_COUNT = 'Show count of qualifying position for Norris in final 2025 qualifying classification.';
const QUALIFYING_COUNT_RANK = 'Show top 10 drivers by count of qualifying position in final 2025 qualifying classification.';
const RACE_COUNT_RANK = 'Show top 10 drivers by count of finishing position in final 2025 race classification.';
const SELECTED_RACE_COUNT = 'Show driver and count of finishing position for Lando Norris and Oscar Piastri in final 2025 race classification.';
const SELECTED_QUALIFYING_COUNT = 'Show driver and count of qualifying position for Lando Norris and Oscar Piastri in final 2025 qualifying classification.';
const UNFILTERED_RACE_DRIVER_COUNT = 'Show count of finishing position per driver in final 2025 race classification.';
const SINGLETON_STANDINGS_POSITION = 'List driver and championship position for Norris from final 2025 driver standings.';
const MULTI_STANDINGS_POSITION = 'List driver and championship position for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const MULTI_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const EVENT_DATE_NAME = 'List race date and event name from round 1 of final 2025 event metadata.';
const EVENT_DATE_CIRCUIT = 'List race date and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME_CIRCUIT = 'List event name and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_ALL_METADATA = 'List race date, event name, and circuit identifier from round 1 of final 2025 event metadata.';

describe('independent semantic whole-plan proof', () => {
  it('uses one frozen resolver transcript for planning and independent proof', async () => {
    const norris = span(COMPOSE, 'Norris');
    const mention: SemanticDriverMention = {
      ...norris,
      candidates: ['historical-norris', 'lando-norris'],
      active_candidates: ['lando-norris']
    };
    const prepared = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [mention]);

    expect(prepared.calls).toEqual({ drivers: 1, events: 0 });
    expect(Object.isFrozen(prepared.resolution)).toBe(true);
    expect(Object.isFrozen(prepared.resolution.entities[0].candidate_ids)).toBe(true);
    expect(prepared.plan.resolution_evidence_hash).toBe(prepared.resolution.resolution_hash);
    expect(prepared.proof).toMatchObject({
      semantic_evidence_hash: prepared.admission.semantic_evidence_hash,
      resolution_evidence_hash: prepared.resolution.resolution_hash,
      answer_plan_hash: prepared.plan.answer_plan_hash,
      planned_f1ql_hash: prepared.plan.planned_f1ql_hash,
      core_hash: prepared.plan.core_hash
    });
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).program_hash).toBe(prepared.plan.planned_f1ql_hash);
    expect(() => verifySemanticPlanProof({ ...prepared.proof })).toThrow('provenance');
    expect(() => verifySemanticResolutionEvidence({ ...prepared.resolution }, COMPOSE, prepared.admission)).toThrow('provenance');
  });

  it.each([
    ['single-source rows', STANDINGS, []],
    ['single-source scalar aggregate', SCALAR_COUNT, []],
    ['single-source race scalar aggregate', RACE_SCALAR_COUNT, []],
    ['single-source grouped qualifying count rank', QUALIFYING_COUNT_RANK, []],
    ['single-source grouped race count rank', RACE_COUNT_RANK, []],
    ['single-source unfiltered grouped race count', UNFILTERED_RACE_DRIVER_COUNT, []],
    ['single-source event date and name', EVENT_DATE_NAME, []],
    ['single-source event date and circuit', EVENT_DATE_CIRCUIT, []],
    ['single-source event name and circuit', EVENT_NAME_CIRCUIT, []],
    ['single-source complete event metadata', EVENT_ALL_METADATA, []],
    ['safe metadata join', RACE_METADATA, []]
  ])('reproduces %s without planner decision imports', async (_name, question, entities) => {
    const prepared = await prepare(question, entities, [], { type: 'resolved', season: 2025, round: 1 });
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(prepared.proof.topology_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.proof.participation_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.proof.compiled_hash).toMatch(/^[a-f0-9]{64}$/u);
    if ([EVENT_DATE_NAME, EVENT_DATE_CIRCUIT, EVENT_NAME_CIRCUIT, EVENT_ALL_METADATA].includes(question)) {
      expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({ type: 'not_required' });
    }
  });

  it('independently reproduces selected race counts and rejects direct structure mutations', async () => {
    const lando = span(SELECTED_RACE_COUNT, 'Lando Norris');
    const oscar = span(SELECTED_RACE_COUNT, 'Oscar Piastri');
    const entities = [{ type: 'driver' as const, span: lando }, { type: 'driver' as const, span: oscar }];
    const prepared = await prepare(SELECTED_RACE_COUNT, entities, [
      { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
      { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
    ]);
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['lando-norris', 'oscar-piastri'] }]
    });
    for (const mutate of [
      (plan: any) => { plan.branches[0].aggregate.group_by = []; },
      (plan: any) => { plan.planned_f1ql.root.input.input.outputs.reverse(); },
      (plan: any) => { plan.planned_f1ql.root.input.keys[0].output_id = 'count_finishing_position'; },
      (plan: any) => { plan.planned_f1ql.root.input.input.input.input.predicates[0].operator = 'eq'; },
      (plan: any) => { plan.planned_f1ql.root.count = 10; }
    ]) {
      const mutated: any = structuredClone(prepared.plan);
      mutate(mutated);
      expect(() => proveSemanticAnswerPlan({
        question: SELECTED_RACE_COUNT,
        entity_inventory: entities,
        evidence: prepared.evidence,
        admission: prepared.admission,
        resolution: prepared.resolution,
        plan: mutated
      })).toThrow('plan_mismatch');
    }
  });

  it('independently rejects unfiltered race-count structure mutations', async () => {
    const prepared = await prepare(UNFILTERED_RACE_DRIVER_COUNT, [], []);
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({ type: 'not_required' });
    for (const mutate of [
      (plan: any) => { plan.branches[0].aggregate.group_by = []; },
      (plan: any) => { plan.planned_f1ql.root.input.input.outputs.reverse(); },
      (plan: any) => { plan.planned_f1ql.root.input.keys[0].output_id = 'count_finishing_position'; },
      (plan: any) => { plan.planned_f1ql.root.input.input.input.input.predicates.push({
        concept: { source_id: 'event_classification', concept_id: 'round' }, operator: 'eq', value: 1
      }); },
      (plan: any) => { plan.planned_f1ql.root.count = 10; }
    ]) {
      const mutated: any = structuredClone(prepared.plan);
      mutate(mutated);
      expect(() => proveSemanticAnswerPlan({
        question: UNFILTERED_RACE_DRIVER_COUNT,
        entity_inventory: [], evidence: prepared.evidence, admission: prepared.admission,
        resolution: prepared.resolution, plan: mutated
      })).toThrow('plan_mismatch');
    }
  });

  it('independently reproduces selected qualifying counts and rejects direct structure mutations', async () => {
    const lando = span(SELECTED_QUALIFYING_COUNT, 'Lando Norris');
    const oscar = span(SELECTED_QUALIFYING_COUNT, 'Oscar Piastri');
    const entities = [{ type: 'driver' as const, span: lando }, { type: 'driver' as const, span: oscar }];
    const prepared = await prepare(SELECTED_QUALIFYING_COUNT, entities, [
      { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
      { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
    ]);
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['lando-norris', 'oscar-piastri'] }]
    });
    for (const mutate of [
      (plan: any) => { plan.branches[0].aggregate.group_by = []; },
      (plan: any) => { plan.planned_f1ql.root.input.input.outputs.reverse(); },
      (plan: any) => { plan.planned_f1ql.root.input.keys[0].output_id = 'count_qualifying_position'; },
      (plan: any) => { plan.planned_f1ql.root.input.input.input.input.predicates[0].operator = 'eq'; },
      (plan: any) => { plan.planned_f1ql.root.count = 10; }
    ]) {
      const mutated: any = structuredClone(prepared.plan);
      mutate(mutated);
      expect(() => proveSemanticAnswerPlan({
        question: SELECTED_QUALIFYING_COUNT,
        entity_inventory: entities,
        evidence: prepared.evidence,
        admission: prepared.admission,
        resolution: prepared.resolution,
        plan: mutated
      })).toThrow('plan_mismatch');
    }
  });

  it('independently reproduces reverse-canonical qualifying metadata branch orientation', async () => {
    const norris = span(QUALIFYING_METADATA, 'Norris');
    const prepared = await prepare(
      QUALIFYING_METADATA,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris'] }],
      { type: 'resolved', season: 2025, round: 1 }
    );
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(prepared.plan).toMatchObject({
      source_graph: {
        source_ids: ['event_metadata', 'qualifying_classification'],
        row_relationship_ids: ['qualifying_event_metadata']
      },
      output_grain: [],
      work: { requested_rows: 1 }
    });
  });

  it('independently proves the exact zero-driver aggregate-locality plan', async () => {
    const prepared = await prepare(UNFILTERED_COMPOSE, [], []);
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(prepared.plan).toMatchObject({
      topology: 'scalar_aggregate_compose',
      source_graph: {
        source_ids: ['event_classification', 'qualifying_classification'],
        row_relationship_ids: []
      },
      linked_entities: [],
      output_grain: [],
      work: { requested_rows: 1 }
    });
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({ type: 'not_required' });
    expect(getSemanticPlanProofParent(prepared.proof).program.root.input.input.input)
      .toMatchObject({ op: 'compose', inputs: [{ op: 'aggregate' }, { op: 'aggregate' }] });
  });

  it('reproduces one selected final standings-position row with one participation requirement', async () => {
    const norris = span(SINGLETON_STANDINGS_POSITION, 'Norris');
    const prepared = await prepare(
      SINGLETON_STANDINGS_POSITION,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({
      type: 'required',
      requirements: [{ season: 2025, driver_ids: ['lando-norris'] }]
    });
  });

  it.each([MULTI_STANDINGS_POSITION, MULTI_STANDINGS_SUMMARY])(
    'reproduces selected final standings rows with complete participation requirements: %s', async question => {
    const lando = span(question, 'Lando Norris');
    const oscar = span(question, 'Oscar Piastri');
    const prepared = await prepare(
      question,
      [{ type: 'driver', span: lando }, { type: 'driver', span: oscar }],
      [
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ]
    );
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({
      type: 'required',
      requirements: [{ season: 2025, driver_ids: ['lando-norris', 'oscar-piastri'] }]
    });
  });

  it.each([
    ['race', FILTERED_RACE_SCALAR_COUNT],
    ['qualifying', FILTERED_QUALIFYING_SCALAR_COUNT]
  ])('reproduces the filtered %s scalar aggregate with one participation requirement', async (_source, question) => {
    const norris = span(question, 'Norris');
    const prepared = await prepare(
      question,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(verifySemanticPlanProof(prepared.proof)).toBe(prepared.proof);
    expect(getSemanticPlanProofParent(prepared.proof).participation).toEqual({
      type: 'required',
      requirements: [{ season: 2025, driver_ids: ['lando-norris'] }]
    });
  });

  it.each([
    ['catalog source', (plan: any) => { plan.source_graph.source_ids = ['event_metadata']; }],
    ['predicate', (plan: any) => { plan.branches[0].predicates[0].value = 2024; }],
    ['grain', (plan: any) => { plan.branches[0].residual_grain = []; }],
    ['work', (plan: any) => { plan.work.source_scan_units += 1; }],
    ['planned source', (plan: any) => { plan.planned_f1ql.root.input.input.input.input.source_id = 'event_metadata'; }],
    ['planned hash', (plan: any) => { plan.planned_f1ql_hash = '0'.repeat(64); }],
    ['extra field', (plan: any) => { plan.authorization = true; }]
  ])('rejects independently reconstructed plan mutation: %s', async (_name, mutate) => {
    const prepared = await prepare(STANDINGS, [], []);
    const mutated: any = structuredClone(prepared.plan);
    mutate(mutated);
    expect(() => proveSemanticAnswerPlan({
      question: STANDINGS,
      evidence: prepared.evidence,
      admission: prepared.admission,
      resolution: prepared.resolution,
      plan: mutated
    })).toThrow('plan_mismatch');
  });

  it.each([
    ['group key', (plan: any) => { plan.branches[0].aggregate.group_by = []; }],
    ['aggregate function', (plan: any) => { plan.planned_f1ql.root.input.input.input.measures[0].function = 'max'; }],
    ['output order', (plan: any) => { plan.planned_f1ql.root.input.input.outputs.reverse(); }],
    ['count direction', (plan: any) => { plan.planned_f1ql.root.input.keys[0].direction = 'asc'; }],
    ['identity tie break', (plan: any) => { plan.planned_f1ql.root.input.keys[1].direction = 'desc'; }],
    ['season predicate', (plan: any) => { plan.planned_f1ql.root.input.input.input.input.predicates[0].value = 2024; }],
    ['limit', (plan: any) => { plan.planned_f1ql.root.count = 9; }]
  ])('rejects independently reconstructed classification-count rank mutation: %s', async (_name, mutate) => {
    for (const question of [RACE_COUNT_RANK, QUALIFYING_COUNT_RANK]) {
      const prepared = await prepare(question, [], []);
      const mutated: any = structuredClone(prepared.plan);
      mutate(mutated);
      expect(() => proveSemanticAnswerPlan({
        question,
        evidence: prepared.evidence,
        admission: prepared.admission,
        resolution: prepared.resolution,
        plan: mutated
      })).toThrow('plan_mismatch');
    }
  });

  it('re-enumerates complete active evidence and rejects copied or mismatched inventories', async () => {
    const norris = span(COMPOSE, 'Norris');
    const entities = [{ type: 'driver', span: norris }];
    const prepared = await prepare(COMPOSE, entities, [{
      ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    expect(verifySemanticEvidence(prepared.evidence, COMPOSE, entities)).toBe(prepared.evidence);
    expect(() => verifySemanticEvidence(structuredClone(prepared.evidence), COMPOSE, entities)).toThrow('provenance');
    expect(() => proveSemanticAnswerPlan({
      question: COMPOSE,
      entity_inventory: [],
      evidence: prepared.evidence,
      admission: prepared.admission,
      resolution: prepared.resolution,
      plan: prepared.plan
    })).toThrow('evidence_invalid');
  });

  it('strictly rejects malformed resolver records before plan materialization', async () => {
    const norris = span(COMPOSE, 'Norris');
    const { evidence, admission } = admitted(COMPOSE, [{ type: 'driver', span: norris }]);
    await expect(collectSemanticResolutionEvidence({
      question: COMPOSE,
      admission,
      driver_resolver: {
        inventoryMentions: async () => [{
          ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris'], injected: true
        } as any]
      },
      event_resolver: eventResolver({ type: 'missing' })
    })).rejects.toMatchObject({ reason: 'entity_inventory_mismatch' });
    expect(evidence.type).toBe('candidate_set');
  });

  it('has no planner, route, provider, database, or executor dependency', () => {
    const proof = readFileSync('src/f1ql/semantic-plan-proof.ts', 'utf8');
    expect(proof).not.toMatch(/from ['"].*semantic-planner['"]/u);
    expect(proof).not.toMatch(/from ['"](?:pg|\.\/executor|\.\.\/api)/u);
    expect(proof).not.toMatch(/executeF1QL|database\.query|planSemanticAnswer/u);
  });

  it('keeps the semantic shadow transitive source graph database-free', () => {
    const graph = reachableLocalModules(resolve('src/f1ql/semantic-shadow-planner.ts'));
    const relative = [...graph].map(file => file.replace(`${resolve('.')}\/`, ''));
    expect(relative.filter(file =>
      /(?:^|\/)(?:database|validation|translation-linking)\.ts$/u.test(file) ||
      /(?:^|\/)[^/]*(?:executor|authorization|format|interpreter)[^/]*\.ts$/u.test(file) ||
      /(?:^|\/)api\/routes\//u.test(file) ||
      /(?:^|\/)identity\/(?:answer-identity-resolvers|driver-resolver|event-resolver)\.ts$/u.test(file)
    )).toEqual([]);
    for (const file of graph) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/(?:from\s+|require\s*\()['"]pg(?:\/[^'"]*)?['"]/u);
    }
  });
});

function reachableLocalModules(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
  for (const specifier of imports) {
    const base = resolve(dirname(entry), specifier);
    const candidates = extname(base) ? [base] : [`${base}.ts`, resolve(base, 'index.ts')];
    const child = candidates.find(existsSync);
    if (child) reachableLocalModules(child, seen);
  }
  return seen;
}

async function prepare(
  question: string,
  entities: readonly unknown[],
  mentions: readonly SemanticDriverMention[],
  eventResolution: { readonly type: 'resolved'; readonly season: number; readonly round: number } |
    { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] } |
    { readonly type: 'missing' } = { type: 'missing' }
) {
  const { evidence, admission } = admitted(question, entities);
  const calls = { drivers: 0, events: 0 };
  const resolution = await collectSemanticResolutionEvidence({
    question,
    admission,
    driver_resolver: { inventoryMentions: async () => {calls.drivers += 1; return mentions;} },
    event_resolver: {
      resolve: async () => {calls.events += 1; return eventResolution;},
      resolveRound: async () => {calls.events += 1; return eventResolution;}
    }
  });
  const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
  const proof = proveSemanticAnswerPlan({
    question,
    entity_inventory: entities,
    evidence,
    admission,
    resolution,
    plan
  });
  return { evidence, admission, resolution, plan, proof, calls };
}

function admitted(question: string, entities: readonly unknown[]) {
  const evidence = enumerateSemanticQueries(question, entities);
  expect(evidence.type).toBe('candidate_set');
  const candidates = (evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>).candidates;
  const admission = admitSemanticQueryCandidates({ version: 2, candidates }, question, evidence);
  if (admission.type !== 'admitted') throw new Error('test semantic query was not admitted');
  return { evidence, admission };
}

function eventResolver(
  resolution: { readonly type: 'resolved'; readonly season: number; readonly round: number } |
    { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] } |
    { readonly type: 'missing' }
) {
  return { resolve: async () => resolution, resolveRound: async () => resolution };
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}
