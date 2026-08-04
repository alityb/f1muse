import {
  sanitizeSemanticShadowRetainedObservation,
  SemanticShadowRetainedObservation
} from './semantic-shadow-retained-observation';

export const SEMANTIC_SHADOW_REPORT_VERSION = 'semantic-shadow-report-v1' as const;
export const SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS = 28;
export const SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS = 3;
const RETAINED_VERSION = 'semantic-shadow-retained-v2';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type Counts = Readonly<Record<string, number>>;

export interface SemanticShadowReportExpectedCase {
  readonly question_sha256: string;
  readonly outcome: 'answer' | 'clarify' | 'abstain';
  readonly reason: string;
  readonly topology_code?: string;
  readonly source_set_code?: string;
  readonly operator_set_code?: string;
  readonly candidate_counts?: Readonly<Record<string, number | string>>;
  readonly plan_work?: Readonly<Record<string, number | string>>;
  readonly template_dual_status?: string;
  readonly provider_raw_candidate_set_sha256?: string;
  readonly hashes?: Readonly<Record<string, string>>;
}

export interface SemanticShadowReportRequirements {
  readonly corpus_sha256: string;
  readonly cases: readonly SemanticShadowReportExpectedCase[];
}

export interface SemanticShadowLatencyReport {
  readonly attempts: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly max_ms: number | null;
}

export interface SemanticShadowReport {
  readonly version: typeof SEMANTIC_SHADOW_REPORT_VERSION;
  readonly attempts: {
    readonly total: number;
    readonly semantic: number;
    readonly operational_failure: number;
  };
  readonly semantic: {
    readonly outcomes: Counts;
    readonly reasons: Counts;
    readonly topologies: Counts;
    readonly sources: Counts;
    readonly operators: Counts;
    readonly dual_statuses: Counts;
  };
  readonly operational: {
    readonly reasons: Counts;
    readonly stages: Counts;
  };
  readonly candidates: {
    readonly matched: number;
    readonly omitted: number;
    readonly extraneous: number;
  };
  readonly resolver_totals: {
    readonly transactions: number;
    readonly statements: number;
    readonly returned_rows: number;
    readonly inventory_reads: number;
    readonly event_reads: number;
    readonly inventory_entities: number;
    readonly verified_candidates: number;
  };
  readonly fingerprint_totals: {
    readonly reads: number;
  };
  readonly result_query_calls: {
    readonly total: number;
    readonly violating_attempts: number;
  };
  readonly provider_identity: {
    readonly distinct: number;
    readonly consistent: boolean;
  };
  readonly evidence_binding: {
    readonly bound_attempts: number;
    readonly distinct_runs: number;
    readonly failures: number;
    readonly valid: boolean;
  };
  readonly oracle: {
    readonly expected_cases: number;
    readonly matched_attempts: number;
    readonly mismatched_attempts: number;
    readonly status: 'pass' | 'fail' | 'insufficient';
  };
  readonly repetition: {
    readonly expected_question_groups: number;
    readonly expected_repetitions_per_group: number;
    readonly expected_attempts: number;
    readonly question_groups: number;
    readonly repeated_groups: number;
    readonly complete_groups: number;
    readonly incomplete_groups: number;
    readonly overfull_groups: number;
    readonly stable_groups: number;
    readonly drifted_groups: number;
    readonly status: 'pass' | 'fail' | 'insufficient';
  };
  readonly latency_ms: {
    readonly semantic_total: SemanticShadowLatencyReport;
    readonly operational_total: SemanticShadowLatencyReport;
  };
  readonly safety: {
    readonly result_query_calls_zero: boolean;
    readonly counter_parse_failures: number;
    readonly counters_valid: boolean;
    readonly dual_mismatches: number;
    readonly dual_mismatches_zero: boolean;
    readonly provider_identity_consistent: boolean;
    readonly operational_failures_zero: boolean;
    readonly evidence_binding_valid: boolean;
    readonly oracle_exact: boolean;
    readonly repetition_complete: boolean;
    readonly repetition_stable: boolean;
    readonly status: 'pass' | 'fail' | 'insufficient';
  };
}

