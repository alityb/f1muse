import { AnswerIntent } from './answer-intent';
import { ANSWER_INTENT_DERIVATION_VERSION, deriveAnswerIntent } from './answer-intent-derivation';
import { ANSWER_QUESTION_CONTRACT_VERSION, AnswerQuestionContract, createAnswerQuestionContract } from './answer-question';
import {
  ANSWER_SEMANTIC_PROOF_VERSION,
  AnswerSemanticProof,
  VerifiedAnswerSemanticProof,
  proveAnswerIntent,
  verifyAnswerSemanticProof
} from './answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_VERSION } from './answer-templates';
import {
  classifySemanticTemplateEquivalence
} from './semantic-template-equivalence';
import { F1QL_FACT_SPACE_VERSION } from './fact-space-version';
import { PLANNED_F1QL_VERSION } from './planned-f1ql';
import { PLANNED_F1QL_COMPILER_VERSION } from './planned-compiler';
import {
  SEMANTIC_PLAN_PROOF_VERSION,
  SemanticPlanProofError,
  proveSemanticAnswerPlan,
  verifySemanticPlanProof
} from './semantic-plan-proof';
import {
  AnswerPlannerError,
  AnswerPlan,
  SEMANTIC_PLANNER_VERSION,
  planSemanticAnswerFromResolution
} from './semantic-planner';
import {
  SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
  SEMANTIC_RESOLVER_MAX_CANDIDATES,
  SemanticDriverMention,
  SemanticDriverResolver,
  SemanticEventResolver,
  SemanticResolutionError,
  VerifiedSemanticResolutionEvidence,
  collectSemanticResolutionEvidence,
  verifySemanticResolutionEvidence
} from './semantic-resolution-evidence';
import {
  SEMANTIC_EVIDENCE_VERSION,
  SEMANTIC_QUERY_MAX_CANDIDATES,
  SEMANTIC_QUERY_VERSION,
  SemanticAbstentionReason,
  SemanticAmbiguityReason,
  SemanticEntityInventoryItem,
  SemanticEvidence,
  SemanticQuery,
  admitSemanticQueryCandidates,
  computeSemanticCandidateSetHash,
  computeSemanticEvidenceHash,
  computeSemanticQueryHash,
  enumerateSemanticQueries,
  parseSemanticQueryCandidateSet
} from './semantic-query';
import {
  SEMANTIC_SHADOW_OBSERVATION_VERSION,
  SemanticShadowObservation,
  SemanticShadowReason,
  sanitizeSemanticShadowObservation
} from './semantic-shadow-observations';

export const SEMANTIC_SHADOW_ORCHESTRATOR_VERSION = 'semantic-shadow-planner-v6' as const;
export const SEMANTIC_SHADOW_RESOLVER_MAX_TOTAL_CANDIDATES = 200;

export interface SemanticShadowProposalRequest {
  readonly question: string;
  readonly semantic_query_version: typeof SEMANTIC_QUERY_VERSION;
  readonly max_candidates: typeof SEMANTIC_QUERY_MAX_CANDIDATES;
}

export interface SemanticShadowProposer {
  propose(request: SemanticShadowProposalRequest): Promise<unknown>;
}

export class SemanticShadowProposalError extends Error {
  constructor(readonly reason: 'provider_malformed' | 'provider_unavailable') {
    super(reason);
    this.name = 'SemanticShadowProposalError';
  }
}

export class SemanticShadowDependencyError extends Error {
  constructor(readonly dependencyError: unknown) {
    super('semantic shadow dependency failed');
    this.name = 'SemanticShadowDependencyError';
  }
}

export interface SemanticShadowDependencies {
  readonly proposer: SemanticShadowProposer;
  readonly entity_inventory_resolver: SemanticDriverResolver;
  readonly event_resolver: SemanticEventResolver;
  readonly template_dual?: boolean;
  readonly now?: () => number;
}

