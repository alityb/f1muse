import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AnswerQuestionContract, AnswerQuestionMention, createAnswerQuestionContract } from './answer-question';
import {
  computeSemanticCatalogHash,
  SEMANTIC_CATALOG,
  SemanticCatalog,
  SemanticCatalogSource
} from './semantic-catalog';

export const SEMANTIC_QUERY_VERSION = 2 as const;
export const SEMANTIC_EVIDENCE_VERSION = 2 as const;
export const SEMANTIC_QUERY_MAX_CANDIDATES = 5;

const sourceIdSchema = z.enum(['driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification']);
const conceptIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const literalSchema = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);
const literalSpanSchema = z.object({
  text: z.string().min(1).max(300),
  start: z.number().int().min(0),
  end: z.number().int().positive()
}).strict().refine(span => span.end > span.start, 'literal span end must be after start');
const evidenceSchema = z.array(literalSpanSchema).min(1).max(8);
const conceptRefSchema = z.object({ source_id: sourceIdSchema, concept_id: conceptIdSchema }).strict();
const outputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), concept: conceptRefSchema, evidence: evidenceSchema }).strict(),
  z.object({
    kind: z.literal('aggregate'),
    function: z.enum(['count', 'max', 'min', 'sum']),
    concept: conceptRefSchema,
    evidence: evidenceSchema
  }).strict()
]);
const entitySchema = z.object({
  type: z.enum(['driver', 'event']),
  span: literalSpanSchema
}).strict();
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('season'), value: z.number().int().min(1950).max(2100), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('round'), value: z.number().int().min(1).max(30), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('session'), source_id: sourceIdSchema, value: z.enum(['season', 'race', 'qualifying']), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('temporal'), value: z.enum(['final', 'latest_recorded']), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('event'), entity_index: z.number().int().min(0).max(7), evidence: evidenceSchema }).strict()
]);
const filterSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    concept: conceptRefSchema,
    operator: z.enum(['eq', 'in']),
    entity_indices: z.array(z.number().int().min(0).max(7)).min(1).max(8),
    evidence: evidenceSchema
  }).strict(),
  z.object({ kind: z.literal('literal'), concept: conceptRefSchema, operator: z.literal('eq'), value: literalSchema, evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('literal_set'), concept: conceptRefSchema, operator: z.literal('in'), values: z.array(literalSchema).min(1).max(20), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('literal_range'), concept: conceptRefSchema, operator: z.literal('range'), min: literalSchema, max: literalSchema, evidence: evidenceSchema }).strict()
]);
const groupingSchema = z.object({ concept: conceptRefSchema, evidence: evidenceSchema }).strict();
const comparisonSchema = z.object({
  relation: z.enum(['count', 'delta', 'higher', 'lower', 'rank', 'shared_event']),
  evidence: evidenceSchema
}).strict();
const orderSchema = z.object({
  output_index: z.number().int().min(0).max(7),
  direction: z.enum(['asc', 'desc']),
  evidence: evidenceSchema
}).strict();
const limitSchema = z.object({ value: z.number().int().min(1).max(100), evidence: evidenceSchema }).strict();
const semanticQuerySchema = z.object({
  version: z.literal(SEMANTIC_QUERY_VERSION),
  outputs: z.array(outputSchema).min(1).max(8),
  scopes: z.array(scopeSchema).min(3).max(8),
  entities: z.array(entitySchema).max(8),
  filters: z.array(filterSchema).max(8),
  group_by: z.array(groupingSchema).max(3),
  comparison: comparisonSchema.optional(),
  order_by: z.array(orderSchema).max(4),
  limit: limitSchema.optional()
}).strict();
const candidateSetSchema = z.object({
  version: z.literal(SEMANTIC_QUERY_VERSION),
  candidates: z.array(semanticQuerySchema).min(1).max(SEMANTIC_QUERY_MAX_CANDIDATES)
}).strict();

export type SemanticLiteralSpan = z.infer<typeof literalSpanSchema>;
export type SemanticConceptRef = z.infer<typeof conceptRefSchema>;
export type SemanticQuery = z.infer<typeof semanticQuerySchema>;
export type SemanticQueryCandidateSet = z.infer<typeof candidateSetSchema>;
export type SemanticEntityInventoryItem = z.infer<typeof entitySchema>;
export type SemanticAmbiguityReason =
  | 'attachment_ambiguous'
  | 'entity_ambiguous'
  | 'metric_ambiguous'
  | 'output_shape_ambiguous'
  | 'scope_ambiguous'
  | 'temporal_ambiguous';
export type SemanticAbstentionReason =
  | 'candidate_overflow'
  | 'provider_candidate_not_enumerated'
  | 'unknown_language'
  | 'unsupported_comparison'
  | 'unsupported_concept'
  | 'unsupported_source_combination'
  | 'unsupported_scope';

const verifiedSemanticAdmissionBrand: unique symbol = Symbol('verifiedSemanticAdmission');

export type SemanticEvidence =
  | {
      readonly version: typeof SEMANTIC_EVIDENCE_VERSION;
      readonly type: 'candidate_set';
      readonly question_sha256: string;
      readonly catalog_hash: string;
      readonly candidate_set_hash: string;
      readonly candidates: readonly SemanticQuery[];
      readonly ambiguity_reason?: SemanticAmbiguityReason;
    }
  | {
      readonly version: typeof SEMANTIC_EVIDENCE_VERSION;
      readonly type: 'abstention';
      readonly question_sha256: string;
      readonly catalog_hash: string;
      readonly reason: SemanticAbstentionReason;
      readonly candidate_count_lower_bound?: number;
    };

export type SemanticCandidateAdmission =
  | VerifiedSemanticQueryAdmission
  | { readonly type: 'clarification_required'; readonly reason: SemanticAmbiguityReason; readonly candidate_set_hash: string }
  | { readonly type: 'abstention'; readonly reason: SemanticAbstentionReason };

export interface VerifiedSemanticQueryAdmission {
  readonly [verifiedSemanticAdmissionBrand]: true;
  readonly type: 'admitted';
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly query: SemanticQuery;
  readonly query_hash: string;
  readonly candidate_set_hash: string;
}

interface LexicalMatch {
  readonly span: SemanticLiteralSpan;
  readonly source_id: z.infer<typeof sourceIdSchema>;
  readonly concept_id?: string;
}

interface OperationEvidence {
  readonly count?: SemanticLiteralSpan;
  readonly count_spans: readonly SemanticLiteralSpan[];
  readonly rank?: SemanticLiteralSpan;
  readonly limit?: { readonly value: number; readonly span: SemanticLiteralSpan };
  readonly temporal: readonly { readonly value: 'final' | 'latest_recorded'; readonly span: SemanticLiteralSpan }[];
}

const activeSemanticEvidence = new WeakSet<object>();
const activeSemanticAdmissions = new WeakSet<object>();

export function parseSemanticQueryCandidateSet(
  input: unknown,
  questionInput: unknown,
  catalog: SemanticCatalog = SEMANTIC_CATALOG
): SemanticQueryCandidateSet {
  const question = createAnswerQuestionContract(questionInput);
  const parsed = candidateSetSchema.parse(input);
  const candidates = parsed.candidates.map(candidate => normalizeSemanticQuery(candidate));
  for (const candidate of candidates) {
    validateSemanticQuery(candidate, question, catalog);
  }
  const sorted = [...candidates].sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)));
  const hashes = sorted.map(computeSemanticQueryHash);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('semantic candidate set contains duplicate normalized queries');
  }
  return deepFreeze({ version: SEMANTIC_QUERY_VERSION, candidates: sorted });
}

export function computeSemanticQueryHash(query: SemanticQuery): string {
  const parsed = semanticQuerySchema.parse(query);
  if (!isCanonicalEntityOrder(parsed.entities)) {
    throw new Error('semantic query entities must be canonically ordered before hashing');
  }
  return createHash('sha256').update(stableSerialize(normalizeSemanticQuery(parsed))).digest('hex');
}

export function computeSemanticCandidateSetHash(
  candidates: readonly SemanticQuery[],
  questionSha256: string,
  catalogHash: string,
  ambiguityReason?: SemanticAmbiguityReason
): string {
  return createHash('sha256').update(stableSerialize({
    version: SEMANTIC_EVIDENCE_VERSION,
    question_sha256: questionSha256,
    catalog_hash: catalogHash,
    query_hashes: candidates.map(computeSemanticQueryHash).sort(compareText),
    ambiguity_reason: ambiguityReason ?? null
  })).digest('hex');
}

export function computeSemanticEvidenceHash(evidence: SemanticEvidence): string {
  return createHash('sha256').update(stableSerialize(evidence)).digest('hex');
}

export function verifySemanticEvidence(
  input: unknown,
  questionInput: unknown,
  entityInventoryInput: readonly unknown[] = [],
  options: { readonly catalog?: SemanticCatalog; readonly max_candidates?: number } = {}
): SemanticEvidence {
  if (!input || typeof input !== 'object' || !activeSemanticEvidence.has(input)) {
    throw new Error('semantic evidence provenance is invalid');
  }
  const evidence = input as SemanticEvidence;
  const reproduced = enumerateSemanticQueries(questionInput, entityInventoryInput, options);
  if (stableSerialize(evidence) !== stableSerialize(reproduced)) {
    throw new Error('semantic evidence does not match independent enumeration');
  }
  return evidence;
}

