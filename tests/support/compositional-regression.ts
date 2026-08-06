import { createHash } from 'node:crypto';
import { z } from 'zod';
import { planSemanticAnswerFromResolution } from '../../src/f1ql/semantic-planner';
import { proveSemanticAnswerPlan } from '../../src/f1ql/semantic-plan-proof';
import { collectSemanticResolutionEvidence } from '../../src/f1ql/semantic-resolution-evidence';
import {
  admitSemanticQueryCandidates,
  computeSemanticEvidenceHash,
  enumerateSemanticQueries,
  SEMANTIC_QUERY_VERSION,
  verifySemanticEvidence
} from '../../src/f1ql/semantic-query';

const sourceIdSchema = z.enum([
  'driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification'
]);
const topologySchema = z.enum([
  'single_source_rows', 'single_source_aggregate', 'row_dimension_join', 'scalar_aggregate_compose'
]);
const planFamilySchema = z.enum(['single_source', 'safe_dimension_join', 'aggregate_locality']);
const ambiguityReasonSchema = z.enum([
  'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
  'scope_ambiguous', 'temporal_ambiguous'
]);
const abstentionReasonSchema = z.enum([
  'candidate_overflow', 'provider_candidate_not_enumerated', 'unknown_language',
  'unsupported_comparison', 'unsupported_concept', 'unsupported_source_combination', 'unsupported_scope'
]);
const coverageTagSchema = z.enum([
  'promoted_topology', 'public_holdout', 'ambiguity', 'abstention', 'plan_family_single_source',
  'plan_family_safe_dimension_join', 'plan_family_aggregate_locality', 'provider_admission'
]);
const riskTagSchema = z.enum([
  'clean', 'aggregation', 'aggregate_locality', 'join_cardinality', 'resolver_event', 'resolver_identity',
  'template_free', 'metric_ambiguity', 'output_shape_ambiguity', 'scope_ambiguity', 'attachment_ambiguity',
  'entity_type_ambiguity', 'candidate_overflow', 'provider_substitution', 'unknown_language',
  'unsupported_comparison', 'unsupported_concept', 'unsupported_source_combination', 'unsupported_scope'
]);
const entitySpecSchema = z.object({
  type: z.enum(['driver', 'event']),
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7).default(0)
}).strict();
const driverMentionFixtureSchema = z.object({
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7).default(0),
  candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).max(100),
  active_candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).max(100)
}).strict();
const eventResolutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('missing') }).strict(),
  z.object({ type: z.literal('resolved'), season: z.number().int().min(1950).max(2100), round: z.number().int().min(1).max(30) }).strict(),
  z.object({
    type: z.literal('ambiguous'),
    candidates: z.array(z.object({
      season: z.number().int().min(1950).max(2100), round: z.number().int().min(1).max(30)
    }).strict()).min(1).max(100)
  }).strict()
]);
const resolverFixtureSchema = z.object({
  driver_mentions: z.array(driverMentionFixtureSchema).max(8),
  event_resolution: eventResolutionSchema
}).strict();
const expectedSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer'),
    reason: z.literal('semantic_plan_proven'),
    topology: topologySchema,
    source_ids: z.array(sourceIdSchema).min(1).max(4),
    plan_family: planFamilySchema.nullable()
  }).strict(),
  z.object({ action: z.literal('clarify'), reason: ambiguityReasonSchema }).strict(),
  z.object({ action: z.literal('abstain'), reason: abstentionReasonSchema }).strict()
]);

