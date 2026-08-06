import type {
  PlannedCorePredicate,
  PlannedCoreProjectNode,
  PlannedCoreProjectOutput,
  PlannedCoreSortKey
} from './core';
import { buildAnswerEnvelope } from './answer-format';
import type { AnswerCoverageStatus, AnswerEnvelope, FormattedAnswer } from './answer-format';
import { serializeAnswerResponse } from './answer-bounds';
import { authorizeAnswerProgram } from './answer-policy';
import { materializeAnswerTemplate } from './answer-templates';
import { MAX_F1QL_RESPONSE_ROWS } from './limits';
import { PLANNED_INTEGRITY_FIELD } from './planned-compiler';
import { getSemanticPlanProofParent } from './semantic-plan-proof';
import type { VerifiedSemanticPlanProof } from './semantic-plan-proof';
import { SEMANTIC_CATALOG } from './semantic-catalog';
import type { SemanticCatalogSource } from './semantic-catalog';
import { getSemanticPlanExecutionResultBinding } from './semantic-plan-execution';
import { finalStandingsRowsResponseContract } from './final-standings-response-contract';
import type { ReviewedFinalStandingsDriverIds } from './final-standings-response-contract';
export { SEMANTIC_ANSWER_COMPATIBILITY_VERSION } from './semantic-answer-compatibility-version';

export const SEMANTIC_RESULT_FORMAT_VERSION = 'semantic-result-format-v30' as const;

type CatalogConcept = SemanticCatalogSource['dimensions'][number] | SemanticCatalogSource['measures'][number];
type SemanticExecutionFormattingBinding = ReturnType<typeof getSemanticPlanExecutionResultBinding>;

interface BuiltSemanticPlanResult {
  readonly envelope: SemanticResultEnvelope;
  readonly compatibility: {
    readonly season: number;
    readonly driver_ids: ReviewedFinalStandingsDriverIds;
    readonly rows: Array<Record<string, unknown>>;
  } | null;
}

export interface SemanticResultColumn {
  readonly id: string;
  readonly label: string;
  readonly source_id: string;
  readonly concept_id: string;
  readonly kind: 'dimension' | 'measure' | 'aggregate';
  readonly aggregation: 'count' | 'max' | 'min' | 'sum' | null;
  readonly physical_type: string;
  readonly semantic_type: string;
  readonly nullable: boolean;
  readonly units: string | null;
  readonly authority: string;
  readonly null_meaning: string;
}

export interface SemanticResultScope {
  readonly source_id: string;
  readonly concept_id: string;
  readonly label: string;
  readonly operator: 'eq' | 'in' | 'range';
  readonly values: readonly (string | number | boolean)[];
}

export interface SemanticResultSourceMetadata {
  readonly id: string;
  readonly label: string;
  readonly authority: SemanticCatalogSource['authority'];
  readonly coverage: SemanticCatalogSource['coverage'];
}

export interface SemanticResultEnvelope {
  readonly mode: 'proven_semantic_result';
  readonly format_version: typeof SEMANTIC_RESULT_FORMAT_VERSION;
  readonly proof_hash: string;
  readonly planned_f1ql_hash: string;
  readonly core_hash: string;
  readonly answer: FormattedAnswer;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly metadata: {
    readonly catalog_hash: string;
    readonly columns: readonly SemanticResultColumn[];
    readonly scope: readonly SemanticResultScope[];
    readonly sources: readonly SemanticResultSourceMetadata[];
    readonly aggregations: ReadonlyArray<{
      readonly output_id: string;
      readonly function: 'count' | 'max' | 'min' | 'sum';
      readonly semantics: string;
    }>;
    readonly ordering: ReadonlyArray<{
      readonly output_id: string;
      readonly direction: 'asc' | 'desc';
      readonly nulls: 'first' | 'last';
    }>;
    readonly coverage: {
      readonly status: AnswerCoverageStatus;
      readonly rows_returned: number;
      readonly row_limit: number;
    };
    readonly caveats: readonly string[];
    readonly advisories?: readonly string[];
  };
}

export class SemanticResultFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticResultFormatError';
  }
}

export function formatSemanticPlanResult(
  executionResultInput: unknown
): SemanticResultEnvelope {
  const execution = getSemanticPlanExecutionResultBinding(executionResultInput);
  const built = buildSemanticPlanResult(execution);
  if (Buffer.byteLength(JSON.stringify(built.envelope), 'utf8') > execution.max_response_bytes) {
    throw new SemanticResultFormatError('Semantic result exceeded its authorized response size');
  }
  execution.assert_active();
  return built.envelope;
}

export function formatSemanticPlanResultAsAnswerEnvelope(
  executionResultInput: unknown
): AnswerEnvelope {
  const execution = getSemanticPlanExecutionResultBinding(executionResultInput);
  const built = buildSemanticPlanResult(execution);
  if (built.compatibility === null) {
    throw new SemanticResultFormatError('Semantic result has no reviewed answer-envelope compatibility contract');
  }
  const program = materializeAnswerTemplate('final_standings_points', {
    season: built.compatibility.season,
    ...(built.compatibility.driver_ids.length > 0
      ? { driver_ids: [...built.compatibility.driver_ids] }
      : {})
  });
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') {
    throw new SemanticResultFormatError('Semantic compatibility program was not authorized');
  }
  const envelope = deepFreeze(buildAnswerEnvelope(
    program,
    decision.capability,
    built.compatibility.rows,
    { row_limit: MAX_F1QL_RESPONSE_ROWS, has_more_rows: execution.has_more_rows }
  ));
  serializeAnswerResponse(envelope, execution.max_response_bytes);
  execution.assert_active();
  return envelope;
}