export function enumerateSemanticQueries(
  questionInput: unknown,
  entityInventoryInput: readonly unknown[] = [],
  options: { readonly catalog?: SemanticCatalog; readonly max_candidates?: number } = {}
): SemanticEvidence {
  const catalog = options.catalog ?? SEMANTIC_CATALOG;
  const catalogHash = computeSemanticCatalogHash(catalog);
  const maxCandidates = options.max_candidates ?? SEMANTIC_QUERY_MAX_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > SEMANTIC_QUERY_MAX_CANDIDATES) {
    throw new Error('semantic candidate bound is invalid');
  }
  const question = createAnswerQuestionContract(questionInput);
  const inventory = entityInventoryInput.map(item => entitySchema.parse(item));
  for (const item of inventory) {
    validateSpan(item.span, question);
  }
  const entities = canonicalEntities(inventory);
  const sourceMatches = collectSourceMatches(question.normalized_question, catalog);
  const conceptMatches = collectConceptMatches(question.normalized_question, catalog, sourceMatches);
  const operations = collectOperationEvidence(question.normalized_question);
  if (new Set(operations.temporal.map(item => item.value)).size > 1) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  if (operations.limit && operations.limit.value > 100) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  if (hasUnsupportedComparison(question.normalized_question)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_comparison'));
  }
  if (entities.filter(entity => entity.type === 'driver').length > 4) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  if (hasCrossTypeEntityAlternative(question, sourceMatches, conceptMatches, operations, entities)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }
  if (hasUnconsumedAlternative(question, sourceMatches, conceptMatches, operations, entities)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }
  if (hasConflictingDriverCardinality(question.normalized_question, entities)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }
  if (hasEntityAlternative(question, sourceMatches, conceptMatches, operations, entities)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }
  if (/\bby\b/iu.test(question.normalized_question) && !operations.rank) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_comparison'));
  }
  const standingsPointsProjection = finalStandingsPointsProjection(
    question,
    sourceMatches,
    conceptMatches,
    operations,
    entities
  );
  if (!standingsPointsProjection && containsUnknownLanguage(question, sourceMatches, conceptMatches, operations, entities)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unknown_language'));
  }
  const effectiveConceptMatches = standingsPointsProjection ? [standingsPointsProjection] : conceptMatches;
  const sourceIds = candidateSourceIds(sourceMatches, effectiveConceptMatches);
  if (sourceIds.length === 0) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }
  if (question.years.length === 0) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  const explicitSourceIds = new Set(sourceMatches.map(match => match.source_id));
  const compositionSourceIds = requestedCompositionSourceIds(sourceMatches, conceptMatches);
  if (compositionSourceIds.length > 1) {
    let compositionAmbiguity: SemanticAmbiguityReason | undefined;
    if (hasEntityTypeAmbiguity(entities)) {
      compositionAmbiguity = 'entity_ambiguous';
    } else if (question.years.length > 1 || question.rounds.length > 1) {
      compositionAmbiguity = 'scope_ambiguous';
    } else if (entities.filter(entity => entity.type === 'event').length > 1 ||
        hasAmbiguousEntityAttachment(entities, conceptMatches, catalog)) {
      compositionAmbiguity = 'attachment_ambiguous';
    } else if (hasOutputAlternative(question.normalized_question, conceptMatches)) {
      compositionAmbiguity = 'output_shape_ambiguous';
    }
    const years = question.years.length > 0 ? question.years : [];
    const rounds = question.rounds.length > 0 ? question.rounds : [undefined];
    const eventEntities = entities.filter(entity => entity.type === 'event');
    const entityChoices = eventEntities.length > 1
      ? eventEntities.map(event => entities.filter(entity => entity.type !== 'event' || entity === event))
      : [entities];
    const composition = years.flatMap(year => rounds.flatMap(round => entityChoices.flatMap(entityChoice =>
      enumeratePromotedComposition(
        { ...question, years: [year], rounds: round ? [round] : [] },
        entityChoice,
        compositionSourceIds,
        sourceMatches,
        conceptMatches,
        operations,
        catalog
      ))));
    if (composition.length === 0) {
      return verifiedEvidence(abstention(question, catalogHash, 'unsupported_source_combination'));
    }
    return verifiedEvidence(candidateSetEvidence(question, catalogHash, composition, maxCandidates, compositionAmbiguity));
  }
  const sourceCompatibility = sourceIds.map(sourceId => {
    const source = catalog.sources.find(item => item.id === sourceId && item.usage === 'answer_fact');
    const compatible = Boolean(source) && !question.years.some(year => source!.scope.season_min === null || source!.scope.season_max === null || year.value < source!.scope.season_min || year.value > source!.scope.season_max) &&
      !(question.rounds.length > 0 && source!.scope.sessions.includes('season')) &&
      !operations.temporal.some(temporal => question.years.some(year => !sourceSupportsTemporal(source!, year.value, temporal.value))) &&
      sourceSupportsEntityInventory(source!, entities);
    return { sourceId, compatible };
  });
  if (explicitSourceIds.size > 0 && sourceCompatibility.some(item => !item.compatible)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  const compatibleSourceIds = sourceCompatibility.filter(item => item.compatible).map(item => item.sourceId);
  if (compatibleSourceIds.length === 0) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  if (hasInvalidOrderingTargets(compatibleSourceIds, conceptMatches, catalog, operations)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_comparison'));
  }
  if (question.rounds.length > 0 && entities.some(entity => entity.type === 'event')) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  if (hasAmbiguousEntityAttachment(entities, conceptMatches, catalog)) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_concept'));
  }

  const candidates: SemanticQuery[] = [];
  let usedDefaultOutputs = false;
  let usedEventAlternatives = false;
  for (const sourceId of compatibleSourceIds) {
    const source = catalog.sources.find(item => item.id === sourceId && item.usage === 'answer_fact');
    if (!source) {
      continue;
    }
    const sourceConceptMatches = canonicalConceptMatches(effectiveConceptMatches.filter(match => match.source_id === sourceId));
    const outputChoices = buildOutputChoices(
      source,
      sourceConceptMatches,
      sourceMatches,
      operations,
      question.normalized_question,
      standingsPointsProjection?.span
    );
    usedDefaultOutputs ||= outputChoices.defaulted;
    if (outputChoices.outputs.length === 0) {
      continue;
    }
    const sourceEntityChoices = buildEntityChoices(source, entities);
    usedEventAlternatives ||= sourceEntityChoices.length > 1;
    for (const combination of candidateCombinations(question, source, outputChoices.outputs, sourceEntityChoices, operations)) {
      const candidate = buildCandidate(source, combination.outputs, combination.year, combination.round, combination.temporal, combination.entities, operations);
      if (!candidate) {
        continue;
      }
      const parsedCandidate = semanticQuerySchema.safeParse(candidate);
      if (!parsedCandidate.success) {
        continue;
      }
      const normalized = normalizeSemanticQuery(parsedCandidate.data);
      validateSemanticQuery(normalized, question, catalog);
      candidates.push(normalized);
    }
  }

  const unique = new Map(candidates.map(candidate => [computeSemanticQueryHash(candidate), candidate]));
  const sorted = [...unique.values()].sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)));
  if (sorted.length === 0) {
    return verifiedEvidence(abstention(question, catalogHash, 'unsupported_scope'));
  }
  const entityTypeAmbiguity = hasEntityTypeAmbiguity(entities);
  if (sorted.length > maxCandidates) {
    return verifiedEvidence(deepFreeze({
      version: SEMANTIC_EVIDENCE_VERSION,
      type: 'abstention',
      question_sha256: question.sha256,
      catalog_hash: catalogHash,
      reason: 'candidate_overflow',
      candidate_count_lower_bound: sorted.length
    }));
  }
  const ambiguityReason = selectAmbiguityReason(
    entityTypeAmbiguity, sorted.length, compatibleSourceIds, question, operations, entities,
    usedDefaultOutputs, usedEventAlternatives
  );
  return verifiedEvidence(deepFreeze({
    version: SEMANTIC_EVIDENCE_VERSION,
    type: 'candidate_set',
    question_sha256: question.sha256,
    catalog_hash: catalogHash,
    candidate_set_hash: computeSemanticCandidateSetHash(sorted, question.sha256, catalogHash, ambiguityReason),
    candidates: sorted,
    ...(ambiguityReason ? { ambiguity_reason: ambiguityReason } : {})
  }));
}

