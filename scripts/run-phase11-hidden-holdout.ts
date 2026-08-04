import { createHash } from 'node:crypto';
import { createAnswerQuestionContract } from '../src/f1ql/answer-question';
import { SEMANTIC_CATALOG } from '../src/f1ql/semantic-catalog';
import { enumerateSemanticQueries } from '../src/f1ql/semantic-query';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';
import {
  CompositionalRegressionSnapshot,
  parseCompositionalRegressionCorpus,
  runCompositionalRegressionCorpus
} from '../tests/support/compositional-regression';
import { z } from 'zod';

export const HIDDEN_HOLDOUT_CONTRACT_VERSION = 'phase11-wp7-hidden-holdout-v1' as const;
export const HIDDEN_HOLDOUT_PAYLOAD_ENV = 'F1MUSE_PHASE11_HIDDEN_HOLDOUT_BASE64' as const;
export const HIDDEN_HOLDOUT_SHA256_ENV = 'F1MUSE_PHASE11_HIDDEN_HOLDOUT_SHA256' as const;

const MAX_PAYLOAD_BYTES = 1_000_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.enum([
  'driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification'
]);
const topologySchema = z.enum([
  'single_source_rows', 'single_source_aggregate', 'row_dimension_join', 'scalar_aggregate_compose'
]);
const planFamilySchema = z.enum(['single_source', 'safe_dimension_join', 'aggregate_locality']);
const operationSchema = z.enum(['source', 'filter', 'aggregate', 'join', 'compose', 'project', 'sort', 'limit']);
const heldOutDimensionSchema = z.enum(['entity', 'season', 'event', 'wording', 'composition']);
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
const entitySchema = z.object({
  type: z.enum(['driver', 'event']),
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7).optional()
}).strict();
const driverMentionSchema = z.object({
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7).optional(),
  candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).max(100),
  active_candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).max(100)
}).strict();
const eventResolutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('missing') }).strict(),
  z.object({
    type: z.literal('resolved'),
    season: z.number().int().min(1950).max(2100),
    round: z.number().int().min(1).max(30)
  }).strict(),
  z.object({
    type: z.literal('ambiguous'),
    candidates: z.array(z.object({
      season: z.number().int().min(1950).max(2100),
      round: z.number().int().min(1).max(30)
    }).strict()).min(1).max(100)
  }).strict()
]);
const expectedSchema = z.object({
  action: z.literal('answer'),
  reason: z.literal('semantic_plan_proven'),
  topology: topologySchema,
  source_ids: z.array(sourceIdSchema).min(1).max(4),
  plan_family: planFamilySchema
}).strict();
const structureSchema = z.object({
  template_free: z.literal(true),
  held_out_dimensions: z.array(heldOutDimensionSchema).min(1).max(5),
  topology: topologySchema,
  source_ids: z.array(sourceIdSchema).min(1).max(4),
  operations: z.array(operationSchema).min(4).max(8),
  output_concept_ids: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)).min(1).max(8)
}).strict();
const hiddenCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,99}$/),
  split: z.literal('hidden_holdout'),
  question: z.string().min(1).max(1_000),
  question_sha256: sha256Schema,
  coverage_tags: z.array(coverageTagSchema).min(1),
  risk_tags: z.array(riskTagSchema).min(1),
  entities: z.array(entitySchema).max(8),
  provider_mode: z.literal('enumerated'),
  resolver: z.object({
    driver_mentions: z.array(driverMentionSchema).max(8),
    event_resolution: eventResolutionSchema
  }).strict(),
  expected: expectedSchema,
  structure: structureSchema
}).strict();
const hiddenPayloadSchema = z.object({
  schema_version: z.literal(1),
  contract_version: z.literal(HIDDEN_HOLDOUT_CONTRACT_VERSION),
  cases: z.array(hiddenCaseSchema).min(1).max(200)
}).strict();

type HiddenCase = z.infer<typeof hiddenCaseSchema>;
export type HiddenHoldoutPayload = z.infer<typeof hiddenPayloadSchema>;

const decodedMaterialBrand: unique symbol = Symbol('decodedHiddenHoldoutMaterial');
export interface DecodedHiddenHoldoutMaterial {
  readonly [decodedMaterialBrand]: true;
  readonly payload_sha256: string;
  readonly payload_bytes: number;
}

interface MaterialBinding {
  readonly payload: unknown;
  readonly payload_sha256: string;
}

const activeMaterials = new WeakSet<object>();
const materialBindings = new WeakMap<object, MaterialBinding>();