const countSchema = z.number().int().min(0);
const coverageSchema = z.object({
  cases_total: countSchema,
  action_counts: z.object({ answer: countSchema, clarify: countSchema, abstain: countSchema }).strict(),
  split_counts: z.object({ development: countSchema, public_holdout: countSchema, ambiguity: countSchema, abstention: countSchema }).strict(),
  topology_counts: z.object({
    single_source_rows: countSchema,
    single_source_aggregate: countSchema,
    row_dimension_join: countSchema,
    scalar_aggregate_compose: countSchema
  }).strict(),
  source_set_counts: z.object({
    driver_standings: countSchema,
    event_classification: countSchema,
    event_metadata: countSchema,
    qualifying_classification: countSchema,
    event_classification_event_metadata: countSchema,
    event_classification_qualifying_classification: countSchema,
    event_metadata_qualifying_classification: countSchema
  }).strict(),
  plan_family_counts: z.object({
    single_source: countSchema,
    safe_dimension_join: countSchema,
    aggregate_locality: countSchema,
    other: countSchema
  }).strict(),
  ambiguity_reason_counts: z.object({
    attachment_ambiguous: countSchema,
    entity_ambiguous: countSchema,
    metric_ambiguous: countSchema,
    output_shape_ambiguous: countSchema,
    scope_ambiguous: countSchema,
    temporal_ambiguous: countSchema
  }).strict(),
  abstention_reason_counts: z.object({
    candidate_overflow: countSchema,
    provider_candidate_not_enumerated: countSchema,
    unknown_language: countSchema,
    unsupported_comparison: countSchema,
    unsupported_concept: countSchema,
    unsupported_source_combination: countSchema,
    unsupported_scope: countSchema
  }).strict(),
  coverage_tag_counts: z.object({
    promoted_topology: countSchema,
    public_holdout: countSchema,
    ambiguity: countSchema,
    abstention: countSchema,
    plan_family_single_source: countSchema,
    plan_family_safe_dimension_join: countSchema,
    plan_family_aggregate_locality: countSchema,
    provider_admission: countSchema
  }).strict(),
  risk_tag_counts: z.object({
    clean: countSchema,
    aggregation: countSchema,
    aggregate_locality: countSchema,
    join_cardinality: countSchema,
    resolver_event: countSchema,
    resolver_identity: countSchema,
    template_free: countSchema,
    metric_ambiguity: countSchema,
    output_shape_ambiguity: countSchema,
    scope_ambiguity: countSchema,
    attachment_ambiguity: countSchema,
    entity_type_ambiguity: countSchema,
    candidate_overflow: countSchema,
    provider_substitution: countSchema,
    unknown_language: countSchema,
    unsupported_comparison: countSchema,
    unsupported_concept: countSchema,
    unsupported_source_combination: countSchema,
    unsupported_scope: countSchema
  }).strict()
}).strict();

const corpusCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,99}$/),
  split: z.enum(['development', 'public_holdout', 'ambiguity', 'abstention']),
  question: z.string().min(1).max(1_000),
  coverage_tags: z.array(coverageTagSchema).min(1),
  risk_tags: z.array(riskTagSchema).min(1),
  entities: z.array(entitySpecSchema).max(8),
  provider_mode: z.enum(['enumerated', 'omit_last_output']),
  resolver: resolverFixtureSchema,
  expected: expectedSchema
}).strict();
const corpusSchema = z.object({
  version: z.literal(1),
  expected_coverage: coverageSchema,
  cases: z.array(corpusCaseSchema).min(1).max(200)
}).strict().superRefine((corpus, context) => {
  reportDuplicates(corpus.cases.map(item => item.id), 'duplicate corpus case id', context);
  for (const [index, item] of corpus.cases.entries()) {
    reportDuplicates(item.coverage_tags, 'duplicate coverage tag', context, ['cases', index, 'coverage_tags']);
    reportDuplicates(item.risk_tags, 'duplicate risk tag', context, ['cases', index, 'risk_tags']);
    reportDuplicates(item.entities.map(entity => stableSerialize(entity)), 'duplicate entity inventory item', context, ['cases', index, 'entities']);
    reportDuplicates(item.resolver.driver_mentions.map(mention => `${mention.occurrence}:${mention.text}`), 'duplicate resolver mention', context, ['cases', index, 'resolver']);
    if (item.split === 'public_holdout' && (item.expected.action !== 'answer' || item.expected.plan_family === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'public holdouts require a plan-family answer', path: ['cases', index] });
    }
    if (item.split === 'ambiguity' && item.expected.action !== 'clarify') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ambiguity split requires clarification', path: ['cases', index] });
    }
    if (item.split === 'abstention' && item.expected.action !== 'abstain') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'abstention split requires abstention', path: ['cases', index] });
    }
    for (const mention of item.resolver.driver_mentions) {
      if (!item.entities.some(entity => entity.type === 'driver' && entity.text === mention.text && entity.occurrence === mention.occurrence)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolver mention is absent from entity inventory', path: ['cases', index, 'resolver'] });
      }
      if (!sameStrings(mention.candidates, sortedUnique(mention.candidates)) ||
          !sameStrings(mention.active_candidates, sortedUnique(mention.active_candidates)) ||
          mention.active_candidates.some(candidate => !mention.candidates.includes(candidate))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolver candidates must be unique, sorted, and active-subset', path: ['cases', index, 'resolver'] });
      }
    }
  }
});