interface MutableTotals {
  transactions: number;
  statements: number;
  returned_rows: number;
  inventory_reads: number;
  event_reads: number;
  inventory_entities: number;
  verified_candidates: number;
  fingerprint_reads: number;
}

export function buildSemanticShadowReport(
  records: readonly unknown[],
  requirements?: SemanticShadowReportRequirements
): SemanticShadowReport {
  const expectedCases = validateRequirements(requirements);
  const outcomes = new Map<string, number>();
  const semanticReasons = new Map<string, number>();
  const topologies = new Map<string, number>();
  const sources = new Map<string, number>();
  const operators = new Map<string, number>();
  const dualStatuses = new Map<string, number>();
  const operationalReasons = new Map<string, number>();
  const operationalStages = new Map<string, number>();
  const providerIdentities = new Set<string>();
  const repetitions = new Map<string, Set<string>>();
  const repetitionCounts = new Map<string, number>();
  const semanticLatencies: number[] = [];
  const operationalLatencies: number[] = [];
  const evidenceRuns = new Set<string>();
  const evidenceAttempts = new Set<string>();
  const evidenceOrdinals = new Set<string>();
  const resolver: MutableTotals = {
    transactions: 0,
    statements: 0,
    returned_rows: 0,
    inventory_reads: 0,
    event_reads: 0,
    inventory_entities: 0,
    verified_candidates: 0,
    fingerprint_reads: 0
  };
  let semanticAttempts = 0;
  let operationalAttempts = 0;
  let matched = 0;
  let omitted = 0;
  let extraneous = 0;
  let resultQueryCalls = 0;
  let resultQueryCallViolations = 0;
  let counterParseFailures = 0;
  let dualMismatches = 0;
  let evidenceBindingFailures = 0;
  let boundAttempts = 0;
  let oracleMatches = 0;
  let oracleMismatches = 0;

  for (const input of records) {
    const retained = asObject(sanitizeSemanticShadowRetainedObservation(input));
    if (retained.version !== RETAINED_VERSION) {
      throw new Error('semantic_shadow_report_retained_version_invalid');
    }
    const questionHash = requiredString(retained.question_sha256, 'question_hash');
    repetitionCounts.set(questionHash, (repetitionCounts.get(questionHash) ?? 0) + 1);
    providerIdentities.add(canonicalize(asObject(retained.provider_identity)));
    counterParseFailures += addResolverCounters(retained, resolver);
    evidenceBindingFailures += addEvidenceBinding(
      retained, questionHash, requirements, expectedCases, evidenceRuns, evidenceAttempts, evidenceOrdinals
    );
    if (retained.evidence_binding !== undefined) {boundAttempts += 1;}
    const resolverRepetitionValue = {
      transaction_count: retained.resolver_transaction_count,
      counters: retained.resolver_transaction_counters
    };

    const terminal = requiredString(retained.terminal, 'terminal');
    let repetitionValue: unknown;
    let calls: number;
    if (terminal === 'semantic') {
      semanticAttempts += 1;
      const observation = asObject(retained.observation);
      increment(outcomes, requiredString(observation.outcome, 'semantic_outcome'));
      increment(semanticReasons, requiredString(observation.reason, 'semantic_reason'));
      incrementOptional(topologies, observation.topology_code);
      incrementOptional(sources, observation.source_set_code);
      incrementOptional(operators, observation.operator_set_code);

      const dual = asObject(observation.template_dual);
      const dualStatus = requiredString(dual.status, 'dual_status');
      increment(dualStatuses, dualStatus);
      if (dualStatus === 'mismatched') {
        dualMismatches += 1;
      }

      const candidates = asObject(observation.candidate_counts);
      matched += requiredCounter(candidates.matched, 'candidate_matched');
      omitted += requiredCounter(candidates.omitted, 'candidate_omitted');
      extraneous += requiredCounter(candidates.extraneous, 'candidate_extraneous');

      const resolverCounts = asObject(observation.resolver_counts);
      resolver.inventory_entities += requiredCounter(resolverCounts.inventory_entities, 'inventory_entities');
      resolver.verified_candidates += requiredCounter(resolverCounts.verified_candidates, 'verified_candidates');
      resolver.fingerprint_reads += requiredCounter(resolverCounts.fingerprint_reads, 'fingerprint_reads');

      const latencies = asObject(observation.latencies);
      semanticLatencies.push(requiredCounter(latencies.total_ms, 'semantic_total_ms'));
      calls = requiredCounter(observation.result_query_calls, 'semantic_result_query_calls');
      repetitionValue = withoutVolatileSemanticFields(observation);
      if (requirements !== undefined) {
        if (matchesSemanticShadowOracle(observation, expectedCases.get(questionHash))) {oracleMatches += 1;}
        else {oracleMismatches += 1;}
      }
    } else if (terminal === 'operational_failure') {
      operationalAttempts += 1;
      const failure = asObject(retained.failure);
      const reason = requiredString(failure.reason, 'operational_reason');
      const stage = requiredString(failure.stage, 'operational_stage');
      if (reason === 'counter_parse_failure' || reason === 'resolver_counter_parse_failure') {
        counterParseFailures += 1;
      }
      increment(operationalReasons, reason);
      increment(operationalStages, stage);
      operationalLatencies.push(requiredCounter(failure.total_ms, 'operational_total_ms'));
      calls = requiredCounter(retained.result_query_calls, 'operational_result_query_calls');
      repetitionValue = { terminal, reason, stage, result_query_calls: calls };
    } else {
      throw new Error('semantic_shadow_report_terminal_invalid');
    }

    resultQueryCalls += calls;
    if (calls !== 0) {
      resultQueryCallViolations += 1;
    }
    const signatures = repetitions.get(questionHash) ?? new Set<string>();
    signatures.add(canonicalize({ terminal, resolver: resolverRepetitionValue, value: repetitionValue }));
    repetitions.set(questionHash, signatures);
  }

  const repetitionValues = [...repetitionCounts.values()];
  const repeatedGroups = repetitionValues.filter(count => count > 1).length;
  const completeGroups = repetitionValues.filter(count => count === SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS).length;
  const incompleteGroups = repetitionValues.filter(count => count < SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS).length;
  const overfullGroups = repetitionValues.filter(count => count > SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS).length;
  const driftedGroups = [...repetitions.entries()].filter(([questionHash, signatures]) =>
    (repetitionCounts.get(questionHash) ?? 0) > 1 && signatures.size > 1).length;
  const stableGroups = [...repetitions.entries()].filter(([questionHash, signatures]) =>
    repetitionCounts.get(questionHash) === SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS && signatures.size === 1).length;
  const expectedAttempts = SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS * SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS;
  const groupSetComplete = requirements !== undefined &&
    repetitionCounts.size === SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS &&
    completeGroups === SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS &&
    semanticAttempts + operationalAttempts === expectedAttempts &&
    [...repetitionCounts.keys()].every(questionHash => expectedCases.has(questionHash));
  const repetitionStable = driftedGroups === 0;
  const providerIdentityConsistent = providerIdentities.size <= 1;
  const countersValid = counterParseFailures === 0;
  const resultQueryCallsZero = resultQueryCallViolations === 0;
  const dualMismatchesZero = dualMismatches === 0;
  const operationalFailuresZero = operationalAttempts === 0;
  const evidenceBindingValid = requirements !== undefined && evidenceBindingFailures === 0 &&
    boundAttempts === expectedAttempts && evidenceRuns.size === 1 && evidenceAttempts.size === expectedAttempts &&
    evidenceOrdinals.size === expectedAttempts;
  const repetitionComplete = groupSetComplete && evidenceBindingValid;
  let repetitionStatus: SemanticShadowReport['repetition']['status'] = 'insufficient';
  if (!repetitionStable || overfullGroups > 0 ||
      repetitionCounts.size > SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS || evidenceBindingFailures > 0) {
    repetitionStatus = 'fail';
  } else if (repetitionComplete) {
    repetitionStatus = 'pass';
  }
  const oracleExact = requirements !== undefined && oracleMismatches === 0 && oracleMatches === expectedAttempts;
  let oracleStatus: SemanticShadowReport['oracle']['status'] = 'insufficient';
  if (requirements !== undefined) {oracleStatus = oracleExact ? 'pass' : 'fail';}
  const hardFailure = !resultQueryCallsZero || !countersValid || !dualMismatchesZero ||
    !providerIdentityConsistent || !operationalFailuresZero || !repetitionStable ||
    overfullGroups > 0 || repetitionCounts.size > SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS ||
    evidenceBindingFailures > 0 || oracleMismatches > 0;
  let status: SemanticShadowReport['safety']['status'] = 'insufficient';
  if (hardFailure) {status = 'fail';}
  else if (repetitionComplete && evidenceBindingValid && oracleExact) {status = 'pass';}

  return deepFreeze({
    version: SEMANTIC_SHADOW_REPORT_VERSION,
    attempts: {
      total: semanticAttempts + operationalAttempts,
      semantic: semanticAttempts,
      operational_failure: operationalAttempts
    },
    semantic: {
      outcomes: sortedCounts(outcomes),
      reasons: sortedCounts(semanticReasons),
      topologies: sortedCounts(topologies),
      sources: sortedCounts(sources),
      operators: sortedCounts(operators),
      dual_statuses: sortedCounts(dualStatuses)
    },
    operational: {
      reasons: sortedCounts(operationalReasons),
      stages: sortedCounts(operationalStages)
    },
    candidates: { matched, omitted, extraneous },
    resolver_totals: {
      transactions: resolver.transactions,
      statements: resolver.statements,
      returned_rows: resolver.returned_rows,
      inventory_reads: resolver.inventory_reads,
      event_reads: resolver.event_reads,
      inventory_entities: resolver.inventory_entities,
      verified_candidates: resolver.verified_candidates
    },
    fingerprint_totals: { reads: resolver.fingerprint_reads },
    result_query_calls: { total: resultQueryCalls, violating_attempts: resultQueryCallViolations },
    provider_identity: { distinct: providerIdentities.size, consistent: providerIdentityConsistent },
    evidence_binding: {
      bound_attempts: boundAttempts,
      distinct_runs: evidenceRuns.size,
      failures: evidenceBindingFailures,
      valid: evidenceBindingValid
    },
    oracle: {
      expected_cases: expectedCases.size,
      matched_attempts: oracleMatches,
      mismatched_attempts: oracleMismatches,
      status: oracleStatus
    },
    repetition: {
      expected_question_groups: SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS,
      expected_repetitions_per_group: SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS,
      expected_attempts: expectedAttempts,
      question_groups: repetitions.size,
      repeated_groups: repeatedGroups,
      complete_groups: completeGroups,
      incomplete_groups: incompleteGroups,
      overfull_groups: overfullGroups,
      stable_groups: stableGroups,
      drifted_groups: driftedGroups,
      status: repetitionStatus
    },
    latency_ms: {
      semantic_total: latencyReport(semanticLatencies),
      operational_total: latencyReport(operationalLatencies)
    },
    safety: {
      result_query_calls_zero: resultQueryCallsZero,
      counter_parse_failures: counterParseFailures,
      counters_valid: countersValid,
      dual_mismatches: dualMismatches,
      dual_mismatches_zero: dualMismatchesZero,
      provider_identity_consistent: providerIdentityConsistent,
      operational_failures_zero: operationalFailuresZero,
      evidence_binding_valid: evidenceBindingValid,
      oracle_exact: oracleExact,
      repetition_complete: repetitionComplete,
      repetition_stable: repetitionStable,
      status
    }
  });
}

