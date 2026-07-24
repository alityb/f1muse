import {
  AnswerEvaluationCase,
  AnswerEvaluationObservation,
  AnswerMetamorphicGroup,
  evaluateAnswerSelection,
  evaluateMetamorphicConsistency
} from './answer-evaluation';
import { AnswerObservationArtifact, isVerifiedAnswerObservationArtifact } from './answer-observations';
import { ProviderDiagnosticCode } from './translator';
import { ANSWER_PROVIDER_DIAGNOSTIC_CODES, AnswerProviderDiagnosticCode } from './answer-translator';
import { ANSWER_TEMPLATE_IDS, AnswerTemplateId } from './answer-templates';

const REQUIRED_SOURCES = ['final_driver_standings', 'qualifying_classification', 'race_classification', 'race_date_metadata'] as const;
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
  version: 1;
  kind: 'f1ql_answer_observation_report';
  artifact: { version: 1 | 2 | 3; observations: number; sha256: string; manifest_sha256: string };
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
  if (artifact.version === 3 && !isVerifiedAnswerObservationArtifact(artifact)) {
    throw new Error('unverified_answer_observation_artifact');
  }
  const selection = evaluateAnswerSelection(cases, artifact.observations);
  const metamorphic = evaluateMetamorphicConsistency(groups, artifact.observations);
  const translationLatency = translationLatencyReport(artifact);
  const translationTimeouts = translationTimeoutReport(artifact);
  const providerDiagnostics = providerDiagnosticReport(artifact);
  const proofRejections = proofRejectionReport(artifact);
  const templates = templateReport(cases, artifact);
  const holdout = cases.filter(item => item.split !== 'development' && item.expected.action === 'answer');
  const bySource = thresholdGroups(REQUIRED_SOURCES, holdout, artifact.observations, item => item.expected.reason);
  const byOperation = thresholdGroups(REQUIRED_OPERATIONS, holdout, artifact.observations, expectedOperation);
  const sourceStatuses = Object.values(bySource).map(result => result.status);
  const operationStatuses = Object.values(byOperation).map(result => result.status);
  const thresholdStatuses = [...sourceStatuses, ...operationStatuses];
  const forbiddenIds = new Set(cases.filter(item => item.expected.action !== 'answer').map(item => item.id));
  const forbiddenAnswers = artifact.observations.filter(observation => forbiddenIds.has(observation.id) && observation.action === 'answer').length;
  const release = {
    observations_complete: selection.observations_missing === 0,
    actions_correct: selection.action_correct === selection.total,
    reasons_correct: selection.reason_correct === selection.total,
    unsafe_answers_zero: selection.unsafe_answers === 0,
    forbidden_answers_zero: forbiddenAnswers === 0,
    candidate_recall_complete: selection.candidate_entities_recalled === selection.candidate_entities_total,
    canonical_links_complete: selection.complete_links_correct === selection.complete_links_total,
    metamorphic_consistency_complete: metamorphic.groups_complete === metamorphic.groups_total && metamorphic.groups_consistent === metamorphic.groups_total,
    holdout_source_thresholds_pass: sourceStatuses.every(status => status === 'pass'),
    holdout_operation_thresholds_pass: operationStatuses.every(status => status === 'pass'),
    translation_latency_budget_pass: translationLatency.status === 'pass',
    translation_timeout_budget_pass: translationTimeouts.status === 'pass',
    provider_diagnostics_zero: providerDiagnostics.observations === 0,
    exact_templates_complete: Object.values(templates).every(value => value.exact === value.cases),
    exact_programs_complete: selection.normalized_program_exact === selection.normalized_program_total,
    semantic_proofs_complete: artifact.version === 3 && Object.values(templates).every(value => value.proof_complete === value.cases)
  };
  const coreGatesPass = release.observations_complete && release.actions_correct && release.reasons_correct && release.unsafe_answers_zero && release.forbidden_answers_zero &&
    release.candidate_recall_complete && release.canonical_links_complete && release.metamorphic_consistency_complete &&
    release.provider_diagnostics_zero && release.exact_programs_complete && (artifact.version !== 3 || (release.exact_templates_complete && release.semantic_proofs_complete));
  const hardenedEvidenceStatus: SemanticThresholdResult['status'] = artifact.version === 3 ? 'pass' : 'insufficient';
  return {
    version: 1,
    kind: 'f1ql_answer_observation_report',
    artifact: { version: artifact.version, observations: artifact.observations.length, sha256: artifactSha256, manifest_sha256: artifact.manifest.sha256 },
    contract: contractReport(artifact),
    translation_outcomes: translationOutcomeReport(artifact),
    selection,
    metamorphic,
    translation_latency: translationLatency,
    translation_timeouts: translationTimeouts,
    provider_diagnostics: providerDiagnostics,
    proof_rejections: proofRejections,
    templates,
    holdout_thresholds: { required_accuracy: 1, by_source: bySource, by_operation: byOperation },
    release_gates: { ...release, status: releaseStatus(coreGatesPass, [...thresholdStatuses, translationLatency.status, translationTimeouts.status, hardenedEvidenceStatus]) }
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
  if (artifact.version !== 3) {
    return { question_version: '', intent_version: '', translator_prompt_hash: '', translator_schema_hash: '', template_version: '', template_registry_hash: '', proof_version: '', status: 'insufficient' };
  }
  return { ...artifact.contract, status: 'pass' };
}

function translationOutcomeReport(artifact: AnswerObservationArtifact): AnswerObservationReport['translation_outcomes'] {
  if (artifact.version !== 3) {
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
    const ids = new Set(selected.map(item => item.id));
    const observations = artifact.observations.filter(item => ids.has(item.id));
    const exact = observations.filter(item => item.action === 'answer' && 'template_id' in item && item.template_id === templateId).length;
    const proofComplete = observations.filter(item => 'proof_status' in item && item.proof_status === 'passed').length;
    return [templateId, { cases: selected.length, non_development_cases: selected.filter(item => item.split !== 'development').length, exact, proof_complete: proofComplete }];
  })) as AnswerObservationReport['templates'];
}

function translationTimeoutReport(artifact: AnswerObservationArtifact): AnswerObservationReport['translation_timeouts'] {
  const attempted = artifact.version === 3 ? artifact.observations.filter(observation => observation.translation_attempted) : artifact.observations;
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
  const attempted = artifact.version === 3 ? artifact.observations.filter(observation => observation.translation_attempted) : artifact.observations;
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