const literalSpanSchema = z.object({
  text: z.string().min(1), start: z.number().int().min(0), end: z.number().int().positive()
}).strict();
const evidenceSummarySchema = z.object({
  type: z.enum(['candidate_set', 'abstention']),
  candidate_count: countSchema,
  evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_set_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict().superRefine((evidence, context) => {
  if ((evidence.type === 'candidate_set') !== (evidence.candidate_set_hash !== null) ||
      (evidence.type === 'candidate_set' && evidence.candidate_count < 1) ||
      (evidence.type === 'abstention' && evidence.candidate_count !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence summary shape is invalid' });
  }
});
const admissionSummarySchema = z.object({
  type: z.enum(['admitted', 'clarification_required', 'abstention']),
  reason: z.union([ambiguityReasonSchema, abstentionReasonSchema]).nullable(),
  query_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict().superRefine((admission, context) => {
  if (admission.type === 'admitted' ? admission.reason !== null || admission.query_hash === null
    : admission.reason === null || admission.query_hash !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'admission summary shape is invalid' });
  }
});
const resolutionSummarySchema = z.object({
  resolution_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_ids: z.array(sourceIdSchema).min(1),
  entities: z.array(z.object({
    entity_index: z.number().int().min(0),
    type: z.enum(['driver', 'event']),
    selected_id: z.string().min(1),
    candidate_ids: z.array(z.string().min(1)),
    resolution_relationship_ids: z.array(z.string().min(1))
  }).strict()),
  resolved_round: z.number().int().min(1).max(30).nullable(),
  resolver_reads: countSchema,
  resolver_candidates: countSchema
}).strict();
const planSummarySchema = z.object({
  topology: topologySchema,
  source_ids: z.array(sourceIdSchema).min(1),
  resolution_relationship_ids: z.array(z.string().min(1)),
  row_relationship_ids: z.array(z.string().min(1)),
  branches: z.array(z.object({
    source_id: sourceIdSchema,
    fixed_grain: z.array(z.string().min(1)),
    residual_grain: z.array(z.string().min(1)),
    aggregate: z.object({ group_by: z.array(z.string().min(1)), measures: z.array(z.string().min(1)) }).strict().nullable()
  }).strict()).min(1),
  output_grain: z.array(z.string().min(1)),
  integrity_checks: z.array(z.string().min(1)),
  work: z.object({
    source_scan_units: countSchema,
    resolver_reads: countSchema,
    resolver_candidates: countSchema,
    sources: countSchema,
    row_joins: countSchema,
    compositions: countSchema,
    operator_depth: countSchema,
    requested_rows: countSchema
  }).strict(),
  answer_plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  planned_f1ql_hash: z.string().regex(/^[a-f0-9]{64}$/),
  core_hash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const proofSummarySchema = z.object({
  proof_hash: z.string().regex(/^[a-f0-9]{64}$/),
  topology_hash: z.string().regex(/^[a-f0-9]{64}$/),
  work_hash: z.string().regex(/^[a-f0-9]{64}$/),
  participation_hash: z.string().regex(/^[a-f0-9]{64}$/),
  compiled_hash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const resultCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['development', 'public_holdout', 'ambiguity', 'abstention']),
  action: z.enum(['answer', 'clarify', 'abstain']),
  reason: z.union([z.literal('semantic_plan_proven'), ambiguityReasonSchema, abstentionReasonSchema]),
  question_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage_tags: z.array(coverageTagSchema).min(1),
  risk_tags: z.array(riskTagSchema).min(1),
  entity_inventory: z.array(z.object({ type: z.enum(['driver', 'event']), span: literalSpanSchema }).strict()),
  evidence: evidenceSummarySchema,
  admission: admissionSummarySchema,
  resolution: resolutionSummarySchema.nullable(),
  plan: planSummarySchema.nullable(),
  proof: proofSummarySchema.nullable(),
  plan_family: planFamilySchema.nullable()
}).strict().superRefine((item, context) => {
  const hasAnswerArtifacts = item.resolution !== null && item.plan !== null && item.proof !== null;
  if (item.action === 'answer' && (item.reason !== 'semantic_plan_proven' || item.admission.type !== 'admitted' ||
      item.evidence.type !== 'candidate_set' || !hasAnswerArtifacts)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'answer result requires complete admitted proof artifacts' });
  }
  if (item.action === 'clarify' && (item.admission.type !== 'clarification_required' ||
      item.evidence.type !== 'candidate_set' || item.admission.reason !== item.reason ||
      !ambiguityReasonSchema.safeParse(item.reason).success || hasAnswerArtifacts || item.plan_family !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clarification result shape is invalid' });
  }
  if (item.action === 'abstain' && (item.admission.type !== 'abstention' ||
      item.admission.reason !== item.reason || !abstentionReasonSchema.safeParse(item.reason).success ||
      hasAnswerArtifacts || item.plan_family !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'abstention result shape is invalid' });
  }
  if (item.action !== 'answer' && (item.resolution !== null || item.plan !== null || item.proof !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-answer result cannot contain proof artifacts' });
  }
  const splitAction = item.split === 'ambiguity' ? 'clarify' : item.split === 'abstention' ? 'abstain' : 'answer';
  if (item.action !== splitAction) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'result action does not match its corpus split' });
  }
  if (item.resolution && item.plan && (!sameStrings(item.resolution.source_ids, item.plan.source_ids) ||
      !sameStrings(item.plan.branches.map(branch => branch.source_id), item.plan.source_ids))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution, branch, and plan sources disagree' });
  }
  if (item.resolution) {
    if (item.resolution.entities.length !== item.entity_inventory.length ||
        new Set(item.resolution.entities.map(entity => entity.entity_index)).size !== item.resolution.entities.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution entities do not cover the inventory exactly' });
    }
    for (const entity of item.resolution.entities) {
      const inventory = item.entity_inventory[entity.entity_index];
      if (!inventory || inventory.type !== entity.type || !entity.candidate_ids.includes(entity.selected_id) ||
          !sameStrings(entity.candidate_ids, sortedUnique(entity.candidate_ids)) ||
          !sameStrings(entity.resolution_relationship_ids, sortedUnique(entity.resolution_relationship_ids))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution entity binding is invalid' });
      }
    }
    if (item.plan && !sameStrings(
      sortedUnique(item.resolution.entities.flatMap(entity => entity.resolution_relationship_ids)),
      item.plan.resolution_relationship_ids
    )) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution relationships disagree with the plan' });
    }
  }
  if (item.plan && item.plan_family !== null &&
      !planFamilyMatches(item.plan_family, item.plan.topology, item.plan.source_ids)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'plan family does not match plan structure' });
  }
});
const snapshotSchema = z.object({
  version: z.literal(1),
  corpus_version: z.literal(1),
  corpus_hash: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: coverageSchema,
  cases: z.array(resultCaseSchema).min(1).max(200)
}).strict();

