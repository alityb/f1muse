import {
  isVerifiedAnswerReleaseAttestation,
  VerifiedAnswerReleaseAttestation
} from './answer-release-attestation';

export const ANSWER_CANARY_STAGES = [0, 100] as const;
export type AnswerCanaryStage = (typeof ANSWER_CANARY_STAGES)[number];
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AnswerCanaryInput {
  readonly kill_switch: boolean;
  readonly stage: number;
  readonly template_id?: string;
  readonly deployment_template_ids?: readonly string[];
  readonly attestation?: VerifiedAnswerReleaseAttestation;
}

export type AnswerCanaryDecision = Readonly<{
  cohort: 'control' | 'canary';
  reason: 'kill_switch' | 'attestation_absent' | 'template_not_allowed' | 'stage_zero' | 'full_release';
  stage: AnswerCanaryStage | null;
}>;

export class AnswerCanaryError extends Error {
  constructor(readonly code: 'invalid_canary_configuration') {
    super(code);
    this.name = 'AnswerCanaryError';
  }
}

export function selectAnswerCanaryCohort(input: AnswerCanaryInput): AnswerCanaryDecision {
  if (input?.kill_switch === true) {
    return decision('control', 'kill_switch', null);
  }
  if (!input || input.kill_switch !== false || !ANSWER_CANARY_STAGES.includes(input.stage as AnswerCanaryStage)) {
    invalidConfig();
  }
  const stage = input.stage as AnswerCanaryStage;
  if (stage === 0) {
    return decision('control', 'stage_zero', stage);
  }
  if (!isVerifiedAnswerReleaseAttestation(input.attestation)) {
    return decision('control', 'attestation_absent', stage);
  }
  const allowed = parseTemplateAllowlist(input.deployment_template_ids);
  if (typeof input.template_id !== 'string' || !allowed.has(input.template_id) || !input.attestation.allowed_template_ids.includes(input.template_id)) {
    return decision('control', 'template_not_allowed', stage);
  }
  return decision('canary', 'full_release', stage);
}

export function getAnswerCanaryStage(env: NodeJS.ProcessEnv = process.env): AnswerCanaryStage {
  const raw = env.F1QL_ANSWER_CANARY_STAGE ?? '0';
  if (!/^\d+$/.test(raw)) {
    invalidConfig();
  }
  const stage = Number(raw);
  if (!ANSWER_CANARY_STAGES.includes(stage as AnswerCanaryStage)) {
    invalidConfig();
  }
  return stage as AnswerCanaryStage;
}

function parseTemplateAllowlist(input: readonly string[] | undefined): Set<string> {
  if (!Array.isArray(input) || input.length === 0 ||
      input.some((value, index) => typeof value !== 'string' || !TEMPLATE_ID.test(value) || (index > 0 && input[index - 1] >= value)) ||
      new Set(input).size !== input.length) {
    invalidConfig();
  }
  return new Set(input);
}

function decision(
  cohort: AnswerCanaryDecision['cohort'],
  reason: AnswerCanaryDecision['reason'],
  stage: AnswerCanaryDecision['stage']
): AnswerCanaryDecision {
  return Object.freeze({ cohort, reason, stage });
}

function invalidConfig(): never {
  throw new AnswerCanaryError('invalid_canary_configuration');
}
