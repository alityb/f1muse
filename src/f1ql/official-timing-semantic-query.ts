import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
  OfficialTimingQuestionMatch
} from './official-timing-question';
import {
  computeSemanticCatalogHash,
  parseSemanticCatalog,
  SemanticCatalog
} from './semantic-catalog';

export const OFFICIAL_TIMING_SEMANTIC_QUERY_VERSION = 3 as const;
export const OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION = 3 as const;
export const OFFICIAL_TIMING_SEMANTIC_MAX_CANDIDATES = 2;
export const OFFICIAL_TIMING_SOURCE_ID = 'official_race_lap_timing' as const;

const metricSchema = z.enum([OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID, OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID]);
const aggregationSchema = z.enum(['arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds']);
const spanSchema = z.object({
  text: z.string().min(1).max(300),
  start: z.number().int().min(0),
  end: z.number().int().positive()
}).strict().refine(span => span.end > span.start, 'literal span end must be after start');
const evidenceSchema = z.array(spanSchema).min(1).max(8);

const measureConceptSchema = z.literal('lap_time_seconds');
const branchSchema = z.enum(['driver_a', 'driver_b']);
const scopeEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('season'), concept: z.literal('season'), value: z.literal(2022), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('round'), concept: z.literal('round'), value: z.literal(14), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('session'), concept: z.literal('session_type'), value: z.literal('R'), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('event'), value: z.literal('2022 Belgian Grand Prix'), evidence: evidenceSchema }).strict()
]);
const filterEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    concept: z.literal('driver_id'),
    operator: z.literal('eq'),
    branch: branchSchema,
    evidence: evidenceSchema
  }).strict(),
  z.object({
    kind: z.literal('literal'),
    concept: z.literal('session_type'),
    operator: z.literal('eq'),
    value: z.literal('R'),
    evidence: evidenceSchema
  }).strict(),
  z.object({
    kind: z.literal('literal_range'),
    concept: z.literal('lap_number'),
    operator: z.literal('range'),
    min: z.number().int().min(1),
    max: z.number().int().min(1),
    evidence: evidenceSchema
  }).strict()
]);

const officialTimingQuerySchemaBase = z.object({
  version: z.literal(OFFICIAL_TIMING_SEMANTIC_QUERY_VERSION),
  source_id: z.literal(OFFICIAL_TIMING_SOURCE_ID),
  metric_id: metricSchema,
  aggregation: aggregationSchema,
  topology: z.literal('same_source_scalar_comparison'),
  entities: z.array(z.object({
    type: z.literal('driver'),
    branch: branchSchema,
    span: spanSchema
  }).strict()).length(2),
  scopes: z.array(scopeEntrySchema).length(4),
  filters: z.array(filterEntrySchema).min(3).max(4),
  outputs: z.tuple([
    z.object({
      kind: z.literal('aggregate'),
      branch: z.literal('driver_a'),
      function: aggregationSchema,
      concept: measureConceptSchema,
      evidence: evidenceSchema
    }).strict(),
    z.object({
      kind: z.literal('aggregate'),
      branch: z.literal('driver_b'),
      function: aggregationSchema,
      concept: measureConceptSchema,
      evidence: evidenceSchema
    }).strict()
  ]),
  comparison: z.object({
    relation: z.literal('lower'),
    delta: z.literal('absolute'),
    winner_on_equal: z.null(),
    decimal_scale: z.literal(4),
    evidence: evidenceSchema
  }).strict(),
  order_by: z.tuple([z.object({
    output_index: z.literal(0),
    direction: z.literal('asc'),
    nulls: z.literal('last'),
    evidence: evidenceSchema
  }).strict()]),
  limit: z.object({ value: z.literal(1), evidence: evidenceSchema }).strict()
}).strict();

const officialTimingQuerySchema = officialTimingQuerySchemaBase.superRefine((query, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  refineAggregation(query, issue);
  refineScopes(query, issue);
  refineFilters(query, issue);
  refineEntities(query, issue);
});

type QueryShape = z.infer<typeof officialTimingQuerySchemaBase>;
type Issue = (message: string) => void;

function refineAggregation(query: QueryShape, issue: Issue): void {
  const expectedAggregation = query.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? 'arithmetic_mean_integer_milliseconds'
    : 'median_integer_milliseconds';
  if (query.aggregation !== expectedAggregation ||
      query.outputs.some(output => output.function !== expectedAggregation)) {
    issue('official timing aggregation does not match metric');
  }
}