type CandidateComparison = SemanticShadowObservation['candidate_counts'];
type Latencies = Omit<SemanticShadowObservation['latencies'], 'total_ms'>;
type DualObservation = SemanticShadowObservation['template_dual'];
type TemplateLane = {
  readonly observation: DualObservation;
  readonly proof?: VerifiedAnswerSemanticProof;
};
type EventRequest = {
  readonly operation: 'resolve' | 'resolveRound';
  readonly season: number;
  readonly value: string | number;
  readonly result: Promise<Awaited<ReturnType<SemanticEventResolver['resolve']>>>;
};

const CLARIFICATION_REASONS = new Set<SemanticShadowReason>([
  'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
  'scope_ambiguous', 'temporal_ambiguous', 'event_ambiguous', 'join_path_ambiguous'
]);
const GENERIC_DRIVER_MENTIONS = new Set(['driver', 'drivers']);

export async function orchestrateSemanticShadow(
  questionInput: unknown,
  dependenciesInput: unknown
): Promise<SemanticShadowObservation> {
  const dependencies = parseDependencies(dependenciesInput);
  const now = dependencies.now ?? (() => performance.now());
  const totalStartedAt = now();
  const latencies: Partial<Latencies> = {};
  let inventoryReads = 0;
  let eventReads = 0;
  let inventoryEntities = 0;
  let verifiedCandidates = 0;
  let comparison = emptyComparison();
  let hashes: SemanticShadowObservation['hashes'] = {};
  const finish = (input: Omit<SemanticShadowObservation, 'latencies' | 'resolver_counts' | 'result_query_calls' | 'versions' | 'version'>) =>
    sanitizeSemanticShadowObservation({
      version: SEMANTIC_SHADOW_OBSERVATION_VERSION,
      ...input,
      resolver_counts: {
        inventory_reads: inventoryReads,
        event_reads: eventReads,
        fingerprint_reads: 0,
        inventory_entities: inventoryEntities,
        verified_candidates: verifiedCandidates
      },
      latencies: { ...latencies, total_ms: boundedLatency(totalStartedAt, now()) },
      result_query_calls: 0,
      versions: semanticShadowActiveVersions()
    });

  let contract: AnswerQuestionContract;
  try {
    contract = timedSync('contract_ms', latencies, now, () => createAnswerQuestionContract(questionInput));
  } catch {
    return finish(baseFailure('question_invalid', comparison, hashes, unavailableTemplateLane(dependencies.template_dual)));
  }

  let transcript: readonly SemanticDriverMention[] = [];
  const uniqueSeason = new Set(contract.years.map(year => year.value));
  if (uniqueSeason.size === 1) {
    try {
      transcript = await timed('inventory_ms', latencies, now, async () => {
        inventoryReads += 1;
        const mentions = parseDriverTranscript(await dependencies.entity_inventory_resolver.inventoryMentions(
          contract.normalized_question,
          contract.years[0].value
        ));
        validateDriverTranscriptSpans(mentions, contract.normalized_question);
        return mentions.filter(mention => !GENERIC_DRIVER_MENTIONS.has(mention.text.toLocaleLowerCase('en-US')));
      });
    } catch (error) {
      rethrowDependencyError(error);
      return finish(baseFailure('entity_inventory_mismatch', comparison, hashes, unavailableTemplateLane(dependencies.template_dual)));
    }
  }
  let inventory: readonly SemanticEntityInventoryItem[];
  try {
    inventory = semanticEntityInventory(contract, transcript);
  } catch {
    return finish(baseFailure('entity_inventory_mismatch', comparison, hashes, unavailableTemplateLane(dependencies.template_dual)));
  }
  inventoryEntities = inventory.length;
  const cachedDriverResolver: SemanticDriverResolver = {
    inventoryMentions: async (question, season) => {
      if (question !== contract.normalized_question || uniqueSeason.size !== 1 || season !== contract.years[0].value) {
        throw new SemanticResolutionError('entity_inventory_mismatch');
      }
      return transcript;
    }
  };
  const cachedEventResolver = createCachedEventResolver(dependencies.event_resolver, () => {eventReads += 1;});
  const templateLane = dependencies.template_dual
    ? await timed('template_dual_ms', latencies, now, () => runTemplateLane(contract, cachedDriverResolver, cachedEventResolver))
    : { observation: notRequestedDual() };

  let evidence: SemanticEvidence;
  try {
    evidence = timedSync('enumeration_ms', latencies, now, () =>
      enumerateSemanticQueries(contract.normalized_question, inventory));
  } catch {
    return finish(baseFailure('evidence_invalid', comparison, hashes, incompleteDual(templateLane)));
  }
  hashes = {
    catalog_sha256: evidence.catalog_hash,
    semantic_evidence_sha256: computeSemanticEvidenceHash(evidence)
  };
  if (evidence.type === 'abstention') {
    comparison = {
      ...emptyComparison(),
      ...(evidence.candidate_count_lower_bound === undefined ? {} : { enumerated_lower_bound: evidence.candidate_count_lower_bound })
    };
    return finish(baseFailure(evidence.reason, comparison, hashes, incompleteDual(templateLane)));
  }
  comparison = { ...emptyComparison(), enumerated: evidence.candidates.length };
  hashes = { ...hashes, candidate_set_sha256: evidence.candidate_set_hash };

  let providerInput: unknown;
  try {
    providerInput = await timed('proposal_ms', latencies, now, () => dependencies.proposer.propose(deepFreeze({
      question: contract.normalized_question,
      semantic_query_version: SEMANTIC_QUERY_VERSION,
      max_candidates: SEMANTIC_QUERY_MAX_CANDIDATES
    })));
  } catch (error) {
    const reason = error instanceof SemanticShadowProposalError ? error.reason : 'provider_unavailable';
    return finish(baseFailure(reason, comparison, hashes, incompleteDual(templateLane)));
  }
  try {
    const provider = parseSemanticQueryCandidateSet(providerInput, contract.normalized_question);
    comparison = compareCandidates(evidence.candidates, provider.candidates);
    hashes = {
      ...hashes,
      provider_candidate_set_sha256: computeSemanticCandidateSetHash(
        provider.candidates,
        contract.sha256,
        evidence.catalog_hash
      )
    };
  } catch {
    return finish(baseFailure('provider_malformed', comparison, hashes, incompleteDual(templateLane)));
  }

  let admission;
  try {
    admission = timedSync('admission_ms', latencies, now, () =>
      admitSemanticQueryCandidates(providerInput, contract.normalized_question, evidence));
  } catch {
    return finish(baseFailure('admission_invalid', comparison, hashes, incompleteDual(templateLane)));
  }
  if (admission.type === 'clarification_required') {
    return finish(baseFailure(admission.reason, comparison, hashes, incompleteDual(templateLane), 'clarify'));
  }
  if (admission.type === 'abstention') {
    return finish(baseFailure(admission.reason, comparison, hashes, incompleteDual(templateLane)));
  }
  hashes = { ...hashes, semantic_query_sha256: admission.query_hash };

  let resolution: VerifiedSemanticResolutionEvidence;
  try {
    resolution = await timed('resolution_ms', latencies, now, async () => {
      const collected = await collectSemanticResolutionEvidence({
        question: contract.normalized_question,
        admission,
        driver_resolver: cachedDriverResolver,
        event_resolver: cachedEventResolver
      });
      return verifySemanticResolutionEvidence(collected, contract.normalized_question, admission);
    });
    verifiedCandidates = resolution.resolver_candidates;
  } catch (error) {
    rethrowDependencyError(error);
    const reason = error instanceof SemanticResolutionError ? error.reason : 'resolution_invalid';
    return finish(baseFailure(reason, comparison, hashes, incompleteDual(templateLane), classifySemanticShadowOutcome(reason)));
  }

  let plan: AnswerPlan;
  try {
    plan = timedSync('planning_ms', latencies, now, () => planSemanticAnswerFromResolution({
      question: contract.normalized_question,
      admission,
      resolution
    }));
  } catch (error) {
    const reason = error instanceof AnswerPlannerError ? error.reason : 'shadow_internal_failure';
    return finish(baseFailure(reason, comparison, hashes, incompleteDual(templateLane), classifySemanticShadowOutcome(reason)));
  }
  let proof;
  try {
    proof = timedSync('proof_ms', latencies, now, () => verifySemanticPlanProof(proveSemanticAnswerPlan({
      question: contract.normalized_question,
      entity_inventory: inventory,
      evidence,
      admission,
      resolution,
      plan
    })));
  } catch (error) {
    const reason = error instanceof SemanticPlanProofError ? error.reason : 'shadow_internal_failure';
    return finish(baseFailure(reason, comparison, hashes, incompleteDual(templateLane)));
  }

  const dual = completedDual(templateLane, plan);
  hashes = {
    ...hashes,
    answer_plan_sha256: plan.answer_plan_hash,
    topology_sha256: proof.topology_hash,
    planned_f1ql_sha256: proof.planned_f1ql_hash,
    core_sha256: proof.core_hash,
    compiled_sha256: proof.compiled_hash,
    semantic_proof_sha256: proof.proof_hash
  };
  return finish({
    outcome: 'answer',
    reason: 'plan_proven',
    candidate_counts: comparison,
    topology_code: plan.topology,
    source_set_code: sourceSetCode(plan),
    operator_set_code: operatorSetCode(plan.topology),
    plan_work: plan.work,
    hashes,
    template_dual: dual
  });
}

