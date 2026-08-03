import type { AnswerCoverageStatus, AnswerEnvelope, FormattedAnswer } from './answer-format';
import { formatAnswerRows } from './answer-format';
import { authorizeAnswerProgram } from './answer-policy';
import { F1QLProgram } from './ast';
import {
  reviewedFinalStandingsPointsProgramScope,
  ReviewedFinalStandingsDriverIds
} from './final-standings-response-contract';
import { MAX_F1QL_RESPONSE_ROWS } from './limits';
import { normalizeF1QLProgram } from './program-normalization';
import { renderF1QL } from './render';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from './semantic-catalog';
import type { SemanticCatalogSource } from './semantic-catalog';
import type {
  SemanticResultColumn,
  SemanticResultEnvelope,
  SemanticResultScope,
  SemanticResultSourceMetadata
} from './semantic-result-format';
import { SEMANTIC_RESULT_FORMAT_VERSION } from './semantic-result-format';
import { F1QL_DEFINITIONS_VERSION } from './validation';
import {
  F1QL_COMPILER_VERSION,
  F1QL_FACT_SPACE_VERSION,
  getF1QLProgramHash
} from './verified-programs';

export const SEMANTIC_RESPONSE_EQUIVALENCE_VERSION = 'semantic-response-equivalence-v3' as const;

const MAX_EQUIVALENCE_ARRAY_LENGTH = 256;

type FieldDisposition =
  | 'accounted_container'
  | 'canonical_contract'
  | 'lane_provenance'
  | 'lane_version'
  | 'representation_specific'
  | 'semantic_enrichment';

type AnswerMetadata = AnswerEnvelope['metadata'];
type SemanticMetadata = SemanticResultEnvelope['metadata'];
type SemanticAggregation = SemanticMetadata['aggregations'][number];
type SemanticOrdering = SemanticMetadata['ordering'][number];
type SemanticCoverage = SemanticMetadata['coverage'];
type CatalogDimension = SemanticCatalogSource['dimensions'][number];
type CatalogMeasure = SemanticCatalogSource['measures'][number];

export const ANSWER_ENVELOPE_FIELD_ACCOUNTING = deepFreeze({
  mode: 'lane_provenance',
  program: 'lane_provenance',
  program_hash: 'lane_provenance',
  answer: 'canonical_contract',
  rows: 'canonical_contract',
  rendering: 'lane_provenance',
  metadata: 'accounted_container'
} satisfies Record<keyof AnswerEnvelope, FieldDisposition>);

export const ANSWER_METADATA_FIELD_ACCOUNTING = deepFreeze({
  source: 'canonical_contract',
  definitions_version: 'lane_version',
  compiler_version: 'lane_version',
  fact_space_version: 'lane_version',
  coverage: 'canonical_contract',
  caveats: 'canonical_contract'
} satisfies Record<keyof AnswerMetadata, FieldDisposition>);

export const SEMANTIC_ENVELOPE_FIELD_ACCOUNTING = deepFreeze({
  mode: 'lane_provenance',
  format_version: 'lane_version',
  proof_hash: 'lane_provenance',
  planned_f1ql_hash: 'lane_provenance',
  core_hash: 'lane_provenance',
  answer: 'canonical_contract',
  rows: 'canonical_contract',
  metadata: 'accounted_container'
} satisfies Record<keyof SemanticResultEnvelope, FieldDisposition>);

export const SEMANTIC_METADATA_FIELD_ACCOUNTING = deepFreeze({
  catalog_hash: 'lane_version',
  columns: 'canonical_contract',
  scope: 'canonical_contract',
  sources: 'canonical_contract',
  aggregations: 'representation_specific',
  ordering: 'canonical_contract',
  coverage: 'canonical_contract',
  caveats: 'canonical_contract',
  advisories: 'semantic_enrichment'
} satisfies Record<keyof SemanticMetadata, FieldDisposition>);

