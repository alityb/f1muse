import {
  AnswerEvaluationCase,
  AnswerEvaluationObservation,
  AnswerMetamorphicGroup,
  evaluateAnswerSelection,
  evaluateMetamorphicConsistency
} from './answer-evaluation';
import { AnswerObservationArtifact } from './answer-observations';

const REQUIRED_SOURCES = ['final_driver_standings', 'qualifying_classification', 'race_classification', 'race_date_metadata'] as const;
const REQUIRED_OPERATIONS = ['aggregate', 'rank', 'event_classification', 'qualifying_classification', 'event_metadata'] as const;

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
  artifact: {
    sha256: string;
    manifest_sha256: string;
    provider: 'anthropic' | 'openai-compatible';
    collected_at: string;
  };
  selection: ReturnType<typeof evaluateAnswerSelection>;
  metamorphic: ReturnType<typeof evaluateMetamorphicConsistency>;
  holdout_thresholds: {
    required_accuracy: 1;
    by_source: Record<(typeof REQUIRED_SOURCES)[number], SemanticThresholdResult>;
    by_operation: Record<(typeof REQUIRED_OPERATIONS)[number], SemanticThresholdResult>;
  };
  release_gates: {
    observations_complete: boolean;
    reasons_correct: boolean;
    unsafe_answers_zero: boolean;
    forbidden_answers_zero: boolean;
    candidate_recall_complete: boolean;
    canonical_links_complete: boolean;
    metamorphic_consistency_complete: boolean;
    holdout_source_thresholds_pass: boolean;
    holdout_operation_thresholds_pass: boolean;
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
  const selection = evaluateAnswerSelection(cases, artifact.observations);
  const metamorphic = evaluateMetamorphicConsistency(groups, artifact.observations);
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
    reasons_correct: selection.reason_correct === selection.total,
    unsafe_answers_zero: selection.unsafe_answers === 0,
    forbidden_answers_zero: forbiddenAnswers === 0,
    candidate_recall_complete: selection.candidate_entities_recalled === selection.candidate_entities_total,
    canonical_links_complete: selection.complete_links_correct === selection.complete_links_total,
    metamorphic_consistency_complete: metamorphic.groups_complete === metamorphic.groups_total && metamorphic.groups_consistent === metamorphic.groups_total,
    holdout_source_thresholds_pass: sourceStatuses.every(status => status === 'pass'),
    holdout_operation_thresholds_pass: operationStatuses.every(status => status === 'pass')
  };
  const coreGatesPass = release.observations_complete && release.reasons_correct && release.unsafe_answers_zero && release.forbidden_answers_zero &&
    release.candidate_recall_complete && release.canonical_links_complete && release.metamorphic_consistency_complete;
  return {
    version: 1,
    kind: 'f1ql_answer_observation_report',
    artifact: {
      sha256: artifactSha256,
      manifest_sha256: artifact.manifest.sha256,
      provider: artifact.provider.type,
      collected_at: artifact.provider.collected_at
    },
    selection,
    metamorphic,
    holdout_thresholds: { required_accuracy: 1, by_source: bySource, by_operation: byOperation },
    release_gates: { ...release, status: releaseStatus(coreGatesPass, thresholdStatuses) }
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