function refineScopes(query: QueryShape, issue: Issue): void {
  const scopeKinds = query.scopes.map(scope => scope.kind).sort(compareText);
  if (scopeKinds.join(',') !== 'event,round,season,session') {
    issue('official timing scopes must contain exactly one season, round, session, and event');
  }
}

function refineFilters(query: QueryShape, issue: Issue): void {
  const entityFilters = query.filters.filter(filter => filter.kind === 'entity');
  const sessionFilters = query.filters.filter(filter => filter.kind === 'literal');
  const windowFilters = query.filters.filter(filter => filter.kind === 'literal_range');
  if (entityFilters.length !== 2 || sessionFilters.length !== 1 ||
      entityFilters[0].branch !== 'driver_a' || entityFilters[1].branch !== 'driver_b') {
    issue('official timing filters require driver_a and driver_b entity filters and one session literal');
  }
  if (windowFilters.length > 1) {
    issue('official timing allows at most one lap window');
  }
  if ((windowFilters.length === 1) !== (query.metric_id === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID)) {
    issue('official timing lap window does not match metric');
  }
  for (const window of windowFilters) {
    if (window.kind === 'literal_range' && (window.max < window.min || window.max - window.min + 1 > 50)) {
      issue('official timing lap window is malformed');
    }
  }
}

function refineEntities(query: QueryShape, issue: Issue): void {
  const [first, second] = query.entities;
  if (first.branch !== 'driver_a' || second.branch !== 'driver_b') {
    issue('official timing entities must remain question ordered');
  }
  if (first.span.start === second.span.start && first.span.end === second.span.end) {
    issue('official timing drivers must be distinct spans');
  }
  if (first.span.text.toLocaleLowerCase('en-US') === second.span.text.toLocaleLowerCase('en-US')) {
    issue('official timing drivers must be distinct');
  }
}

export type OfficialTimingSemanticQuery = z.infer<typeof officialTimingQuerySchema>;

export interface OfficialTimingSemanticEvidence {
  readonly version: typeof OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION;
  readonly type: 'candidate_set';
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly candidate_set_hash: string;
  readonly candidates: readonly [OfficialTimingSemanticQuery];
}

const activeOfficialTimingEvidence = new WeakSet<object>();

export class OfficialTimingSemanticError extends Error {
  constructor(readonly code: 'catalog_unsupported' | 'question_not_official_timing' | 'evidence_provenance_invalid' | 'evidence_mismatch') {
    super(code);
    this.name = 'OfficialTimingSemanticError';
  }
}

export function buildOfficialTimingSemanticQuery(
  question: OfficialTimingQuestionMatch,
  catalog: SemanticCatalog
): OfficialTimingSemanticQuery {
  requireOfficialTimingCatalog(catalog);
  if (question.type !== 'matched') {
    throw new OfficialTimingSemanticError('question_not_official_timing');
  }
  return officialTimingQuerySchema.parse(deepFreeze(buildQueryShape(question)));
}