function buildSemanticPlanResult(execution: SemanticExecutionFormattingBinding): BuiltSemanticPlanResult {
  const proofInput = execution.proof;
  const rowsInput = execution.rows;
  const parent = getSemanticPlanProofParent(proofInput);
  const proof = proofInput as VerifiedSemanticPlanProof;
  if (!Array.isArray(rowsInput)) {
    throw new SemanticResultFormatError('Semantic result rows must be an array');
  }
  const rowCount = rowsInput.length;
  if (!Number.isSafeInteger(rowCount) || rowCount > parent.core_program.root.count) {
    throw new SemanticResultFormatError('Semantic result exceeded its proven row limit');
  }
  for (let index = 0; index < rowCount; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rowsInput, index)) {
      throw new SemanticResultFormatError('Semantic result rows must be a dense array');
    }
  }

  const core = parent.core_program;
  const project = core.root.input.input;
  const branches = inputBranches(project.input);
  const sources = branches.map(branch => sourceFor(branch.input.source_id));
  const columns = project.outputs.map(output => describeOutput(output, project.input));
  const classificationCollectionContract = isClassificationSelectionContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  ) || isClassificationPositionRankingContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (classificationCollectionContract && execution.has_more_rows) {
    throw new SemanticResultFormatError('Classification result collection evidence was incomplete');
  }
  const selectedClassificationMetadataContract = isSelectedClassificationMetadataContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (selectedClassificationMetadataContract && execution.has_more_rows) {
    throw new SemanticResultFormatError('Selected classification metadata result collection evidence was incomplete');
  }
  const classificationScalarCountContract = isClassificationPositionScalarCountContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (classificationScalarCountContract && execution.has_more_rows) {
    throw new SemanticResultFormatError('Classification count result collection evidence was incomplete');
  }
  const classificationCountRankingContract = isClassificationPositionCountRankingContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  const selectedClassificationPositionCountContract = isSelectedClassificationPositionCountContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (selectedClassificationPositionCountContract && execution.has_more_rows) {
    throw new SemanticResultFormatError('Selected classification count result collection evidence was incomplete');
  }
  const unfilteredRacePositionCountContract = isUnfilteredRacePositionCountContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (unfilteredRacePositionCountContract && execution.has_more_rows) {
    throw new SemanticResultFormatError('Unfiltered race count result collection evidence was incomplete');
  }
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(validateRow(rowsInput[index], index, columns, project.outputs));
  }
  if (unfilteredRacePositionCountContract && rows.some(row => !isCanonicalDriverId(row.driver_id))) {
    throw new SemanticResultFormatError('Unfiltered race count result contained a noncanonical driver identifier');
  }

  if (project.output_grain.length === 0 && rows.length !== 1) {
    throw new SemanticResultFormatError('Scalar semantic results require exactly one row');
  }
  validateProjectedPredicates(rows, project.outputs, branches);
  validateRelationshipOutputs(rows, project.outputs, project.input);
  validateUniqueGrain(rows, project.output_grain);
  validateOrdering(rows, core.root.input.keys);
  if (classificationCollectionContract && rows.length === 0) {
    throw new SemanticResultFormatError('Classification result collection evidence was incomplete');
  }
  if (classificationCountRankingContract && rows.length === 0) {
    throw new SemanticResultFormatError('Classification count ranking source evidence was incomplete');
  }
  if (selectedClassificationPositionCountContract && rows.length !== requestedDriverRowCount(branches)) {
    throw new SemanticResultFormatError('Selected classification count result collection evidence was incomplete');
  }
  if (unfilteredRacePositionCountContract && rows.length === 0) {
    throw new SemanticResultFormatError('Unfiltered race count source evidence was incomplete');
  }
  if (selectedClassificationMetadataContract && rows.length !== requestedDriverRowCount(branches)) {
    throw new SemanticResultFormatError('Selected classification metadata result collection evidence was incomplete');
  }
  if (isEventScalarSelectionContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  ) && execution.has_more_rows) {
    throw new SemanticResultFormatError('Event metadata scalar result collection evidence was incomplete');
  }

  const standingsPositionRanking = isFinalStandingsPositionRankingContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  const standingsPositionSelection = isFinalStandingsPositionSelectionContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  ) || isFinalStandingsPositionAndPointsSelectionContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  );
  if (standingsPositionSelection && execution.has_more_rows) {
    throw new SemanticResultFormatError('Final standings position result collection evidence was incomplete');
  }
  if (standingsPositionSelection && rows.length !== requestedDriverRowCount(branches)) {
    throw new SemanticResultFormatError('Final standings position result collection evidence was incomplete');
  }
  if (standingsPositionRanking) {
    validateFinalStandingsPositionRanking(rows);
  }
  const qualifyingPositionRanking = isClassificationPositionRankingContract(
    core.root.count, core.root.input.keys, project, branches, sources, columns
  ) && sources[0]?.id === 'qualifying_classification';
  if (qualifyingPositionRanking) {
    validateQualifyingPositionRanking(rows);
  }
  let finalStandingsContract;
  if (isFinalStandingsPointsContract(sources, columns, project.output_grain) || standingsPositionRanking) {
    try {
      finalStandingsContract = finalStandingsRowsResponseContract(rows.length, {
        row_limit: core.root.count,
        has_more_rows: execution.has_more_rows
      }, requestedDriverRowCount(branches));
    } catch {
      throw new SemanticResultFormatError('Final standings result collection evidence was invalid');
    }
  }
  let coverage: AnswerCoverageStatus = finalStandingsContract?.coverage ?? 'sufficient';
  if (!finalStandingsContract && rows.length === 0) {coverage = 'empty';}
  else if (!finalStandingsContract && execution.has_more_rows && !classificationCountRankingContract) {
    coverage = 'possibly_truncated';
  }
  const scope = branches.flatMap(branch => branch.predicates.map(predicate => describeScope(predicate)));
  const catalogCaveats = unique(sources.flatMap(source => [
    ...source.authority.prohibited_derivations,
    ...source.coverage.unsupported,
    ...source.language.forbidden_conflations,
    ...(source.scope.current_semantics === null ? [] : [source.scope.current_semantics])
  ]).concat(columns.flatMap(column => {
    const concept = conceptFor(sourceFor(column.source_id), column.concept_id);
    return [
      ...(column.nullable ? [column.null_meaning] : []),
      ...(concept.language?.forbidden_conflations ?? [])
    ];
  })));
  const caveats = finalStandingsContract ? [...finalStandingsContract.caveats] : catalogCaveats;
  if (!finalStandingsContract && coverage === 'empty') {
    caveats.unshift('Empty output is unavailable data, not a factual zero.');
  }
  if (!finalStandingsContract && coverage === 'possibly_truncated') {
    caveats.unshift(`Output exceeded the proven ${core.root.count}-row response limit.`);
  }

  const displayedRows = rows.map(row => Object.fromEntries(columns.map(column => [
    column.id,
    displayValue(row[column.id], column)
  ])));
  const subjectColumn = columns.find(column => ['circuit_id', 'driver_id', 'event_id', 'team_id'].includes(column.semantic_type))
    ?? columns.find(column => project.output_grain.includes(column.id));
  const facts = displayedRows.map((row, index) => {
    const subjectValue = subjectColumn ? row[subjectColumn.id] : null;
    const subject = subjectValue === null ? `result ${index + 1}` : subjectValue;
    return {
      subject,
      values: Object.fromEntries(columns.filter(column =>
        column.id !== subjectColumn?.id || subjectValue === null
      ).map(column => [column.id, row[column.id]]))
    };
  });
  const answer: FormattedAnswer = rows.length === 0
    ? { headline: 'No matching source rows were available.', facts: [] }
    : { headline: headlineFor(sources, scope), facts };

  const envelope = deepFreeze({
    mode: 'proven_semantic_result' as const,
    format_version: SEMANTIC_RESULT_FORMAT_VERSION,
    proof_hash: proof.proof_hash,
    planned_f1ql_hash: parent.program_hash,
    core_hash: parent.core_hash,
    answer,
    rows: rows.map(row => Object.fromEntries(columns.map(column => [column.id, row[column.id]]))),
    metadata: {
      catalog_hash: proof.catalog_hash,
      columns,
      scope,
      sources: sources.map(source => ({
        id: source.id,
        label: labelFor(source.id, source.language),
        authority: source.authority,
        coverage: source.coverage
      })),
      aggregations: columns.flatMap(column => column.aggregation === null ? [] : [{
        output_id: column.id,
        function: column.aggregation,
        semantics: aggregationSemantics(column.aggregation, column.label)
      }]),
      ordering: core.root.input.keys.map(key => ({
        output_id: key.output_id,
        direction: key.direction,
        nulls: key.nulls
      })),
      coverage: { status: coverage, rows_returned: rows.length, row_limit: core.root.count },
      caveats,
      ...(finalStandingsContract ? { advisories: catalogCaveats } : {})
    }
  });
  const compatibilityScope = finalStandingsCompatibilityScope(
    core.root.count,
    core.root.input.keys,
    project,
    branches,
    sources,
    columns
  );
  return {
    envelope,
    compatibility: compatibilityScope === null ? null : {
      season: compatibilityScope.season,
      driver_ids: compatibilityScope.driver_ids,
      rows: rows.map(row => Object.fromEntries(columns.map(column => [column.id, row[column.id]])))
    }
  };
}

function describeOutput(
  output: PlannedCoreProjectOutput,
  input: Parameters<typeof inputBranches>[0]
): SemanticResultColumn {
  let sourceId: string;
  let conceptId: string;
  let aggregation: SemanticResultColumn['aggregation'] = null;
  if (output.kind === 'concept') {
    sourceId = output.concept.source_id;
    conceptId = output.concept.concept_id;
  } else {
    let measure;
    if (input.op === 'compose') {
      measure = input.inputs.find(candidate => candidate.input.op === 'filter' &&
        candidate.input.input.source_id === (output.kind === 'composed_aggregate' ? output.source_id : undefined))
        ?.measures.find(candidate => candidate.as === output.measure_as);
    } else if (input.op === 'aggregate') {
      measure = input.measures.find(candidate => candidate.as === output.measure_as);
    }
    if (!measure) {throw new SemanticResultFormatError(`Missing proven aggregate origin for ${output.as}`);}
    sourceId = measure.source_id;
    conceptId = measure.concept_id;
    aggregation = measure.function;
  }
  const source = sourceFor(sourceId);
  const concept = conceptFor(source, conceptId);
  const isDimension = source.dimensions.some(candidate => candidate.id === conceptId);
  const physicalType = output.kind === 'concept' ? output.concept.physical_type : output.physical_type;
  const semanticType = output.kind === 'concept' ? output.concept.semantic_type : output.semantic_type;
  const nullable = output.kind === 'concept' ? output.concept.nullable : output.nullable;
  const conceptLabel = labelFor(concept.id, concept.language);
  let kind: SemanticResultColumn['kind'] = isDimension ? 'dimension' : 'measure';
  if (aggregation !== null) {kind = 'aggregate';}
  return {
    id: output.as,
    label: aggregation === null ? conceptLabel : `${aggregation} of ${conceptLabel}`,
    source_id: sourceId,
    concept_id: conceptId,
    kind,
    aggregation,
    physical_type: physicalType,
    semantic_type: semanticType,
    nullable,
    units: aggregation === 'count' ? 'count' : concept.units,
    authority: 'authority' in concept ? concept.authority : source.authority.primary,
    null_meaning: aggregation === 'count' ? 'Count is zero when no non-null input values match the proven scope.' : concept.null_meaning
  };
}