export const SEMANTIC_COLUMN_FIELD_ACCOUNTING = deepFreeze({
  id: 'canonical_contract',
  label: 'semantic_enrichment',
  source_id: 'canonical_contract',
  concept_id: 'canonical_contract',
  kind: 'canonical_contract',
  aggregation: 'representation_specific',
  physical_type: 'semantic_enrichment',
  semantic_type: 'semantic_enrichment',
  nullable: 'semantic_enrichment',
  units: 'semantic_enrichment',
  authority: 'semantic_enrichment',
  null_meaning: 'semantic_enrichment'
} satisfies Record<keyof SemanticResultColumn, FieldDisposition>);

export const SEMANTIC_SCOPE_FIELD_ACCOUNTING = deepFreeze({
  source_id: 'canonical_contract',
  concept_id: 'canonical_contract',
  label: 'semantic_enrichment',
  operator: 'canonical_contract',
  values: 'canonical_contract'
} satisfies Record<keyof SemanticResultScope, FieldDisposition>);

export const SEMANTIC_SOURCE_FIELD_ACCOUNTING = deepFreeze({
  id: 'canonical_contract',
  label: 'semantic_enrichment',
  authority: 'semantic_enrichment',
  coverage: 'semantic_enrichment'
} satisfies Record<keyof SemanticResultSourceMetadata, FieldDisposition>);

export const SEMANTIC_SOURCE_AUTHORITY_FIELD_ACCOUNTING = deepFreeze({
  primary: 'semantic_enrichment',
  supplementary: 'semantic_enrichment',
  prohibited_derivations: 'semantic_enrichment'
} satisfies Record<keyof SemanticResultSourceMetadata['authority'], FieldDisposition>);

export const SEMANTIC_SOURCE_COVERAGE_FIELD_ACCOUNTING = deepFreeze({
  observed: 'semantic_enrichment',
  certified: 'semantic_enrichment',
  freshness: 'semantic_enrichment',
  observed_seasons: 'semantic_enrichment',
  certification_class: 'semantic_enrichment',
  freshness_class: 'semantic_enrichment',
  unsupported_ids: 'semantic_enrichment',
  unsupported: 'semantic_enrichment'
} satisfies Record<keyof SemanticResultSourceMetadata['coverage'], FieldDisposition>);

export const SEMANTIC_AGGREGATION_FIELD_ACCOUNTING = deepFreeze({
  output_id: 'representation_specific',
  function: 'representation_specific',
  semantics: 'semantic_enrichment'
} satisfies Record<keyof SemanticAggregation, FieldDisposition>);

export const SEMANTIC_ORDERING_FIELD_ACCOUNTING = deepFreeze({
  output_id: 'canonical_contract',
  direction: 'canonical_contract',
  nulls: 'canonical_contract'
} satisfies Record<keyof SemanticOrdering, FieldDisposition>);

export const SEMANTIC_COVERAGE_FIELD_ACCOUNTING = deepFreeze({
  status: 'canonical_contract',
  rows_returned: 'canonical_contract',
  row_limit: 'canonical_contract'
} satisfies Record<keyof SemanticCoverage, FieldDisposition>);

export interface CanonicalFinalStandingsResponse {
  readonly version: typeof SEMANTIC_RESPONSE_EQUIVALENCE_VERSION;
  readonly overlap_id:
    | 'driver_pair_filtered_final_standings_points'
    | 'single_driver_filtered_final_standings_points'
    | 'unfiltered_final_standings_points';
  readonly source_id: 'driver_standings';
  readonly season: number;
  readonly driver_ids: ReviewedFinalStandingsDriverIds;
  readonly outputs: readonly ['driver_id', 'points'];
  readonly ordering: readonly [{
    readonly output_id: 'driver_id';
    readonly direction: 'asc';
    readonly nulls: 'last';
  }];
  readonly answer: FormattedAnswer;
  readonly rows: ReadonlyArray<Readonly<{ driver_id: string; points: string | null }>>;
  readonly coverage: {
    readonly status: AnswerCoverageStatus;
    readonly rows_returned: number;
    readonly row_limit: 1 | typeof MAX_F1QL_RESPONSE_ROWS;
  };
  readonly caveats: readonly string[];
}