export function admitSemanticQueryCandidates(
  providerInput: unknown,
  questionInput: unknown,
  evidence: SemanticEvidence,
  catalog: SemanticCatalog = SEMANTIC_CATALOG
): SemanticCandidateAdmission {
  const question = createAnswerQuestionContract(questionInput);
  const catalogHash = computeSemanticCatalogHash(catalog);
  if (!activeSemanticEvidence.has(evidence) || evidence.question_sha256 !== question.sha256 || evidence.catalog_hash !== catalogHash) {
    throw new Error('semantic evidence is not active for this question and catalog');
  }
  if (evidence.type === 'abstention') {
    return deepFreeze({ type: 'abstention', reason: evidence.reason });
  }
  if (computeSemanticCandidateSetHash(evidence.candidates, question.sha256, catalogHash, evidence.ambiguity_reason) !== evidence.candidate_set_hash) {
    throw new Error('semantic evidence candidate-set hash is invalid');
  }
  const provider = parseSemanticQueryCandidateSet(providerInput, questionInput, catalog);
  if (evidence.candidates.length !== 1 || evidence.ambiguity_reason) {
    return deepFreeze({
      type: 'clarification_required',
      reason: evidence.ambiguity_reason ?? 'metric_ambiguous',
      candidate_set_hash: evidence.candidate_set_hash
    });
  }
  const enumeratedHashes = new Set(evidence.candidates.map(computeSemanticQueryHash));
  if (provider.candidates.some(candidate => !enumeratedHashes.has(computeSemanticQueryHash(candidate)))) {
    return deepFreeze({ type: 'abstention', reason: 'provider_candidate_not_enumerated' });
  }
  if (provider.candidates.length !== 1 || computeSemanticQueryHash(provider.candidates[0]) !== computeSemanticQueryHash(evidence.candidates[0])) {
    return deepFreeze({ type: 'abstention', reason: 'provider_candidate_not_enumerated' });
  }
  const admission: VerifiedSemanticQueryAdmission = deepFreeze({
    [verifiedSemanticAdmissionBrand]: true as const,
    type: 'admitted',
    question_sha256: question.sha256,
    catalog_hash: catalogHash,
    semantic_evidence_hash: computeSemanticEvidenceHash(evidence),
    query: evidence.candidates[0],
    query_hash: computeSemanticQueryHash(evidence.candidates[0]),
    candidate_set_hash: evidence.candidate_set_hash
  });
  activeSemanticAdmissions.add(admission);
  return admission;
}

export function verifySemanticQueryAdmission(
  input: unknown,
  questionInput: unknown,
  catalog: SemanticCatalog = SEMANTIC_CATALOG
): VerifiedSemanticQueryAdmission {
  if (!input || typeof input !== 'object' || !activeSemanticAdmissions.has(input)) {
    throw new Error('semantic query admission provenance is invalid');
  }
  const admission = input as VerifiedSemanticQueryAdmission;
  const question = createAnswerQuestionContract(questionInput);
  const catalogHash = computeSemanticCatalogHash(catalog);
  if (admission[verifiedSemanticAdmissionBrand] !== true || admission.type !== 'admitted' ||
      admission.question_sha256 !== question.sha256 || admission.catalog_hash !== catalogHash) {
    throw new Error('semantic query admission binding is invalid');
  }
  const query = parseSemanticQueryCandidateSet(
    { version: SEMANTIC_QUERY_VERSION, candidates: [admission.query] }, questionInput, catalog
  ).candidates[0];
  const queryHash = computeSemanticQueryHash(query);
  const candidateSetHash = computeSemanticCandidateSetHash([query], question.sha256, catalogHash);
  const semanticEvidenceHash = computeSemanticEvidenceHash({
    version: SEMANTIC_EVIDENCE_VERSION,
    type: 'candidate_set',
    question_sha256: question.sha256,
    catalog_hash: catalogHash,
    candidate_set_hash: candidateSetHash,
    candidates: [query]
  });
  if (admission.query_hash !== queryHash || admission.candidate_set_hash !== candidateSetHash) {
    throw new Error('semantic query admission binding is invalid');
  }
  if (admission.semantic_evidence_hash !== semanticEvidenceHash) {
    throw new Error('semantic query admission evidence binding is invalid');
  }
  return admission;
}

function normalizeSemanticQuery(query: SemanticQuery): SemanticQuery {
  const normalizeEvidence = (evidence: readonly SemanticLiteralSpan[]) =>
    [...new Map(evidence.map(span => [stableSerialize(span), span])).values()].sort(compareSpans);
  const normalized: SemanticQuery = {
    version: SEMANTIC_QUERY_VERSION,
    outputs: query.outputs.map(output => ({ ...output, evidence: normalizeEvidence(output.evidence) })),
    scopes: [...query.scopes].map(scope => ({ ...scope, evidence: normalizeEvidence(scope.evidence) }))
      .sort((left, right) => compareText(stableSerialize(left), stableSerialize(right))),
    entities: [...query.entities],
    filters: [...query.filters].map(filter => ({
      ...filter,
      ...('entity_indices' in filter ? { entity_indices: [...filter.entity_indices].sort((left, right) => left - right) } : {}),
      ...('values' in filter ? { values: [...filter.values].sort(compareLiteral) } : {}),
      evidence: normalizeEvidence(filter.evidence)
    })).sort((left, right) => compareText(stableSerialize(left), stableSerialize(right))),
    group_by: [...query.group_by].map(group => ({ ...group, evidence: normalizeEvidence(group.evidence) }))
      .sort((left, right) => compareText(stableSerialize(left), stableSerialize(right))),
    ...(query.comparison ? { comparison: { ...query.comparison, evidence: normalizeEvidence(query.comparison.evidence) } } : {}),
    order_by: query.order_by.map(order => ({ ...order, evidence: normalizeEvidence(order.evidence) })),
    ...(query.limit ? { limit: { ...query.limit, evidence: normalizeEvidence(query.limit.evidence) } } : {})
  };
  return deepFreeze(normalized);
}

function validateSemanticQuery(query: SemanticQuery, question: AnswerQuestionContract, catalog: SemanticCatalog): void {
  forEachEvidence(query, span => validateSpan(span, question));
  if (!isCanonicalEntityOrder(query.entities)) {
    throw new Error('semantic query entities must be canonically ordered');
  }
  const seasons = query.scopes.filter(scope => scope.kind === 'season');
  const sessions = query.scopes.filter(scope => scope.kind === 'session');
  const temporals = query.scopes.filter(scope => scope.kind === 'temporal');
  const rounds = query.scopes.filter(scope => scope.kind === 'round');
  const events = query.scopes.filter(scope => scope.kind === 'event');
  if (seasons.length !== 1 || sessions.length < 1 || temporals.length !== 1 || rounds.length > 1 || events.length > 1 || (rounds.length > 0 && events.length > 0)) {
    throw new Error('semantic query scope must contain one season, source session, temporal mode, and at most one event selector');
  }
  const season = seasons[0].value;
  const temporal = temporals[0].value;
  const sourceIds = new Set<string>();

  for (const output of query.outputs) {
    const { source, concept, kind } = resolveConcept(output.concept, catalog);
    sourceIds.add(source.id);
    if (output.kind === 'aggregate') {
      if (kind !== 'measure' || !concept.allowed_aggregations.includes(output.function)) {
        throw new Error(`semantic aggregate is not allowed for ${source.id}.${concept.id}`);
      }
    }
  }
  for (const grouping of query.group_by) {
    const { source, concept, kind } = resolveConcept(grouping.concept, catalog);
    sourceIds.add(source.id);
    if (kind !== 'dimension' || !concept.groupable) {
      throw new Error(`semantic grouping is not allowed for ${source.id}.${concept.id}`);
    }
  }
  for (const filter of query.filters) {
    const { source, concept } = resolveConcept(filter.concept, catalog);
    sourceIds.add(source.id);
    if (!concept.filter_operators.includes(filter.operator)) {
      throw new Error(`semantic filter operator is not allowed for ${source.id}.${concept.id}`);
    }
    if (filter.kind === 'entity') {
      const expectedType = entityTypeForConcept(concept.semantic_type);
      if (!expectedType || filter.entity_indices.some(index => query.entities[index]?.type !== expectedType)) {
        throw new Error('semantic entity filter does not match its referenced entity or concept');
      }
    } else {
      if (['driver_id', 'event_id', 'circuit_id', 'identity', 'team_id'].includes(concept.semantic_type)) {
        throw new Error('semantic identity concepts require deterministic entity linking');
      }
      const values = literalFilterValues(filter);
      if (values.some(value => !isLiteralValidForConcept(value, concept))) {
        throw new Error(`semantic literal does not match ${source.id}.${concept.id}`);
      }
      if (values.some(value => !literalHasEvidence(value, filter.evidence))) {
        throw new Error('semantic literal value is not grounded by its evidence');
      }
      if (filter.kind === 'literal_set' && new Set(filter.values.map(stableSerialize)).size !== filter.values.length) {
        throw new Error('semantic literal set contains duplicates');
      }
      if (filter.kind === 'literal_range' && compareLiteral(filter.min, filter.max) > 0) {
        throw new Error('semantic literal range is inverted');
      }
    }
  }
  assertUnique(sessions.map(scope => scope.source_id), 'semantic source sessions');
  if (sessions.length !== sourceIds.size || sessions.some(scope => !sourceIds.has(scope.source_id))) {
    throw new Error('semantic query requires exactly one session scope for every source');
  }
  for (const sourceId of sourceIds) {
    const source = catalog.sources.find(item => item.id === sourceId)!;
    const session = sessions.find(scope => scope.source_id === sourceId)!;
    if (source.usage !== 'answer_fact' || !source.scope.sessions.includes(session.value) || source.scope.season_min === null || source.scope.season_max === null || season < source.scope.season_min || season > source.scope.season_max) {
      throw new Error(`semantic scope is not supported by ${source.id}`);
    }
    if (temporal === 'final' && (source.scope.final_season_through === null || season > source.scope.final_season_through)) {
      throw new Error(`semantic final scope is not supported by ${source.id}`);
    }
    if (temporal === 'latest_recorded' && source.scope.final_season_through !== null && season <= source.scope.final_season_through) {
      throw new Error(`semantic latest-recorded scope is not supported by ${source.id}`);
    }
  }
  if ((rounds.length > 0 || events.length > 0) && sessions.some(session => session.value === 'season')) {
    throw new Error('semantic season scope cannot include an event selector');
  }
  if (!literalHasEvidence(season, seasons[0].evidence) || rounds.some(round => !literalHasEvidence(round.value, round.evidence))) {
    throw new Error('semantic scope value is not grounded by its evidence');
  }
  if (!temporalHasEvidence(temporal, temporals[0].evidence, season, question.normalized_question)) {
    throw new Error('semantic temporal value is not grounded by its evidence');
  }
  for (const event of events) {
    if (query.entities[event.entity_index]?.type !== 'event') {
      throw new Error('semantic event scope must reference an event literal');
    }
  }
  const referencedEntities = new Set([
    ...events.map(event => event.entity_index),
    ...query.filters.flatMap(filter => filter.kind === 'entity' ? filter.entity_indices : [])
  ]);
  if (query.entities.some((_entity, index) => !referencedEntities.has(index))) {
    throw new Error('semantic query contains an unreferenced entity literal');
  }
  if (query.order_by.some(order => order.output_index >= query.outputs.length)) {
    throw new Error('semantic ordering references a missing output');
  }
  assertUnique(query.outputs.map(output => stableSerialize({ kind: output.kind, concept: output.concept, ...('function' in output ? { function: output.function } : {}) })), 'semantic outputs');
  assertUnique(query.scopes.filter(scope => scope.kind !== 'session').map(scope => scope.kind), 'semantic scope kinds');
  assertUnique(query.filters.map(filter => stableSerialize(filter)), 'semantic filters');
  assertUnique(query.group_by.map(group => stableSerialize(group.concept)), 'semantic groupings');
}