export function buildSemanticShadowReportFromJsonl(
  content: string,
  requirements?: SemanticShadowReportRequirements
): SemanticShadowReport {
  return buildSemanticShadowReport(parseSemanticShadowRetainedEventsFromJsonl(content), requirements);
}

export function parseSemanticShadowRetainedEventsFromJsonl(
  content: string
): readonly SemanticShadowRetainedObservation[] {
  const records: SemanticShadowRetainedObservation[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    let outer: unknown;
    try {
      outer = parseSemanticShadowJsonRejectDuplicateKeys(line);
    } catch {
      if (claimsRetainedFamily(line)) {
        throw new Error('semantic_shadow_report_claim_malformed');
      }
      continue;
    }

    const outerObject = objectOrUndefined(outer);
    if (outerObject?.version === RETAINED_VERSION) {
      records.push(sanitizeClaim(outerObject));
      continue;
    }
    if (outerObject?.version === 'semantic-shadow-retained-v1') {
      if (claimsRetainedV2(line)) {throw new Error('semantic_shadow_report_claim_malformed');}
      continue;
    }
    if (typeof outerObject?.message === 'string') {
      let message: unknown;
      try {
        message = parseSemanticShadowJsonRejectDuplicateKeys(outerObject.message);
      } catch {
        if (claimsRetainedFamily(outerObject.message)) {
          throw new Error('semantic_shadow_report_claim_malformed');
        }
        continue;
      }
      const messageObject = objectOrUndefined(message);
      if (messageObject?.version === RETAINED_VERSION) {
        records.push(sanitizeClaim(messageObject));
      } else if (messageObject?.version === 'semantic-shadow-retained-v1') {
        if (claimsRetainedV2(outerObject.message)) {throw new Error('semantic_shadow_report_claim_malformed');}
      } else if (claimsRetainedFamily(outerObject.message)) {
        throw new Error('semantic_shadow_report_claim_malformed');
      }
      continue;
    }
    if (outerObject?.version !== 'semantic-shadow-retained-v1' && claimsRetainedFamily(line)) {
      throw new Error('semantic_shadow_report_claim_malformed');
    }
  }
  return Object.freeze(records);
}