function validateRow(
  input: unknown,
  index: number,
  columns: readonly SemanticResultColumn[],
  outputs: readonly PlannedCoreProjectOutput[]
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new SemanticResultFormatError(`Semantic result row ${index} is not a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string') ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
    throw new SemanticResultFormatError(`Semantic result row ${index} has an invalid property shape`);
  }
  const expected = [...columns.map(column => column.id), PLANNED_INTEGRITY_FIELD].sort(compareText);
  const actual = Object.keys(input).sort(compareText);
  if (!sameStrings(actual, expected)) {
    throw new SemanticResultFormatError(`Semantic result row ${index} did not match the proven schema`);
  }
  const row = Object.fromEntries(expected.map(key => [key, descriptors[key].value])) as Record<string, unknown>;
  if (row[PLANNED_INTEGRITY_FIELD] !== true) {
    throw new SemanticResultFormatError(`Semantic result row ${index} failed source integrity`);
  }
  for (const column of columns) {
    row[column.id] = validateValue(row[column.id], column, outputs.find(output => output.as === column.id)!);
  }
  return row;
}

function validateValue(value: unknown, column: SemanticResultColumn, output: PlannedCoreProjectOutput): unknown {
  if (value === null) {
    if (!column.nullable) {throw new SemanticResultFormatError(`Semantic result field ${column.id} cannot be null`);}
    return null;
  }
  if (column.physical_type === 'boolean' && typeof value !== 'boolean') {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be boolean`);
  }
  if (column.physical_type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be a safe integer`);
  }
  if (column.physical_type === 'numeric' && (typeof value !== 'string' || decimalParts(value) === null)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be an exact decimal string`);
  }
  if (column.physical_type === 'text' && (typeof value !== 'string' || !isWellFormedText(value))) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be text`);
  }
  if (column.physical_type === 'date' && !((typeof value === 'string' && isIsoDate(value)) ||
      (value instanceof Date && !Number.isNaN(value.valueOf())))) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be an ISO date`);
  }
  if (['circuit_id', 'driver_id', 'event_id', 'status', 'team_id'].includes(column.semantic_type) &&
      (typeof value !== 'string' || value.trim().length === 0)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be nonempty`);
  }
  if (column.source_id === 'event_metadata' && column.concept_id === 'event_name' &&
      (typeof value !== 'string' || value.trim().length === 0)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be nonempty`);
  }
  if (column.aggregation === 'count' && (typeof value !== 'number' || value < 0)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be a nonnegative count`);
  }
  if (column.semantic_type === 'duration_ms' && (typeof value !== 'number' || value < 0)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be a nonnegative duration`);
  }
  if (column.semantic_type === 'round' && (typeof value !== 'number' || value < 1 || value > 30)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} is outside round bounds`);
  }
  const source = sourceFor(column.source_id);
  if (column.semantic_type === 'season' && (typeof value !== 'number' ||
      (source.scope.season_min !== null && value < source.scope.season_min) ||
      (source.scope.season_max !== null && value > source.scope.season_max))) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} is outside source season coverage`);
  }
  if (column.semantic_type === 'position') {
    const bounds = source.integrity.position_bounds.find(candidate => candidate.measure_id === column.concept_id);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || !bounds || value < bounds.min ||
        (bounds.max !== null && value > bounds.max)) {
      throw new SemanticResultFormatError(`Semantic result field ${column.id} is outside position bounds`);
    }
  }
  if (output.kind === 'concept') {
    const concept = conceptFor(source, output.concept.concept_id);
    if ('allowed_values' in concept && concept.allowed_values.length > 0 && !concept.allowed_values.includes(String(value))) {
      throw new SemanticResultFormatError(`Semantic result field ${column.id} has an unsupported value`);
    }
  }
  if (!(value instanceof Date)) {return value;}
  if (value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0 || value.getMilliseconds() !== 0) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be a date-only value`);
  }
  const normalizedDate = `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  if (!isIsoDate(normalizedDate)) {
    throw new SemanticResultFormatError(`Semantic result field ${column.id} must be an ISO date`);
  }
  return normalizedDate;
}

function validateProjectedPredicates(
  rows: readonly Record<string, unknown>[],
  outputs: readonly PlannedCoreProjectOutput[],
  branches: ReturnType<typeof inputBranches>
): void {
  for (const output of outputs) {
    if (output.kind !== 'concept') {continue;}
    const branch = branches.find(candidate => candidate.input.source_id === output.concept.source_id);
    const predicate = branch?.predicates.find(candidate => candidate.concept.concept_id === output.concept.concept_id);
    if (!predicate) {continue;}
    const values = rows.map(row => row[output.as]);
    if (values.some(value => !matchesPredicate(value, predicate))) {
      throw new SemanticResultFormatError(`Semantic result field ${output.as} was substituted outside its proven predicate`);
    }
    const requiresCompleteMembership = ['circuit_id', 'driver_id', 'event_id', 'position', 'team_id']
      .includes(predicate.concept.semantic_type);
    let expectedValues: readonly (string | number | boolean)[] = [];
    if (predicate.operator === 'eq') {expectedValues = [predicate.value];}
    else if (predicate.operator === 'in' && requiresCompleteMembership) {expectedValues = predicate.values;}
    if (expectedValues.some(value => !values.includes(value))) {
      throw new SemanticResultFormatError(`Semantic result field ${output.as} was partial for its proven predicate`);
    }
  }
}

function validateRelationshipOutputs(
  rows: readonly Record<string, unknown>[],
  outputs: readonly PlannedCoreProjectOutput[],
  input: Parameters<typeof inputBranches>[0]
): void {
  if (input.op !== 'join' || !input.integrity.includes('non_null_requested_to_concepts')) {return;}
  const relationship = SEMANTIC_CATALOG.relationships.find(candidate => candidate.id === input.relationship_id);
  if (!relationship) {throw new SemanticResultFormatError('Proven result relationship was unavailable');}
  for (const output of outputs) {
    if (output.kind !== 'concept' || output.concept.source_id !== relationship.to_source ||
        relationship.to_keys.includes(output.concept.concept_id)) {continue;}
    if (rows.some(row => row[output.as] === null ||
        (output.concept.physical_type === 'text' && String(row[output.as]).trim().length === 0))) {
      throw new SemanticResultFormatError(`Semantic result field ${output.as} failed relationship completeness`);
    }
  }
}

function validateUniqueGrain(rows: readonly Record<string, unknown>[], grain: readonly string[]): void {
  if (grain.length === 0) {return;}
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(grain.map(id => row[id]));
    if (seen.has(key)) {throw new SemanticResultFormatError('Semantic result contained a duplicate output grain');}
    seen.add(key);
  }
}

function validateOrdering(
  rows: readonly Record<string, unknown>[],
  keys: readonly { output_id: string; direction: 'asc' | 'desc'; nulls: 'first' | 'last'; semantic_type: string }[]
): void {
  for (let index = 1; index < rows.length; index += 1) {
    let comparison = 0;
    for (const key of keys) {
      comparison = compareSortValues(rows[index - 1][key.output_id], rows[index][key.output_id], key);
      if (comparison !== 0) {break;}
    }
    if (comparison > 0) {throw new SemanticResultFormatError('Semantic result did not preserve proven source ordering');}
    if (comparison === 0) {throw new SemanticResultFormatError('Semantic result contained a tie without a distinct proven order');}
  }
}

