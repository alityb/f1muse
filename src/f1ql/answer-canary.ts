import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ANSWER_CANARY_POLICY_VERSION,
  getAnswerCanaryHmacKeySha256,
  isVerifiedAnswerReleaseAttestation,
  VerifiedAnswerReleaseAttestation,
  verifyVerifiedAnswerReleaseAttestationValidity
} from './answer-release-attestation';

export const ANSWER_CANARY_STAGES = [0, 1, 5, 25, 50, 100] as const;
export type AnswerCanaryStage = (typeof ANSWER_CANARY_STAGES)[number];
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AnswerCanaryInput {
  readonly kill_switch: boolean;
  readonly stage: number;
  readonly template_id?: string;
  readonly deployment_template_ids?: readonly string[];
  readonly attestation?: VerifiedAnswerReleaseAttestation;
  readonly subject_id?: string;
  readonly hmac_key_base64?: string;
  readonly now_ms?: number;
}

export type AnswerCanaryDecision = Readonly<{
  cohort: 'control' | 'canary';
  reason: 'kill_switch' | 'attestation_absent' | 'template_not_allowed' | 'stage_not_attested' | 'key_not_attested' | 'stage_zero' | 'staged_control' | 'staged_canary' | 'full_release';
  stage: AnswerCanaryStage | null;
}>;

export class AnswerCanaryError extends Error {
  constructor(readonly code: 'invalid_canary_configuration') {
    super(code);
    this.name = 'AnswerCanaryError';
  }
}

export function selectAnswerCanaryCohort(input: AnswerCanaryInput): AnswerCanaryDecision {
  const subjectDecision = selectAnswerCanarySubjectCohort(input);
  if (subjectDecision.cohort !== 'canary') {
    return subjectDecision;
  }
  const stage = subjectDecision.stage as AnswerCanaryStage;
  const attestation = input.attestation as VerifiedAnswerReleaseAttestation;
  const allowed = parseTemplateAllowlist(input.deployment_template_ids);
  if (typeof input.template_id !== 'string' || !allowed.has(input.template_id) || !attestation.allowed_template_ids.includes(input.template_id)) {
    return decision('control', 'template_not_allowed', stage);
  }
  return subjectDecision;
}

export function selectAnswerCanarySubjectCohort(input: AnswerCanaryInput): AnswerCanaryDecision {
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
  if (stage < 100 && input.attestation === undefined && input.subject_id === undefined && input.hmac_key_base64 === undefined) {
    invalidConfig();
  }
  if (!isVerifiedAnswerReleaseAttestation(input.attestation)) {
    return decision('control', 'attestation_absent', stage);
  }
  verifyVerifiedAnswerReleaseAttestationValidity(input.attestation, input.now_ms ?? Date.now());
  if (input.attestation.canary_policy_version !== ANSWER_CANARY_POLICY_VERSION || stage > input.attestation.maximum_canary_stage) {
    return decision('control', 'stage_not_attested', stage);
  }
  if (stage < 100) {
    const key = parseHmacKey(input.hmac_key_base64);
    if (!sameHash(getAnswerCanaryHmacKeySha256(input.hmac_key_base64), input.attestation.canary_hmac_key_sha256)) {
      return decision('control', 'key_not_attested', stage);
    }
    if (typeof input.subject_id !== 'string' || input.subject_id.length < 1 || input.subject_id.length > 256) {
      invalidConfig();
    }
    const digest = createHmac('sha256', key).update(`${ANSWER_CANARY_POLICY_VERSION}\0${input.subject_id}`, 'utf8').digest();
    const selected = digest.readBigUInt64BE(0) * 100n < BigInt(stage) * (1n << 64n);
    return selected
      ? decision('canary', 'staged_canary', stage)
      : decision('control', 'staged_control', stage);
  }
  return decision('canary', 'full_release', stage);
}

export function getAnswerCanaryStage(env: NodeJS.ProcessEnv = process.env): AnswerCanaryStage {
  const raw = env.F1QL_ANSWER_CANARY_STAGE ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
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

function parseHmacKey(raw: string | undefined): Buffer {
  try {
    if (!raw || raw.length > 1_000) {
      throw new Error('Invalid key');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.toString('base64') !== raw || key.byteLength < 32 || key.byteLength > 64) {
      throw new Error('Invalid key');
    }
    return key;
  } catch {
    invalidConfig();
  }
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