export type HiddenHoldoutErrorCode =
  | 'material_absent'
  | 'material_provenance_invalid'
  | 'digest_absent'
  | 'digest_invalid'
  | 'payload_encoding_invalid'
  | 'payload_too_large'
  | 'hash_mismatch'
  | 'json_invalid'
  | 'payload_noncanonical'
  | 'template_identifier_forbidden'
  | 'schema_invalid'
  | 'duplicate_case_id'
  | 'duplicate_question_hash'
  | 'question_hash_mismatch'
  | 'public_corpus_overlap'
  | 'structure_invalid'
  | 'capability_interaction_not_reviewed'
  | 'public_plan_structure_overlap'
  | 'duplicate_hidden_plan_structure'
  | 'evaluation_failed';

export class HiddenHoldoutError extends Error {
  constructor(readonly code: HiddenHoldoutErrorCode) {
    super(`hidden holdout ${code.replaceAll('_', ' ')}`);
    this.name = 'HiddenHoldoutError';
  }
}

export interface HiddenHoldoutReport {
  readonly contract_version: typeof HIDDEN_HOLDOUT_CONTRACT_VERSION;
  readonly payload_sha256: string;
  readonly outcomes_sha256: string;
  readonly public_structure_set_sha256: string;
  readonly cases_total: number;
  readonly action_counts: { readonly answer: number; readonly clarify: number; readonly abstain: number };
  readonly topology_counts: Readonly<Record<z.infer<typeof topologySchema>, number>>;
  readonly plan_family_counts: Readonly<Record<z.infer<typeof planFamilySchema>, number>>;
}

export function canonicalizeHiddenHoldoutJson(input: unknown): string {
  return stableSerialize(input);
}

export function decodeHiddenHoldoutEnvironment(
  env: Readonly<Record<string, string | undefined>>
): DecodedHiddenHoldoutMaterial {
  const encoded = env[HIDDEN_HOLDOUT_PAYLOAD_ENV];
  if (!encoded) {throw new HiddenHoldoutError('material_absent');}
  const expectedHash = env[HIDDEN_HOLDOUT_SHA256_ENV];
  if (!expectedHash) {throw new HiddenHoldoutError('digest_absent');}
  if (!sha256Schema.safeParse(expectedHash).success) {throw new HiddenHoldoutError('digest_invalid');}
  if (encoded.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4) {throw new HiddenHoldoutError('payload_too_large');}
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new HiddenHoldoutError('payload_encoding_invalid');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) {throw new HiddenHoldoutError('payload_encoding_invalid');}
  if (bytes.length > MAX_PAYLOAD_BYTES) {throw new HiddenHoldoutError('payload_too_large');}
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {throw new HiddenHoldoutError('hash_mismatch');}
  let text: string;
  let payload: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw new HiddenHoldoutError('json_invalid');
  }
  if (canonicalizeHiddenHoldoutJson(payload) !== text) {throw new HiddenHoldoutError('payload_noncanonical');}
  const material: DecodedHiddenHoldoutMaterial = deepFreeze({
    [decodedMaterialBrand]: true as const,
    payload_sha256: actualHash,
    payload_bytes: bytes.length
  });
  activeMaterials.add(material);
  materialBindings.set(material, { payload, payload_sha256: actualHash });
  return material;
}

export function parseHiddenHoldoutPayload(input: unknown): HiddenHoldoutPayload {
  if (containsTemplateIdentifier(input)) {throw new HiddenHoldoutError('template_identifier_forbidden');}
  const parsedResult = hiddenPayloadSchema.safeParse(input);
  if (!parsedResult.success) {throw new HiddenHoldoutError('schema_invalid');}
  const parsed = parsedResult.data;
  if (new Set(parsed.cases.map(item => item.id)).size !== parsed.cases.length) {
    throw new HiddenHoldoutError('duplicate_case_id');
  }
  if (new Set(parsed.cases.map(item => item.question_sha256)).size !== parsed.cases.length) {
    throw new HiddenHoldoutError('duplicate_question_hash');
  }
  const publicQuestionHashes = getPublicCorpusQuestionHashes();
  for (const item of parsed.cases) {
    if (questionSha256(item.question) !== item.question_sha256) {
      throw new HiddenHoldoutError('question_hash_mismatch');
    }
    if (publicQuestionHashes.has(item.question_sha256)) {throw new HiddenHoldoutError('public_corpus_overlap');}
    validateDeclaredStructure(item);
  }
  try {
    parseCompositionalRegressionCorpus(toRunnerCorpus(parsed.cases));
  } catch {
    throw new HiddenHoldoutError('schema_invalid');
  }
  return deepFreeze(parsed);
}