export type CompositionalRegressionCorpus = z.infer<typeof corpusSchema>;
export type CompositionalRegressionSnapshot = z.infer<typeof snapshotSchema>;

export interface CompositionalAnswerFixtureInput {
  readonly question: string;
  readonly entities: readonly z.input<typeof entitySpecSchema>[];
  readonly resolver: z.input<typeof resolverFixtureSchema>;
}

export function parseCompositionalRegressionCorpus(input: unknown): CompositionalRegressionCorpus {
  return deepFreeze(corpusSchema.parse(input));
}

export function computeCompositionalRegressionCorpusHash(input: unknown): string {
  return sha256(stableSerialize(parseCompositionalRegressionCorpus(input)));
}

export function parseCompositionalRegressionSnapshot(input: unknown): CompositionalRegressionSnapshot {
  const parsed = snapshotSchema.parse(input);
  if (new Set(parsed.cases.map(item => item.id)).size !== parsed.cases.length ||
      stableSerialize(parsed.coverage) !== stableSerialize(computeCoverage(parsed.cases))) {
    throw new Error('compositional regression snapshot accounting is invalid');
  }
  return deepFreeze(parsed);
}

export async function prepareCompositionalAnswerArtifacts(input: CompositionalAnswerFixtureInput) {
  const question = z.string().min(1).max(1_000).parse(input.question);
  const entities = z.array(entitySpecSchema).max(8).parse(input.entities);
  const resolver = resolverFixtureSchema.parse(input.resolver);
  return prepareAnswerArtifacts(question, entities, resolver);
}