export class SemanticResponseEquivalenceError extends Error {}

export function canonicalizeAnswerFinalStandingsResponse(input: AnswerEnvelope): CanonicalFinalStandingsResponse {
  const envelope = snapshotDataObject(
    input,
    Object.keys(ANSWER_ENVELOPE_FIELD_ACCOUNTING),
    'answer envelope'
  ) as unknown as AnswerEnvelope;
  const metadata = snapshotDataObject(
    envelope.metadata,
    Object.keys(ANSWER_METADATA_FIELD_ACCOUNTING),
    'answer metadata'
  ) as unknown as AnswerMetadata;
  const coverage = snapshotDataObject(
    metadata.coverage,
    ['status', 'rows_returned'],
    'answer coverage'
  ) as unknown as AnswerMetadata['coverage'];
  const program = exactFinalStandingsProgram(envelope.program);
  if (program.root.input.op !== 'filter') {
    throw new SemanticResponseEquivalenceError('Answer program was outside the reviewed standings overlap');
  }
  const scope = reviewedFinalStandingsPointsProgramScope(program);
  if (!scope) {
    throw new SemanticResponseEquivalenceError('Answer program was outside the reviewed standings overlap');
  }
  const rows = canonicalRows(envelope.rows);
  if (envelope.mode !== 'gated_execution' || envelope.program_hash !== getF1QLProgramHash(program) ||
      envelope.rendering !== renderF1QL(program) || metadata.source !== 'final_driver_standings' ||
      metadata.definitions_version !== F1QL_DEFINITIONS_VERSION ||
      metadata.compiler_version !== F1QL_COMPILER_VERSION ||
      metadata.fact_space_version !== F1QL_FACT_SPACE_VERSION || coverage.rows_returned !== rows.length) {
    throw new SemanticResponseEquivalenceError('Answer envelope provenance did not match the reviewed overlap');
  }
  return canonicalResponse(program, rows, envelope.answer, coverage.status, metadata.caveats, scope);
}

export function canonicalizeSemanticFinalStandingsResponse(
  input: SemanticResultEnvelope
): CanonicalFinalStandingsResponse {
  if (!Object.isFrozen(input)) {
    throw new SemanticResponseEquivalenceError('Semantic envelope provenance did not match the reviewed overlap');
  }
  const envelope = snapshotDataObject(
    input,
    Object.keys(SEMANTIC_ENVELOPE_FIELD_ACCOUNTING),
    'semantic envelope'
  ) as unknown as SemanticResultEnvelope;
  const metadata = snapshotDataObject(
    envelope.metadata,
    Object.keys(SEMANTIC_METADATA_FIELD_ACCOUNTING),
    'semantic metadata'
  ) as unknown as SemanticMetadata;
  const coverage = snapshotDataObject(
    metadata.coverage,
    Object.keys(SEMANTIC_COVERAGE_FIELD_ACCOUNTING),
    'semantic coverage'
  ) as unknown as SemanticCoverage;
  if (envelope.mode !== 'proven_semantic_result' || envelope.format_version !== SEMANTIC_RESULT_FORMAT_VERSION ||
      metadata.catalog_hash !== SEMANTIC_CATALOG_HASH ||
      ![envelope.proof_hash, envelope.planned_f1ql_hash, envelope.core_hash].every(isSha256)) {
    throw new SemanticResponseEquivalenceError('Semantic envelope provenance did not match the reviewed overlap');
  }
  const scope = assertSemanticContractMetadata(metadata);
  const rows = canonicalRows(envelope.rows);
  const rowLimit = responseRowLimit(scope.driver_ids);
  if (coverage.rows_returned !== rows.length || coverage.row_limit !== rowLimit) {
    throw new SemanticResponseEquivalenceError('Semantic coverage did not match the reviewed overlap');
  }
  return canonicalResponse(
    finalStandingsProgram(scope),
    rows,
    envelope.answer,
    coverage.status,
    metadata.caveats,
    scope
  );
}