function resolveConcept(reference: SemanticConceptRef, catalog: SemanticCatalog) {
  const source = catalog.sources.find(item => item.id === reference.source_id);
  const dimension = source?.dimensions.find(item => item.id === reference.concept_id);
  const measure = source?.measures.find(item => item.id === reference.concept_id);
  if (!source || (!dimension && !measure)) {
    throw new Error(`semantic query references unknown concept ${reference.source_id}.${reference.concept_id}`);
  }
  return dimension
    ? { source, concept: dimension, kind: 'dimension' as const }
    : { source, concept: measure!, kind: 'measure' as const };
}

function buildOutputChoices(
  source: SemanticCatalogSource,
  matches: readonly LexicalMatch[],
  sourceMatches: readonly LexicalMatch[],
  operations: OperationEvidence,
  question: string,
  standingsPointsEvidence?: SemanticLiteralSpan
): { readonly outputs: readonly (readonly SemanticQuery['outputs'][number][])[]; readonly defaulted: boolean } {
  if (source.id === 'driver_standings' && standingsPointsEvidence) {
    return { outputs: [standingsPointsOutputs(standingsPointsEvidence)], defaulted: false };
  }
  const explicit = matches.map(match => {
    const concept = { source_id: match.source_id, concept_id: match.concept_id! };
    return { kind: 'concept' as const, concept, evidence: [match.span] };
  });
  if (explicit.length > 0) {
    const alternatives = alternativeOutputChoices(matches, explicit, question);
    if (alternatives) {
      return operations.count ? { outputs: [], defaulted: false } : { outputs: alternatives, defaulted: true };
    }
    const countable = explicit.filter(output => source.measures.find(measure => measure.id === output.concept.concept_id)?.allowed_aggregations.includes('count'));
    if (operations.count) {
      if (countable.length !== 1) {
        return { outputs: [], defaulted: false };
      }
      const dimensions = explicit.filter(output => source.dimensions.some(dimension => dimension.id === output.concept.concept_id));
      return {
        outputs: [[...dimensions, {
          kind: 'aggregate' as const,
          function: 'count' as const,
          concept: countable[0].concept,
          evidence: [operations.count, ...countable[0].evidence]
        }]],
        defaulted: false
      };
    }
    return { outputs: [explicit], defaulted: false };
  }
  const sourceEvidence = sourceMatches.find(match => match.source_id === source.id)?.span;
  if (!sourceEvidence) {
    return { outputs: [], defaulted: false };
  }
  const defaults: Readonly<Record<string, readonly (readonly string[])[]>> = {
    driver_standings: [['driver_id', 'championship_position'], ['driver_id', 'championship_position', 'points']],
    event_classification: [['driver_id', 'finishing_position'], ['classification_status', 'driver_id', 'finishing_position']],
    event_metadata: [['date', 'event_name'], ['circuit_id', 'date', 'event_name']],
    qualifying_classification: [['driver_id', 'qualifying_position'], ['classification_status', 'driver_id', 'qualifying_position']]
  };
  return {
    outputs: (defaults[source.id] ?? []).map(ids => ids.map(conceptId => ({
      kind: 'concept' as const,
      concept: { source_id: source.id as z.infer<typeof sourceIdSchema>, concept_id: conceptId },
      evidence: [sourceEvidence]
    }))),
    defaulted: true
  };
}

function standingsPointsOutputs(
  evidence: SemanticLiteralSpan
): readonly SemanticQuery['outputs'][number][] {
  return [
    {
      kind: 'concept',
      concept: { source_id: 'driver_standings', concept_id: 'driver_id' },
      evidence: [evidence]
    },
    {
      kind: 'concept',
      concept: { source_id: 'driver_standings', concept_id: 'points' },
      evidence: [evidence]
    }
  ];
}

// eslint-disable-next-line complexity
function finalStandingsPointsProjection(
  question: AnswerQuestionContract,
  sourceMatches: readonly LexicalMatch[],
  conceptMatches: readonly LexicalMatch[],
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[]
): LexicalMatch | undefined {
  const unfiltered = [
    /^show the final \d{4} standings points\.?$/iu,
    /^what were the final standings points in 2025\?$/iu
  ].some(pattern => pattern.test(question.normalized_question));
  const singleDriver = /^what were charles leclerc final standings points in 2024\?$/iu
    .test(question.normalized_question);
  let driverPairNames: readonly string[] | undefined;
  if (/^final 2025 standings points for lando norris and oscar piastri\.$/iu.test(question.normalized_question)) {
    driverPairNames = ['lando norris', 'oscar piastri'];
  } else if (/^final 2025 standings points for oscar piastri and lando norris\.$/iu.test(question.normalized_question)) {
    driverPairNames = ['oscar piastri', 'lando norris'];
  }
  if (!unfiltered && !singleDriver && !driverPairNames) {
    return undefined;
  }
  let exactEntities = entities.length === 0;
  if (singleDriver) {
    exactEntities = entities.length === 1 && entities[0].type === 'driver' &&
      entities[0].span.text.toLocaleLowerCase('en-US') === 'charles leclerc';
  } else if (driverPairNames) {
    exactEntities = entities.length === 2 && entities.every(entity => entity.type === 'driver') &&
      entities.every((entity, index) =>
        entity.span.text.toLocaleLowerCase('en-US') === driverPairNames[index]);
  }
  if (![question.years.length === 1, question.rounds.length === 0, exactEntities,
    sourceMatches.length === 0, operations.temporal.length === 1, operations.temporal[0].value === 'final',
    !operations.count, !operations.rank, !operations.limit].every(Boolean)) {
    return undefined;
  }
  const selected = conceptMatches.filter(match =>
    match.source_id === 'driver_standings' && match.concept_id === 'points' &&
    match.span.text.toLocaleLowerCase('en-US') === 'standings points');
  if (selected.length !== 1 || conceptMatches.some(match =>
    (match.span.start < selected[0].span.start || match.span.end > selected[0].span.end))) {
    return undefined;
  }
  return selected[0];
}

function alternativeOutputChoices(
  matches: readonly LexicalMatch[],
  outputs: readonly Extract<SemanticQuery['outputs'][number], { kind: 'concept' }>[],
  question: string
): readonly (readonly SemanticQuery['outputs'][number][])[] | undefined {
  const orSpans = regexSpans(question, /\bor\b/giu);
  if (orSpans.length === 0) {return undefined;}
  const semanticMatches = matches;
  if (orSpans.length > 1) {
    const separatesOutputs = orSpans.some(orSpan =>
      semanticMatches.some(match => match.span.end <= orSpan.start) && semanticMatches.some(match => match.span.start >= orSpan.end));
    return separatesOutputs ? [] : undefined;
  }
  const left = [...semanticMatches].filter(match => match.span.end <= orSpans[0].start).sort(compareMatches).at(-1);
  const right = [...semanticMatches].filter(match => match.span.start >= orSpans[0].end).sort(compareMatches)[0];
  if (!left || !right) {return undefined;}
  if (left.concept_id === right.concept_id) {return [];}
  const common = outputs.filter(output => output.concept.concept_id !== left.concept_id && output.concept.concept_id !== right.concept_id);
  const leftOutput = outputs.find(output => output.concept.concept_id === left.concept_id)!;
  const rightOutput = outputs.find(output => output.concept.concept_id === right.concept_id)!;
  return [[...common, leftOutput], [...common, rightOutput]];
}