export async function prepareReviewedCompositionalAnswerCase(input: unknown, caseId: string) {
  const corpus = parseCompositionalRegressionCorpus(input);
  const item = corpus.cases.find(candidate => candidate.id === caseId);
  if (!item || item.expected.action !== 'answer' || item.provider_mode !== 'enumerated') {
    throw new Error(`reviewed compositional answer case is unavailable: ${caseId}`);
  }
  return {
    corpus_case: item,
    ...await prepareAnswerArtifacts(item.question, item.entities, item.resolver)
  };
}

export async function runCompositionalRegressionCorpus(input: unknown): Promise<CompositionalRegressionSnapshot> {
  const corpus = parseCompositionalRegressionCorpus(input);
  const results = [];
  for (const item of corpus.cases) {
    const entityInventory = materializeEntityInventory(item.question, item.entities);
    const evidence = enumerateSemanticQueries(item.question, entityInventory);
    verifySemanticEvidence(evidence, item.question, entityInventory);
    const provider = providerCandidateSet(evidence, item.provider_mode);
    const admission = admitSemanticQueryCandidates(provider, item.question, evidence);
    const common = {
      id: item.id,
      split: item.split,
      question_sha256: evidence.question_sha256,
      coverage_tags: item.coverage_tags,
      risk_tags: item.risk_tags,
      entity_inventory: entityInventory,
      evidence: {
        type: evidence.type,
        candidate_count: evidence.type === 'candidate_set' ? evidence.candidates.length : 0,
        evidence_hash: computeSemanticEvidenceHash(evidence),
        candidate_set_hash: evidence.type === 'candidate_set' ? evidence.candidate_set_hash : null
      },
      admission: {
        type: admission.type,
        reason: admission.type === 'admitted' ? null : admission.reason,
        query_hash: admission.type === 'admitted' ? admission.query_hash : null
      }
    };

    if (admission.type !== 'admitted') {
      const action = admission.type === 'clarification_required' ? 'clarify' as const : 'abstain' as const;
      assertExpectedOutcome(item, action, admission.reason);
      results.push({
        ...common, action, reason: admission.reason, resolution: null, plan: null, proof: null, plan_family: null
      });
      continue;
    }

    const prepared = await prepareAnswerArtifacts(item.question, item.entities, item.resolver, {
      entityInventory, evidence, admission
    });
    const { resolution, plan, proof } = prepared;
    if (!Object.isFrozen(resolution) || !Object.isFrozen(resolution.entities)) {
      throw new Error(`case ${item.id} produced mutable resolution evidence`);
    }
    assertExpectedAnswer(item, plan.topology, plan.source_graph.source_ids);
    results.push({
      ...common,
      action: 'answer' as const,
      reason: 'semantic_plan_proven' as const,
      resolution: {
        resolution_hash: resolution.resolution_hash,
        source_ids: resolution.source_ids,
        entities: resolution.entities.map(entity => ({
          entity_index: entity.entity_index,
          type: entity.type,
          selected_id: entity.selected_id,
          candidate_ids: entity.candidate_ids,
          resolution_relationship_ids: entity.resolution_relationship_ids
        })),
        resolved_round: resolution.resolved_round ?? null,
        resolver_reads: resolution.resolver_reads,
        resolver_candidates: resolution.resolver_candidates
      },
      plan: {
        topology: plan.topology,
        source_ids: plan.source_graph.source_ids,
        resolution_relationship_ids: plan.source_graph.resolution_relationship_ids,
        row_relationship_ids: plan.source_graph.row_relationship_ids,
        branches: plan.branches.map(branch => ({
          source_id: branch.source_id,
          fixed_grain: branch.fixed_grain,
          residual_grain: branch.residual_grain,
          aggregate: branch.aggregate ?? null
        })),
        output_grain: plan.output_grain,
        integrity_checks: plan.integrity_checks,
        work: {
          source_scan_units: plan.work.source_scan_units,
          resolver_reads: plan.work.resolver_reads,
          resolver_candidates: plan.work.resolver_candidates,
          sources: plan.work.sources,
          row_joins: plan.work.row_joins,
          compositions: plan.work.compositions,
          operator_depth: plan.work.operator_depth,
          requested_rows: plan.work.requested_rows
        },
        answer_plan_hash: plan.answer_plan_hash,
        planned_f1ql_hash: plan.planned_f1ql_hash,
        core_hash: plan.core_hash
      },
      proof: {
        proof_hash: proof.proof_hash,
        topology_hash: proof.topology_hash,
        work_hash: proof.work_hash,
        participation_hash: proof.participation_hash,
        compiled_hash: proof.compiled_hash
      },
      plan_family: item.expected.action === 'answer' ? item.expected.plan_family : null
    });
  }

  const coverage = computeCoverage(results);
  if (stableSerialize(coverage) !== stableSerialize(corpus.expected_coverage)) {
    throw new Error(`compositional regression coverage mismatch: ${stableSerialize(coverage)}`);
  }
  return parseCompositionalRegressionSnapshot({
    version: 1,
    corpus_version: corpus.version,
    corpus_hash: sha256(stableSerialize(corpus)),
    coverage,
    cases: results
  });
}