function canonicalResponse(
  program: F1QLProgram,
  rows: ReadonlyArray<Readonly<{ driver_id: string; points: string | null }>>,
  answer: FormattedAnswer,
  coverage: AnswerCoverageStatus,
  caveats: readonly string[],
  scope: { readonly season: number; readonly driver_ids: ReviewedFinalStandingsDriverIds }
): CanonicalFinalStandingsResponse {
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') {
    throw new SemanticResponseEquivalenceError('Canonical standings program was not authorized');
  }
  const hasMoreRows = coverage === 'possibly_truncated';
  const formatted = formatAnswerRows(
    program,
    decision.capability,
    rows.map(row => ({ ...row })),
    { row_limit: MAX_F1QL_RESPONSE_ROWS, has_more_rows: hasMoreRows }
  );
  if (!safeEqual(answer, formatted.answer, 'answer') || coverage !== formatted.coverage ||
      !safeEqual(caveats, formatted.caveats, 'caveats')) {
    throw new SemanticResponseEquivalenceError('Response fields did not match the reviewed standings contract');
  }
  if (scope.driver_ids.length > 0 &&
      (rows.length !== scope.driver_ids.length ||
        rows.some((row, index) => row.driver_id !== scope.driver_ids[index]) ||
        coverage !== 'sufficient')) {
    throw new SemanticResponseEquivalenceError('Filtered response did not match its reviewed driver scope');
  }
  let overlapId: CanonicalFinalStandingsResponse['overlap_id'] = 'unfiltered_final_standings_points';
  if (scope.driver_ids.length === 1) {overlapId = 'single_driver_filtered_final_standings_points';}
  else if (scope.driver_ids.length === 2) {overlapId = 'driver_pair_filtered_final_standings_points';}
  return deepFreeze({
    version: SEMANTIC_RESPONSE_EQUIVALENCE_VERSION,
    overlap_id: overlapId,
    source_id: 'driver_standings' as const,
    season: scope.season,
    driver_ids: scope.driver_ids,
    outputs: ['driver_id', 'points'] as const,
    ordering: [{ output_id: 'driver_id' as const, direction: 'asc' as const, nulls: 'last' as const }],
    answer: formatted.answer,
    rows: rows.map(row => ({ ...row })),
    coverage: {
      status: formatted.coverage,
      rows_returned: rows.length,
      row_limit: responseRowLimit(scope.driver_ids)
    },
    caveats: [...formatted.caveats]
  });
}

function exactFinalStandingsProgram(input: F1QLProgram): F1QLProgram & {
  root: Extract<F1QLProgram['root'], { op: 'aggregate' }>;
} {
  const normalized = normalizeF1QLProgram(snapshotJsonValue(input, 'answer program', new Set()));
  if (!reviewedFinalStandingsPointsProgramScope(normalized)) {
    throw new SemanticResponseEquivalenceError('Answer program was outside the reviewed standings overlap');
  }
  return normalized as F1QLProgram & { root: Extract<F1QLProgram['root'], { op: 'aggregate' }> };
}

function finalStandingsProgram(scope: {
  readonly season: number;
  readonly driver_ids: ReviewedFinalStandingsDriverIds;
}): F1QLProgram {
  if (!Number.isSafeInteger(scope.season) ||
      scope.driver_ids.some((id, index) => !isCanonicalDriverId(id) ||
        (index > 0 && compareText(scope.driver_ids[index - 1], id) >= 0))) {
    throw new SemanticResponseEquivalenceError('Semantic season was invalid');
  }
  return {
    version: 1,
    root: {
      op: 'aggregate',
      input: {
        op: 'filter',
        input: { op: 'source', source: 'standings' },
        where: {
          season: scope.season,
          ...(scope.driver_ids.length > 0 ? { driver_id: [...scope.driver_ids] } : {})
        }
      },
      group_by: ['driver_id'],
      measures: [{ as: 'points', function: 'max', field: 'points' }]
    }
  };
}

