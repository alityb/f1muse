import type { Pool } from 'pg';
import {
  OfficialTimingQuestionMatch,
  OfficialTimingQuestionRefusalReason,
  parseOfficialTimingQuestion
} from './official-timing-question';
import { AnswerQuestionError } from './answer-question';
import { enumerateOfficialTimingEvidence } from './official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolutionDependencies
} from './official-timing-resolution';
import { planOfficialTimingAnswer } from './official-timing-plan';
import { runOfficialTimingPlannedPipeline } from './official-timing-compiler';
import { proveOfficialTimingPlan } from './official-timing-proof';
import {
  authorizeOfficialTimingCapability,
  OfficialTimingAuthorizationError,
  OfficialTimingPrincipalClass,
  OfficialTimingReleaseBinding
} from './official-timing-authorization';
import {
  executeOfficialTimingPlan,
  OfficialTimingExecutionError
} from './official-timing-execution';
import {
  formatOfficialTimingResult,
  OfficialTimingSemanticEnvelope
} from './official-timing-format';

export const OFFICIAL_TIMING_ANSWER_ORCHESTRATOR_VERSION = 'official-timing-answer-v1' as const;

export interface OfficialTimingAnswerDependencies {
  readonly database: Pick<Pool, 'connect'>;
  readonly catalog: OfficialTimingResolutionDependencies['catalog'];
  readonly driver_resolver: OfficialTimingResolutionDependencies['driver_resolver'];
  readonly event_resolver: OfficialTimingResolutionDependencies['event_resolver'];
  readonly release: OfficialTimingReleaseBinding;
  readonly principal_class: OfficialTimingPrincipalClass;
  readonly canary: { readonly stage: number; readonly subject_id: string };
  readonly request_id: string;
  readonly statement_timeout_ms: number;
  readonly request_deadline_ms: number;
  readonly is_kill_switch_active: () => boolean;
  readonly now_ms?: number;
}

export type OfficialTimingAnswerOutcome =
  | { readonly type: 'answered'; readonly envelope: OfficialTimingSemanticEnvelope }
  | { readonly type: 'refused'; readonly reason: OfficialTimingQuestionRefusalReason | 'question_invalid' }
  | { readonly type: 'abstained'; readonly reason: 'source_coverage_missing' | 'source_integrity_failed' }
  | {
      readonly type: 'unavailable';
      readonly reason:
        | 'authorization_binding_mismatch' | 'authorization_expired' | 'authorization_replayed'
        | 'catalog_mismatch' | 'internal_failure' | 'kill_switch_active' | 'profile_not_released'
        | 'release_inactive' | 'routing_mode_inactive' | 'statement_timeout' | 'request_timeout';
    };

export async function answerOfficialTimingQuestion(
  questionInput: unknown,
  dependencies: OfficialTimingAnswerDependencies
): Promise<OfficialTimingAnswerOutcome> {
  const gate = preAnswerGate(questionInput, dependencies);
  if (gate.type !== 'matched') {
    return gate.outcome;
  }
  const question = gate.question;
  let evidence;
  try {
    evidence = enumerateOfficialTimingEvidence(question, dependencies.catalog);
  } catch {
    return deepFreeze({ type: 'unavailable', reason: 'internal_failure' });
  }
  let resolution;
  try {
    resolution = await collectOfficialTimingResolution(question, evidence, {
      database: dependencies.database,
      catalog: dependencies.catalog,
      driver_resolver: dependencies.driver_resolver,
      event_resolver: dependencies.event_resolver
    });
  } catch {
    return deepFreeze({ type: 'unavailable', reason: 'internal_failure' });
  }
  if (resolution.type === 'abstained') {
    return deepFreeze({ type: 'abstained', reason: resolution.coverage.reason });
  }
  try {
    return await executeAnswerChain(question, evidence, resolution, dependencies);
  } catch (error) {
    if ((dependencies.now_ms ?? Date.now()) >= dependencies.request_deadline_ms) {
      return deepFreeze({ type: 'unavailable', reason: 'request_timeout' });
    }
    return deepFreeze({ type: 'unavailable', reason: mapFailure(error) });
  }
}

