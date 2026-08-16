import { AnswerEvaluationCase, AnswerMetamorphicGroup, evaluateAnswerSelection, evaluateMetamorphicConsistency } from './answer-evaluation';
import { AnswerDerivationEvidenceArtifact, isVerifiedAnswerDerivationEvidence } from './answer-derivation-evidence';

export interface AnswerDerivationReport {
  readonly version: 1;
  readonly kind: 'f1ql_answer_derivation_report';
  readonly evidence: { readonly artifact_sha256: string; readonly manifest_sha256: string; readonly observations: number };
  readonly counts: {
    readonly cases: number;
    readonly actions_correct: number;
    readonly reasons_correct: number;
    readonly programs_exact: number;
    readonly programs_required: number;
    readonly templates_exact: number;
    readonly proofs_complete: number;
    readonly candidates_recalled: number;
    readonly candidates_required: number;
    readonly canonical_links_correct: number;
    readonly canonical_links_required: number;
    readonly metamorphic_groups_consistent: number;
    readonly metamorphic_groups_required: number;
    readonly unsafe_answers: number;
    readonly forbidden_answers: number;
    readonly missing_observations: number;
  };
  readonly release_gates: {
    readonly observations_complete: boolean;
    readonly actions_and_reasons_exact: boolean;
    readonly templates_programs_and_proofs_exact: boolean;
    readonly candidate_recall_complete: boolean;
    readonly canonical_links_complete: boolean;
    readonly metamorphic_groups_complete: boolean;
    readonly unsafe_and_forbidden_answers_zero: boolean;
    readonly status: 'pass' | 'fail';
  };
}

export function buildAnswerDerivationReport(
  cases: readonly AnswerEvaluationCase[],
  groups: readonly AnswerMetamorphicGroup[],
  artifact: AnswerDerivationEvidenceArtifact,
  artifactSha256: string
): AnswerDerivationReport {
  if (!isVerifiedAnswerDerivationEvidence(artifact)) {
    throw new Error('answer_derivation_report_unverified_artifact');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw new Error('answer_derivation_report_artifact_hash_invalid');
  }
  const selection = evaluateAnswerSelection(cases, artifact.observations);
  const metamorphic = evaluateMetamorphicConsistency(groups, artifact.observations);
  const answerCases = cases.filter(item => item.expected.action === 'answer');
  const templatesExact = answerCases.filter(item => artifact.observations.some(observation =>
    observation.id === item.id && observation.action === 'answer' && observation.template_id === item.expected.template_id)).length;
  const proofsComplete = answerCases.filter(item => artifact.observations.some(observation =>
    observation.id === item.id && observation.action === 'answer' && observation.proof_hash !== undefined)).length;
  const forbiddenIds = new Set(cases.filter(item => item.expected.action !== 'answer').map(item => item.id));
  const forbiddenAnswers = artifact.observations.filter(item => forbiddenIds.has(item.id) && item.action === 'answer').length;
  const counts = {
    cases: cases.length,
    actions_correct: selection.action_correct,
    reasons_correct: selection.reason_correct,
    programs_exact: selection.normalized_program_exact,
    programs_required: selection.normalized_program_total,
    templates_exact: templatesExact,
    proofs_complete: proofsComplete,
    candidates_recalled: selection.candidate_entities_recalled,
    candidates_required: selection.candidate_entities_total,
    canonical_links_correct: selection.complete_links_correct,
    canonical_links_required: selection.complete_links_total,
    metamorphic_groups_consistent: metamorphic.groups_consistent,
    metamorphic_groups_required: metamorphic.groups_total,
    unsafe_answers: selection.unsafe_answers,
    forbidden_answers: forbiddenAnswers,
    missing_observations: selection.observations_missing
  };
  const gates = {
    observations_complete: counts.missing_observations === 0 && artifact.observations.length === cases.length,
    actions_and_reasons_exact: counts.actions_correct === 112 && counts.reasons_correct === 112 && counts.cases === 112,
    templates_programs_and_proofs_exact: counts.templates_exact === 77 && counts.programs_exact === 77 && counts.programs_required === 77 && counts.proofs_complete === 77,
    candidate_recall_complete: counts.candidates_recalled === counts.candidates_required,
    canonical_links_complete: counts.canonical_links_correct === counts.canonical_links_required,
    metamorphic_groups_complete: metamorphic.groups_complete === metamorphic.groups_total && counts.metamorphic_groups_consistent === counts.metamorphic_groups_required,
    unsafe_and_forbidden_answers_zero: counts.unsafe_answers === 0 && counts.forbidden_answers === 0
  };
  return {
    version: 1,
    kind: 'f1ql_answer_derivation_report',
    evidence: { artifact_sha256: artifactSha256, manifest_sha256: artifact.manifest.sha256, observations: artifact.observations.length },
    counts,
    release_gates: { ...gates, status: Object.values(gates).every(Boolean) ? 'pass' : 'fail' }
  };
}
