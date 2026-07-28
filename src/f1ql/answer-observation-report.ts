import {
  AnswerEvaluationCase,
  AnswerEvaluationObservation,
  AnswerMetamorphicGroup,
  evaluateAnswerSelection,
  evaluateMetamorphicConsistency
} from './answer-evaluation';
import { ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE, AnswerObservationArtifact, isVerifiedAnswerObservationArtifact } from './answer-observations';
import { ProviderDiagnosticCode } from './translator';
import { ANSWER_PROVIDER_DIAGNOSTIC_CODES, AnswerProviderDiagnosticCode } from './answer-translator';
import { ANSWER_TEMPLATE_IDS, AnswerTemplateId } from './answer-templates';
import { getF1QLProgramHash } from './verified-programs';

const REQUIRED_SOURCES = ['current_driver_standings', 'final_driver_standings', 'qualifying_classification', 'race_classification', 'race_date_metadata'] as const;
const REQUIRED_OPERATIONS = ['aggregate', 'rank', 'event_classification', 'qualifying_classification', 'event_metadata'] as const;
const PROOF_REJECTION_REASONS = ['season_mismatch', 'event_mismatch', 'session_mismatch', 'metric_mismatch', 'status_mismatch', 'entity_cardinality_mismatch', 'template_mismatch'] as const;
export const ANSWER_TRANSLATION_P95_BUDGET_MS = 5_000;
export const ANSWER_TRANSLATION_MAX_BUDGET_MS = 10_000;

interface SemanticThresholdResult {
  cases: number;
  action_correct: number;
  reason_correct: number;
  normalized_program_exact: number;
  required_accuracy: 1;
  status: 'pass' | 'fail' | 'insufficient';
}

export interface AnswerObservationReport {
  version: 3;
  kind: 'f1ql_answer_observation_report';
  artifact: { version: AnswerObservationArtifact['version']; observations: number; sha256: string; manifest_sha256: string };
  contract: {
    question_version: string;
    intent_version: string;
    translator_prompt_hash: string;
    translator_schema_hash: string;
    template_version: string;
    template_registry_hash: string;
    proof_version: string;
    status: 'pass' | 'insufficient';
  };
  provider_evidence: {
    provider: string;
    endpoint_sha256: string;
    reasoning_effort: string;
    status: 'pass' | 'insufficient';
  };
  translation_outcomes: { attempted: number; deterministic: number };
  selection: ReturnType<typeof evaluateAnswerSelection>;
  metamorphic: ReturnType<typeof evaluateMetamorphicConsistency>;
  translation_latency: {
    observations: number;
    required_observations: number;
    p95_ms: number | null;
    max_ms: number | null;
    p95_budget_ms: typeof ANSWER_TRANSLATION_P95_BUDGET_MS;
    max_budget_ms: typeof ANSWER_TRANSLATION_MAX_BUDGET_MS;
    status: 'pass' | 'fail' | 'insufficient';
  };
  translation_timeouts: {
    observations: number;
    required_observations: number;
    timed_out: number;
    maximum_timeouts: 0;
    status: 'pass' | 'fail' | 'insufficient';
  };
  provider_diagnostics: {
    observations: number;
    counts: Record<AnswerProviderDiagnosticCode, number>;
  };
  proof_rejections: { observations: number; counts: Record<(typeof PROOF_REJECTION_REASONS)[number], number> };
  reliability: {
    required_observations_per_case: typeof ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE;
    answerable_cases: number;
    required_observations: number;
    supplied_observations: number;
    complete_cases: number;
    action: { exact_cases: number; drift_cases: number };
    reason: { exact_cases: number; drift_cases: number };
    template_id: { exact_cases: number; drift_cases: number };
    program_hash: { exact_cases: number; drift_cases: number };
    status: 'pass' | 'fail' | 'insufficient';
  };
  templates: Record<AnswerTemplateId, { cases: number; non_development_cases: number; exact: number; proof_complete: number }>;
  holdout_thresholds: {
    required_accuracy: 1;
    by_source: Record<(typeof REQUIRED_SOURCES)[number], SemanticThresholdResult>;
    by_operation: Record<(typeof REQUIRED_OPERATIONS)[number], SemanticThresholdResult>;
  };
  release_gates: {
    observations_complete: boolean;
    actions_correct: boolean;
    reasons_correct: boolean;
    unsafe_answers_zero: boolean;
    forbidden_answers_zero: boolean;
    candidate_recall_complete: boolean;
    canonical_links_complete: boolean;
    metamorphic_consistency_complete: boolean;
    holdout_source_thresholds_pass: boolean;
    holdout_operation_thresholds_pass: boolean;
    translation_latency_budget_pass: boolean;
    translation_timeout_budget_pass: boolean;
    provider_diagnostics_zero: boolean;
    exact_templates_complete: boolean;
    exact_programs_complete: boolean;
    semantic_proofs_complete: boolean;
    repetition_completeness: boolean;
    repeated_exactness: boolean;
    zero_repetition_drift: boolean;
    status: 'pass' | 'fail' | 'insufficient';
  };
}