export async function evaluateHiddenHoldout(materialInput: unknown): Promise<HiddenHoldoutReport> {
  const binding = verifyDecodedMaterial(materialInput);
  const payload = parseHiddenHoldoutPayload(binding.payload);
  let hiddenSnapshot: CompositionalRegressionSnapshot;
  let publicSnapshot: CompositionalRegressionSnapshot;
  try {
    [hiddenSnapshot, publicSnapshot] = await Promise.all([
      runCompositionalRegressionCorpus(toRunnerCorpus(payload.cases)),
      runCompositionalRegressionCorpus(compositionalRegressionCorpusInput)
    ]);
  } catch {
    throw new HiddenHoldoutError('evaluation_failed');
  }
  const hiddenFingerprints = structuralFingerprints(hiddenSnapshot, payload.cases);
  const publicCorpus = parseCompositionalRegressionCorpus(compositionalRegressionCorpusInput);
  const publicFingerprints = structuralFingerprints(publicSnapshot, publicCorpus.cases);
  const reviewedCases = publicCorpus.cases.filter(item =>
    item.expected.action === 'answer' && item.expected.plan_family !== null);
  const reviewedIds = new Set(reviewedCases.map(item => item.id));
  const reviewedInteractionFingerprints = structuralFingerprints(
    { ...publicSnapshot, cases: publicSnapshot.cases.filter(item => reviewedIds.has(item.id)) },
    reviewedCases
  );
  const reviewedSet = new Set(reviewedInteractionFingerprints);
  if (hiddenFingerprints.some(fingerprint => !reviewedSet.has(fingerprint))) {
    throw new HiddenHoldoutError('capability_interaction_not_reviewed');
  }
  const publicSet = new Set(publicFingerprints);
  if (hiddenFingerprints.some(fingerprint => publicSet.has(fingerprint))) {
    throw new HiddenHoldoutError('public_plan_structure_overlap');
  }
  if (new Set(hiddenFingerprints).size !== hiddenFingerprints.length) {
    throw new HiddenHoldoutError('duplicate_hidden_plan_structure');
  }
  return aggregateReport(binding.payload_sha256, hiddenSnapshot, publicFingerprints);
}

export async function runHiddenHoldoutFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<HiddenHoldoutReport> {
  return evaluateHiddenHoldout(decodeHiddenHoldoutEnvironment(env));
}

function verifyDecodedMaterial(input: unknown): MaterialBinding {
  if (!input || typeof input !== 'object' || !activeMaterials.has(input)) {
    throw new HiddenHoldoutError('material_provenance_invalid');
  }
  const material = input as DecodedHiddenHoldoutMaterial;
  const binding = materialBindings.get(material);
  if (!binding || material[decodedMaterialBrand] !== true || material.payload_sha256 !== binding.payload_sha256) {
    throw new HiddenHoldoutError('material_provenance_invalid');
  }
  return binding;
}

function structuralFingerprints(
  snapshot: CompositionalRegressionSnapshot,
  cases: readonly { readonly id: string; readonly question: string; readonly entities: readonly z.infer<typeof entitySchema>[] }[]
): string[] {
  const caseById = new Map(cases.map(item => [item.id, item]));
  return snapshot.cases.flatMap(result => {
    if (result.action !== 'answer' || !result.plan) {return [];}
    const item = caseById.get(result.id);
    if (!item) {throw new HiddenHoldoutError('evaluation_failed');}
    const entityInventory = item.entities.map(entity => ({
      type: entity.type,
      span: materializeSpan(item.question, entity.text, entity.occurrence ?? 0)
    }));
    const evidence = enumerateSemanticQueries(item.question, entityInventory);
    if (evidence.type !== 'candidate_set' || evidence.candidates.length !== 1) {
      throw new HiddenHoldoutError('evaluation_failed');
    }
    const query = evidence.candidates[0];
    return [sha256(Buffer.from(stableSerialize({
      plan: {
        topology: result.plan.topology,
        source_ids: result.plan.source_ids,
        resolution_relationship_ids: result.plan.resolution_relationship_ids,
        row_relationship_ids: result.plan.row_relationship_ids,
        branches: result.plan.branches,
        output_grain: result.plan.output_grain,
        integrity_checks: result.plan.integrity_checks,
        work: {
          source_scan_units: result.plan.work.source_scan_units,
          sources: result.plan.work.sources,
          row_joins: result.plan.work.row_joins,
          compositions: result.plan.work.compositions,
          operator_depth: result.plan.work.operator_depth,
          requested_rows: result.plan.work.requested_rows
        }
      },
      query: {
        entity_types: query.entities.map(entity => entity.type),
        scopes: query.scopes.map(scope => scope.kind),
        filters: query.filters.map(filter => filter.kind === 'entity'
          ? { kind: filter.kind, concept: filter.concept, operator: filter.operator, entity_count: filter.entity_indices.length }
          : { kind: filter.kind, concept: filter.concept, operator: filter.operator }),
        outputs: query.outputs.map(output => ({
          kind: output.kind,
          concept: output.concept,
          ...('function' in output ? { function: output.function } : {})
        })),
        group_by: query.group_by.map(group => group.concept),
        comparison: query.comparison ? { relation: query.comparison.relation } : null,
        order_by: query.order_by.map(order => ({
          output_index: order.output_index,
          direction: order.direction
        })),
        limit: query.limit?.value ?? null
      }
    }), 'utf8'))];
  });
}