function buildQueryShape(question: OfficialTimingQuestionMatch) {
  const aggregation = question.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? 'arithmetic_mean_integer_milliseconds' as const
    : 'median_integer_milliseconds' as const;
  const driverEvidenceA = [question.driver_a];
  const driverEvidenceB = [question.driver_b];
  const eventEvidence = [question.event_span];
  const seasonEvidence = [question.season_span];
  const operationEvidence = [question.operation_span];
  const lapEvidence = question.lap_range === null
    ? null
    : [question.lap_range.start_span, question.lap_range.end_span];
  return {
    version: OFFICIAL_TIMING_SEMANTIC_QUERY_VERSION,
    source_id: OFFICIAL_TIMING_SOURCE_ID,
    metric_id: question.metric_id,
    aggregation,
    topology: 'same_source_scalar_comparison',
    entities: [
      { type: 'driver', branch: 'driver_a', span: question.driver_a },
      { type: 'driver', branch: 'driver_b', span: question.driver_b }
    ],
    scopes: [
      { kind: 'season', concept: 'season', value: 2022, evidence: seasonEvidence },
      { kind: 'round', concept: 'round', value: 14, evidence: eventEvidence },
      { kind: 'session', concept: 'session_type', value: 'R', evidence: eventEvidence },
      { kind: 'event', value: '2022 Belgian Grand Prix', evidence: eventEvidence }
    ],
    filters: [
      { kind: 'entity', concept: 'driver_id', operator: 'eq', branch: 'driver_a', evidence: driverEvidenceA },
      { kind: 'entity', concept: 'driver_id', operator: 'eq', branch: 'driver_b', evidence: driverEvidenceB },
      { kind: 'literal', concept: 'session_type', operator: 'eq', value: 'R', evidence: eventEvidence },
      ...(lapEvidence === null || question.lap_range === null ? [] : [{
        kind: 'literal_range' as const,
        concept: 'lap_number' as const,
        operator: 'range' as const,
        min: question.lap_range.lap_start,
        max: question.lap_range.lap_end,
        evidence: lapEvidence
      }])
    ],
    outputs: [
      { kind: 'aggregate', branch: 'driver_a', function: aggregation, concept: 'lap_time_seconds', evidence: driverEvidenceA },
      { kind: 'aggregate', branch: 'driver_b', function: aggregation, concept: 'lap_time_seconds', evidence: driverEvidenceB }
    ],
    comparison: {
      relation: 'lower',
      delta: 'absolute',
      winner_on_equal: null,
      decimal_scale: 4,
      evidence: operationEvidence
    },
    order_by: [{ output_index: 0, direction: 'asc', nulls: 'last', evidence: operationEvidence }],
    limit: { value: 1, evidence: operationEvidence }
  };
}

export function enumerateOfficialTimingEvidence(
  question: OfficialTimingQuestionMatch,
  catalog: SemanticCatalog
): OfficialTimingSemanticEvidence {
  const query = buildOfficialTimingSemanticQuery(question, catalog);
  const catalogHash = computeSemanticCatalogHash(catalog);
  const evidence: OfficialTimingSemanticEvidence = {
    version: OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION,
    type: 'candidate_set',
    question_sha256: question.question_sha256,
    catalog_hash: catalogHash,
    candidate_set_hash: computeOfficialTimingCandidateSetHash([query], question.question_sha256, catalogHash),
    candidates: [query]
  };
  const frozen = deepFreeze(evidence);
  activeOfficialTimingEvidence.add(frozen);
  return frozen;
}

export function verifyOfficialTimingEvidence(
  input: unknown,
  question: OfficialTimingQuestionMatch,
  catalog: SemanticCatalog
): OfficialTimingSemanticEvidence {
  if (!input || typeof input !== 'object' || !activeOfficialTimingEvidence.has(input)) {
    throw new OfficialTimingSemanticError('evidence_provenance_invalid');
  }
  const reproduced = enumerateOfficialTimingEvidence(question, catalog);
  if (stableSerialize(input) !== stableSerialize(reproduced)) {
    throw new OfficialTimingSemanticError('evidence_mismatch');
  }
  return input as OfficialTimingSemanticEvidence;
}

export function computeOfficialTimingQueryHash(query: OfficialTimingSemanticQuery): string {
  return createHash('sha256').update(stableSerialize(officialTimingQuerySchema.parse(query))).digest('hex');
}

export function computeOfficialTimingCandidateSetHash(
  candidates: readonly OfficialTimingSemanticQuery[],
  questionSha256: string,
  catalogHash: string
): string {
  return createHash('sha256').update(stableSerialize({
    version: OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION,
    question_sha256: questionSha256,
    catalog_hash: catalogHash,
    query_hashes: candidates.map(computeOfficialTimingQueryHash).sort(compareText)
  })).digest('hex');
}

export function computeOfficialTimingEvidenceHash(evidence: OfficialTimingSemanticEvidence): string {
  return createHash('sha256').update(stableSerialize(evidence)).digest('hex');
}

function requireOfficialTimingCatalog(catalog: SemanticCatalog): void {
  let parsed: SemanticCatalog;
  try {
    parsed = parseSemanticCatalog(catalog);
  } catch {
    throw new OfficialTimingSemanticError('catalog_unsupported');
  }
  const source = parsed.sources.find(candidate => candidate.id === OFFICIAL_TIMING_SOURCE_ID);
  if (parsed.version !== 2 || !source ||
      source.governance !== 'certified' || source.family_id !== 'official_historical_laps') {
    throw new OfficialTimingSemanticError('catalog_unsupported');
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing semantic value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