function compareSortValues(
  left: unknown,
  right: unknown,
  key: { direction: 'asc' | 'desc'; nulls: 'first' | 'last'; semantic_type: string }
): number {
  const leftNull = left === null;
  const rightNull = right === null;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) {return 0;}
    return leftNull === (key.nulls === 'first') ? -1 : 1;
  }
  let comparison: number;
  if (['circuit_id', 'date', 'driver_id', 'event_id', 'status', 'team_id', 'text'].includes(key.semantic_type)) {
    comparison = Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
  } else if (key.semantic_type === 'number') {
    comparison = compareDecimals(String(left), String(right));
  } else {
    comparison = compareNumbers(Number(left), Number(right));
  }
  return key.direction === 'asc' ? comparison : -comparison;
}

function describeScope(predicate: PlannedCorePredicate): SemanticResultScope {
  const source = sourceFor(predicate.concept.source_id);
  const concept = conceptFor(source, predicate.concept.concept_id);
  let values: readonly (string | number | boolean)[];
  if (predicate.operator === 'eq') {values = [predicate.value];}
  else if (predicate.operator === 'in') {values = [...predicate.values];}
  else {values = [predicate.min, predicate.max];}
  return {
    source_id: source.id,
    concept_id: concept.id,
    label: labelFor(concept.id, concept.language),
    operator: predicate.operator,
    values
  };
}

function headlineFor(sources: readonly SemanticCatalogSource[], scope: readonly SemanticResultScope[]): string {
  const seasons = unique(scope.filter(item => item.concept_id === 'season' && item.operator === 'eq')
    .map(item => String(item.values[0])));
  const rounds = unique(scope.filter(item => item.concept_id === 'round' && item.operator === 'eq')
    .map(item => String(item.values[0])));
  const sourceLabels = sources.map(source => labelFor(source.id, source.language));
  const sourceText = sourceLabels.length === 1 ? sourceLabels[0]
    : `${sourceLabels.slice(0, -1).join(', ')} and ${sourceLabels[sourceLabels.length - 1]}`;
  const season = seasons.length === 1 ? Number(seasons[0]) : null;
  const final = season !== null && sources.every(source => source.scope.final_season_through !== null &&
    season <= source.scope.final_season_through);
  let temporal = 'Latest recorded ';
  if (final) {temporal = 'Final ';}
  else if (season === null) {temporal = '';}
  const prefix = `${temporal}${season ?? 'proven'} ${sourceText} result`;
  return `${prefix}${rounds.length === 1 ? ` for round ${rounds[0]}` : ''}.`;
}

function displayValue(value: unknown, column: SemanticResultColumn): string | null {
  if (value === null) {return null;}
  if (column.physical_type === 'numeric') {return normalizeDecimal(String(value));}
  if (column.physical_type === 'boolean') {return value ? 'true' : 'false';}
  return String(value);
}

function aggregationSemantics(aggregation: NonNullable<SemanticResultColumn['aggregation']>, label: string): string {
  const baseLabel = label.replace(new RegExp(`^${aggregation} of `, 'u'), '');
  if (aggregation === 'count') {return `Count of non-null ${baseLabel} values after all source-specific predicates.`;}
  return `${aggregation} of ${baseLabel} after all source-specific predicates and before cross-source composition.`;
}

function matchesPredicate(value: unknown, predicate: PlannedCorePredicate): boolean {
  if (value === null) {return false;}
  if (predicate.operator === 'eq') {return value === predicate.value;}
  if (predicate.operator === 'in') {return predicate.values.includes(value as never);}
  return compareTyped(value, predicate.min, predicate.concept.semantic_type) >= 0 &&
    compareTyped(value, predicate.max, predicate.concept.semantic_type) <= 0;
}

function compareTyped(left: unknown, right: unknown, semanticType: string): number {
  if (semanticType === 'number') {return compareDecimals(String(left), String(right));}
  if (typeof left === 'string' && typeof right === 'string') {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  }
  return compareNumbers(Number(left), Number(right));
}

function inputBranches(input: import('./core').PlannedCoreProjectNode['input']) {
  if (input.op === 'join') {return [requireFilter(input.left), requireFilter(input.right)];}
  if (input.op === 'compose') {return input.inputs.map(candidate => requireFilter(candidate.input));}
  if (input.op === 'aggregate') {return [requireFilter(input.input)];}
  return [requireFilter(input)];
}

function requireFilter(branch: import('./core').PlannedCoreRowBranch) {
  if (branch.op !== 'filter') {throw new SemanticResultFormatError('Proven result source was not explicitly filtered');}
  return branch;
}

function sourceFor(sourceId: string): SemanticCatalogSource {
  const source = SEMANTIC_CATALOG.sources.find(candidate => candidate.id === sourceId);
  if (!source || source.usage !== 'answer_fact') {
    throw new SemanticResultFormatError(`Unknown semantic result source ${sourceId}`);
  }
  return source;
}

function conceptFor(source: SemanticCatalogSource, conceptId: string): CatalogConcept {
  const concept = [...source.dimensions, ...source.measures].find(candidate => candidate.id === conceptId);
  if (!concept) {throw new SemanticResultFormatError(`Unknown semantic result concept ${source.id}.${conceptId}`);}
  return concept;
}

function labelFor(id: string, language: { readonly names: readonly string[] } | null): string {
  return language?.names[0] ?? id.replaceAll('_', ' ');
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {return false;}
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {return false;}
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeDecimal(value: string): string {
  const parts = decimalParts(value);
  if (!parts) {throw new SemanticResultFormatError('Invalid exact decimal value');}
  return `${parts.negative ? '-' : ''}${parts.integer}${parts.fraction ? `.${parts.fraction}` : ''}`;
}

function compareDecimals(left: string, right: string): number {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) {throw new SemanticResultFormatError('Invalid exact decimal sort value');}
  if (leftParts.negative !== rightParts.negative) {return leftParts.negative ? -1 : 1;}
  const direction = leftParts.negative ? -1 : 1;
  if (leftParts.integer.length !== rightParts.integer.length) {
    return leftParts.integer.length < rightParts.integer.length ? -direction : direction;
  }
  if (leftParts.integer !== rightParts.integer) {return leftParts.integer < rightParts.integer ? -direction : direction;}
  const width = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(width, '0');
  const rightFraction = rightParts.fraction.padEnd(width, '0');
  if (leftFraction === rightFraction) {return 0;}
  return leftFraction < rightFraction ? -direction : direction;
}

function compareNumbers(left: number, right: number): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function decimalParts(value: string): { negative: boolean; integer: string; fraction: string } | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) {return null;}
  const integer = match[2].replace(/^0+(?=\d)/u, '');
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  const zero = integer === '0' && fraction.length === 0;
  return { negative: match[1] === '-' && !zero, integer, fraction };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isFinalStandingsPointsContract(
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[],
  outputGrain: readonly string[]
): boolean {
  return sources.length === 1 && sources[0].id === 'driver_standings' &&
    (outputGrain.length === 0 || (outputGrain.length === 1 && outputGrain[0] === 'driver_id')) &&
    columns.length === 2 &&
    columns[0].source_id === 'driver_standings' && columns[0].concept_id === 'driver_id' &&
    columns[0].id === 'driver_id' && columns[1].source_id === 'driver_standings' &&
    columns[1].concept_id === 'points' && columns[1].id === 'points';
}