function parseDependencies(input: unknown): SemanticShadowDependencies {
  if (!isPlainObject(input) || !hasOnlyKeys(input, [
    'entity_inventory_resolver', 'event_resolver', 'now', 'proposer', 'template_dual'
  ])) {
    throw new Error('semantic shadow dependencies are invalid');
  }
  const proposer = parseMethodObject(input.proposer, ['propose']);
  const driver = parseMethodObject(input.entity_inventory_resolver, ['inventoryMentions']);
  const event = parseMethodObject(input.event_resolver, ['resolve', 'resolveRound']);
  if ((input.now !== undefined && typeof input.now !== 'function') ||
      (input.template_dual !== undefined && typeof input.template_dual !== 'boolean')) {
    throw new Error('semantic shadow dependencies are invalid');
  }
  return {
    proposer: { propose: proposer.propose as SemanticShadowProposer['propose'] },
    entity_inventory_resolver: { inventoryMentions: driver.inventoryMentions as SemanticDriverResolver['inventoryMentions'] },
    event_resolver: {
      resolve: event.resolve as SemanticEventResolver['resolve'],
      resolveRound: event.resolveRound as SemanticEventResolver['resolveRound']
    },
    ...(input.template_dual === undefined ? {} : { template_dual: input.template_dual }),
    ...(input.now === undefined ? {} : { now: input.now as () => number })
  };
}