async function prepareAnswerArtifacts(
  question: string,
  entities: readonly z.infer<typeof entitySpecSchema>[],
  resolver: z.infer<typeof resolverFixtureSchema>,
  existing?: {
    readonly entityInventory: ReturnType<typeof materializeEntityInventory>;
    readonly evidence: ReturnType<typeof enumerateSemanticQueries>;
    readonly admission: ReturnType<typeof admitSemanticQueryCandidates>;
  }
) {
  const entityInventory = existing?.entityInventory ?? materializeEntityInventory(question, entities);
  const evidence = existing?.evidence ?? enumerateSemanticQueries(question, entityInventory);
  verifySemanticEvidence(evidence, question, entityInventory);
  const admission = existing?.admission ?? admitSemanticQueryCandidates(
    providerCandidateSet(evidence, 'enumerated'), question, evidence
  );
  if (admission.type !== 'admitted') {
    throw new Error(`compositional answer fixture was not admitted: ${admission.reason}`);
  }
  const mentions = resolver.driver_mentions.map(mention => ({
    ...materializeSpan(question, mention.text, mention.occurrence),
    candidates: mention.candidates,
    active_candidates: mention.active_candidates
  }));
  const resolution = await collectSemanticResolutionEvidence({
    question,
    admission,
    driver_resolver: { inventoryMentions: async () => mentions },
    event_resolver: {
      resolve: async () => resolver.event_resolution,
      resolveRound: async () => resolver.event_resolution
    }
  });
  const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
  const proof = proveSemanticAnswerPlan({
    question,
    entity_inventory: entityInventory,
    evidence,
    admission,
    resolution,
    plan
  });
  return { question, entity_inventory: entityInventory, evidence, admission, resolution, plan, proof };
}

