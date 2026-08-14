import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import {
  classifySemanticShadowOutcome,
  compareTemplateAndSemanticPlan,
  SEMANTIC_SHADOW_RESOLVER_MAX_TOTAL_CANDIDATES,
  SemanticShadowDependencies,
  orchestrateSemanticShadow
} from '../../src/f1ql/semantic-shadow-planner';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { proveAnswerIntent, verifyAnswerSemanticProof } from '../../src/f1ql/answer-semantic-proof';
import { materializeAnswerTemplate } from '../../src/f1ql/answer-templates';
import { sanitizeSemanticShadowObservation } from '../../src/f1ql/semantic-shadow-observations';
import {
  collectSemanticResolutionEvidence,
  SemanticDriverMention,
  verifySemanticResolutionEvidence
} from '../../src/f1ql/semantic-resolution-evidence';
import { planSemanticAnswerFromResolution, verifyAnswerPlan } from '../../src/f1ql/semantic-planner';
import { proveSemanticAnswerPlan, verifySemanticPlanProof } from '../../src/f1ql/semantic-plan-proof';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticLiteralSpan,
  verifySemanticEvidence,
  verifySemanticQueryAdmission
} from '../../src/f1ql/semantic-query';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const DEV_POINTS = 'Show the final 2025 standings points.';
const IID_POINTS_ALL = 'What were the final standings points in 2025?';
const FILTERED_POINTS = 'What were Charles Leclerc final standings points in 2024?';
const PAIR_POINTS = 'Final 2025 standings points for Lando Norris and Oscar Piastri.';
const REVERSED_PAIR_POINTS = 'Final 2025 standings points for Oscar Piastri and Lando Norris.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const QUALIFYING_METADATA = 'List driver, qualifying position, and race date for Norris from round 1 of final 2025 qualifying classification and event metadata.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const SCALAR_COUNT = 'Show count of qualifying position in final 2025 qualifying classification.';
const RACE_SCALAR_COUNT = 'Show count of finishing position in final 2025 race classification.';
const FILTERED_RACE_SCALAR_COUNT = 'Show count of finishing position for Norris in final 2025 race classification.';
const FILTERED_QUALIFYING_SCALAR_COUNT = 'Show count of qualifying position for Norris in final 2025 qualifying classification.';
const SINGLETON_STANDINGS_POSITION = 'List driver and championship position for Norris from final 2025 driver standings.';
const SINGLETON_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Norris from final 2025 driver standings.';
const MULTI_STANDINGS_POSITION = 'List driver and championship position for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const MULTI_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const EVENT_DATE = 'The 2025 Monaco race date.';
const EVENT_DATE_NAME = 'List race date and event name from round 1 of final 2025 event metadata.';
const EVENT_DATE_CIRCUIT = 'List race date and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME_CIRCUIT = 'List event name and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_ALL_METADATA = 'List race date, event name, and circuit identifier from round 1 of final 2025 event metadata.';