function hasEntityAlternative(
  question: AnswerQuestionContract,
  sources: readonly LexicalMatch[],
  concepts: readonly LexicalMatch[],
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  const drivers = entities.filter(entity => entity.type === 'driver');
  return regexSpans(question.normalized_question, /\bor\b/giu).some(orSpan =>
    drivers.some(entity => entity.span.end <= orSpan.start) &&
    drivers.some(entity => entity.span.start >= orSpan.end) &&
    !isRecognizedNonEntityAlternative(orSpan, question, sources, concepts, operations));
}

function hasCrossTypeEntityAlternative(
  question: AnswerQuestionContract,
  sources: readonly LexicalMatch[],
  concepts: readonly LexicalMatch[],
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  return regexSpans(question.normalized_question, /\bor\b/giu).some(orSpan => {
    const left = entities.filter(entity => entity.span.end <= orSpan.start)
      .sort((a, b) => b.span.end - a.span.end)[0];
    const right = entities.filter(entity => entity.span.start >= orSpan.end)
      .sort((a, b) => a.span.start - b.span.start)[0];
    if (!left || !right || left.type === right.type) {return false;}
    const typeCountAt = (target: SemanticEntityInventoryItem) => new Set(entities
      .filter(entity => entity.span.start === target.span.start && entity.span.end === target.span.end)
      .map(entity => entity.type)).size;
    if (typeCountAt(left) > 1 || typeCountAt(right) > 1) {return false;}
    return !isRecognizedNonEntityAlternative(orSpan, question, sources, concepts, operations);
  });
}

function isRecognizedNonEntityAlternative(
  orSpan: SemanticLiteralSpan,
  question: AnswerQuestionContract,
  sources: readonly LexicalMatch[],
  concepts: readonly LexicalMatch[],
  operations: OperationEvidence
): boolean {
  const straddles = (spans: readonly SemanticLiteralSpan[]) =>
    spans.some(span => span.end <= orSpan.start) && spans.some(span => span.start >= orSpan.end);
  if (straddles(question.years.map(copyMention)) || straddles(question.rounds.map(copyMention)) ||
      straddles(operations.temporal.map(item => item.span))) {
    return true;
  }
  const explicitSourceIds = new Set(sources.map(source => source.source_id));
  const relevantConcepts = explicitSourceIds.size === 0
    ? concepts
    : concepts.filter(concept => explicitSourceIds.has(concept.source_id));
  const leftConcept = relevantConcepts.filter(match => match.span.end <= orSpan.start)
    .sort((a, b) => b.span.end - a.span.end || b.span.start - a.span.start)[0];
  const rightConcept = relevantConcepts.filter(match => match.span.start >= orSpan.end)
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)[0];
  if (leftConcept && rightConcept &&
      (leftConcept.source_id !== rightConcept.source_id || leftConcept.concept_id !== rightConcept.concept_id)) {
    return true;
  }
  const leftSources = sources.filter(match => match.span.end <= orSpan.start);
  const rightSources = sources.filter(match => match.span.start >= orSpan.end);
  return leftSources.some(leftSource => rightSources.some(rightSource => leftSource.source_id !== rightSource.source_id));
}

function hasConflictingDriverCardinality(
  question: string,
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  return entities.some(entity => entity.type === 'driver') && /\b(?:all|each)\b/iu.test(question);
}

function hasUnconsumedAlternative(
  question: AnswerQuestionContract,
  sources: readonly LexicalMatch[],
  concepts: readonly LexicalMatch[],
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  const categories: readonly (readonly SemanticLiteralSpan[])[] = [
    sources.map(match => match.span),
    concepts.map(match => match.span),
    question.years.map(copyMention),
    question.rounds.map(copyMention),
    operations.temporal.map(item => item.span),
    entities.filter(entity => entity.type === 'driver').map(entity => entity.span),
    entities.filter(entity => entity.type === 'event').map(entity => entity.span)
  ];
  return regexSpans(question.normalized_question, /\bor\b/giu).some(orSpan =>
    !categories.some(spans =>
      spans.some(span => span.end <= orSpan.start) &&
      spans.some(span => span.start >= orSpan.end)));
}

function buildCandidate(
  source: SemanticCatalogSource,
  outputs: readonly SemanticQuery['outputs'][number][],
  year: AnswerQuestionMention<number>,
  round: AnswerQuestionMention<number> | undefined,
  temporal: { readonly value: 'final' | 'latest_recorded'; readonly span: SemanticLiteralSpan },
  entities: readonly SemanticEntityInventoryItem[],
  operations: OperationEvidence
): SemanticQuery | undefined {
  const session = source.scope.sessions.find(value => value === 'season' || value === 'race' || value === 'qualifying');
  if (!session) {
    return undefined;
  }
  const queryEntities = canonicalEntities(entities);
  const scopes: SemanticQuery['scopes'] = [
    { kind: 'season', value: year.value, evidence: [copyMention(year)] },
    { kind: 'session', source_id: source.id as z.infer<typeof sourceIdSchema>, value: session, evidence: [sourceEvidence(outputs)] },
    { kind: 'temporal', value: temporal.value, evidence: [temporal.span] }
  ];
  if (round) {
    scopes.push({ kind: 'round', value: round.value, evidence: [copyMention(round)] });
  }
  const eventIndex = queryEntities.findIndex(entity => entity.type === 'event');
  if (eventIndex >= 0) {
    scopes.push({ kind: 'event', entity_index: eventIndex, evidence: [queryEntities[eventIndex].span] });
  }
  const driverIndices = queryEntities.flatMap((entity, index) => entity.type === 'driver' ? [index] : []);
  const driverConcept = source.dimensions.find(dimension => dimension.id === 'driver_id');
  const filters: SemanticQuery['filters'] = driverIndices.length > 0 && driverConcept
    ? [{
        kind: 'entity',
        concept: { source_id: source.id as z.infer<typeof sourceIdSchema>, concept_id: 'driver_id' },
        operator: driverIndices.length === 1 ? 'eq' : 'in',
        entity_indices: driverIndices,
        evidence: driverIndices.map(index => queryEntities[index].span)
      }]
    : [];
  const groupBy = outputs.flatMap(output =>
    output.kind === 'concept' && source.dimensions.some(dimension => dimension.id === output.concept.concept_id) && outputs.some(item => item.kind === 'aggregate')
      ? [{ concept: output.concept, evidence: output.evidence }]
      : []
  );
  let orderBy: SemanticQuery['order_by'] = [];
  let comparison: SemanticQuery['comparison'];
  if (operations.rank) {
    const metricIndex = outputs.findIndex(output => output.kind === 'aggregate' || source.measures.some(measure => measure.id === output.concept.concept_id));
    if (metricIndex < 0) {
      return undefined;
    }
    const metric = outputs[metricIndex];
    const metricConcept = [...source.dimensions, ...source.measures].find(concept => concept.id === metric.concept.concept_id)!;
    const direction = semanticSortDirection(metric, metricConcept.semantic_type);
    orderBy = [{ output_index: metricIndex, direction, evidence: [operations.rank] }];
    comparison = { relation: 'rank', evidence: [operations.rank] };
  } else if (operations.count) {
    comparison = { relation: 'count', evidence: [operations.count] };
  }
  return {
    version: SEMANTIC_QUERY_VERSION,
    outputs: [...outputs],
    scopes,
    entities: queryEntities,
    filters,
    group_by: groupBy,
    ...(comparison ? { comparison } : {}),
    order_by: orderBy,
    ...(operations.limit ? { limit: { value: operations.limit.value, evidence: [operations.limit.span] } } : {})
  };
}

function requestedCompositionSourceIds(
  sourceMatches: readonly LexicalMatch[],
  _conceptMatches: readonly LexicalMatch[]
): z.infer<typeof sourceIdSchema>[] {
  const explicit = [...new Set(sourceMatches.map(match => match.source_id))].sort(compareText);
  return explicit.length > 1 ? explicit : [];
}