function sanitizeClaim(input: unknown): SemanticShadowRetainedObservation {
  try {
    return sanitizeSemanticShadowRetainedObservation(input);
  } catch {
    throw new Error('semantic_shadow_report_claim_invalid');
  }
}

function claimsRetainedFamily(value: string): boolean {
  return normalizedClaimText(value).includes('semantic-shadow-retained-');
}

function claimsRetainedV2(value: string): boolean {
  return normalizedClaimText(value).includes(RETAINED_VERSION);
}

function normalizedClaimText(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded.replace(/\\+u([0-9a-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
  }
  return decoded;
}

export function parseSemanticShadowJsonRejectDuplicateKeys(value: string): unknown {
  new DuplicateKeyJsonScanner(value).validate();
  return JSON.parse(value);
}

class DuplicateKeyJsonScanner {
  private index = 0;

  constructor(private readonly input: string) {}

  validate(): void {
    this.readValue();
    this.skipWhitespace();
    if (this.index !== this.input.length) {throw new Error('json_trailing_content');}
  }

  private readValue(): void {
    this.skipWhitespace();
    const token = this.input[this.index];
    if (token === '{') {this.readObject(); return;}
    if (token === '[') {this.readArray(); return;}
    if (token === '"') {this.readString(); return;}
    if (token === '-' || (token >= '0' && token <= '9')) {this.readNumber(); return;}
    for (const literal of ['true', 'false', 'null']) {
      if (this.input.startsWith(literal, this.index)) {this.index += literal.length; return;}
    }
    throw new Error('json_value_invalid');
  }

  private readObject(): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.input[this.index] === '}') {this.index += 1; return;}
    while (this.index < this.input.length) {
      this.skipWhitespace();
      const key = this.readString();
      if (keys.has(key)) {throw new Error('json_duplicate_key');}
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.index] !== ':') {throw new Error('json_colon_missing');}
      this.index += 1;
      this.readValue();
      this.skipWhitespace();
      if (this.input[this.index] === '}') {this.index += 1; return;}
      if (this.input[this.index] !== ',') {throw new Error('json_object_separator_missing');}
      this.index += 1;
    }
    throw new Error('json_object_unterminated');
  }

  private readArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === ']') {this.index += 1; return;}
    while (this.index < this.input.length) {
      this.readValue();
      this.skipWhitespace();
      if (this.input[this.index] === ']') {this.index += 1; return;}
      if (this.input[this.index] !== ',') {throw new Error('json_array_separator_missing');}
      this.index += 1;
    }
    throw new Error('json_array_unterminated');
  }

  private readString(): string {
    if (this.input[this.index] !== '"') {throw new Error('json_string_missing');}
    const start = this.index;
    this.index += 1;
    while (this.index < this.input.length) {
      const token = this.input[this.index];
      if (token === '\\') {this.index += 2; continue;}
      this.index += 1;
      if (token === '"') {return JSON.parse(this.input.slice(start, this.index)) as string;}
    }
    throw new Error('json_string_unterminated');
  }

  private readNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.input.slice(this.index));
    if (!match) {throw new Error('json_number_invalid');}
    this.index += match[0].length;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? '')) {this.index += 1;}
  }
}