describe('pure non-executing semantic shadow orchestrator', () => {
  it.each([
    [STANDINGS, [], { type: 'missing' } as const, 'single_source_rows', 'driver_standings', 'filter_project_sort_limit'],
    [SCALAR_COUNT, [], { type: 'missing' } as const, 'single_source_aggregate', 'qualifying_classification', 'filter_aggregate_project_sort_limit'],
    [RACE_SCALAR_COUNT, [], { type: 'missing' } as const, 'single_source_aggregate', 'event_classification', 'filter_aggregate_project_sort_limit'],
    [FILTERED_RACE_SCALAR_COUNT, [driverMention(FILTERED_RACE_SCALAR_COUNT, 'Norris', ['lando-norris'], ['lando-norris'])],
      { type: 'missing' } as const, 'single_source_aggregate', 'event_classification', 'filter_aggregate_project_sort_limit'],
    [FILTERED_QUALIFYING_SCALAR_COUNT, [driverMention(FILTERED_QUALIFYING_SCALAR_COUNT, 'Norris', ['lando-norris'], ['lando-norris'])],
      { type: 'missing' } as const, 'single_source_aggregate', 'qualifying_classification', 'filter_aggregate_project_sort_limit'],
    [SINGLETON_STANDINGS_POSITION, [driverMention(SINGLETON_STANDINGS_POSITION, 'Norris', ['lando-norris'], ['lando-norris'])],
      { type: 'missing' } as const, 'single_source_rows', 'driver_standings', 'filter_project_sort_limit'],
    [SINGLETON_STANDINGS_SUMMARY, [driverMention(SINGLETON_STANDINGS_SUMMARY, 'Norris', ['lando-norris'], ['lando-norris'])],
      { type: 'missing' } as const, 'single_source_rows', 'driver_standings', 'filter_project_sort_limit'],
    [MULTI_STANDINGS_POSITION, [
      driverMention(MULTI_STANDINGS_POSITION, 'Lando Norris', ['lando-norris'], ['lando-norris']),
      driverMention(MULTI_STANDINGS_POSITION, 'Oscar Piastri', ['oscar-piastri'], ['oscar-piastri'])
    ], { type: 'missing' } as const, 'single_source_rows', 'driver_standings', 'filter_project_sort_limit'],
    [MULTI_STANDINGS_SUMMARY, [
      driverMention(MULTI_STANDINGS_SUMMARY, 'Lando Norris', ['lando-norris'], ['lando-norris']),
      driverMention(MULTI_STANDINGS_SUMMARY, 'Oscar Piastri', ['oscar-piastri'], ['oscar-piastri'])
    ], { type: 'missing' } as const, 'single_source_rows', 'driver_standings', 'filter_project_sort_limit'],
    [EVENT_DATE_NAME, [], { type: 'resolved', season: 2025, round: 1 } as const,
      'single_source_rows', 'event_metadata', 'filter_project_sort_limit'],
    [EVENT_DATE_CIRCUIT, [], { type: 'resolved', season: 2025, round: 1 } as const,
      'single_source_rows', 'event_metadata', 'filter_project_sort_limit'],
    [EVENT_NAME_CIRCUIT, [], { type: 'resolved', season: 2025, round: 1 } as const,
      'single_source_rows', 'event_metadata', 'filter_project_sort_limit'],
    [EVENT_ALL_METADATA, [], { type: 'resolved', season: 2025, round: 1 } as const,
      'single_source_rows', 'event_metadata', 'filter_project_sort_limit'],
    [RACE_METADATA, [], { type: 'resolved', season: 2025, round: 1 } as const, 'row_dimension_join', 'event_classification__event_metadata', 'filter_join_project_sort_limit'],
    [QUALIFYING_METADATA, [driverMention(QUALIFYING_METADATA, 'Norris', ['lando-norris'], ['lando-norris'])],
      { type: 'resolved', season: 2025, round: 1 } as const, 'row_dimension_join',
      'event_metadata__qualifying_classification', 'filter_join_project_sort_limit'],
    [COMPOSE, [driverMention(COMPOSE, 'Norris', ['recognizable-secret-driver'], ['recognizable-secret-driver'])], { type: 'missing' } as const,
      'scalar_aggregate_compose', 'event_classification__qualifying_classification', 'filter_aggregate_compose_project_sort_limit']
  ])('proves but never executes every promoted topology: %s', async (
    question, mentions, eventResolution, topology, sourceSet, operatorSet
  ) => {
    const observation = await orchestrateSemanticShadow(question, dependencies(mentions, eventResolution));

    expect(observation).toMatchObject({
      outcome: 'answer',
      reason: 'plan_proven',
      candidate_counts: { comparison: 'exact', matched: 1, omitted: 0, extraneous: 0 },
      topology_code: topology,
      source_set_code: sourceSet,
      operator_set_code: operatorSet,
      result_query_calls: 0
    });
    expect(observation.hashes).toMatchObject({
      catalog_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      candidate_set_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provider_candidate_set_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      semantic_evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      semantic_query_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      planned_f1ql_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      core_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      compiled_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      semantic_proof_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(observation.plan_work).toMatchObject({
      model: 'semantic-plan-work-v1',
      resolver_reads: expect.any(Number),
      resolver_candidates: expect.any(Number),
      requested_rows: expect.any(Number)
    });
    expect(observation.versions).toMatchObject({
      planned_compiler: 'planned-compiler-v2',
      fact_space: 'source-views-v3'
    });
    expect(isDeepFrozen(observation)).toBe(true);
  });

  it('does not treat generic driver language as a named resolver entity', async () => {
    const generic = driverMention(STANDINGS, 'driver', ['sample-driver'], ['sample-driver']);
    const observation = await orchestrateSemanticShadow(
      STANDINGS,
      dependencies([generic], { type: 'missing' }, exactProposal([]))
    );
    expect(observation).toMatchObject({
      outcome: 'answer',
      reason: 'plan_proven',
      candidate_counts: { comparison: 'exact', matched: 1, omitted: 0, extraneous: 0 },
      resolver_counts: { inventory_entities: 0 },
      result_query_calls: 0
    });
  });

  it('validates generic resolver mentions before filtering them', async () => {
    const generic = driverMention(STANDINGS, 'driver', ['sample-driver'], ['sample-driver']);
    const observation = await orchestrateSemanticShadow(
      STANDINGS,
      dependencies([{ ...generic, start: 999, end: 1005 }], { type: 'missing' }, exactProposal([]))
    );
    expect(observation).toMatchObject({
      outcome: 'abstain',
      reason: 'entity_inventory_mismatch',
      result_query_calls: 0
    });
  });

  it('closes answer, clarification, abstention, malformed-provider, and provider-omission outcomes', async () => {
    const answer = await orchestrateSemanticShadow(STANDINGS, dependencies([]));
    expect(answer).toMatchObject({ outcome: 'answer', reason: 'plan_proven' });

    const ambiguous = 'Show final 2025 driver standings.';
    let ambiguousProposalCalls = 0;
    const omission = await orchestrateSemanticShadow(ambiguous, dependencies([], { type: 'missing' }, async () => {
      ambiguousProposalCalls += 1;
      throw new Error('ambiguous evidence must not reach the provider');
    }));
    expect(omission).toMatchObject({
      outcome: 'clarify', reason: 'output_shape_ambiguous',
      candidate_counts: { enumerated: 2, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' },
      result_query_calls: 0
    });
    expect(ambiguousProposalCalls).toBe(0);

    let abstentionProposalCalls = 0;
    const abstention = await orchestrateSemanticShadow(
      'List secret championship points from final 2025 driver standings.',
      dependencies([], { type: 'missing' }, async () => {abstentionProposalCalls += 1; return {};})
    );
    expect(abstention).toMatchObject({ outcome: 'abstain', reason: 'unknown_language', result_query_calls: 0 });
    expect(abstentionProposalCalls).toBe(0);

    const malformed = await orchestrateSemanticShadow(STANDINGS, dependencies([], { type: 'missing' }, async () => ({
      provider_body: 'RECOGNIZABLE_PROVIDER_BODY',
      provider_url: 'https://recognizable.invalid/private'
    })));
    expect(malformed).toMatchObject({ outcome: 'unavailable', reason: 'provider_malformed', result_query_calls: 0 });
    expect(JSON.stringify(malformed)).not.toContain('RECOGNIZABLE_PROVIDER_BODY');
    expect(JSON.stringify(malformed)).not.toContain('recognizable.invalid');
  });

  it('matches the reviewed final standings overlap with real proof hashes without executing either lane', async () => {
    const observation = await orchestrateSemanticShadow(STANDINGS, {
      ...dependencies([]),
      template_dual: true
    });

    expect(observation).toMatchObject({
      outcome: 'answer',
      result_query_calls: 0,
      template_dual: {
        enabled: true,
        status: 'matched',
        template_id: 'final_standings_points',
        template_intent_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        template_program_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        template_proof_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
  });

  it('maps all reviewed current cases through proof and template dual without execution', async () => {
    for (const [question, mentions] of [
      [DEV_POINTS, []],
      [IID_POINTS_ALL, []],
      [FILTERED_POINTS, [driverMention(FILTERED_POINTS, 'Charles Leclerc', ['charles-leclerc'], ['charles-leclerc'])]],
      [PAIR_POINTS, [
        driverMention(PAIR_POINTS, 'Lando Norris', ['lando-norris'], ['lando-norris']),
        driverMention(PAIR_POINTS, 'Oscar Piastri', ['oscar-piastri'], ['oscar-piastri'])
      ]],
      [REVERSED_PAIR_POINTS, [
        driverMention(REVERSED_PAIR_POINTS, 'Oscar Piastri', ['oscar-piastri'], ['oscar-piastri']),
        driverMention(REVERSED_PAIR_POINTS, 'Lando Norris', ['lando-norris'], ['lando-norris'])
      ]]
    ] as const) {
      const observation = await orchestrateSemanticShadow(question, {
        ...dependencies(mentions),
        template_dual: true
      });

      expect(observation).toMatchObject({
        outcome: 'answer',
        reason: 'plan_proven',
        topology_code: 'single_source_rows',
        source_set_code: 'driver_standings',
        operator_set_code: 'filter_project_sort_limit',
        candidate_counts: { comparison: 'exact', matched: 1, omitted: 0, extraneous: 0 },
        result_query_calls: 0,
        template_dual: {
          enabled: true,
          status: 'matched',
          template_id: 'final_standings_points'
        }
      });
    }
  });

  it('proves the template before proposal failure and retains its hashes', async () => {
    let proposalCalls = 0;
    const observation = await orchestrateSemanticShadow(STANDINGS, {
      ...dependencies([], { type: 'missing' }, async () => {
        proposalCalls += 1;
        throw new Error('provider unavailable');
      }),
      template_dual: true
    });

    expect(proposalCalls).toBe(1);
    expect(observation).toMatchObject({
      outcome: 'unavailable', reason: 'provider_unavailable',
      template_dual: {
        enabled: true,
        status: 'semantic_lane_incomplete',
        template_id: 'final_standings_points',
        template_intent_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        template_program_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        template_proof_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
  });

  it('reports an inapplicable template lane independently of a proven semantic plan', async () => {
    const observation = await orchestrateSemanticShadow(SCALAR_COUNT, {
      ...dependencies([]),
      template_dual: true
    });

    expect(observation).toMatchObject({
      outcome: 'answer',
      template_dual: { enabled: true, status: 'not_applicable' }
    });
    expect(observation.template_dual).not.toHaveProperty('template_proof_sha256');
  });

  it('replays the exact frozen event result when both lanes request the same event', async () => {
    let eventReads = 0;
    const resolution = { type: 'resolved', season: 2025, round: 1 } as const;
    const base = dependencies([], resolution);
    const observation = await orchestrateSemanticShadow(EVENT_DATE, {
      ...base,
      template_dual: true,
      event_resolver: {
        resolve: async () => {eventReads += 1; return resolution;},
        resolveRound: async () => {eventReads += 1; return resolution;}
      }
    });

    expect(observation).toMatchObject({
      outcome: 'answer',
      resolver_counts: { event_reads: 1 },
      template_dual: {
        enabled: true,
        status: 'not_comparable',
        template_id: 'race_date'
      }
    });
    expect(eventReads).toBe(1);
    expect(Object.isFrozen(resolution)).toBe(true);
  });

  it('reports a contradiction in the mapped final standings pair as mismatched', async () => {
    const contract = createAnswerQuestionContract(STANDINGS);
    const driverResolver = { inventoryMentions: async () => [] };
    const intent = await deriveAnswerIntent(contract, driverResolver);
    const templateProof = verifyAnswerSemanticProof(await proveAnswerIntent(
      contract, intent, fixtureEventResolver({ type: 'missing' }), driverResolver
    ));
    const evidence = enumerateSemanticQueries(STANDINGS, []);
    if (evidence.type !== 'candidate_set') throw new Error('missing fixture candidates');
    const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, STANDINGS, evidence);
    if (admission.type !== 'admitted') throw new Error('fixture was not admitted');
    const resolution = await collectSemanticResolutionEvidence({
      question: STANDINGS,
      admission,
      driver_resolver: driverResolver,
      event_resolver: fixtureEventResolver({ type: 'missing' })
    });
    const plan = planSemanticAnswerFromResolution({ question: STANDINGS, admission, resolution });
    const mutation = structuredClone(plan);
    mutation.branches[0].predicates[0].value = 2024;

    expect(compareTemplateAndSemanticPlan(templateProof, plan)).toBe('matched');
    expect(compareTemplateAndSemanticPlan(templateProof, mutation)).toBe('mismatched');
  });

  it('compares canonical pair membership separately from question-span identity order', async () => {
    const mentions = [
      driverMention(REVERSED_PAIR_POINTS, 'Oscar Piastri', ['oscar-piastri'], ['oscar-piastri']),
      driverMention(REVERSED_PAIR_POINTS, 'Lando Norris', ['lando-norris'], ['lando-norris'])
    ];
    const contract = createAnswerQuestionContract(REVERSED_PAIR_POINTS);
    const driverResolver = { inventoryMentions: async () => mentions };
    const intent = await deriveAnswerIntent(contract, driverResolver);
    const templateProof = verifyAnswerSemanticProof(await proveAnswerIntent(
      contract, intent, fixtureEventResolver({ type: 'missing' }), driverResolver
    ));
    const evidence = enumerateSemanticQueries(REVERSED_PAIR_POINTS, mentions.map(mention => ({
      type: 'driver' as const,
      span: { text: mention.text, start: mention.start, end: mention.end }
    })));
    if (evidence.type !== 'candidate_set') throw new Error('missing fixture candidates');
    const admission = admitSemanticQueryCandidates(
      { version: 2, candidates: evidence.candidates }, REVERSED_PAIR_POINTS, evidence
    );
    if (admission.type !== 'admitted') throw new Error('fixture was not admitted');
    const resolution = await collectSemanticResolutionEvidence({
      question: REVERSED_PAIR_POINTS, admission, driver_resolver: driverResolver,
      event_resolver: fixtureEventResolver({ type: 'missing' })
    });
    const plan = planSemanticAnswerFromResolution({
      question: REVERSED_PAIR_POINTS, admission, resolution
    });
    const swapped = structuredClone(plan);
    swapped.linked_entities.reverse();

    expect(templateProof.template_variables).toEqual({
      season: 2025,
      driver_ids: ['lando-norris', 'oscar-piastri']
    });
    expect(templateProof.mentions.map(mention => mention.selected_id))
      .toEqual(['oscar-piastri', 'lando-norris']);
    expect(compareTemplateAndSemanticPlan(templateProof, plan)).toBe('matched');
    expect(compareTemplateAndSemanticPlan(templateProof, swapped)).toBe('mismatched');
  });

  it('compares canonical four-driver membership separately from question-span identity order', async () => {
    const question = 'List driver and championship points for Oscar Piastri, Lando Norris, George Russell, Charles Leclerc from final 2025 driver standings.';
    const drivers = [
      ['Oscar Piastri', 'oscar-piastri'],
      ['Lando Norris', 'lando-norris'],
      ['George Russell', 'george-russell'],
      ['Charles Leclerc', 'charles-leclerc']
    ] as const;
    const mentions = drivers.map(([name, id]) => driverMention(question, name, [id], [id]));
    const entities = mentions.map(mention => ({
      type: 'driver' as const, span: { text: mention.text, start: mention.start, end: mention.end }
    }));
    const evidence = enumerateSemanticQueries(question, entities);
    if (evidence.type !== 'candidate_set') throw new Error('missing fixture candidates');
    const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, question, evidence);
    if (admission.type !== 'admitted') throw new Error('fixture was not admitted');
    const driverResolver = { inventoryMentions: async () => mentions };
    const resolution = await collectSemanticResolutionEvidence({
      question, admission, driver_resolver: driverResolver,
      event_resolver: fixtureEventResolver({ type: 'missing' })
    });
    const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
    const canonicalIds = drivers.map(([, id]) => id).sort();
    const template = {
      question_hash: createAnswerQuestionContract(question).sha256,
      mentions: drivers.map(([, selected_id]) => ({ kind: 'driver' as const, selected_id })),
      template_id: 'final_standings_points' as const,
      template_variables: { season: 2025, driver_ids: canonicalIds },
      program: materializeAnswerTemplate('final_standings_points', {
        season: 2025, driver_ids: canonicalIds
      })
    };
    const swapped = structuredClone(plan);
    swapped.linked_entities.reverse();

    expect(compareTemplateAndSemanticPlan(template as never, plan)).toBe('matched');
    expect(compareTemplateAndSemanticPlan(template as never, swapped)).toBe('mismatched');
  });

  it('classifies join-path ambiguity as clarification', () => {
    expect(classifySemanticShadowOutcome('join_path_ambiguous')).toBe('clarify');
    expect(classifySemanticShadowOutcome('source_graph_disconnected')).toBe('abstain');
  });

  it('does not leak recognizable question, resolver, provider error, plan, program, SQL, parameter, or row material', async () => {
    const question = COMPOSE;
    const resolverId = 'recognizable-private-driver';
    const observation = await orchestrateSemanticShadow(question, dependencies(
      [driverMention(question, 'Norris', [resolverId], [resolverId])],
      { type: 'missing' }
    ));
    const serialized = JSON.stringify(observation);
    for (const forbidden of [question, 'Norris', resolverId, 'SELECT ', 'https://', 'params']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/"(?:rows|sql|params|entities|question)"\s*:/iu);
    expect(Object.keys(observation)).not.toContain('plan');
    expect(Object.keys(observation)).not.toContain('program');
    expect(() => sanitizeSemanticShadowObservation({ ...observation, sql: 'RECOGNIZABLE_SQL' })).toThrow();
    const partialPlanHashes = structuredClone(unavailableObservationFixture(observation));
    partialPlanHashes.hashes.answer_plan_sha256 = 'a'.repeat(64);
    expect(() => sanitizeSemanticShadowObservation(partialPlanHashes)).toThrow('plan fields are incomplete');

    const unavailable = await orchestrateSemanticShadow(STANDINGS, dependencies([], { type: 'missing' }, async () => {
      throw new Error('RECOGNIZABLE_PROVIDER_ERROR https://private.invalid');
    }));
    expect(unavailable).toMatchObject({ outcome: 'unavailable', reason: 'provider_unavailable' });
    expect(JSON.stringify(unavailable)).not.toMatch(/RECOGNIZABLE_PROVIDER_ERROR|private\.invalid/u);
  });

  it.each(['execute', 'afterPlan', 'onProof'])('rejects unknown callback dependency %s before invoking any stage', async callback => {
    let calls = 0;
    const input = {
      ...dependencies([], { type: 'missing' }, async () => {calls += 1; return {}; }),
      [callback]: async () => {calls += 1;}
    };
    await expect(orchestrateSemanticShadow(STANDINGS, input)).rejects.toThrow('dependencies are invalid');
    expect(calls).toBe(0);
  });

  it('keeps resolver inventory private from the provider and enforces one global candidate budget', async () => {
    const question = COMPOSE;
    const reference = span(question, 'Norris');
    const candidates = Array.from({ length: 67 }, (_value, index) => `driver-${String(index).padStart(3, '0')}`);
    const mentions = Array.from({ length: 3 }, (_value, index) => ({
      text: `${reference.text}-${index}`,
      start: reference.start + index,
      end: reference.end + index,
      candidates,
      active_candidates: [candidates[0]]
    }));
    expect(mentions.reduce((total, mention) => total + mention.candidates.length, 0))
      .toBe(SEMANTIC_SHADOW_RESOLVER_MAX_TOTAL_CANDIDATES + 1);
    let proposalCalls = 0;
    const observation = await orchestrateSemanticShadow(question, dependencies(mentions, { type: 'missing' }, async request => {
      proposalCalls += 1;
      expect(Object.keys(request).sort()).toEqual(['max_candidates', 'question', 'semantic_query_version']);
      expect(JSON.stringify(request)).not.toContain('driver-0');
      return {};
    }));
    expect(observation).toMatchObject({ outcome: 'abstain', reason: 'entity_inventory_mismatch' });
    expect(proposalCalls).toBe(0);
  });

  it('retains active provenance and rejects copied evidence, admission, resolution, plan, and proof objects', async () => {
    const evidence = enumerateSemanticQueries(STANDINGS, []);
    if (evidence.type !== 'candidate_set') throw new Error('missing fixture candidates');
    const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, STANDINGS, evidence);
    if (admission.type !== 'admitted') throw new Error('fixture was not admitted');
    const resolution = await collectSemanticResolutionEvidence({
      question: STANDINGS,
      admission,
      driver_resolver: { inventoryMentions: async () => [] },
      event_resolver: fixtureEventResolver({ type: 'missing' })
    });
    const plan = planSemanticAnswerFromResolution({ question: STANDINGS, admission, resolution });
    const proof = proveSemanticAnswerPlan({ question: STANDINGS, entity_inventory: [], evidence, admission, resolution, plan });

    expect(() => verifySemanticEvidence(structuredClone(evidence), STANDINGS, [])).toThrow('provenance');
    expect(() => verifySemanticQueryAdmission(structuredClone(admission), STANDINGS)).toThrow('provenance');
    expect(() => verifySemanticResolutionEvidence(structuredClone(resolution), STANDINGS, admission)).toThrow('provenance');
    expect(() => verifyAnswerPlan(structuredClone(plan))).toThrow('provenance');
    expect(() => verifySemanticPlanProof(structuredClone(proof))).toThrow('provenance');
  });

  it('has no executor, authorization, formatter, interpreter, pg, database, or route import graph', () => {
    const graph = sourceGraph([
      resolve('src/f1ql/semantic-shadow-planner.ts'),
      resolve('src/f1ql/semantic-shadow-observations.ts')
    ]);
    const relative = [...graph.keys()].map(file => file.replace(`${resolve('.')}\/`, ''));
    expect(relative).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/(?:executor|authorization|format|interpreter|routes?)(?:\.ts|\/)/u)
    ]));
    const entrySource = readFileSync(resolve('src/f1ql/semantic-shadow-planner.ts'), 'utf8');
    expect(entrySource).not.toMatch(/from ['"]pg['"]|from ['"].*(?:executor|authorization|format|interpreter|routes?)["']/u);
    expect(entrySource).not.toMatch(/executeF1QL|database\.query|getSemanticPlanProofParent/u);
  });
});

function dependencies(
  mentions: readonly SemanticDriverMention[],
  eventResolution: EventResolution = { type: 'missing' },
  propose?: SemanticShadowDependencies['proposer']['propose']
): SemanticShadowDependencies {
  return {
    proposer: { propose: propose ?? exactProposal(mentions) },
    entity_inventory_resolver: { inventoryMentions: async () => mentions },
    event_resolver: fixtureEventResolver(eventResolution)
  };
}

function exactProposal(mentions: readonly SemanticDriverMention[]): SemanticShadowDependencies['proposer']['propose'] {
  return async request => {
    const contract = createAnswerQuestionContract(request.question);
    const inventory = [
      ...mentions.map(mention => ({ type: 'driver' as const, span: { text: mention.text, start: mention.start, end: mention.end } })),
      ...contract.event_cues.map(event => ({ type: 'event' as const, span: { text: event.text, start: event.start, end: event.end } }))
    ];
    const evidence = enumerateSemanticQueries(request.question, inventory);
    if (evidence.type !== 'candidate_set') throw new Error('missing fixture candidates');
    return { version: 2, candidates: evidence.candidates };
  };
}

type EventResolution =
  | { readonly type: 'resolved'; readonly season: number; readonly round: number }
  | { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] }
  | { readonly type: 'missing' };

function fixtureEventResolver(resolution: EventResolution) {
  return { resolve: async () => resolution, resolveRound: async () => resolution };
}

function driverMention(
  question: string,
  text: string,
  candidates: readonly string[],
  activeCandidates: readonly string[]
): SemanticDriverMention {
  return { ...span(question, text), candidates, active_candidates: activeCandidates };
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing fixture span ${text}`);
  return { text, start, end: start + target.length };
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

function unavailableObservationFixture(observation: Awaited<ReturnType<typeof orchestrateSemanticShadow>>) {
  const fixture = structuredClone(observation);
  fixture.outcome = 'unavailable';
  fixture.reason = 'provider_unavailable';
  delete fixture.topology_code;
  delete fixture.source_set_code;
  delete fixture.operator_set_code;
  delete fixture.plan_work;
  fixture.hashes = {};
  return fixture;
}

function sourceGraph(entries: readonly string[]): Map<string, string> {
  const graph = new Map<string, string>();
  const visit = (file: string) => {
    if (graph.has(file)) return;
    const source = readFileSync(file, 'utf8');
    graph.set(file, source);
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)) {
      const base = resolve(dirname(file), match[1]);
      const child = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(resolve(base, 'index.ts')) ? resolve(base, 'index.ts') : undefined;
      if (child) visit(child);
    }
  };
  entries.forEach(visit);
  return graph;
}