function aggregateReport(
  payloadSha256: string,
  snapshot: CompositionalRegressionSnapshot,
  publicFingerprints: readonly string[]
): HiddenHoldoutReport {
  const actionCounts = countBy(snapshot.cases.map(item => item.action));
  const topologyCounts = countBy(snapshot.cases.flatMap(item => item.plan ? [item.plan.topology] : []));
  const familyCounts = countBy(snapshot.cases.flatMap(item => item.plan_family ? [item.plan_family] : []));
  return deepFreeze({
    contract_version: HIDDEN_HOLDOUT_CONTRACT_VERSION,
    payload_sha256: payloadSha256,
    outcomes_sha256: sha256(Buffer.from(stableSerialize(snapshot), 'utf8')),
    public_structure_set_sha256: sha256(Buffer.from(stableSerialize(sortedUnique(publicFingerprints)), 'utf8')),
    cases_total: snapshot.cases.length,
    action_counts: {
      answer: actionCounts.answer ?? 0,
      clarify: actionCounts.clarify ?? 0,
      abstain: actionCounts.abstain ?? 0
    },
    topology_counts: Object.fromEntries(topologySchema.options.map(value => [value, topologyCounts[value] ?? 0])),
    plan_family_counts: Object.fromEntries(planFamilySchema.options.map(value => [value, familyCounts[value] ?? 0]))
  }) as HiddenHoldoutReport;
}

function getPublicCorpusQuestionHashes(): ReadonlySet<string> {
  const compositional = parseCompositionalRegressionCorpus(compositionalRegressionCorpusInput);
  return new Set([
    ...compositional.cases.flatMap(item => questionSha256(item.question) ?? []),
    ...answerEvaluationManifest.flatMap(item => questionSha256(item.question) ?? [])
  ]);
}

function questionSha256(question: string): string | null {
  try {
    return createAnswerQuestionContract(question).sha256;
  } catch {
    return null;
  }
}

function validateDeclaredStructure(item: HiddenCase): void {
  const expectedOperations: Record<z.infer<typeof topologySchema>, readonly z.infer<typeof operationSchema>[]> = {
    single_source_rows: ['source', 'filter', 'project', 'sort', 'limit'],
    single_source_aggregate: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
    row_dimension_join: ['source', 'filter', 'join', 'project', 'sort', 'limit'],
    scalar_aggregate_compose: ['source', 'filter', 'aggregate', 'compose', 'project', 'sort', 'limit']
  };
  const familyTopologies = {
    single_source: ['single_source_aggregate', 'single_source_rows'],
    safe_dimension_join: ['row_dimension_join'],
    aggregate_locality: ['scalar_aggregate_compose']
  } as const;
  const structure = item.structure;
  const knownConcepts = new Set(SEMANTIC_CATALOG.sources.flatMap(source =>
    [...source.dimensions, ...source.measures].map(concept => `${source.id}.${concept.id}`)));
  if (!item.risk_tags.includes('template_free') || !structure.held_out_dimensions.includes('composition') ||
      new Set(structure.held_out_dimensions).size !== structure.held_out_dimensions.length ||
      new Set(structure.source_ids).size !== structure.source_ids.length ||
      new Set(structure.operations).size !== structure.operations.length ||
      new Set(structure.output_concept_ids).size !== structure.output_concept_ids.length ||
      structure.topology !== item.expected.topology ||
      !familyTopologies[item.expected.plan_family].includes(structure.topology as never) ||
      !sameStrings(structure.source_ids, item.expected.source_ids) ||
      !sameStrings(structure.operations, expectedOperations[structure.topology]) ||
      structure.output_concept_ids.some(id => !structure.source_ids.includes(id.split('.')[0] as never) || !knownConcepts.has(id))) {
    throw new HiddenHoldoutError('structure_invalid');
  }
  try {
    const inventory = item.entities.map(entity => ({
      type: entity.type,
      span: materializeSpan(item.question, entity.text, entity.occurrence ?? 0)
    }));
    const evidence = enumerateSemanticQueries(item.question, inventory);
    if (evidence.type !== 'candidate_set' || evidence.candidates.length !== 1 ||
        !sameStrings(structure.output_concept_ids, evidence.candidates[0].outputs.map(output =>
          `${output.concept.source_id}.${output.concept.concept_id}`))) {
      throw new Error('structure mismatch');
    }
  } catch {
    throw new HiddenHoldoutError('structure_invalid');
  }
}