// Keep all canonical metadata exclusions in one fail-closed gate.
// eslint-disable-next-line complexity
function assertSemanticContractMetadata(metadata: SemanticMetadata): {
  readonly season: number;
  readonly driver_ids: ReviewedFinalStandingsDriverIds;
} {
  const columns = snapshotDataArray(metadata.columns, 'semantic columns');
  const scopes = snapshotDataArray(metadata.scope, 'semantic scopes');
  const sources = snapshotDataArray(metadata.sources, 'semantic sources');
  const aggregations = snapshotDataArray(metadata.aggregations, 'semantic aggregations');
  const orderings = snapshotDataArray(metadata.ordering, 'semantic ordering');
  const advisories = snapshotDataArray(metadata.advisories, 'semantic advisories');
  if (columns.length !== 2 || ![1, 2].includes(scopes.length) || sources.length !== 1 ||
      aggregations.length !== 0 || orderings.length !== 1) {
    throw new SemanticResponseEquivalenceError('Semantic metadata was outside the reviewed standings overlap');
  }
  const catalogSource = SEMANTIC_CATALOG.sources.find(source => source.id === 'driver_standings');
  const driverConcept = catalogSource?.dimensions.find(concept => concept.id === 'driver_id');
  const pointsConcept = catalogSource?.measures.find(concept => concept.id === 'points');
  if (!catalogSource || !driverConcept || !pointsConcept) {
    throw new SemanticResponseEquivalenceError('Active catalog lacked the reviewed standings contract');
  }
  assertSemanticColumns(columns, catalogSource, driverConcept, pointsConcept);
  const seasonScopes = scopes.filter(scope => semanticScopeConcept(scope) === 'season');
  const driverScopes = scopes.filter(scope => semanticScopeConcept(scope) === 'driver_id');
  if (seasonScopes.length !== 1 || driverScopes.length > 1 || seasonScopes.length + driverScopes.length !== scopes.length) {
    throw new SemanticResponseEquivalenceError('Semantic metadata was outside the reviewed standings overlap');
  }
  const season = semanticSeason(seasonScopes[0]);
  const driverIds: ReviewedFinalStandingsDriverIds = driverScopes.length === 1
    ? semanticDriver(driverScopes[0])
    : [];
  assertSemanticSource(sources[0], catalogSource);
  assertSemanticOrdering(orderings[0]);
  assertSemanticAdvisories(advisories, catalogSource, driverConcept, pointsConcept);
  return { season, driver_ids: driverIds };
}