function preAnswerGate(
  questionInput: unknown,
  dependencies: OfficialTimingAnswerDependencies
): { readonly type: 'matched'; readonly question: OfficialTimingQuestionMatch } | { readonly type: 'outcome'; readonly outcome: OfficialTimingAnswerOutcome } {
  let killSwitchActive: boolean;
  try {
    killSwitchActive = dependencies.is_kill_switch_active();
  } catch {
    return { type: 'outcome', outcome: deepFreeze({ type: 'unavailable', reason: 'internal_failure' }) };
  }
  if (killSwitchActive) {
    return { type: 'outcome', outcome: deepFreeze({ type: 'unavailable', reason: 'kill_switch_active' }) };
  }
  if ((dependencies.now_ms ?? Date.now()) >= dependencies.request_deadline_ms) {
    return { type: 'outcome', outcome: deepFreeze({ type: 'unavailable', reason: 'request_timeout' }) };
  }
  try {
    const parsed = parseOfficialTimingQuestion(questionInput);
    if (parsed.type !== 'matched') {
      return { type: 'outcome', outcome: deepFreeze({ type: 'refused', reason: parsed.reason }) };
    }
    return { type: 'matched', question: parsed };
  } catch (error) {
    // Only the typed normalization errors are caller-facing refusals; internal
    // FAIL_CLOSED invariant violations are unavailable/internal_failure.
    const outcome: OfficialTimingAnswerOutcome = error instanceof AnswerQuestionError
      ? { type: 'refused', reason: 'question_invalid' }
      : { type: 'unavailable', reason: 'internal_failure' };
    return { type: 'outcome', outcome: deepFreeze(outcome) };
  }
}

async function executeAnswerChain(
  question: OfficialTimingQuestionMatch,
  evidence: ReturnType<typeof enumerateOfficialTimingEvidence>,
  resolution: Extract<Awaited<ReturnType<typeof collectOfficialTimingResolution>>, { type: 'resolved' }>,
  dependencies: OfficialTimingAnswerDependencies
): Promise<OfficialTimingAnswerOutcome> {
  const plan = planOfficialTimingAnswer({ question, evidence, resolution });
  const pipeline = runOfficialTimingPlannedPipeline(plan);
  const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
  const authorization = authorizeOfficialTimingCapability({
    question, evidence, resolution, plan, pipeline, proof,
    request_id: dependencies.request_id,
    principal_class: dependencies.principal_class,
    canary: dependencies.canary,
    release: dependencies.release,
    now_ms: dependencies.now_ms
  });
  const execution = await executeOfficialTimingPlan(
    dependencies.database,
    authorization,
    pipeline.compiled,
    proof.proof_hash,
    pipeline.planned_core_hash,
    {
      request_id: dependencies.request_id,
      principal_class: dependencies.principal_class,
      statement_timeout_ms: dependencies.statement_timeout_ms,
      deadline_ms: dependencies.request_deadline_ms,
      is_kill_switch_active: dependencies.is_kill_switch_active,
      now_ms: dependencies.now_ms
    }
  );
  const envelope = formatOfficialTimingResult(execution, { question, resolution, plan, pipeline, proof });
  return deepFreeze({ type: 'answered', envelope });
}

function mapFailure(error: unknown): Extract<OfficialTimingAnswerOutcome, { type: 'unavailable' }>['reason'] {
  if (error instanceof OfficialTimingAuthorizationError) {
    const mapped: Record<string, Extract<OfficialTimingAnswerOutcome, { type: 'unavailable' }>['reason']> = {
      authorization_binding_mismatch: 'authorization_binding_mismatch',
      authorization_expired: 'authorization_expired',
      authorization_replayed: 'authorization_replayed',
      catalog_mismatch: 'catalog_mismatch',
      invalid_authorization: 'internal_failure',
      kill_switch_active: 'kill_switch_active',
      profile_not_released: 'profile_not_released',
      release_inactive: 'release_inactive',
      routing_mode_inactive: 'routing_mode_inactive'
    };
    return mapped[error.reason] ?? 'internal_failure';
  }
  if (error instanceof OfficialTimingExecutionError) {
    const mapped: Partial<Record<string, Extract<OfficialTimingAnswerOutcome, { type: 'unavailable' }>['reason']>> = {
      authorization_binding_mismatch: 'authorization_binding_mismatch',
      authorization_expired: 'authorization_expired',
      authorization_replayed: 'authorization_replayed',
      kill_switch_active: 'kill_switch_active',
      statement_timeout: 'statement_timeout'
    };
    return mapped[error.code] ?? 'internal_failure';
  }
  return 'internal_failure';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