function materializeEntityInventory(question: string, entities: readonly z.infer<typeof entitySpecSchema>[]) {
  return entities.map(entity => ({
    type: entity.type,
    span: materializeSpan(question, entity.text, entity.occurrence)
  })).sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end || compareText(left.type, right.type));
}

function materializeSpan(question: string, text: string, occurrence: number) {
  const questionPoints = Array.from(question.normalize('NFKC').trim());
  const textPoints = Array.from(text);
  const starts = questionPoints.flatMap((_point, index) =>
    textPoints.every((point, offset) => questionPoints[index + offset] === point) ? [index] : []);
  const start = starts[occurrence];
  if (start === undefined) {
    throw new Error(`entity text occurrence is absent from question: ${text}`);
  }
  return { text, start, end: start + textPoints.length };
}

function providerCandidateSet(
  evidence: ReturnType<typeof enumerateSemanticQueries>,
  mode: z.infer<typeof corpusCaseSchema>['provider_mode']
): unknown {
  if (evidence.type === 'abstention') {
    return { version: SEMANTIC_QUERY_VERSION, candidates: [] };
  }
  if (mode === 'enumerated') {
    return { version: SEMANTIC_QUERY_VERSION, candidates: evidence.candidates };
  }
  if (evidence.candidates.length !== 1 || evidence.candidates[0].outputs.length < 2) {
    throw new Error('omit_last_output requires one multi-output evidence candidate');
  }
  const candidate = structuredClone(evidence.candidates[0]);
  candidate.outputs.pop();
  return { version: SEMANTIC_QUERY_VERSION, candidates: [candidate] };
}

function assertExpectedOutcome(
  item: z.infer<typeof corpusCaseSchema>,
  action: 'clarify' | 'abstain',
  reason: z.infer<typeof ambiguityReasonSchema> | z.infer<typeof abstentionReasonSchema>
): void {
  if (item.expected.action !== action || item.expected.reason !== reason) {
    throw new Error(`case ${item.id} expected ${item.expected.action}/${item.expected.reason} but produced ${action}/${reason}`);
  }
}

function assertExpectedAnswer(
  item: z.infer<typeof corpusCaseSchema>,
  topology: z.infer<typeof topologySchema>,
  sourceIds: readonly z.infer<typeof sourceIdSchema>[]
): void {
  if (item.expected.action !== 'answer' || item.expected.topology !== topology ||
      !sameStrings(item.expected.source_ids, sourceIds)) {
    throw new Error(`case ${item.id} produced an unexpected answer structure`);
  }
  if (item.expected.plan_family === null) {
    return;
  }
  if (!planFamilyMatches(item.expected.plan_family, topology, sourceIds)) {
    throw new Error(`case ${item.id} does not match its expected plan family`);
  }
}