function assertSemanticColumns(
  columns: readonly unknown[],
  catalogSource: SemanticCatalogSource,
  driverConcept: CatalogDimension,
  pointsConcept: CatalogMeasure
): void {
  const driver = snapshotDataObject(
    columns[0],
    Object.keys(SEMANTIC_COLUMN_FIELD_ACCOUNTING),
    'semantic driver column'
  );
  const points = snapshotDataObject(
    columns[1],
    Object.keys(SEMANTIC_COLUMN_FIELD_ACCOUNTING),
    'semantic points column'
  );
  const expectedDriver = {
    id: 'driver_id', label: 'driver', source_id: 'driver_standings', concept_id: 'driver_id',
    kind: 'dimension', aggregation: null, physical_type: driverConcept.physical_type,
    semantic_type: driverConcept.semantic_type, nullable: driverConcept.nullable, units: driverConcept.units,
    authority: catalogSource.authority.primary, null_meaning: driverConcept.null_meaning
  };
  const expectedPoints = {
    id: 'points', label: 'championship points', source_id: 'driver_standings', concept_id: 'points',
    kind: 'measure', aggregation: null, physical_type: pointsConcept.physical_type,
    semantic_type: pointsConcept.semantic_type, nullable: pointsConcept.nullable, units: pointsConcept.units,
    authority: pointsConcept.authority, null_meaning: pointsConcept.null_meaning
  };
  if (!safeEqual(driver, expectedDriver, 'semantic driver column') ||
      !safeEqual(points, expectedPoints, 'semantic points column')) {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
}

function semanticSeason(scopeInput: unknown): number {
  const scope = snapshotDataObject(
    scopeInput,
    Object.keys(SEMANTIC_SCOPE_FIELD_ACCOUNTING),
    'semantic scope'
  );
  const scopeValues = snapshotDataArray(scope.values, 'semantic scope values');
  if (scope.source_id !== 'driver_standings' || scope.concept_id !== 'season' || scope.label !== 'season' ||
      scope.operator !== 'eq' || scopeValues.length !== 1 || !Number.isSafeInteger(scopeValues[0])) {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
  return scopeValues[0] as number;
}

function semanticDriver(scopeInput: unknown): readonly [string] | readonly [string, string] {
  const scope = snapshotDataObject(
    scopeInput,
    Object.keys(SEMANTIC_SCOPE_FIELD_ACCOUNTING),
    'semantic scope'
  );
  const scopeValues = snapshotDataArray(scope.values, 'semantic scope values');
  const singleton = scope.operator === 'eq' && scopeValues.length === 1;
  const pair = scope.operator === 'in' && scopeValues.length === 2;
  if (scope.source_id !== 'driver_standings' || scope.concept_id !== 'driver_id' || scope.label !== 'driver' ||
      (!singleton && !pair) || scopeValues.some(value => !isCanonicalDriverId(value)) ||
      (pair && compareText(scopeValues[0] as string, scopeValues[1] as string) >= 0)) {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
  return [...scopeValues] as unknown as readonly [string] | readonly [string, string];
}

function semanticScopeConcept(scopeInput: unknown): unknown {
  if (!scopeInput || typeof scopeInput !== 'object' || Array.isArray(scopeInput)) {return undefined;}
  const descriptor = Object.getOwnPropertyDescriptor(scopeInput, 'concept_id');
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function assertSemanticSource(sourceInput: unknown, catalogSource: SemanticCatalogSource): void {
  const source = snapshotDataObject(
    sourceInput,
    Object.keys(SEMANTIC_SOURCE_FIELD_ACCOUNTING),
    'semantic source'
  );
  const authority = snapshotDataObject(
    source.authority,
    Object.keys(SEMANTIC_SOURCE_AUTHORITY_FIELD_ACCOUNTING),
    'semantic authority'
  );
  const sourceCoverage = snapshotDataObject(
    source.coverage,
    Object.keys(SEMANTIC_SOURCE_COVERAGE_FIELD_ACCOUNTING),
    'semantic source coverage'
  );
  if (source.id !== 'driver_standings' || source.label !== 'driver standings' ||
      !safeEqual(authority, catalogSource.authority, 'semantic authority') ||
      !safeEqual(sourceCoverage, catalogSource.coverage, 'semantic source coverage')) {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
}

function assertSemanticOrdering(orderingInput: unknown): void {
  const ordering = snapshotDataObject(
    orderingInput,
    Object.keys(SEMANTIC_ORDERING_FIELD_ACCOUNTING),
    'semantic ordering'
  );
  if (ordering.output_id !== 'driver_id' || ordering.direction !== 'asc' || ordering.nulls !== 'last') {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
}

function assertSemanticAdvisories(
  advisories: readonly unknown[],
  catalogSource: SemanticCatalogSource,
  driverConcept: CatalogDimension,
  pointsConcept: CatalogMeasure
): void {
  const expectedAdvisories = unique([
    ...catalogSource.authority.prohibited_derivations,
    ...catalogSource.coverage.unsupported,
    ...catalogSource.language.forbidden_conflations,
    ...(catalogSource.scope.current_semantics === null ? [] : [catalogSource.scope.current_semantics]),
    ...(driverConcept.language?.forbidden_conflations ?? []),
    ...(pointsConcept.nullable ? [pointsConcept.null_meaning] : []),
    ...(pointsConcept.language?.forbidden_conflations ?? [])
  ]);
  if (!safeEqual(advisories, expectedAdvisories, 'semantic advisories')) {
    throw new SemanticResponseEquivalenceError('Semantic metadata did not match the reviewed standings contract');
  }
}

function canonicalRows(
  input: ReadonlyArray<Readonly<Record<string, unknown>>>
): ReadonlyArray<Readonly<{ driver_id: string; points: string | null }>> {
  const values = snapshotDataArray(input, 'response rows', MAX_F1QL_RESPONSE_ROWS);
  const rows = values.map((value, index) => {
    const row = snapshotDataObject(value, ['driver_id', 'points'], `response row ${index}`);
    if (typeof row.driver_id !== 'string' || row.driver_id.trim().length === 0 ||
        Buffer.from(row.driver_id, 'utf8').toString('utf8') !== row.driver_id ||
        !(row.points === null || (typeof row.points === 'string' && /^-?\d+(?:\.\d+)?$/u.test(row.points)))) {
      throw new SemanticResponseEquivalenceError(`Response row ${index} was invalid`);
    }
    return { driver_id: row.driver_id, points: row.points };
  });
  for (let index = 1; index < rows.length; index += 1) {
    if (Buffer.compare(Buffer.from(rows[index - 1].driver_id, 'utf8'), Buffer.from(rows[index].driver_id, 'utf8')) >= 0) {
      throw new SemanticResponseEquivalenceError('Response rows did not preserve canonical C ordering');
    }
  }
  return rows;
}

function snapshotDataObject(input: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new SemanticResponseEquivalenceError(`${label} was not a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string') || !sameStrings((keys as string[]).sort(), [...expectedKeys].sort()) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
    throw new SemanticResponseEquivalenceError(`${label} fields were invalid`);
  }
  return Object.fromEntries(expectedKeys.map(key => [key, descriptors[key].value]));
}

function snapshotDataArray(
  input: unknown,
  label: string,
  maxLength = MAX_EQUIVALENCE_ARRAY_LENGTH
): unknown[] {
  const length = boundedArrayLength(input, label, maxLength);
  const array = input as unknown[];
  const descriptors = Object.getOwnPropertyDescriptors(array) as unknown as Record<PropertyKey, PropertyDescriptor | undefined>;
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), 'length'];
  const keys = Reflect.ownKeys(array);
  if (keys.some(key => typeof key !== 'string') || !sameStrings((keys as string[]).sort(), expectedKeys.sort())) {
    throw new SemanticResponseEquivalenceError(`${label} fields were invalid`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new SemanticResponseEquivalenceError(`${label} entries were invalid`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function boundedArrayLength(input: unknown, label: string, maxLength: number): number {
  if (!Array.isArray(input)) {
    throw new SemanticResponseEquivalenceError(`${label} was not an array`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new SemanticResponseEquivalenceError(`${label} length was invalid`);
  }
  return length;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function responseRowLimit(driverIds: ReviewedFinalStandingsDriverIds): 1 | typeof MAX_F1QL_RESPONSE_ROWS {
  return driverIds.length === 1 ? 1 : MAX_F1QL_RESPONSE_ROWS;
}

function isCanonicalDriverId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function safeEqual(left: unknown, right: unknown, label: string): boolean {
  return JSON.stringify(snapshotJsonValue(left, label, new Set())) ===
    JSON.stringify(snapshotJsonValue(right, `${label} oracle`, new Set()));
}

function snapshotJsonValue(value: unknown, label: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {return value;}
  if (typeof value === 'number' && Number.isFinite(value)) {return value;}
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new SemanticResponseEquivalenceError(`${label} contained an unsupported value`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotJsonArray(value, label, seen);
    }
    return snapshotJsonObject(value, label, seen);
  } finally {
    seen.delete(value);
  }
}

function snapshotJsonArray(value: unknown[], label: string, seen: Set<object>): unknown[] {
  return snapshotDataArray(value, label).map((child, index) =>
    snapshotJsonValue(child, `${label}[${index}]`, seen));
}

function snapshotJsonObject(value: object, label: string, seen: Set<object>): Record<string, unknown> {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SemanticResponseEquivalenceError(`${label} contained a non-plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
    throw new SemanticResponseEquivalenceError(`${label} fields were invalid`);
  }
  return Object.fromEntries((keys as string[]).sort().map(key => [
    key,
    snapshotJsonValue(descriptors[key].value, `${label}.${key}`, seen)
  ]));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
  }
  return value;
}