type UnknownMethod = (...args: never[]) => unknown;

function parseMethodObject(input: unknown, methods: readonly string[]): Record<string, UnknownMethod> {
  if (!isPlainObject(input) || !hasOnlyKeys(input, methods) || methods.some(method => typeof input[method] !== 'function')) {
    throw new Error('semantic shadow dependencies are invalid');
  }
  return input as Record<string, UnknownMethod>;
}

function parseDriverTranscript(input: unknown): readonly SemanticDriverMention[] {
  if (!Array.isArray(input) || input.length > 8) {throw new Error('semantic shadow entity inventory is invalid');}
  const mentions = input.map(item => {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ['active_candidates', 'candidates', 'end', 'start', 'text']) ||
        typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 300 ||
        !Number.isInteger(item.start) || !Number.isInteger(item.end) || (item.end as number) <= (item.start as number) ||
        !Array.isArray(item.candidates) || !Array.isArray(item.active_candidates)) {
      throw new Error('semantic shadow entity inventory is invalid');
    }
    const candidates = candidateIds(item.candidates);
    const active = candidateIds(item.active_candidates);
    if (active.some(candidate => !candidates.includes(candidate))) {throw new Error('semantic shadow entity inventory is invalid');}
    return {
      text: item.text,
      start: item.start as number,
      end: item.end as number,
      candidates,
      active_candidates: active
    };
  }).sort(compareMentions);
  if (new Set(mentions.map(mention => `${mention.start}:${mention.end}:${mention.text}`)).size !== mentions.length) {
    throw new Error('semantic shadow entity inventory is invalid');
  }
  if (mentions.reduce((total, mention) => total + mention.candidates.length, 0) >
      SEMANTIC_SHADOW_RESOLVER_MAX_TOTAL_CANDIDATES) {
    throw new Error('semantic shadow resolver candidate budget is exceeded');
  }
  return deepFreeze(mentions);
}