// Bind selected drivers' recorded final championship positions without implying a ranking operation.
// eslint-disable-next-line complexity
function isFinalStandingsPositionSelectionContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'multi' | 'singleton' | 'unsupported' = 'unsupported';
  if (driverPredicate?.operator === 'eq') {mode = 'singleton';}
  else if (driverPredicate?.operator === 'in') {mode = 'multi';}
  const expectedGrain = mode === 'singleton' ? [] : ['driver_id'];
  const key = ordering[0];
  return mode !== 'unsupported' &&
    rowLimit === (mode === 'singleton' ? 1 : MAX_F1QL_RESPONSE_ROWS) &&
    sources.length === 1 && source?.id === 'driver_standings' &&
    project.input.op === 'filter' && branches.length === 1 && branch.input.source_id === 'driver_standings' &&
    branch.predicates.length === 2 && project.outputs.length === 2 &&
    project.outputs.every(output => output.kind === 'concept') && sameStrings(project.output_grain, expectedGrain) &&
    columns.length === 2 && columns[0].source_id === 'driver_standings' &&
    columns[0].concept_id === 'driver_id' && columns[0].id === 'driver_id' && columns[0].kind === 'dimension' &&
    columns[0].aggregation === null && columns[1].source_id === 'driver_standings' &&
    columns[1].concept_id === 'championship_position' && columns[1].id === 'championship_position' &&
    columns[1].kind === 'measure' && columns[1].aggregation === null && ordering.length === 1 &&
    key.output_id === 'driver_id' && key.direction === 'asc' && key.nulls === 'last' &&
    key.semantic_type === 'driver_id' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === 'driver_standings' &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    reviewedEventDriverPredicate(mode, driverPredicate, 'driver_standings');
}

// Bind selected drivers' exact standings summary without widening points compatibility.
// eslint-disable-next-line complexity
function isFinalStandingsPositionAndPointsSelectionContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'multi' | 'singleton' | 'unsupported' = 'unsupported';
  if (driverPredicate?.operator === 'eq') {mode = 'singleton';}
  else if (driverPredicate?.operator === 'in') {mode = 'multi';}
  const expectedGrain = mode === 'singleton' ? [] : ['driver_id'];
  const key = ordering[0];
  return mode !== 'unsupported' &&
    rowLimit === (mode === 'singleton' ? 1 : MAX_F1QL_RESPONSE_ROWS) &&
    sources.length === 1 && source?.id === 'driver_standings' &&
    project.input.op === 'filter' && branches.length === 1 && branch.input.source_id === 'driver_standings' &&
    branch.predicates.length === 2 && project.outputs.length === 3 &&
    project.outputs.every(output => output.kind === 'concept') && sameStrings(project.output_grain, expectedGrain) &&
    columns.length === 3 && columns[0].source_id === 'driver_standings' &&
    columns[0].concept_id === 'driver_id' && columns[0].id === 'driver_id' &&
    columns[0].kind === 'dimension' && columns[0].aggregation === null &&
    columns[0].physical_type === 'text' && columns[0].semantic_type === 'driver_id' &&
    columns[1].source_id === 'driver_standings' && columns[1].concept_id === 'championship_position' &&
    columns[1].id === 'championship_position' && columns[1].kind === 'measure' &&
    columns[1].aggregation === null && columns[1].physical_type === 'integer' &&
    columns[1].semantic_type === 'position' && columns[1].nullable &&
    columns[2].source_id === 'driver_standings' && columns[2].concept_id === 'points' &&
    columns[2].id === 'points' && columns[2].kind === 'measure' && columns[2].aggregation === null &&
    columns[2].physical_type === 'numeric' && columns[2].semantic_type === 'number' && columns[2].nullable &&
    ordering.length === 1 && key.output_id === 'driver_id' && key.direction === 'asc' && key.nulls === 'last' &&
    key.physical_type === 'text' && key.semantic_type === 'driver_id' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === 'driver_standings' &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    reviewedEventDriverPredicate(mode, driverPredicate, 'driver_standings');
}

// Keep the complete reviewed selected-driver ranking admission visible as one fail-closed gate.
// eslint-disable-next-line complexity
function isFinalStandingsPositionRankingContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  const positionKey = ordering[0];
  const driverKey = ordering[1];
  return rowLimit === MAX_F1QL_RESPONSE_ROWS && sources.length === 1 && source?.id === 'driver_standings' &&
    project.input.op === 'filter' && branches.length === 1 && branch.input.source_id === 'driver_standings' &&
    branch.predicates.length === 2 && project.outputs.length === 2 &&
    project.outputs.every(output => output.kind === 'concept') && sameStrings(project.output_grain, ['driver_id']) &&
    columns.length === 2 && columns[0].source_id === 'driver_standings' &&
    columns[0].concept_id === 'driver_id' && columns[0].id === 'driver_id' && columns[0].kind === 'dimension' &&
    columns[0].aggregation === null && columns[1].source_id === 'driver_standings' &&
    columns[1].concept_id === 'championship_position' && columns[1].id === 'championship_position' &&
    columns[1].kind === 'measure' && columns[1].aggregation === null && ordering.length === 2 &&
    positionKey.output_id === 'championship_position' && positionKey.direction === 'asc' &&
    positionKey.nulls === 'last' && positionKey.semantic_type === 'position' &&
    driverKey.output_id === 'driver_id' && driverKey.direction === 'asc' && driverKey.nulls === 'last' &&
    driverKey.semantic_type === 'driver_id' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === 'driver_standings' &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    reviewedEventDriverPredicate('multi', driverPredicate, 'driver_standings');
}

function validateFinalStandingsPositionRanking(rows: readonly Record<string, unknown>[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const position = rows[index].championship_position;
    if (typeof position !== 'number' || (index > 0 && position <= (rows[index - 1].championship_position as number))) {
      throw new SemanticResultFormatError('Final standings ranking positions were incomplete or non-unique');
    }
  }
}

// Bind the complete reviewed one-event position-ranking shape for both classification sources.
// eslint-disable-next-line complexity
function isClassificationPositionRankingContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const sourceId = source?.id;
  let positionId: 'finishing_position' | 'qualifying_position' | undefined;
  if (sourceId === 'event_classification') {positionId = 'finishing_position';}
  else if (sourceId === 'qualifying_classification') {positionId = 'qualifying_position';}
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const roundPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'round');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  const positionKey = ordering[0];
  const driverKey = ordering[1];
  return rowLimit === MAX_F1QL_RESPONSE_ROWS && sources.length === 1 && positionId !== undefined &&
    project.input.op === 'filter' && branches.length === 1 && branch.input.source_id === sourceId &&
    branch.predicates.length === 3 && project.outputs.length === 2 &&
    project.outputs.every(output => output.kind === 'concept') && sameStrings(project.output_grain, ['driver_id']) &&
    columns.length === 2 && columns[0].source_id === sourceId &&
    columns[0].concept_id === 'driver_id' && columns[0].id === 'driver_id' && columns[0].kind === 'dimension' &&
    columns[0].aggregation === null && columns[1].source_id === sourceId &&
    columns[1].concept_id === positionId && columns[1].id === positionId &&
    columns[1].kind === 'measure' && columns[1].aggregation === null && ordering.length === 2 &&
    positionKey.output_id === positionId && positionKey.direction === 'asc' &&
    positionKey.nulls === 'last' && positionKey.semantic_type === 'position' &&
    driverKey.output_id === 'driver_id' && driverKey.direction === 'asc' && driverKey.nulls === 'last' &&
    driverKey.semantic_type === 'driver_id' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === sourceId &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    Boolean(roundPredicate && roundPredicate.concept.source_id === sourceId &&
      roundPredicate.operator === 'eq' && typeof roundPredicate.value === 'number' &&
      Number.isSafeInteger(roundPredicate.value) && roundPredicate.value >= 1 && roundPredicate.value <= 30) &&
    reviewedEventDriverPredicate('multi', driverPredicate, sourceId);
}

function validateQualifyingPositionRanking(rows: readonly Record<string, unknown>[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const position = rows[index].qualifying_position;
    if (typeof position !== 'number' || (index > 0 && position <= (rows[index - 1].qualifying_position as number))) {
      throw new SemanticResultFormatError('Qualifying ranking positions were incomplete or non-unique');
    }
  }
}