export function buildAnswerObservationReport(
  cases: readonly AnswerEvaluationCase[],
  groups: readonly AnswerMetamorphicGroup[],
  artifact: AnswerObservationArtifact,
  artifactSha256: string
): AnswerObservationReport {
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw new Error('invalid_answer_observation_artifact_hash');
  }
  if ((artifact.version === 3 || artifact.version === 4) && !isVerifiedAnswerObservationArtifact(artifact)) {
    throw new Error('unverified_answer_observation_artifact');
  }
  const primaryObservations = artifact.version === 4
    ? artifact.observations.filter(observation => observation.observation_index === 0)
    : artifact.observations;
  const selection = evaluateAnswerSelection(cases, primaryObservations);
  const metamorphic = evaluateMetamorphicConsistency(groups, primaryObservations);
  const translationLatency = translationLatencyReport(artifact);
  const translationTimeouts = translationTimeoutReport(artifact);
  const providerDiagnostics = providerDiagnosticReport(artifact);
  const proofRejections = proofRejectionReport(artifact);
  const reliability = reliabilityReport(cases, artifact);
  const templates = templateReport(cases, artifact);
  const holdout = cases.filter(item => item.split !== 'development' && item.expected.action === 'answer');
  const bySource = thresholdGroups(REQUIRED_SOURCES, holdout, primaryObservations, item => item.expected.reason);
  const byOperation = thresholdGroups(REQUIRED_OPERATIONS, holdout, primaryObservations, expectedOperation);
  const sourceStatuses = Object.values(bySource).map(result => result.status);
  const operationStatuses = Object.values(byOperation).map(result => result.status);
  const thresholdStatuses = [...sourceStatuses, ...operationStatuses];
  const forbiddenIds = new Set(cases.filter(item => item.expected.action !== 'answer').map(item => item.id));
  const forbiddenAnswers = artifact.observations.filter(observation => forbiddenIds.has(observation.id) && observation.action === 'answer').length;
  const repeatedChecks = allObservationChecks(cases, artifact);
  const release = {
    observations_complete: selection.observations_missing === 0,
    actions_correct: selection.action_correct === selection.total,
    reasons_correct: selection.reason_correct === selection.total,
    unsafe_answers_zero: repeatedChecks.unsafe_answers_zero,
    forbidden_answers_zero: forbiddenAnswers === 0,
    candidate_recall_complete: repeatedChecks.candidate_recall_complete,
    canonical_links_complete: repeatedChecks.canonical_links_complete,
    metamorphic_consistency_complete: metamorphic.groups_complete === metamorphic.groups_total && metamorphic.groups_consistent === metamorphic.groups_total,
    holdout_source_thresholds_pass: sourceStatuses.every(status => status === 'pass'),
    holdout_operation_thresholds_pass: operationStatuses.every(status => status === 'pass'),
    translation_latency_budget_pass: translationLatency.status === 'pass',
    translation_timeout_budget_pass: translationTimeouts.status === 'pass',
    provider_diagnostics_zero: providerDiagnostics.observations === 0,
    exact_templates_complete: Object.values(templates).every(value => value.exact === value.cases),
    exact_programs_complete: selection.normalized_program_exact === selection.normalized_program_total,
    semantic_proofs_complete: (artifact.version === 3 || artifact.version === 4) && Object.values(templates).every(value => value.proof_complete === value.cases),
    repetition_completeness: artifact.version === 4 && reliability.complete_cases === reliability.answerable_cases && reliability.supplied_observations === reliability.required_observations,
    repeated_exactness: artifact.version === 4 && [reliability.action, reliability.reason, reliability.template_id, reliability.program_hash]
      .every(value => value.exact_cases === reliability.answerable_cases),
    zero_repetition_drift: artifact.version === 4 && [reliability.action, reliability.reason, reliability.template_id, reliability.program_hash]
      .every(value => value.drift_cases === 0)
  };
  const coreGatesPass = release.observations_complete && release.actions_correct && release.reasons_correct && release.unsafe_answers_zero && release.forbidden_answers_zero &&
    release.candidate_recall_complete && release.canonical_links_complete && release.metamorphic_consistency_complete &&
    release.provider_diagnostics_zero && release.exact_programs_complete &&
    ((artifact.version !== 3 && artifact.version !== 4) || (release.exact_templates_complete && release.semantic_proofs_complete));
  const hardenedEvidenceStatus: SemanticThresholdResult['status'] = artifact.version === 3 || artifact.version === 4 ? 'pass' : 'insufficient';
  return {
    version: 3,
    kind: 'f1ql_answer_observation_report',
    artifact: { version: artifact.version, observations: artifact.observations.length, sha256: artifactSha256, manifest_sha256: artifact.manifest.sha256 },
    contract: contractReport(artifact),
    provider_evidence: providerEvidenceReport(artifact),
    translation_outcomes: translationOutcomeReport(artifact),
    selection,
    metamorphic,
    translation_latency: translationLatency,
    translation_timeouts: translationTimeouts,
    provider_diagnostics: providerDiagnostics,
    proof_rejections: proofRejections,
    reliability,
    templates,
    holdout_thresholds: { required_accuracy: 1, by_source: bySource, by_operation: byOperation },
    release_gates: { ...release, status: releaseStatus(coreGatesPass, [...thresholdStatuses, translationLatency.status, translationTimeouts.status, hardenedEvidenceStatus, reliability.status]) }
  };
}