function validateDriverTranscriptSpans(mentions: readonly SemanticDriverMention[], question: string): void {
  const points = Array.from(question);
  if (mentions.some(mention => mention.start < 0 || mention.end > points.length ||
      points.slice(mention.start, mention.end).join('') !== mention.text)) {
    throw new Error('semantic shadow entity inventory is invalid');
  }
}

function candidateIds(input: readonly unknown[]): string[] {
  if (input.length > SEMANTIC_RESOLVER_MAX_CANDIDATES || input.some(value =>
    typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(value))) {
    throw new Error('semantic shadow resolver candidates are invalid');
  }
  const values = [...input] as string[];
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1] >= value)) {
    throw new Error('semantic shadow resolver candidates are invalid');
  }
  return values;
}

function semanticEntityInventory(
  contract: AnswerQuestionContract,
  mentions: readonly SemanticDriverMention[]
): readonly SemanticEntityInventoryItem[] {
  const inventory = [
    ...mentions.map(mention => ({ type: 'driver' as const, span: { text: mention.text, start: mention.start, end: mention.end } })),
    ...contract.event_cues.map(event => ({ type: 'event' as const, span: { text: event.text, start: event.start, end: event.end } }))
  ].sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end || compareText(left.type, right.type));
  if (inventory.length > 8) {throw new Error('semantic shadow entity inventory is invalid');}
  return deepFreeze(inventory);
}

function compareCandidates(enumerated: readonly SemanticQuery[], proposed: readonly SemanticQuery[]): CandidateComparison {
  const expected = new Set(enumerated.map(computeSemanticQueryHash));
  const actual = new Set(proposed.map(computeSemanticQueryHash));
  const matched = [...actual].filter(hash => expected.has(hash)).length;
  const omitted = [...expected].filter(hash => !actual.has(hash)).length;
  const extraneous = [...actual].filter(hash => !expected.has(hash)).length;
  const status = comparisonStatus(omitted, extraneous);
  return { enumerated: expected.size, proposed: actual.size, matched, omitted, extraneous, comparison: status };
}

function comparisonStatus(omitted: number, extraneous: number): CandidateComparison['comparison'] {
  if (omitted > 0 && extraneous > 0) {return 'mixed';}
  if (omitted > 0) {return 'omission';}
  return extraneous > 0 ? 'extraneous' : 'exact';
}

async function runTemplateLane(
  contract: AnswerQuestionContract,
  driverResolver: SemanticDriverResolver,
  eventResolver: SemanticEventResolver
): Promise<TemplateLane> {
  let intent: AnswerIntent;
  try {
    intent = await deriveAnswerIntent(contract, driverResolver);
  } catch (error) {
    rethrowDependencyError(error);
    return { observation: { enabled: true, status: 'template_proof_failed' } };
  }
  if (intent.type === 'clarification' || intent.type === 'unsupported') {
    return { observation: { enabled: true, status: 'not_applicable' } };
  }
  try {
    const proof = verifyAnswerSemanticProof(await proveAnswerIntent(
      contract,
      intent,
      eventResolver,
      driverResolver
    ));
    return deepFreeze({ proof, observation: proofDual('semantic_lane_incomplete', proof) });
  } catch (error) {
    rethrowDependencyError(error);
    return { observation: { enabled: true, status: 'template_proof_failed' } };
  }
}