// Keep the complete reviewed event-selection admission visible as one fail-closed gate.
// eslint-disable-next-line complexity
function isClassificationSelectionContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const sourceId = source?.id;
  let positionId: 'finishing_position' | 'qualifying_position' | undefined;
  if (sourceId === 'event_classification') {positionId = 'finishing_position';}
  else if (sourceId === 'qualifying_classification') {positionId = 'qualifying_position';}
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'multi' | 'singleton' | 'unsupported' = 'unsupported';
  if (driverPredicate?.operator === 'eq') {mode = 'singleton';}
  else if (driverPredicate?.operator === 'in') {mode = 'multi';}
  const expectedGrain = mode === 'singleton' ? [] : ['driver_id'];
  if (mode === 'unsupported' || sources.length !== 1 || !positionId ||
      columns.length !== 2 || columns[0].source_id !== sourceId ||
      columns[0].concept_id !== 'driver_id' || columns[0].id !== 'driver_id' ||
      columns[1].source_id !== sourceId || columns[1].concept_id !== positionId ||
      columns[1].id !== positionId || columns[0].kind !== 'dimension' ||
      columns[1].kind !== 'measure' || columns.some(column => column.aggregation !== null) ||
      project.input.op !== 'filter' || branches.length !== 1 || project.outputs.length !== 2 ||
      project.outputs.some(output => output.kind !== 'concept') || !sameStrings(project.output_grain, expectedGrain) ||
      rowLimit !== (mode === 'singleton' ? 1 : MAX_F1QL_RESPONSE_ROWS) || ordering.length !== 1 ||
      branch.predicates.length !== 3) {
    return false;
  }
  const seasonPredicate = branch.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const roundPredicate = branch.predicates.find(predicate => predicate.concept.concept_id === 'round');
  const key = ordering[0];
  return branch.input.source_id === sourceId &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === sourceId &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    Boolean(roundPredicate && roundPredicate.concept.source_id === sourceId &&
      roundPredicate.operator === 'eq' && typeof roundPredicate.value === 'number' &&
      Number.isSafeInteger(roundPredicate.value) && roundPredicate.value >= 1 && roundPredicate.value <= 30) &&
    reviewedEventDriverPredicate(mode, driverPredicate, sourceId) && key.output_id === 'driver_id' &&
    key.direction === 'asc' && key.nulls === 'last' && key.physical_type === 'text' &&
    key.semantic_type === 'driver_id';
}

// Keep selected classification membership and joined metadata completeness in one exact contract.
// eslint-disable-next-line complexity
function isSelectedClassificationMetadataContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const classification = branches.find(branch =>
    branch.input.source_id === 'event_classification' || branch.input.source_id === 'qualifying_classification');
  const metadata = branches.find(branch => branch.input.source_id === 'event_metadata');
  const classificationSourceId = classification?.input.source_id, contract = classificationMetadataContract(classificationSourceId);
  const positionConceptId = contract?.position_concept_id;
  const relationshipId = contract?.relationship_id;
  const driverPredicate = classification?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'multi' | 'singleton' | 'unsupported' = 'unsupported';
  if (driverPredicate?.operator === 'eq') {mode = 'singleton';}
  else if (driverPredicate?.operator === 'in') {mode = 'multi';}
  const expectedGrain = mode === 'singleton' ? [] : ['driver_id'];
  const conceptIds = project.outputs.map(output => output.kind === 'concept'
    ? `${output.concept.source_id}.${output.concept.concept_id}`
    : '');
  const metadataConceptIds = conceptIds.slice(2).map(conceptId => conceptId.replace('event_metadata.', ''));
  const canonicalMetadataConceptIds = ['date', 'event_name', 'circuit_id'];
  const supportedMetadataProjection = metadataConceptIds.length >= 1 &&
    sameStrings(metadataConceptIds, canonicalMetadataConceptIds.filter(conceptId => metadataConceptIds.includes(conceptId)));
  if (mode === 'unsupported' || !classification || !metadata || !classificationSourceId || !positionConceptId ||
      !relationshipId || sources.length !== 2 ||
      sources[0]?.id !== classificationSourceId || sources[1]?.id !== 'event_metadata' ||
      project.input.op !== 'join' || project.input.relationship_id !== relationshipId ||
      project.input.left !== classification || project.input.right !== metadata || branches.length !== 2 ||
      classification.predicates.length !== 3 || metadata.predicates.length !== 2 ||
      !sameStrings(project.output_grain, expectedGrain) ||
      rowLimit !== (mode === 'singleton' ? 1 : MAX_F1QL_RESPONSE_ROWS) || ordering.length !== 1 ||
      conceptIds[0] !== `${classificationSourceId}.driver_id` ||
      conceptIds[1] !== `${classificationSourceId}.${positionConceptId}` || !supportedMetadataProjection ||
      project.outputs.some((output, index) => output.kind !== 'concept' || output.as !== conceptIds[index].split('.')[1]) ||
      columns.length !== conceptIds.length || columns.some((column, index) =>
        `${column.source_id}.${column.concept_id}` !== conceptIds[index] ||
        column.id !== conceptIds[index].split('.')[1] || column.aggregation !== null) ||
      columns[0].kind !== 'dimension' || columns[1].kind !== 'measure' ||
      columns.slice(2).some(column => column.kind !== 'dimension')) {
    return false;
  }
  const classificationSeason = classification.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const classificationRound = classification.predicates.find(predicate => predicate.concept.concept_id === 'round');
  const metadataSeason = metadata.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const metadataRound = metadata.predicates.find(predicate => predicate.concept.concept_id === 'round');
  const key = ordering[0];
  const source = sources[0];
  return reviewedEventDriverPredicate(mode, driverPredicate, classificationSourceId) &&
    validHistoricalSeasonPredicate(classificationSeason, classificationSourceId, source) &&
    validHistoricalSeasonPredicate(metadataSeason, 'event_metadata', sources[1]) &&
    validRoundPredicate(classificationRound, classificationSourceId) &&
    validRoundPredicate(metadataRound, 'event_metadata') &&
    eqPredicateValue(classificationSeason) === eqPredicateValue(metadataSeason) &&
    eqPredicateValue(classificationRound) === eqPredicateValue(metadataRound) &&
    key.output_id === 'driver_id' && key.direction === 'asc' && key.nulls === 'last' &&
    key.physical_type === 'text' && key.semantic_type === 'driver_id';
}

function classificationMetadataContract(sourceId: string | undefined): {
  readonly position_concept_id: 'finishing_position' | 'qualifying_position';
  readonly relationship_id: 'qualifying_event_metadata' | 'race_event_metadata';
} | undefined {
  if (sourceId === 'event_classification') {
    return { position_concept_id: 'finishing_position', relationship_id: 'race_event_metadata' };
  }
  return sourceId === 'qualifying_classification'
    ? { position_concept_id: 'qualifying_position', relationship_id: 'qualifying_event_metadata' }
    : undefined;
}

function validHistoricalSeasonPredicate(
  predicate: PlannedCorePredicate | undefined,
  sourceId: string,
  source: SemanticCatalogSource
): boolean {
  return Boolean(predicate && predicate.concept.source_id === sourceId && predicate.operator === 'eq' &&
    typeof predicate.value === 'number' && Number.isSafeInteger(predicate.value) && source.scope.season_min !== null &&
    predicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
    predicate.value <= source.scope.final_season_through);
}

function validRoundPredicate(predicate: PlannedCorePredicate | undefined, sourceId: string): boolean {
  return Boolean(predicate && predicate.concept.source_id === sourceId && predicate.operator === 'eq' &&
    typeof predicate.value === 'number' && Number.isSafeInteger(predicate.value) &&
    predicate.value >= 1 && predicate.value <= 30);
}

function eqPredicateValue(predicate: PlannedCorePredicate | undefined): unknown {
  return predicate?.operator === 'eq' ? predicate.value : undefined;
}

// eslint-disable-next-line complexity
function isEventScalarSelectionContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const roundPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'round');
  const source = sources[0];
  const key = ordering[0];
  const conceptIds = project.outputs.map(output => output.kind === 'concept'
    ? output.concept.concept_id
    : '');
  const canonicalConceptIds = ['date', 'event_name', 'circuit_id'];
  const supportedProjection = conceptIds.length >= 1 &&
    sameStrings(conceptIds, canonicalConceptIds.filter(conceptId => conceptIds.includes(conceptId)));
  const firstConceptId = conceptIds[0];
  return rowLimit === 1 && sources.length === 1 && source?.id === 'event_metadata' &&
    branches.length === 1 && branch.input.source_id === 'event_metadata' && branch.predicates.length === 2 &&
    project.input.op === 'filter' && supportedProjection && project.outputs.every((output, index) =>
      output.kind === 'concept' && output.concept.source_id === 'event_metadata' &&
      output.as === conceptIds[index]) &&
    project.output_grain.length === 0 && columns.length === conceptIds.length && columns.every((column, index) =>
      column.source_id === 'event_metadata' && column.concept_id === conceptIds[index] &&
      column.id === conceptIds[index] && column.kind === 'dimension' && column.aggregation === null) &&
    ordering.length === 1 && key.output_id === firstConceptId &&
    key.direction === 'asc' && key.nulls === 'last' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === 'event_metadata' &&
      seasonPredicate.operator === 'eq' && typeof seasonPredicate.value === 'number' &&
      Number.isSafeInteger(seasonPredicate.value) && source.scope.season_min !== null &&
      seasonPredicate.value >= source.scope.season_min && source.scope.final_season_through !== null &&
      seasonPredicate.value <= source.scope.final_season_through) &&
    Boolean(roundPredicate && roundPredicate.concept.source_id === 'event_metadata' &&
      roundPredicate.operator === 'eq' && typeof roundPredicate.value === 'number' &&
      Number.isSafeInteger(roundPredicate.value) && roundPredicate.value >= 1 && roundPredicate.value <= 30);
}