function computeCoverage(results: readonly z.infer<typeof resultCaseSchema>[]): z.infer<typeof coverageSchema> {
  const actions = countBy(results.map(item => item.action));
  const splits = countBy(results.map(item => item.split));
  const topologies = countBy(results.flatMap(item => item.plan ? [item.plan.topology] : []));
  const sourceSets = countBy(results.flatMap(item => item.plan ? [sourceSetKey(item.plan.source_ids)] : []));
  const planFamilies = countBy(results.flatMap(item =>
    item.action === 'answer' ? [item.plan_family ?? 'other'] : []));
  const ambiguities = countBy(results.flatMap(item => item.action === 'clarify' ? [item.reason] : []));
  const abstentions = countBy(results.flatMap(item => item.action === 'abstain' ? [item.reason] : []));
  const coverageTags = countBy(results.flatMap(item => item.coverage_tags));
  const riskTags = countBy(results.flatMap(item => item.risk_tags));
  return coverageSchema.parse({
    cases_total: results.length,
    action_counts: { answer: actions.answer ?? 0, clarify: actions.clarify ?? 0, abstain: actions.abstain ?? 0 },
    split_counts: {
      development: splits.development ?? 0,
      public_holdout: splits.public_holdout ?? 0,
      ambiguity: splits.ambiguity ?? 0,
      abstention: splits.abstention ?? 0
    },
    topology_counts: {
      single_source_rows: topologies.single_source_rows ?? 0,
      single_source_aggregate: topologies.single_source_aggregate ?? 0,
      row_dimension_join: topologies.row_dimension_join ?? 0,
      scalar_aggregate_compose: topologies.scalar_aggregate_compose ?? 0
    },
    source_set_counts: {
      driver_standings: sourceSets.driver_standings ?? 0,
      event_classification: sourceSets.event_classification ?? 0,
      event_metadata: sourceSets.event_metadata ?? 0,
      qualifying_classification: sourceSets.qualifying_classification ?? 0,
      event_classification_event_metadata: sourceSets.event_classification_event_metadata ?? 0,
      event_classification_qualifying_classification: sourceSets.event_classification_qualifying_classification ?? 0,
      event_metadata_qualifying_classification: sourceSets.event_metadata_qualifying_classification ?? 0
    },
    plan_family_counts: {
      single_source: planFamilies.single_source ?? 0,
      safe_dimension_join: planFamilies.safe_dimension_join ?? 0,
      aggregate_locality: planFamilies.aggregate_locality ?? 0,
      other: planFamilies.other ?? 0
    },
    ambiguity_reason_counts: {
      attachment_ambiguous: ambiguities.attachment_ambiguous ?? 0,
      entity_ambiguous: ambiguities.entity_ambiguous ?? 0,
      metric_ambiguous: ambiguities.metric_ambiguous ?? 0,
      output_shape_ambiguous: ambiguities.output_shape_ambiguous ?? 0,
      scope_ambiguous: ambiguities.scope_ambiguous ?? 0,
      temporal_ambiguous: ambiguities.temporal_ambiguous ?? 0
    },
    abstention_reason_counts: {
      candidate_overflow: abstentions.candidate_overflow ?? 0,
      provider_candidate_not_enumerated: abstentions.provider_candidate_not_enumerated ?? 0,
      unknown_language: abstentions.unknown_language ?? 0,
      unsupported_comparison: abstentions.unsupported_comparison ?? 0,
      unsupported_concept: abstentions.unsupported_concept ?? 0,
      unsupported_source_combination: abstentions.unsupported_source_combination ?? 0,
      unsupported_scope: abstentions.unsupported_scope ?? 0
    },
    coverage_tag_counts: Object.fromEntries(coverageTagSchema.options.map(tag => [tag, coverageTags[tag] ?? 0])),
    risk_tag_counts: Object.fromEntries(riskTagSchema.options.map(tag => [tag, riskTags[tag] ?? 0]))
  });
}

function sourceSetKey(sourceIds: readonly string[]): string {
  return sourceIds.join('_');
}

function planFamilyMatches(
  planFamily: z.infer<typeof planFamilySchema>,
  topology: z.infer<typeof topologySchema>,
  sourceIds: readonly string[]
): boolean {
  if (planFamily === 'single_source') {
    return (topology === 'single_source_rows' || topology === 'single_source_aggregate') && (
      sameStrings(sourceIds, ['driver_standings']) || sameStrings(sourceIds, ['event_classification']) ||
      sameStrings(sourceIds, ['event_metadata']) || sameStrings(sourceIds, ['qualifying_classification'])
    );
  }
  if (planFamily === 'safe_dimension_join') {
    return topology === 'row_dimension_join' && (
      sameStrings(sourceIds, ['event_classification', 'event_metadata']) ||
      sameStrings(sourceIds, ['event_metadata', 'qualifying_classification'])
    );
  }
  return topology === 'scalar_aggregate_compose' &&
    sameStrings(sourceIds, ['event_classification', 'qualifying_classification']);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function reportDuplicates(
  values: readonly string[],
  message: string,
  context: z.RefinementCtx,
  path: Array<string | number> = []
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