function createCachedEventResolver(resolver: SemanticEventResolver, onRead: () => void): SemanticEventResolver {
  let request: EventRequest | undefined;
  const read = (
    operation: EventRequest['operation'],
    season: number,
    value: string | number
  ): EventRequest['result'] => {
    if (request) {
      if (request.operation !== operation || request.season !== season || request.value !== value) {
        throw new SemanticResolutionError('entity_inventory_mismatch');
      }
      return request.result;
    }
    onRead();
    const result = Promise.resolve().then(() => operation === 'resolve'
      ? resolver.resolve(season, value as string)
      : resolver.resolveRound(season, value as number)).then(deepFreeze);
    request = Object.freeze({ operation, season, value, result });
    return result;
  };
  return Object.freeze({
    resolve: (season: number, name: string) => read('resolve', season, name),
    resolveRound: (season: number, round: number) => read('resolveRound', season, round)
  });
}

// Keep the complete template/semantic dual comparison visible as one gate.
// eslint-disable-next-line complexity, max-lines-per-function
export function compareTemplateAndSemanticPlan(
  template: Pick<AnswerSemanticProof, 'question_hash' | 'mentions' | 'template_id' | 'template_variables' | 'program'>,
  semantic: Pick<AnswerPlan, 'question_sha256' | 'topology' | 'linked_entities' | 'source_graph' | 'branches' | 'output_grain' | 'planned_f1ql'>
): 'matched' | 'mismatched' | 'not_comparable' {
  const project = semantic.planned_f1ql.root.input.input;
  if (classifySemanticTemplateEquivalence(
    template.template_id,
    template.template_variables,
    template.program
  ) !== 'program_shape_overlap' ||
      semantic.topology !== 'single_source_rows' ||
      !sameValue(project.outputs.map(output => ({ kind: output.kind, as: output.as })), [
        { kind: 'concept', as: 'driver_id' }, { kind: 'concept', as: 'points' }
      ])) {
    return 'not_comparable';
  }
  const season = template.template_variables.season;
  const driverIds = template.template_variables.driver_ids;
  if (!Number.isSafeInteger(season) || (season as number) < 1950 || (season as number) > 2025) {
    return 'mismatched';
  }
  if (driverIds !== undefined && (!Array.isArray(driverIds) || driverIds.length < 1 || driverIds.length > 4 ||
      driverIds.some((id, index) => typeof id !== 'string' || id.length === 0 ||
        (index > 0 && compareText(driverIds[index - 1], id) >= 0)))) {
    return 'not_comparable';
  }
  const filtered = Array.isArray(driverIds);
  const singleton = driverIds?.length === 1;
  const predicates = [
    ...(filtered ? [{
      concept: { source_id: 'driver_standings', concept_id: 'driver_id' },
      ...(singleton
        ? { operator: 'eq', value: driverIds[0] }
        : { operator: 'in', values: [...driverIds].sort(compareText) })
    }] : []),
    { concept: { source_id: 'driver_standings', concept_id: 'season' }, operator: 'eq', value: season }
  ];
  const expectedProgram = {
    version: 1,
    root: {
      op: 'aggregate',
      input: {
        op: 'filter', input: { op: 'source', source: 'standings' },
        where: { season, ...(filtered ? { driver_id: [...driverIds] } : {}) }
      },
      group_by: ['driver_id'],
      measures: [{ as: 'points', function: 'max', field: 'points' }]
    }
  };
  const expectedBranch = {
    source_id: 'driver_standings', predicates, source_grain: ['driver_id', 'season'],
    fixed_grain: singleton ? ['driver_id', 'season'] : ['season'], residual_grain: singleton ? [] : ['driver_id']
  };
  const expectedProject = {
    op: 'project',
    input: { op: 'filter', input: { op: 'source', source_id: 'driver_standings' }, predicates },
    outputs: [
      { kind: 'concept', concept: { source_id: 'driver_standings', concept_id: 'driver_id' }, as: 'driver_id' },
      { kind: 'concept', concept: { source_id: 'driver_standings', concept_id: 'points' }, as: 'points' }
    ]
  };
  const mentionDriverIds = template.mentions.flatMap(mention =>
    mention.kind === 'driver' ? [mention.selected_id] : []);
  const templateEntityBindingsMatch = filtered
    ? template.mentions.length === driverIds.length && mentionDriverIds.length === driverIds.length &&
      sameValue([...mentionDriverIds].sort(compareText), driverIds)
    : template.mentions.length === 0;
  const linkedEntitiesMatch = filtered
    ? semantic.linked_entities.length === mentionDriverIds.length && semantic.linked_entities.every((entity, index) =>
      entity.type === 'driver' && entity.selected_id === mentionDriverIds[index] &&
      sameValue(entity.resolution_relationship_ids, [
        'driver_identity_standings_resolution', 'driver_participation_resolution'
      ]))
    : semantic.linked_entities.length === 0;
  const matches = template.question_hash === semantic.question_sha256 &&
    sameValue(template.template_variables, { season, ...(filtered ? { driver_ids: [...driverIds] } : {}) }) &&
    sameValue(template.program, expectedProgram) && templateEntityBindingsMatch && linkedEntitiesMatch &&
    sameValue(semantic.source_graph, {
      source_ids: ['driver_standings'],
      resolution_relationship_ids: filtered
        ? ['driver_identity_standings_resolution', 'driver_participation_resolution']
        : [],
      row_relationship_ids: []
    }) &&
    sameValue(semantic.branches, [expectedBranch]) &&
    sameValue(semantic.output_grain, singleton ? [] : ['driver_id']) &&
    semantic.planned_f1ql.root.count === (singleton ? 1 : 100) && sameValue(project, expectedProject) &&
    sameValue(semantic.planned_f1ql.root.input.keys, [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]);
  return matches ? 'matched' : 'mismatched';
}