function validateRequirements(
  requirements: SemanticShadowReportRequirements | undefined
): ReadonlyMap<string, SemanticShadowReportExpectedCase> {
  if (requirements === undefined) {return new Map();}
  if (!HASH_PATTERN.test(requirements.corpus_sha256) || !Array.isArray(requirements.cases) ||
      requirements.cases.length !== SEMANTIC_SHADOW_REPORT_REQUIRED_QUESTION_GROUPS) {
    throw new Error('semantic_shadow_report_requirements_invalid');
  }
  const cases = new Map<string, SemanticShadowReportExpectedCase>();
  for (const expected of requirements.cases) {
    if (!expected || !HASH_PATTERN.test(expected.question_sha256) ||
        !['answer', 'clarify', 'abstain'].includes(expected.outcome) ||
        typeof expected.reason !== 'string' || expected.reason.length === 0 ||
        (expected.topology_code !== undefined && (typeof expected.topology_code !== 'string' || expected.topology_code.length === 0)) ||
        (expected.source_set_code !== undefined && (typeof expected.source_set_code !== 'string' || expected.source_set_code.length === 0)) ||
        (expected.provider_raw_candidate_set_sha256 !== undefined &&
          !HASH_PATTERN.test(expected.provider_raw_candidate_set_sha256)) ||
        (expected.hashes !== undefined && Object.entries(expected.hashes).some(([key, value]) =>
          key.length === 0 || typeof value !== 'string' || !HASH_PATTERN.test(value)))) {
      throw new Error('semantic_shadow_report_requirements_invalid');
    }
    if (cases.has(expected.question_sha256)) {
      throw new Error('semantic_shadow_report_requirements_invalid');
    }
    cases.set(expected.question_sha256, expected);
  }
  return cases;
}