function materializeSpan(question: string, text: string, occurrence: number) {
  const questionPoints = Array.from(question.normalize('NFKC').trim());
  const textPoints = Array.from(text);
  const starts = questionPoints.flatMap((_point, index) =>
    textPoints.every((point, offset) => questionPoints[index + offset] === point) ? [index] : []);
  const start = starts[occurrence];
  if (start === undefined) {throw new Error('entity occurrence is absent');}
  return { text, start, end: start + textPoints.length };
}

function toRunnerCorpus(cases: readonly HiddenCase[]): unknown {
  const runnerCases = cases.map(({ question_sha256: _questionHash, structure: _structure, ...item }) => ({
    ...item,
    split: 'public_holdout' as const
  }));
  return { version: 1, expected_coverage: expectedCoverage(cases), cases: runnerCases };
}

function expectedCoverage(cases: readonly HiddenCase[]) {
  const topologies = countBy(cases.map(item => item.expected.topology));
  const sourceSets = countBy(cases.map(item => item.expected.source_ids.join('_')));
  const families = countBy(cases.map(item => item.expected.plan_family));
  const coverageTags = countBy(cases.flatMap(item => item.coverage_tags));
  const riskTags = countBy(cases.flatMap(item => item.risk_tags));
  const zeros = <T extends readonly string[]>(values: T) => Object.fromEntries(values.map(value => [value, 0]));
  return {
    cases_total: cases.length,
    action_counts: { answer: cases.length, clarify: 0, abstain: 0 },
    split_counts: { development: 0, public_holdout: cases.length, ambiguity: 0, abstention: 0 },
    topology_counts: Object.fromEntries(topologySchema.options.map(value => [value, topologies[value] ?? 0])),
    source_set_counts: {
      driver_standings: sourceSets.driver_standings ?? 0,
      event_classification: sourceSets.event_classification ?? 0,
      event_metadata: sourceSets.event_metadata ?? 0,
      qualifying_classification: sourceSets.qualifying_classification ?? 0,
      event_classification_event_metadata: sourceSets.event_classification_event_metadata ?? 0,
      event_classification_qualifying_classification: sourceSets.event_classification_qualifying_classification ?? 0
    },
    plan_family_counts: { ...Object.fromEntries(planFamilySchema.options.map(value => [value, families[value] ?? 0])), other: 0 },
    ambiguity_reason_counts: zeros([
      'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
      'scope_ambiguous', 'temporal_ambiguous'
    ]),
    abstention_reason_counts: zeros([
      'candidate_overflow', 'provider_candidate_not_enumerated', 'unknown_language', 'unsupported_comparison',
      'unsupported_concept', 'unsupported_source_combination', 'unsupported_scope'
    ]),
    coverage_tag_counts: Object.fromEntries(coverageTagSchema.options.map(value => [value, coverageTags[value] ?? 0])),
    risk_tag_counts: Object.fromEntries(riskTagSchema.options.map(value => [value, riskTags[value] ?? 0]))
  };
}

function containsTemplateIdentifier(value: unknown): boolean {
  if (!value || typeof value !== 'object') {return false;}
  if (Array.isArray(value)) {return value.some(containsTemplateIdentifier);}
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.replaceAll(/[^a-z]/giu, '').toLowerCase();
    return normalized === 'templateid' || normalized === 'templateids' || containsTemplateIdentifier(child);
  });
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {counts[value] = (counts[value] ?? 0) + 1;}
  return counts;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
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

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

if (require.main === module) {
  runHiddenHoldoutFromEnvironment().then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch(error => {
    const safe = error instanceof HiddenHoldoutError ? error : new HiddenHoldoutError('evaluation_failed');
    process.stderr.write(`${safe.message}\n`);
    process.exitCode = 1;
  });
}