function completedDual(lane: TemplateLane, plan: AnswerPlan): DualObservation {
  return lane.proof
    ? proofDual(compareTemplateAndSemanticPlan(lane.proof, plan), lane.proof)
    : lane.observation;
}

function incompleteDual(lane: TemplateLane): DualObservation {
  return lane.proof ? proofDual('semantic_lane_incomplete', lane.proof) : lane.observation;
}

function proofDual(
  status: 'semantic_lane_incomplete' | 'matched' | 'mismatched' | 'not_comparable',
  proof: VerifiedAnswerSemanticProof
): DualObservation {
  return deepFreeze({
    enabled: true,
    status,
    template_id: proof.template_id,
    template_intent_sha256: proof.intent_hash,
    template_program_sha256: proof.program_hash,
    template_proof_sha256: proof.proof_hash
  });
}

function sourceSetCode(plan: AnswerPlan): NonNullable<SemanticShadowObservation['source_set_code']> {
  const code = plan.source_graph.source_ids.join('__');
  const allowed: readonly NonNullable<SemanticShadowObservation['source_set_code']>[] = [
    'driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification',
    'event_classification__event_metadata', 'event_classification__qualifying_classification',
    'event_metadata__qualifying_classification'
  ];
  if (!allowed.includes(code as NonNullable<SemanticShadowObservation['source_set_code']>)) {
    throw new Error('semantic shadow source set is unsupported');
  }
  return code as NonNullable<SemanticShadowObservation['source_set_code']>;
}