function addEvidenceBinding(
  retained: Record<string, unknown>,
  questionHash: string,
  requirements: SemanticShadowReportRequirements | undefined,
  expectedCases: ReadonlyMap<string, SemanticShadowReportExpectedCase>,
  runs: Set<string>,
  attempts: Set<string>,
  ordinals: Set<string>
): number {
  if (requirements === undefined) {return 0;}
  const binding = objectOrUndefined(retained.evidence_binding);
  if (!binding) {return 1;}
  const corpusHash = requiredString(binding.corpus_sha256, 'binding_corpus');
  const runHash = requiredString(binding.run_sha256, 'binding_run');
  const attemptHash = requiredString(binding.attempt_sha256, 'binding_attempt');
  const caseIndex = requiredCounter(binding.case_index, 'binding_case_index');
  const repetitionIndex = requiredCounter(binding.repetition_index, 'binding_repetition_index');
  const expected = requirements.cases[caseIndex];
  let failures = corpusHash === requirements.corpus_sha256 && expected?.question_sha256 === questionHash &&
    expectedCases.has(questionHash) && repetitionIndex < SEMANTIC_SHADOW_REPORT_REQUIRED_REPETITIONS &&
    binding.provider_raw_candidate_set_sha256 === expected?.provider_raw_candidate_set_sha256 ? 0 : 1;
  const ordinal = `${caseIndex}:${repetitionIndex}`;
  if (attempts.has(attemptHash) || ordinals.has(ordinal)) {failures += 1;}
  attempts.add(attemptHash);
  ordinals.add(ordinal);
  runs.add(runHash);
  return failures;
}