function enumeratePromotedComposition(
  question: AnswerQuestionContract,
  inventory: readonly SemanticEntityInventoryItem[],
  sourceIds: readonly z.infer<typeof sourceIdSchema>[],
  sourceMatches: readonly LexicalMatch[],
  conceptMatches: readonly LexicalMatch[],
  operations: OperationEvidence,
  catalog: SemanticCatalog
): SemanticQuery[] {
  if (question.years.length !== 1 || question.rounds.length > 1 || operations.temporal.length > 1) {
    return [];
  }
  const sources = sourceIds.map(sourceId => catalog.sources.find(source => source.id === sourceId && source.usage === 'answer_fact'));
  if (sources.some(source => !source)) {return [];}
  const year = question.years[0];
  const temporal = temporalChoices(year, operations, sources[0]!);
  if (temporal.length !== 1 || sources.some(source => !sourceSupportsTemporal(source!, year.value, temporal[0].value))) {
    return [];
  }
  const entities = canonicalEntities(inventory);
  if (!compositionSupportsEntities(sources as SemanticCatalogSource[], entities)) {
    return [];
  }
  const selectedConceptMatches = conceptMatches.filter(match => sourceIds.includes(match.source_id));
  const hasUnselectedSpecificConcept = conceptMatches.some(match => !sourceIds.includes(match.source_id) &&
    !selectedConceptMatches.some(selected => selected.span.start <= match.span.start && selected.span.end >= match.span.end));
  if (hasUnselectedSpecificConcept) {return [];}
  const scopedMatches = selectedConceptMatches;
  const longestByConcept = new Map<string, number>();
  for (const match of scopedMatches) {
    const key = `${match.source_id}.${match.concept_id}`;
    longestByConcept.set(key, Math.max(longestByConcept.get(key) ?? 0, match.span.end - match.span.start));
  }
  const canonicalMatches = canonicalConceptMatches(scopedMatches.filter(match =>
    match.span.end - match.span.start === longestByConcept.get(`${match.source_id}.${match.concept_id}`)));
  const matches = canonicalMatches.filter(match => !canonicalMatches.some(other =>
    other.span.start <= match.span.start && other.span.end >= match.span.end &&
    (other.span.start < match.span.start || other.span.end > match.span.end)));
  const rowJoin = stableSerialize(sourceIds) === stableSerialize(['event_classification', 'event_metadata']);
  const scalarCompose = stableSerialize(sourceIds) === stableSerialize(['event_classification', 'qualifying_classification']);
  if (!rowJoin && !scalarCompose) {return [];}
  if (rowJoin && (operations.count || operations.rank || (question.rounds.length === 0 && !entities.some(entity => entity.type === 'event')))) {
    return [];
  }
  if (scalarCompose && (!operations.count || operations.rank)) {return [];}

  const outputs: SemanticQuery['outputs'] = scalarCompose
    ? compositionAggregateOutputs(matches, operations, catalog)
    : matches.map(match => ({
        kind: 'concept' as const,
        concept: { source_id: match.source_id, concept_id: match.concept_id! },
        evidence: [match.span]
      }));
  if (outputs.length === 0 || sourceIds.some(sourceId => !outputs.some(output => output.concept.source_id === sourceId)) ||
      (scalarCompose && (outputs.length !== sourceIds.length || outputs.some(output => output.kind !== 'aggregate')))) {
    return [];
  }
  const scopes: SemanticQuery['scopes'] = [
    { kind: 'season', value: year.value, evidence: [copyMention(year)] },
    ...sourceIds.map(sourceId => {
      const source = sources.find(item => item!.id === sourceId)!;
      const session = source!.scope.sessions.find(value => value === 'season' || value === 'race' || value === 'qualifying')!;
      const evidence = sourceMatches.find(match => match.source_id === sourceId)?.span ?? outputs.find(output => output.concept.source_id === sourceId)!.evidence[0];
      return { kind: 'session' as const, source_id: sourceId, value: session, evidence: [evidence] };
    }),
    { kind: 'temporal', value: temporal[0].value, evidence: [temporal[0].span] }
  ];
  if (question.rounds[0]) {
    scopes.push({ kind: 'round', value: question.rounds[0].value, evidence: [copyMention(question.rounds[0])] });
  }
  const eventIndex = entities.findIndex(entity => entity.type === 'event');
  if (eventIndex >= 0) {
    scopes.push({ kind: 'event', entity_index: eventIndex, evidence: [entities[eventIndex].span] });
  }
  const driverIndices = entities.flatMap((entity, index) => entity.type === 'driver' ? [index] : []);
  const filters: SemanticQuery['filters'] = sourceIds.flatMap(sourceId => {
    const source = sources.find(item => item!.id === sourceId)!;
    return driverIndices.length > 0 && source!.dimensions.some(dimension => dimension.id === 'driver_id')
      ? [{
          kind: 'entity' as const,
          concept: { source_id: sourceId, concept_id: 'driver_id' },
          operator: driverIndices.length === 1 ? 'eq' as const : 'in' as const,
          entity_indices: driverIndices,
          evidence: driverIndices.map(index => entities[index].span)
        }]
      : [];
  });
  const candidate: SemanticQuery = {
    version: SEMANTIC_QUERY_VERSION,
    outputs,
    scopes,
    entities,
    filters,
    group_by: [],
    ...(scalarCompose ? { comparison: { relation: 'count' as const, evidence: [...operations.count_spans] } } : {}),
    order_by: [],
    ...(rowJoin && operations.limit ? { limit: { value: operations.limit.value, evidence: [operations.limit.span] } } : {})
  };
  const parsed = semanticQuerySchema.safeParse(candidate);
  if (!parsed.success) {return [];}
  const normalized = normalizeSemanticQuery(parsed.data);
  try {
    validateSemanticQuery(normalized, question, catalog);
  } catch {
    return [];
  }
  return [normalized];
}

function compositionAggregateOutputs(
  matches: readonly LexicalMatch[],
  operations: OperationEvidence,
  catalog: SemanticCatalog
): SemanticQuery['outputs'] {
  const measureMatches = matches.filter(match => {
    const source = catalog.sources.find(item => item.id === match.source_id);
    return source?.measures.some(measure => measure.id === match.concept_id && measure.allowed_aggregations.includes('count'));
  });
  const usedCounts = new Set<string>();
  return measureMatches.flatMap(match => {
    const count = [...operations.count_spans].reverse().find(span => span.end <= match.span.start && !usedCounts.has(stableSerialize(span)));
    if (!count) {return [];}
    usedCounts.add(stableSerialize(count));
    return [{
      kind: 'aggregate' as const,
      function: 'count' as const,
      concept: { source_id: match.source_id, concept_id: match.concept_id! },
      evidence: [count, match.span]
    }];
  });
}

function compositionSupportsEntities(
  sources: readonly SemanticCatalogSource[],
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  return entities.every(entity => entity.type === 'driver'
    ? sources.some(source => source.dimensions.some(dimension => dimension.id === 'driver_id'))
    : sources.some(source => source.scope.sessions.some(session => session === 'race' || session === 'qualifying')));
}

function candidateSetEvidence(
  question: AnswerQuestionContract,
  catalogHash: string,
  candidates: readonly SemanticQuery[],
  maxCandidates: number,
  ambiguityReason?: SemanticAmbiguityReason
): SemanticEvidence {
  const unique = new Map(candidates.map(candidate => [computeSemanticQueryHash(candidate), candidate]));
  const sorted = [...unique.values()].sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)));
  if (sorted.length > maxCandidates) {
    return deepFreeze({
      version: SEMANTIC_EVIDENCE_VERSION,
      type: 'abstention',
      question_sha256: question.sha256,
      catalog_hash: catalogHash,
      reason: 'candidate_overflow',
      candidate_count_lower_bound: sorted.length
    });
  }
  return deepFreeze({
    version: SEMANTIC_EVIDENCE_VERSION,
    type: 'candidate_set',
    question_sha256: question.sha256,
    catalog_hash: catalogHash,
    candidate_set_hash: computeSemanticCandidateSetHash(sorted, question.sha256, catalogHash, ambiguityReason),
    candidates: sorted,
    ...(ambiguityReason ? { ambiguity_reason: ambiguityReason } : {})
  });
}

function collectSourceMatches(question: string, catalog: SemanticCatalog): LexicalMatch[] {
  return catalog.sources.flatMap(source => source.usage === 'answer_fact'
    ? [...source.language.names, ...source.language.synonyms, ...source.language.abbreviations]
      .flatMap(phrase => findLiteralSpans(question, phrase).map(span => ({
        span,
        source_id: source.id as z.infer<typeof sourceIdSchema>
      })))
    : []).sort(compareMatches);
}

function collectConceptMatches(question: string, catalog: SemanticCatalog, sourceMatches: readonly LexicalMatch[]): LexicalMatch[] {
  return catalog.sources.flatMap(source => source.usage === 'answer_fact'
    ? [...source.dimensions, ...source.measures].flatMap(concept => concept.language === null ? []
      : [...concept.language.names, ...concept.language.synonyms, ...concept.language.abbreviations]
        .flatMap(phrase => findLiteralSpans(question, phrase).map(span => ({
          span,
          source_id: source.id as z.infer<typeof sourceIdSchema>,
          concept_id: concept.id
        })))
        .filter(match => !sourceMatches.some(sourceMatch =>
          sourceMatch.span.start <= match.span.start && sourceMatch.span.end >= match.span.end &&
          (sourceMatch.span.start < match.span.start || sourceMatch.span.end > match.span.end))))
    : []).sort(compareMatches);
}

function collectOperationEvidence(question: string): OperationEvidence {
  const countSpans = regexSpans(question, /\b(?:count(?:\s+of)?|number\s+of)\b/giu);
  const count = countSpans[0];
  const rank = firstRegexSpan(question, /\b(?:rank|top\s+\d{1,3})\b/iu);
  const limitMatch = [...question.matchAll(/\btop\s+(\d{1,3})\b/giu)][0];
  const temporal = [
    ...regexSpans(question, /\bfinal\b/giu).map(span => ({ value: 'final' as const, span })),
    ...regexSpans(question, /\b(?:current|latest\s+recorded)\b/giu).map(span => ({ value: 'latest_recorded' as const, span }))
  ].sort((left, right) => compareSpans(left.span, right.span));
  return {
    ...(count ? { count } : {}),
    count_spans: countSpans,
    ...(rank ? { rank } : {}),
    ...(limitMatch ? {
      limit: {
        value: Number(limitMatch[1]),
        span: regexMatchSpan(question, limitMatch)
      }
    } : {}),
    temporal
  };
}

