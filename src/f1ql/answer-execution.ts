import { Pool } from 'pg';
import {
  AnswerAuthorizationConsumptionContext,
  AnswerAuthorizationError,
  VerifiedAnswerExecutionAuthorization,
  assertAnswerExecutionAuthorizationActive,
  consumeAnswerExecutionAuthorization
} from './answer-authorization';
import { enforceAnswerRows, enforceVerifiedAnswerWorkBudget, serializeAnswerResponse } from './answer-bounds';
import { buildAnswerEnvelope, AnswerEnvelope } from './answer-format';
import { AnswerCapability, authorizeAnswerProgram } from './answer-policy';
import { VerifiedAnswerSemanticProof, verifyAnswerSemanticProof } from './answer-semantic-proof';
import { executeAnswerF1QL } from './executor';
import { getF1QLProgramHash, normalizeF1QLProgram } from './verified-programs';

export interface AnswerExecutionResult {
  readonly response: AnswerEnvelope;
  readonly serialized_response: string;
}

export interface AnswerExecutionOptions {
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export async function executeAuthorizedAnswer(
  pool: Pool,
  authorization: VerifiedAnswerExecutionAuthorization,
  proofInput: VerifiedAnswerSemanticProof,
  context: AnswerAuthorizationConsumptionContext,
  options: AnswerExecutionOptions = {}
): Promise<AnswerExecutionResult> {
  const proof = verifyAnswerSemanticProof(proofInput);
  const program = normalizeF1QLProgram(proof.program);
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved' || !authorizationMatchesProof(authorization, proof, decision.capability)) {
    throw new AnswerAuthorizationError('authorization_binding_mismatch');
  }

  const runtime = context.release_attestation.runtime_ceilings;
  const now = options.now ?? Date.now;
  enforceVerifiedAnswerWorkBudget(proof, runtime.max_work_units, runtime.max_rows);
  const result = await executeAnswerF1QL(pool, program, () => {
    consumeAnswerExecutionAuthorization(authorization, context, now());
  }, () => {
    assertAnswerExecutionAuthorizationActive(authorization, context, now());
  }, () => {
    assertAnswerExecutionAuthorizationActive(authorization, context, now());
  }, {
    statementTimeoutMs: runtime.statement_timeout_ms,
    maxRows: runtime.max_rows,
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    now
  });
  enforceAnswerRows(result.rows, runtime.max_rows);
  const response = buildAnswerEnvelope(result.program, decision.capability, result.rows);
  const serializedResponse = serializeAnswerResponse(response, runtime.max_response_bytes);
  assertAnswerExecutionAuthorizationActive(authorization, context, now());
  return { response, serialized_response: serializedResponse };
}

function authorizationMatchesProof(
  authorization: VerifiedAnswerExecutionAuthorization,
  proof: VerifiedAnswerSemanticProof,
  capability: AnswerCapability
): boolean {
  return authorization.question_hash === proof.question_hash &&
    authorization.intent_hash === proof.intent_hash &&
    authorization.proof_hash === proof.proof_hash &&
    authorization.template_id === proof.template_id &&
    authorization.template_version === proof.template_version &&
    authorization.template_registry_hash === proof.template_registry_hash &&
    authorization.program_hash === proof.program_hash &&
    authorization.program_hash === getF1QLProgramHash(proof.program) &&
    JSON.stringify(authorization.capability) === JSON.stringify(capability);
}