function operatorSetCode(topology: AnswerPlan['topology']): NonNullable<SemanticShadowObservation['operator_set_code']> {
  const codes: Record<AnswerPlan['topology'], NonNullable<SemanticShadowObservation['operator_set_code']>> = {
    single_source_rows: 'filter_project_sort_limit',
    single_source_aggregate: 'filter_aggregate_project_sort_limit',
    row_dimension_join: 'filter_join_project_sort_limit',
    scalar_aggregate_compose: 'filter_aggregate_compose_project_sort_limit'
  };
  return codes[topology];
}

function baseFailure(
  reason: SemanticShadowReason | SemanticAbstentionReason | SemanticAmbiguityReason,
  candidateCounts: CandidateComparison,
  observationHashes: SemanticShadowObservation['hashes'],
  dual: DualObservation,
  outcome: 'clarify' | 'abstain' | 'unavailable' = classifySemanticShadowOutcome(reason)
): Omit<SemanticShadowObservation, 'latencies' | 'resolver_counts' | 'result_query_calls' | 'versions' | 'version'> {
  return { outcome, reason: reason as SemanticShadowReason, candidate_counts: candidateCounts, hashes: observationHashes, template_dual: dual };
}

export function classifySemanticShadowOutcome(reason: string): 'clarify' | 'abstain' | 'unavailable' {
  if (reason === 'provider_malformed' || reason === 'provider_unavailable') {return 'unavailable';}
  return CLARIFICATION_REASONS.has(reason as SemanticShadowReason) ? 'clarify' : 'abstain';
}

function emptyComparison(): CandidateComparison {
  return { enumerated: 0, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' };
}

function notRequestedDual(): DualObservation {
  return { enabled: false, status: 'not_requested' };
}

function unavailableTemplateLane(enabled: boolean | undefined): DualObservation {
  return enabled ? { enabled: true, status: 'template_proof_failed' } : notRequestedDual();
}

export function semanticShadowActiveVersions(): SemanticShadowObservation['versions'] {
  return {
    orchestrator: SEMANTIC_SHADOW_ORCHESTRATOR_VERSION,
    observation: SEMANTIC_SHADOW_OBSERVATION_VERSION,
    question_contract: ANSWER_QUESTION_CONTRACT_VERSION,
    semantic_query: SEMANTIC_QUERY_VERSION,
    semantic_evidence: SEMANTIC_EVIDENCE_VERSION,
    resolution: SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
    planner: SEMANTIC_PLANNER_VERSION,
    semantic_proof: SEMANTIC_PLAN_PROOF_VERSION,
    planned_f1ql: PLANNED_F1QL_VERSION,
    planned_compiler: PLANNED_F1QL_COMPILER_VERSION,
    fact_space: F1QL_FACT_SPACE_VERSION,
    template_intent: ANSWER_INTENT_DERIVATION_VERSION,
    template_registry: ANSWER_TEMPLATE_REGISTRY_VERSION,
    template_proof: ANSWER_SEMANTIC_PROOF_VERSION
  };
}

async function timed<T>(
  field: keyof Latencies,
  latencies: Partial<Latencies>,
  now: () => number,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = now();
  try {return await operation();}
  finally {latencies[field] = boundedLatency(startedAt, now());}
}

function timedSync<T>(
  field: keyof Latencies,
  latencies: Partial<Latencies>,
  now: () => number,
  operation: () => T
): T {
  const startedAt = now();
  try {return operation();}
  finally {latencies[field] = boundedLatency(startedAt, now());}
}

function boundedLatency(startedAt: number, finishedAt: number): number {
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 60_000) {
    throw new Error('semantic shadow latency is invalid');
  }
  return Math.ceil(elapsed);
}

function compareMentions(left: SemanticDriverMention, right: SemanticDriverMention): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed
    .filter(key => !['now', 'template_dual'].includes(key)).every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

function rethrowDependencyError(error: unknown): void {
  if (error instanceof SemanticShadowDependencyError) {throw error;}
}