function providerEvidenceReport(artifact: AnswerObservationArtifact): AnswerObservationReport['provider_evidence'] {
  if (artifact.version !== 3 && artifact.version !== 4) {
    return { provider: artifact.provider.type, endpoint_sha256: '', reasoning_effort: '', status: 'insufficient' };
  }
  return {
    provider: artifact.provider.type,
    endpoint_sha256: artifact.provider.endpoint_sha256,
    reasoning_effort: artifact.provider.reasoning_effort,
    status: 'pass'
  };
}

function proofRejectionReport(artifact: AnswerObservationArtifact): AnswerObservationReport['proof_rejections'] {
  const counts = Object.fromEntries(PROOF_REJECTION_REASONS.map(reason => [reason, 0])) as AnswerObservationReport['proof_rejections']['counts'];
  let observations = 0;
  for (const observation of artifact.observations) {
    if ((PROOF_REJECTION_REASONS as readonly string[]).includes(observation.reason)) {
      counts[observation.reason as (typeof PROOF_REJECTION_REASONS)[number]]++;
      observations++;
    }
  }
  return { observations, counts };
}

function contractReport(artifact: AnswerObservationArtifact): AnswerObservationReport['contract'] {
  if (artifact.version !== 3 && artifact.version !== 4) {
    return { question_version: '', intent_version: '', translator_prompt_hash: '', translator_schema_hash: '', template_version: '', template_registry_hash: '', proof_version: '', status: 'insufficient' };
  }
  return { ...artifact.contract, status: 'pass' };
}