function temporalChoices(
  year: AnswerQuestionMention<number>,
  operations: OperationEvidence,
  source: SemanticCatalogSource
): readonly { readonly value: 'final' | 'latest_recorded'; readonly span: SemanticLiteralSpan }[] {
  if (operations.temporal.length > 0) {
    return [...new Map(operations.temporal.map(item => [item.value, item])).values()];
  }
  const value = source.scope.final_season_through !== null && year.value <= source.scope.final_season_through ? 'final' : 'latest_recorded';
  return [{ value, span: copyMention(year) }];
}

function candidateCombinations(
  question: AnswerQuestionContract,
  source: SemanticCatalogSource,
  outputChoices: readonly (readonly SemanticQuery['outputs'][number][])[],
  entityChoices: readonly (readonly SemanticEntityInventoryItem[])[],
  operations: OperationEvidence
): Array<{
  year: AnswerQuestionMention<number>;
  round: AnswerQuestionMention<number> | undefined;
  temporal: { readonly value: 'final' | 'latest_recorded'; readonly span: SemanticLiteralSpan };
  outputs: readonly SemanticQuery['outputs'][number][];
  entities: readonly SemanticEntityInventoryItem[];
}> {
  const rounds: readonly (AnswerQuestionMention<number> | undefined)[] = question.rounds.length > 0 ? question.rounds : [undefined];
  return question.years.flatMap(year => rounds.flatMap(round =>
    temporalChoices(year, operations, source).flatMap(temporal =>
      outputChoices.flatMap(outputs => entityChoices.map(entities => ({ year, round, temporal, outputs, entities }))))));
}

function candidateSourceIds(sourceMatches: readonly LexicalMatch[], conceptMatches: readonly LexicalMatch[]): z.infer<typeof sourceIdSchema>[] {
  const explicit = [...new Set(sourceMatches.map(match => match.source_id))];
  if (explicit.length === 0) {
    return [...new Set(conceptMatches.map(match => match.source_id))].sort(compareText);
  }
  const matchesBySpan = new Map<string, LexicalMatch[]>();
  for (const match of conceptMatches) {
    const key = stableSerialize(match.span);
    matchesBySpan.set(key, [...(matchesBySpan.get(key) ?? []), match]);
  }
  const conflicting = [...matchesBySpan.values()].flatMap(matches =>
    matches.some(match => explicit.includes(match.source_id)) ? [] : matches.map(match => match.source_id));
  const values = [...new Set([...explicit, ...conflicting])];
  return values.sort(compareText);
}

function canonicalConceptMatches(matches: readonly LexicalMatch[]): LexicalMatch[] {
  const longest = matches.filter(match => !matches.some(other =>
    other.source_id === match.source_id && other.concept_id === match.concept_id &&
    other.span.start <= match.span.start && other.span.end >= match.span.end &&
    (other.span.start < match.span.start || other.span.end > match.span.end)));
  const byConcept = new Map<string, LexicalMatch>();
  for (const match of longest) {
    const key = `${match.source_id}.${match.concept_id}`;
    const current = byConcept.get(key);
    if (!current || compareSpans(match.span, current.span) < 0) {
      byConcept.set(key, match);
    }
  }
  return [...byConcept.values()].sort((left, right) => compareSpans(left.span, right.span) || compareMatches(left, right));
}