export function matchesSemanticShadowOracle(
  observation: Record<string, unknown>,
  expected: SemanticShadowReportExpectedCase | undefined
): boolean {
  if (!expected || observation.outcome !== expected.outcome || observation.reason !== expected.reason ||
      (expected.topology_code !== undefined && observation.topology_code !== expected.topology_code) ||
      (expected.source_set_code !== undefined && observation.source_set_code !== expected.source_set_code) ||
      (expected.operator_set_code !== undefined && observation.operator_set_code !== expected.operator_set_code) ||
      !containsExpectedFields(observation.candidate_counts, expected.candidate_counts) ||
      !containsExpectedFields(observation.plan_work, expected.plan_work) ||
      (expected.template_dual_status !== undefined &&
        objectOrUndefined(observation.template_dual)?.status !== expected.template_dual_status)) {
    return false;
  }
  if (!expected.hashes) {return true;}
  const hashes = objectOrUndefined(observation.hashes);
  return Boolean(hashes) && Object.entries(expected.hashes).every(([key, value]) => hashes![key] === value);
}

function containsExpectedFields(actual: unknown, expected: Readonly<Record<string, number | string>> | undefined): boolean {
  if (expected === undefined) {return true;}
  const object = objectOrUndefined(actual);
  return Boolean(object) && Object.entries(expected).every(([key, value]) => object![key] === value);
}

function addResolverCounters(retained: Record<string, unknown>, totals: MutableTotals): number {
  try {
    const transactionCount = requiredCounter(retained.resolver_transaction_count, 'resolver_transactions');
    const counters = asObject(retained.resolver_transaction_counters);
    const statementCount = requiredCounter(counters.statement_count, 'resolver_statements');
    const returnedRows = requiredCounter(counters.returned_row_count, 'resolver_returned_rows');
    const statements = asObject(counters.statements);
    const inventoryReads = requiredCounter(statements.driver_inventory_unscoped, 'driver_inventory_unscoped') +
      requiredCounter(statements.driver_inventory_scoped, 'driver_inventory_scoped');
    const eventReads = requiredCounter(statements.event_name, 'event_name') +
      requiredCounter(statements.event_round, 'event_round');
    const maximumReturnedRows =
      requiredCounter(statements.driver_inventory_unscoped, 'driver_inventory_unscoped') * 10_001 +
      requiredCounter(statements.driver_inventory_scoped, 'driver_inventory_scoped') * 10_001 +
      requiredCounter(statements.event_name, 'event_name') * 501 +
      requiredCounter(statements.event_round, 'event_round') * 2;
    totals.transactions += transactionCount;
    totals.statements += statementCount;
    totals.returned_rows += returnedRows;
    totals.inventory_reads += inventoryReads;
    totals.event_reads += eventReads;
    return statementCount <= transactionCount && statementCount === inventoryReads + eventReads &&
      returnedRows <= maximumReturnedRows ? 0 : 1;
  } catch {
    return 1;
  }
}

function withoutVolatileSemanticFields(observation: Record<string, unknown>): unknown {
  const stable = { ...observation };
  delete stable.latencies;
  return stable;
}

function latencyReport(values: readonly number[]): SemanticShadowLatencyReport {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    attempts: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    max_ms: sorted.at(-1) ?? null
  };
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function incrementOptional(counts: Map<string, number>, value: unknown): void {
  if (value !== undefined) {
    increment(counts, requiredString(value, 'aggregate_key'));
  }
}

function sortedCounts(counts: ReadonlyMap<string, number>): Counts {
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function requiredCounter(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`semantic_shadow_report_${field}_invalid`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`semantic_shadow_report_${field}_invalid`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  const object = objectOrUndefined(value);
  if (!object) {
    throw new Error('semantic_shadow_report_object_invalid');
  }
  return object;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const object = objectOrUndefined(value);
  if (object) {
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