function translationOutcomeReport(artifact: AnswerObservationArtifact): AnswerObservationReport['translation_outcomes'] {
  if (artifact.version !== 3 && artifact.version !== 4) {
    return { attempted: artifact.observations.length, deterministic: 0 };
  }
  const attempted = artifact.observations.filter(observation => observation.translation_attempted).length;
  return { attempted, deterministic: artifact.observations.length - attempted };
}

function providerDiagnosticReport(artifact: AnswerObservationArtifact): AnswerObservationReport['provider_diagnostics'] {
  const counts = Object.fromEntries(ANSWER_PROVIDER_DIAGNOSTIC_CODES.map(code => [code, 0])) as Record<AnswerProviderDiagnosticCode, number>;
  let observations = 0;
  for (const observation of artifact.observations) {
    if (observation.provider_diagnostic_code !== undefined) {
      counts[normalizeDiagnostic(observation.provider_diagnostic_code)]++;
      observations++;
    }
  }
  return { observations, counts };
}

function normalizeDiagnostic(code: ProviderDiagnosticCode | AnswerProviderDiagnosticCode): AnswerProviderDiagnosticCode {
  const mapping: Record<ProviderDiagnosticCode, AnswerProviderDiagnosticCode> = {
    transport_error: 'transport', http_auth: 'auth', http_quota: 'quota', http_rate_limit: 'rate_limit', http_client: 'client', http_server: 'server',
    response_oversized: 'oversize', response_json_malformed: 'malformed', tool_call_missing: 'incomplete', tool_call_multiple: 'schema_invalid',
    tool_name_invalid: 'schema_invalid', tool_arguments_invalid: 'schema_invalid', generation_incomplete: 'incomplete', request_timeout: 'request_timeout'
  };
  return (ANSWER_PROVIDER_DIAGNOSTIC_CODES as readonly string[]).includes(code) ? code as AnswerProviderDiagnosticCode : mapping[code as ProviderDiagnosticCode];
}

function templateReport(cases: readonly AnswerEvaluationCase[], artifact: AnswerObservationArtifact): AnswerObservationReport['templates'] {
  return Object.fromEntries(ANSWER_TEMPLATE_IDS.map(templateId => {
    const selected = cases.filter(item => item.expected.template_id === templateId);
    const exact = selected.filter(item => observationsForCase(artifact, item.id).every(observation => observation.action === 'answer' && 'template_id' in observation && observation.template_id === templateId)).length;
    const proofComplete = selected.filter(item => observationsForCase(artifact, item.id).every(observation => 'proof_status' in observation && observation.proof_status === 'passed')).length;
    return [templateId, { cases: selected.length, non_development_cases: selected.filter(item => item.split !== 'development').length, exact, proof_complete: proofComplete }];
  })) as AnswerObservationReport['templates'];
}

function reliabilityReport(cases: readonly AnswerEvaluationCase[], artifact: AnswerObservationArtifact): AnswerObservationReport['reliability'] {
  const answerable = cases.filter(item => item.answerable);
  const required = answerable.length * ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE;
  if (artifact.version !== 4) {
    return {
      required_observations_per_case: ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE,
      answerable_cases: answerable.length,
      required_observations: required,
      supplied_observations: answerable.reduce((count, item) => count + observationsForCase(artifact, item.id).length, 0),
      complete_cases: 0,
      action: { exact_cases: 0, drift_cases: 0 },
      reason: { exact_cases: 0, drift_cases: 0 },
      template_id: { exact_cases: 0, drift_cases: 0 },
      program_hash: { exact_cases: 0, drift_cases: 0 },
      status: 'insufficient'
    };
  }
  const fields = {
    action: { exact_cases: 0, drift_cases: 0 },
    reason: { exact_cases: 0, drift_cases: 0 },
    template_id: { exact_cases: 0, drift_cases: 0 },
    program_hash: { exact_cases: 0, drift_cases: 0 }
  };
  let supplied = 0;
  let complete = 0;
  let knownWrong = false;
  for (const item of answerable) {
    const observations = observationsForCase(artifact, item.id);
    supplied += observations.length;
    complete += Number(observations.length === ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE);
    const acceptableHashes = (item.expected.acceptable_programs ?? []).map(getF1QLProgramHash);
    const expectations = {
      action: (value: unknown) => value === item.expected.action,
      reason: (value: unknown) => value === item.expected.reason,
      template_id: (value: unknown) => value === item.expected.template_id,
      program_hash: (value: unknown) => typeof value === 'string' && acceptableHashes.includes(value)
    };
    for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
      const values = observations.map(observation => repeatedField(observation, field));
      fields[field].exact_cases += Number(values.length === ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE && values.every(expectations[field]));
      fields[field].drift_cases += Number(new Set(values.map(value => JSON.stringify(value))).size > 1);
      knownWrong ||= values.some(value => !expectations[field](value));
    }
  }
  const allExact = Object.values(fields).every(value => value.exact_cases === answerable.length);
  const zeroDrift = Object.values(fields).every(value => value.drift_cases === 0);
  let status: AnswerObservationReport['reliability']['status'];
  if (knownWrong || !zeroDrift) {
    status = 'fail';
  } else if (complete !== answerable.length || supplied !== required) {
    status = 'insufficient';
  } else {
    status = allExact ? 'pass' : 'fail';
  }
  return {
    required_observations_per_case: ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE,
    answerable_cases: answerable.length,
    required_observations: required,
    supplied_observations: supplied,
    complete_cases: complete,
    ...fields,
    status
  };
}