// Keep recorded-position counts distinct from appearances, events, wins, and ranked counts.
// eslint-disable-next-line complexity
function isClassificationPositionScalarCountContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const sourceId = source?.id;
  let positionId: 'finishing_position' | 'qualifying_position' | undefined;
  if (sourceId === 'event_classification') {positionId = 'finishing_position';}
  else if (sourceId === 'qualifying_classification') {positionId = 'qualifying_position';}
  const countId = positionId === undefined ? undefined : `count_${positionId}`;
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'singleton' | 'unfiltered' | 'unsupported' = 'unsupported';
  if (driverPredicate === undefined) {mode = 'unfiltered';}
  else if (driverPredicate.operator === 'eq') {mode = 'singleton';}
  const aggregate = project.input.op === 'aggregate' ? project.input : undefined;
  const measure = aggregate?.measures[0];
  const output = project.outputs[0];
  const key = ordering[0];
  return mode !== 'unsupported' && rowLimit === 1 && sources.length === 1 &&
    sourceId !== undefined && positionId !== undefined &&
    countId !== undefined && branches.length === 1 && branch.input.source_id === sourceId &&
    branch.predicates.length === (mode === 'singleton' ? 2 : 1) &&
    (mode === 'unfiltered' || reviewedEventDriverPredicate('singleton', driverPredicate, sourceId)) &&
    aggregate !== undefined && aggregate.group_by.length === 0 &&
    aggregate.measures.length === 1 && measure?.source_id === sourceId &&
    measure.concept_id === positionId && measure.function === 'count' &&
    measure.as === countId && project.outputs.length === 1 &&
    output?.kind === 'aggregate' && output.measure_as === countId &&
    output.as === countId && project.output_grain.length === 0 &&
    columns.length === 1 && columns[0].source_id === sourceId &&
    columns[0].concept_id === positionId && columns[0].id === countId &&
    columns[0].kind === 'aggregate' && columns[0].aggregation === 'count' &&
    columns[0].physical_type === 'integer' && columns[0].nullable === false && ordering.length === 1 &&
    key.output_id === countId && key.direction === 'asc' && key.nulls === 'last' &&
    Boolean(seasonPredicate && seasonPredicate.concept.source_id === sourceId &&
      seasonPredicate.concept.concept_id === 'season' && seasonPredicate.operator === 'eq' &&
      typeof seasonPredicate.value === 'number' && Number.isSafeInteger(seasonPredicate.value) &&
      source.scope.season_min !== null && seasonPredicate.value >= source.scope.season_min &&
      source.scope.final_season_through !== null && seasonPredicate.value <= source.scope.final_season_through);
}

// A caller-requested top ten is complete at ten rows even when collection proves an eleventh group exists.
// eslint-disable-next-line complexity
function isClassificationPositionCountRankingContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const sourceId = source?.id;
  let positionId: 'finishing_position' | 'qualifying_position' | undefined;
  if (sourceId === 'event_classification') {positionId = 'finishing_position';}
  else if (sourceId === 'qualifying_classification') {positionId = 'qualifying_position';}
  const countId = positionId === undefined ? undefined : `count_${positionId}`;
  const aggregate = project.input.op === 'aggregate' ? project.input : undefined;
  const measure = aggregate?.measures[0];
  const seasonPredicate = branch?.predicates[0];
  return rowLimit === 10 && sources.length === 1 && sourceId !== undefined && positionId !== undefined &&
    countId !== undefined && branches.length === 1 && branch.input.source_id === sourceId &&
    branch.predicates.length === 1 && seasonPredicate?.concept.source_id === sourceId &&
    seasonPredicate.concept.concept_id === 'season' && seasonPredicate.operator === 'eq' &&
    typeof seasonPredicate.value === 'number' && Number.isSafeInteger(seasonPredicate.value) &&
    source.scope.season_min !== null && seasonPredicate.value >= source.scope.season_min &&
    source.scope.final_season_through !== null && seasonPredicate.value <= source.scope.final_season_through &&
    aggregate !== undefined && aggregate.group_by.length === 1 &&
    aggregate.group_by[0].source_id === sourceId &&
    aggregate.group_by[0].concept_id === 'driver_id' && aggregate.measures.length === 1 &&
    measure?.source_id === sourceId && measure.concept_id === positionId &&
    measure.function === 'count' && measure.as === countId &&
    project.outputs.length === 2 && project.outputs[0].kind === 'concept' &&
    project.outputs[0].concept.source_id === sourceId &&
    project.outputs[0].concept.concept_id === 'driver_id' && project.outputs[0].as === 'driver_id' &&
    project.outputs[1].kind === 'aggregate' &&
    project.outputs[1].measure_as === countId && project.outputs[1].as === countId &&
    sameStrings(project.output_grain, ['driver_id']) && columns.length === 2 &&
    columns[0].id === 'driver_id' && columns[0].kind === 'dimension' && columns[0].aggregation === null &&
    columns[1].id === countId && columns[1].kind === 'aggregate' &&
    columns[1].aggregation === 'count' && columns[1].physical_type === 'integer' &&
    columns[1].nullable === false && ordering.length === 2 &&
    ordering[0].output_id === countId && ordering[0].direction === 'desc' &&
    ordering[0].nulls === 'last' && ordering[1].output_id === 'driver_id' &&
    ordering[1].direction === 'asc' && ordering[1].nulls === 'last';
}

// Bind selected classification counts to identity ordering and exact selected membership, never count ranking.
// eslint-disable-next-line complexity
function isSelectedClassificationPositionCountContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const branch = branches[0];
  const source = sources[0];
  const sourceId = source?.id;
  let positionId: 'finishing_position' | 'qualifying_position' | undefined;
  if (sourceId === 'event_classification') {positionId = 'finishing_position';}
  else if (sourceId === 'qualifying_classification') {positionId = 'qualifying_position';}
  const countId = positionId === undefined ? undefined : `count_${positionId}`;
  const aggregate = project.input.op === 'aggregate' ? project.input : undefined;
  const measure = aggregate?.measures[0];
  const seasonPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'season');
  const driverPredicate = branch?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  const key = ordering[0];
  return rowLimit === MAX_F1QL_RESPONSE_ROWS && sources.length === 1 && sourceId !== undefined &&
    positionId !== undefined && countId !== undefined && branches.length === 1 &&
    branch.input.source_id === sourceId && branch.predicates.length === 2 &&
    reviewedEventDriverPredicate('multi', driverPredicate, sourceId) &&
    validHistoricalSeasonPredicate(seasonPredicate, sourceId, source) &&
    aggregate !== undefined && aggregate.group_by.length === 1 &&
    aggregate.group_by[0].source_id === sourceId &&
    aggregate.group_by[0].concept_id === 'driver_id' && aggregate.measures.length === 1 &&
    measure?.source_id === sourceId && measure.concept_id === positionId &&
    measure.function === 'count' && measure.as === countId &&
    project.outputs.length === 2 && project.outputs[0].kind === 'concept' &&
    project.outputs[0].concept.source_id === sourceId &&
    project.outputs[0].concept.concept_id === 'driver_id' && project.outputs[0].as === 'driver_id' &&
    project.outputs[1].kind === 'aggregate' &&
    project.outputs[1].measure_as === countId && project.outputs[1].as === countId &&
    sameStrings(project.output_grain, ['driver_id']) && columns.length === 2 &&
    columns[0].source_id === sourceId && columns[0].concept_id === 'driver_id' &&
    columns[0].id === 'driver_id' && columns[0].kind === 'dimension' && columns[0].aggregation === null &&
    columns[1].source_id === sourceId && columns[1].concept_id === positionId &&
    columns[1].id === countId && columns[1].kind === 'aggregate' &&
    columns[1].aggregation === 'count' && columns[1].physical_type === 'integer' &&
    columns[1].nullable === false && ordering.length === 1 && key.output_id === 'driver_id' &&
    key.direction === 'asc' && key.nulls === 'last' && key.physical_type === 'text' &&
    key.semantic_type === 'driver_id';
}