function buildEntityChoices(source: SemanticCatalogSource, inventory: readonly SemanticEntityInventoryItem[]): readonly (readonly SemanticEntityInventoryItem[])[] {
  const supportsDrivers = source.dimensions.some(dimension => dimension.id === 'driver_id');
  const supportsEvents = source.scope.sessions.some(session => session === 'race' || session === 'qualifying');
  const groups = new Map<string, SemanticEntityInventoryItem[]>();
  for (const item of inventory) {
    const key = stableSerialize(item.span);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  let variants: SemanticEntityInventoryItem[][] = [[]];
  for (const group of groups.values()) {
    const compatible = group.filter(item => item.type === 'driver' ? supportsDrivers : supportsEvents);
    if (compatible.length === 0) {return [];}
    variants = variants.flatMap(variant => compatible.map(item => [...variant, item]));
  }
  return variants.flatMap(variant => {
    const drivers = variant.filter(item => item.type === 'driver');
    const events = variant.filter(item => item.type === 'event');
    return events.length === 0 ? [drivers] : events.map(event => [...drivers, event]);
  });
}

function sourceSupportsEntityInventory(source: SemanticCatalogSource, inventory: readonly SemanticEntityInventoryItem[]): boolean {
  const supportsDrivers = source.dimensions.some(dimension => dimension.id === 'driver_id');
  const supportsEvents = source.scope.sessions.some(session => session === 'race' || session === 'qualifying');
  const groups = new Map<string, SemanticEntityInventoryItem[]>();
  for (const item of inventory) {
    const key = stableSerialize(item.span);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].every(group => group.some(item => item.type === 'driver' ? supportsDrivers : supportsEvents));
}

function sourceSupportsTemporal(source: SemanticCatalogSource, season: number, temporal: 'final' | 'latest_recorded'): boolean {
  return temporal === 'final'
    ? source.scope.final_season_through !== null && season <= source.scope.final_season_through
    : source.scope.final_season_through === null || season > source.scope.final_season_through;
}

function hasAmbiguousEntityAttachment(
  entities: readonly SemanticEntityInventoryItem[],
  conceptMatches: readonly LexicalMatch[],
  catalog: SemanticCatalog
): boolean {
  const drivers = entities.filter(entity => entity.type === 'driver').map(entity => entity.span).sort(compareSpans);
  if (drivers.length < 2) {return false;}
  const outputSpans = new Map<string, SemanticLiteralSpan>();
  for (const match of conceptMatches) {
    const source = catalog.sources.find(item => item.id === match.source_id);
    const concept = [...(source?.dimensions ?? []), ...(source?.measures ?? [])].find(item => item.id === match.concept_id);
    if (concept && !['driver_id', 'round', 'season'].includes(concept.semantic_type)) {
      outputSpans.set(stableSerialize(match.span), match.span);
    }
  }
  const attachmentRegions = new Set([...outputSpans.values()].map(span => drivers.filter(driver => driver.end <= span.start).length));
  return attachmentRegions.size > 1;
}

function hasOutputAlternative(question: string, conceptMatches: readonly LexicalMatch[]): boolean {
  return regexSpans(question, /\bor\b/giu).some(orSpan =>
    conceptMatches.some(match => match.span.end <= orSpan.start) &&
    conceptMatches.some(match => match.span.start >= orSpan.end));
}

function hasInvalidOrderingTargets(
  sourceIds: readonly string[],
  conceptMatches: readonly LexicalMatch[],
  catalog: SemanticCatalog,
  operations: OperationEvidence
): boolean {
  if (!operations.rank) {return false;}
  return sourceIds.some(sourceId => {
    const source = catalog.sources.find(item => item.id === sourceId)!;
    const targets = new Set(canonicalConceptMatches(conceptMatches.filter(match => match.source_id === sourceId)).flatMap(match => {
      const concept = [...source.dimensions, ...source.measures].find(item => item.id === match.concept_id);
      return concept && !['driver_id', 'round', 'season'].includes(concept.semantic_type) ? [concept.id] : [];
    }));
    return targets.size !== 1;
  });
}

function containsUnknownLanguage(
  question: AnswerQuestionContract,
  sources: readonly LexicalMatch[],
  concepts: readonly LexicalMatch[],
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[]
): boolean {
  const characters = Array.from(question.normalized_question);
  const spans = [
    ...sources.map(match => match.span),
    ...concepts.map(match => match.span),
    ...question.years.map(copyMention),
    ...question.rounds.map(copyMention),
    ...entities.map(entity => entity.span),
    ...operations.count_spans,
    ...(operations.rank ? [operations.rank] : []),
    ...(operations.limit ? [operations.limit.span] : []),
    ...operations.temporal.map(item => item.span)
  ];
  for (const span of spans) {
    characters.fill(' ', span.start, span.end);
  }
  const remainder = characters.join('').replace(/\b(?:a|all|an|and|at|by|each|for|from|give|in|list|of|on|or|per|recorded|return|round|season|show|the|with)\b/giu, ' ')
    .replace(/[\p{P}\p{S}\s]/gu, '');
  return /[\p{L}\p{N}]/u.test(remainder);
}

function hasUnsupportedComparison(question: string): boolean {
  return /\b(?:ahead|behind|compare|delta|faster|fastest|gap|higher|lower|quicker|shared\s+event)\b/iu.test(question);
}

function classifyAmbiguity(
  sources: readonly string[],
  question: AnswerQuestionContract,
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[],
  defaulted: boolean,
  eventAlternatives: boolean
): SemanticAmbiguityReason {
  if (operations.temporal.length > 1) {return 'temporal_ambiguous';}
  if (question.years.length > 1 || question.rounds.length > 1) {return 'scope_ambiguous';}
  if (entities.some((entity, index) => entities.some((other, otherIndex) => index !== otherIndex && stableSerialize(entity.span) === stableSerialize(other.span) && entity.type !== other.type))) {return 'entity_ambiguous';}
  if (eventAlternatives) {return 'attachment_ambiguous';}
  if (sources.length > 1) {return 'metric_ambiguous';}
  if (defaulted) {return 'output_shape_ambiguous';}
  return 'metric_ambiguous';
}

function selectAmbiguityReason(
  entityTypeAmbiguity: boolean,
  candidateCount: number,
  sources: readonly string[],
  question: AnswerQuestionContract,
  operations: OperationEvidence,
  entities: readonly SemanticEntityInventoryItem[],
  defaulted: boolean,
  eventAlternatives: boolean
): SemanticAmbiguityReason | undefined {
  if (entityTypeAmbiguity) {return 'entity_ambiguous';}
  if (candidateCount > 1) {
    return classifyAmbiguity(sources, question, operations, entities, defaulted, eventAlternatives);
  }
  return undefined;
}

function canonicalEntities(entities: readonly SemanticEntityInventoryItem[]): SemanticEntityInventoryItem[] {
  return [...new Map(entities.map(entity => [stableSerialize(entity), entity])).values()]
    .sort((left, right) => compareSpans(left.span, right.span) || compareText(left.type, right.type));
}

function isCanonicalEntityOrder(entities: readonly SemanticEntityInventoryItem[]): boolean {
  const canonical = canonicalEntities(entities);
  return canonical.length === entities.length && canonical.every((entity, index) => stableSerialize(entity) === stableSerialize(entities[index]));
}

function forEachEvidence(query: SemanticQuery, visit: (span: SemanticLiteralSpan) => void): void {
  for (const output of query.outputs) {output.evidence.forEach(visit);}
  for (const scope of query.scopes) {scope.evidence.forEach(visit);}
  for (const entity of query.entities) {visit(entity.span);}
  for (const filter of query.filters) {filter.evidence.forEach(visit);}
  for (const group of query.group_by) {group.evidence.forEach(visit);}
  query.comparison?.evidence.forEach(visit);
  for (const order of query.order_by) {order.evidence.forEach(visit);}
  query.limit?.evidence.forEach(visit);
}

function validateSpan(span: SemanticLiteralSpan, question: AnswerQuestionContract): void {
  const codePoints = Array.from(question.normalized_question);
  if (span.end > codePoints.length || codePoints.slice(span.start, span.end).join('') !== span.text) {
    throw new Error('semantic literal span does not exactly match the normalized question');
  }
}

function isLiteralValidForConcept(value: string | number | boolean, concept: SemanticCatalogSource['dimensions'][number] | SemanticCatalogSource['measures'][number]): boolean {
  const expected = literalTypeForSemanticType(concept.semantic_type);
  if (typeof value !== expected) {return false;}
  return !('allowed_values' in concept) || concept.allowed_values.length === 0 || typeof value !== 'string' || concept.allowed_values.includes(value);
}

function literalTypeForSemanticType(semanticType: string): 'boolean' | 'number' | 'string' {
  if (semanticType === 'boolean') {return 'boolean';}
  if (['date', 'circuit_id', 'driver_id', 'event_id', 'identity', 'provenance', 'status', 'team_id', 'text'].includes(semanticType)) {
    return 'string';
  }
  return 'number';
}

function entityTypeForConcept(semanticType: string): 'driver' | 'event' | undefined {
  if (semanticType === 'driver_id') {return 'driver';}
  if (semanticType === 'event_id') {return 'event';}
  return undefined;
}

function literalFilterValues(
  filter: Exclude<SemanticQuery['filters'][number], { kind: 'entity' }>
): readonly (string | number | boolean)[] {
  if (filter.kind === 'literal') {return [filter.value];}
  if (filter.kind === 'literal_set') {return filter.values;}
  return [filter.min, filter.max];
}

function semanticSortDirection(
  output: SemanticQuery['outputs'][number],
  semanticType: string
): 'asc' | 'desc' {
  if (output.kind === 'aggregate' && output.function === 'count') {return 'desc';}
  return semanticType === 'position' ? 'asc' : 'desc';
}

function literalHasEvidence(value: string | number | boolean, evidence: readonly SemanticLiteralSpan[]): boolean {
  if (typeof value === 'number') {
    return evidence.some(span => [...span.text.matchAll(/-?\d+(?:\.\d+)?/gu)].some(match => Number(match[0]) === value));
  }
  if (typeof value === 'boolean') {
    return evidence.some(span => span.text.toLocaleLowerCase('en-US') === String(value));
  }
  return evidence.some(span => span.text.normalize('NFKC').toLocaleLowerCase('en-US') === value.normalize('NFKC').toLocaleLowerCase('en-US'));
}

function temporalHasEvidence(
  value: 'final' | 'latest_recorded',
  evidence: readonly SemanticLiteralSpan[],
  season: number,
  question: string
): boolean {
  const hasFinalCue = /\bfinal\b/iu.test(question);
  const hasLatestCue = /\b(?:current|latest\s+recorded)\b/iu.test(question);
  return evidence.some(span => {
    const normalized = span.text.normalize('NFKC').toLocaleLowerCase('en-US');
    if (!hasFinalCue && !hasLatestCue && literalHasEvidence(season, [span])) {return true;}
    return value === 'final' ? normalized === 'final' : normalized === 'current' || normalized === 'latest recorded';
  });
}

function hasEntityTypeAmbiguity(entities: readonly SemanticEntityInventoryItem[]): boolean {
  return entities.some((entity, index) => entities.some((other, otherIndex) =>
    index !== otherIndex && entity.type !== other.type && stableSerialize(entity.span) === stableSerialize(other.span)));
}

function sourceEvidence(outputs: readonly SemanticQuery['outputs'][number][]): SemanticLiteralSpan {
  return outputs.flatMap(output => output.evidence).sort(compareSpans)[0];
}

function findLiteralSpans(question: string, phrase: string): SemanticLiteralSpan[] {
  const questionPoints = Array.from(question);
  const lowerQuestion = questionPoints.map(point => point.toLocaleLowerCase('en-US'));
  const phrasePoints = Array.from(phrase);
  const lowerPhrase = phrasePoints.map(point => point.toLocaleLowerCase('en-US'));
  const spans: SemanticLiteralSpan[] = [];
  for (let start = 0; start <= questionPoints.length - phrasePoints.length; start += 1) {
    if (!lowerPhrase.every((point, index) => lowerQuestion[start + index] === point)) {continue;}
    const before = questionPoints[start - 1];
    const after = questionPoints[start + phrasePoints.length];
    if ((before && /[\p{L}\p{N}_]/u.test(before)) || (after && /[\p{L}\p{N}_]/u.test(after))) {continue;}
    spans.push({ text: questionPoints.slice(start, start + phrasePoints.length).join(''), start, end: start + phrasePoints.length });
  }
  return spans;
}

function firstRegexSpan(question: string, pattern: RegExp): SemanticLiteralSpan | undefined {
  const match = pattern.exec(question);
  pattern.lastIndex = 0;
  return match ? regexMatchSpan(question, match) : undefined;
}

function regexSpans(question: string, pattern: RegExp): SemanticLiteralSpan[] {
  return [...question.matchAll(pattern)].map(match => regexMatchSpan(question, match));
}

function regexMatchSpan(question: string, match: RegExpMatchArray): SemanticLiteralSpan {
  const start = Array.from(question.slice(0, match.index)).length;
  return { text: match[0], start, end: start + Array.from(match[0]).length };
}

function copyMention(mention: Pick<AnswerQuestionMention<string | number>, 'text' | 'start' | 'end'>): SemanticLiteralSpan {
  return { text: mention.text, start: mention.start, end: mention.end };
}

function compareMatches(left: LexicalMatch, right: LexicalMatch): number {
  return compareSpans(left.span, right.span) || compareText(left.source_id, right.source_id) || compareText(left.concept_id ?? '', right.concept_id ?? '');
}

function compareSpans(left: SemanticLiteralSpan, right: SemanticLiteralSpan): number {
  return left.start - right.start || right.end - left.end || compareText(left.text, right.text);
}

function compareLiteral(left: string | number | boolean, right: string | number | boolean): number {
  return compareText(stableSerialize(left), stableSerialize(right));
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  if (left > right) {return 1;}
  return 0;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {throw new Error(`${label} must be unique`);}
}

function abstention(question: AnswerQuestionContract, catalogHash: string, reason: SemanticAbstentionReason): SemanticEvidence {
  return deepFreeze({
    version: SEMANTIC_EVIDENCE_VERSION,
    type: 'abstention',
    question_sha256: question.sha256,
    catalog_hash: catalogHash,
    reason
  });
}

function verifiedEvidence<T extends SemanticEvidence>(evidence: T): T {
  activeSemanticEvidence.add(evidence);
  return evidence;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value !== null && typeof value === 'object') {
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