function repeatedField(observation: AnswerObservationArtifact['observations'][number], field: 'action' | 'reason' | 'template_id' | 'program_hash'): unknown {
  if (field === 'action' || field === 'reason') {
    return observation[field];
  }
  if (field === 'template_id') {
    return 'template_id' in observation ? observation.template_id : undefined;
  }
  return 'program_hash' in observation ? observation.program_hash : undefined;
}

function allObservationChecks(cases: readonly AnswerEvaluationCase[], artifact: AnswerObservationArtifact): {
  unsafe_answers_zero: boolean;
  candidate_recall_complete: boolean;
  canonical_links_complete: boolean;
} {
  let unsafeAnswers = 0;
  let candidatesComplete = true;
  let linksComplete = true;
  for (const item of cases) {
    for (const observation of observationsForCase(artifact, item.id)) {
      const acceptableHashes = (item.expected.acceptable_programs ?? []).map(getF1QLProgramHash);
      const observedHash = observationProgramHash(observation);
      if (observation.action === 'answer' && (item.expected.action !== 'answer' || observedHash === undefined || !acceptableHashes.includes(observedHash))) {
        unsafeAnswers++;
      }
      candidatesComplete &&= item.canonical_entities.every(entity => observation.entity_candidates.includes(entity));
      if ((item.acceptable_linked_entities ?? []).length > 0) {
        linksComplete &&= item.acceptable_linked_entities!.some(expected => sameStringSet(expected, observation.linked_entities));
      }
    }
  }
  return { unsafe_answers_zero: unsafeAnswers === 0, candidate_recall_complete: candidatesComplete, canonical_links_complete: linksComplete };
}

function observationProgramHash(observation: AnswerObservationArtifact['observations'][number]): string | undefined {
  if ('program_hash' in observation && observation.program_hash !== undefined) {
    return observation.program_hash;
  }
  return 'program' in observation && observation.program !== undefined ? getF1QLProgramHash(observation.program) : undefined;
}