// Bind the exact unfiltered race count table without inferring a selected membership universe.
// eslint-disable-next-line complexity
function isUnfilteredRacePositionCountContract(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): boolean {
  const sourceId = 'event_classification';
  const positionId = 'finishing_position';
  const countId = 'count_finishing_position';
  const branch = branches[0];
  const source = sources[0];
  const aggregate = project.input.op === 'aggregate' ? project.input : undefined;
  const measure = aggregate?.measures[0];
  const seasonPredicate = branch?.predicates[0];
  const key = ordering[0];
  return rowLimit === MAX_F1QL_RESPONSE_ROWS && sources.length === 1 && source?.id === sourceId &&
    branches.length === 1 && branch.input.source_id === sourceId && branch.predicates.length === 1 &&
    validHistoricalSeasonPredicate(seasonPredicate, sourceId, source) &&
    aggregate !== undefined && aggregate.group_by.length === 1 &&
    aggregate.group_by[0].source_id === sourceId && aggregate.group_by[0].concept_id === 'driver_id' &&
    aggregate.measures.length === 1 && measure?.source_id === sourceId &&
    measure.concept_id === positionId && measure.function === 'count' && measure.as === countId &&
    project.outputs.length === 2 && project.outputs[0].kind === 'concept' &&
    project.outputs[0].concept.source_id === sourceId &&
    project.outputs[0].concept.concept_id === 'driver_id' && project.outputs[0].as === 'driver_id' &&
    project.outputs[1].kind === 'aggregate' && project.outputs[1].measure_as === countId &&
    project.outputs[1].as === countId && sameStrings(project.output_grain, ['driver_id']) &&
    columns.length === 2 && columns[0].source_id === sourceId && columns[0].concept_id === 'driver_id' &&
    columns[0].id === 'driver_id' && columns[0].kind === 'dimension' && columns[0].aggregation === null &&
    columns[1].source_id === sourceId && columns[1].concept_id === positionId &&
    columns[1].id === countId && columns[1].kind === 'aggregate' && columns[1].aggregation === 'count' &&
    columns[1].physical_type === 'integer' && columns[1].nullable === false && ordering.length === 1 &&
    key.output_id === 'driver_id' && key.direction === 'asc' && key.nulls === 'last' &&
    key.physical_type === 'text' && key.semantic_type === 'driver_id';
}

function reviewedEventDriverPredicate(
  mode: 'multi' | 'singleton' | 'unsupported',
  predicate: PlannedCorePredicate | undefined,
  sourceId: string
): boolean {
  if (!predicate || predicate.concept.source_id !== sourceId) {return false;}
  if (mode === 'singleton') {return predicate.operator === 'eq' && isCanonicalDriverId(predicate.value);}
  return mode === 'multi' && predicate.operator === 'in' &&
    predicate.values.length >= 2 && predicate.values.length <= 4 &&
    predicate.values.every(isCanonicalDriverId) &&
    predicate.values.every((value, index) => index === 0 || predicate.values[index - 1] < value);
}

// Keep the complete reviewed compatibility admission visible as one fail-closed gate.
// eslint-disable-next-line complexity
function finalStandingsCompatibilityScope(
  rowLimit: number,
  ordering: readonly PlannedCoreSortKey[],
  project: PlannedCoreProjectNode,
  branches: ReturnType<typeof inputBranches>,
  sources: readonly SemanticCatalogSource[],
  columns: readonly SemanticResultColumn[]
): { readonly season: number; readonly driver_ids: ReviewedFinalStandingsDriverIds } | null {
  const driverPredicate = branches[0]?.predicates.find(predicate => predicate.concept.concept_id === 'driver_id');
  let mode: 'multi' | 'singleton' | 'unfiltered' | 'unsupported' = 'unsupported';
  if (driverPredicate === undefined) {mode = 'unfiltered';}
  else if (driverPredicate.operator === 'eq') {mode = 'singleton';}
  else if (driverPredicate.operator === 'in') {mode = 'multi';}
  const expectedGrain = mode === 'singleton' ? [] : ['driver_id'];
  if (mode === 'unsupported' || rowLimit !== (mode === 'singleton' ? 1 : MAX_F1QL_RESPONSE_ROWS) ||
      !isFinalStandingsPointsContract(sources, columns, project.output_grain) ||
      project.input.op !== 'filter' || branches.length !== 1 ||
      branches[0].predicates.length !== (mode === 'unfiltered' ? 1 : 2) ||
      !sameStrings(project.output_grain, expectedGrain) ||
      project.outputs.length !== 2 || project.outputs.some(output => output.kind !== 'concept') ||
      columns[0].kind !== 'dimension' || columns[0].aggregation !== null ||
      columns[1].kind !== 'measure' || columns[1].aggregation !== null || ordering.length !== 1) {
    return null;
  }
  const seasonPredicate = branches[0].predicates.find(predicate => predicate.concept.concept_id === 'season');
  const key = ordering[0];
  if (branches[0].input.source_id !== 'driver_standings' ||
      !seasonPredicate || seasonPredicate.concept.source_id !== 'driver_standings' ||
      seasonPredicate.operator !== 'eq' || typeof seasonPredicate.value !== 'number' ||
      !Number.isSafeInteger(seasonPredicate.value) ||
      !reviewedDriverPredicate(mode, driverPredicate) ||
      key.output_id !== 'driver_id' || key.direction !== 'asc' || key.nulls !== 'last' ||
      key.physical_type !== 'text' || key.semantic_type !== 'driver_id') {
    return null;
  }
  const source = sources[0];
  return (source.scope.season_min === null || seasonPredicate.value >= source.scope.season_min) &&
    source.scope.final_season_through !== null && seasonPredicate.value <= source.scope.final_season_through
    ? {
        season: seasonPredicate.value,
        driver_ids: driverIdsForPredicate(driverPredicate)
      }
    : null;
}

function requestedDriverRowCount(branches: ReturnType<typeof inputBranches>): number | undefined {
  const predicates = branches.flatMap(branch => branch.predicates.filter(candidate =>
    candidate.concept.concept_id === 'driver_id'));
  const predicate = predicates.length === 1 ? predicates[0] : undefined;
  if (predicate?.operator === 'eq') {return 1;}
  return predicate?.operator === 'in' ? predicate.values.length : undefined;
}

function reviewedDriverPredicate(
  mode: 'multi' | 'singleton' | 'unfiltered' | 'unsupported',
  predicate: PlannedCorePredicate | undefined
): boolean {
  if (mode === 'unfiltered') {return predicate === undefined;}
  if (!predicate || predicate.concept.source_id !== 'driver_standings') {return false;}
  if (mode === 'singleton') {
    return predicate.operator === 'eq' && isCanonicalDriverId(predicate.value);
  }
  return mode === 'multi' && predicate.operator === 'in' &&
    predicate.values.length >= 2 && predicate.values.length <= 4 &&
    predicate.values.every(isCanonicalDriverId) &&
    predicate.values.every((value, index) => index === 0 || predicate.values[index - 1] < value);
}

function driverIdsForPredicate(predicate: PlannedCorePredicate | undefined): ReviewedFinalStandingsDriverIds {
  if (predicate?.operator === 'eq') {return [predicate.value as string];}
  if (predicate?.operator === 'in') {
    return [...predicate.values] as unknown as ReviewedFinalStandingsDriverIds;
  }
  return [];
}

function isCanonicalDriverId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