function observationsForCase(artifact: AnswerObservationArtifact, id: string): readonly AnswerObservationArtifact['observations'][number][] {
  return artifact.observations.filter(observation => observation.id === id);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function translationTimeoutReport(artifact: AnswerObservationArtifact): AnswerObservationReport['translation_timeouts'] {
  const attempted = artifact.version === 3 || artifact.version === 4 ? artifact.observations.filter(observation => observation.translation_attempted) : artifact.observations;
  const observed = attempted.filter(observation => observation.translation_timed_out !== undefined);
  const timedOut = observed.filter(observation => observation.translation_timed_out).length;
  let status: AnswerObservationReport['translation_timeouts']['status'] = 'insufficient';
  if (timedOut > 0) {
    status = 'fail';
  } else if (observed.length === attempted.length && attempted.length > 0) {
    status = 'pass';
  }
  return {
    observations: observed.length,
    required_observations: attempted.length,
    timed_out: timedOut,
    maximum_timeouts: 0,
    status
  };
}

function translationLatencyReport(artifact: AnswerObservationArtifact): AnswerObservationReport['translation_latency'] {
  const attempted = artifact.version === 3 || artifact.version === 4 ? artifact.observations.filter(observation => observation.translation_attempted) : artifact.observations;
  const latencies = attempted
    .map(observation => observation.translation_latency_ms)
    .filter((latency): latency is number => latency !== undefined)
    .sort((left, right) => left - right);
  const complete = latencies.length === attempted.length && attempted.length > 0;
  const p95 = latencies.length === 0 ? null : latencies[Math.ceil(latencies.length * 0.95) - 1];
  const maximum = latencies.length === 0 ? null : latencies[latencies.length - 1];
  const requiredP95Rank = Math.ceil(attempted.length * 0.95);
  const allowedAboveP95 = attempted.length - requiredP95Rank;
  const observedAboveP95 = latencies.filter(latency => latency > ANSWER_TRANSLATION_P95_BUDGET_MS).length;
  let status: AnswerObservationReport['translation_latency']['status'] = 'insufficient';
  if ((maximum !== null && maximum > ANSWER_TRANSLATION_MAX_BUDGET_MS) || observedAboveP95 > allowedAboveP95) {
    status = 'fail';
  } else if (complete && p95 !== null && maximum !== null) {
    status = p95 <= ANSWER_TRANSLATION_P95_BUDGET_MS && maximum <= ANSWER_TRANSLATION_MAX_BUDGET_MS ? 'pass' : 'fail';
  }
  return {
    observations: latencies.length,
    required_observations: attempted.length,
    p95_ms: p95,
    max_ms: maximum,
    p95_budget_ms: ANSWER_TRANSLATION_P95_BUDGET_MS,
    max_budget_ms: ANSWER_TRANSLATION_MAX_BUDGET_MS,
    status
  };
}

function thresholdGroups<Key extends string>(
  requiredKeys: readonly Key[],
  cases: readonly AnswerEvaluationCase[],
  observations: readonly AnswerEvaluationObservation[],
  keyFor: (item: AnswerEvaluationCase) => string | undefined
): Record<Key, SemanticThresholdResult> {
  return Object.fromEntries(requiredKeys.map(key => {
    const selectedCases = cases.filter(item => keyFor(item) === key);
    if (selectedCases.length === 0) {
      return [key, thresholdResult(0, 0, 0, 0)];
    }
    const ids = new Set(selectedCases.map(item => item.id));
    const report = evaluateAnswerSelection(selectedCases, observations.filter(observation => ids.has(observation.id)));
    return [key, thresholdResult(selectedCases.length, report.action_correct, report.reason_correct, report.normalized_program_exact)];
  })) as Record<Key, SemanticThresholdResult>;
}

function thresholdResult(cases: number, actionCorrect: number, reasonCorrect: number, programExact: number): SemanticThresholdResult {
  let status: SemanticThresholdResult['status'];
  if (cases === 0) {
    status = 'insufficient';
  } else {
    status = actionCorrect === cases && reasonCorrect === cases && programExact === cases ? 'pass' : 'fail';
  }
  return { cases, action_correct: actionCorrect, reason_correct: reasonCorrect, normalized_program_exact: programExact, required_accuracy: 1, status };
}

function releaseStatus(coreGatesPass: boolean, thresholds: SemanticThresholdResult['status'][]): AnswerObservationReport['release_gates']['status'] {
  if (!coreGatesPass || thresholds.includes('fail')) {
    return 'fail';
  }
  return thresholds.includes('insufficient') ? 'insufficient' : 'pass';
}

function expectedOperation(item: AnswerEvaluationCase): string | undefined {
  const operations = [...new Set((item.expected.acceptable_programs ?? []).map(program => program.root.op))];
  return operations.length === 1 ? operations[0] : undefined;
}
