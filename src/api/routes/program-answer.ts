import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool, PoolClient } from 'pg';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../../identity/answer-identity-resolvers';
import { AnswerAuthorizationError, AnswerPrincipalClass, buildAnswerExecutionAuthorization } from '../../f1ql/answer-authorization';
import { AnswerBoundError, enforceVerifiedAnswerWorkBudget } from '../../f1ql/answer-bounds';
import { getAnswerCanaryStage, selectAnswerCanaryCohort, selectAnswerCanarySubjectCohort } from '../../f1ql/answer-canary';
import { AnswerExecutionResult, executeAuthorizedAnswer } from '../../f1ql/answer-execution';
import { AnswerReleaseVerificationInput, loadAnswerReleaseVerificationInput, VerifiedAnswerReleaseAttestation, verifyAnswerReleaseAttestation } from '../../f1ql/answer-release-attestation';
import { AnswerAdmissionController, AnswerAdmissionError, AnswerRuntimeConfig, getAnswerRuntimeConfig } from '../../f1ql/answer-runtime';
import { AnswerIntent, parseAnswerIntent } from '../../f1ql/answer-intent';
import { AnswerQuestionContract, AnswerQuestionError, createAnswerQuestionContract } from '../../f1ql/answer-question';
import { AnswerSemanticProofError, proveAnswerIntent, VerifiedAnswerSemanticProof } from '../../f1ql/answer-semantic-proof';
import { AnswerIntentModel, AnswerProviderConfigurationError, AnswerTranslationResult, createAnswerIntentModel, translateAnswerQuestion } from '../../f1ql/answer-translator';
import { F1QLLinkingError } from '../../f1ql/translation-linking';
import { F1QLRequestDeadlineError, F1QLResultLimitError, F1QLStatementTimeoutError } from '../../f1ql/executor';
import { metrics } from '../../observability/metrics';

export interface ProgramAnswerDependencies {
  modelFactory?: () => AnswerIntentModel;
  translate?: (contract: AnswerQuestionContract, model: AnswerIntentModel, signal?: AbortSignal) => Promise<AnswerTranslationResult>;
  releaseVerification?: AnswerReleaseVerificationInput | (() => AnswerReleaseVerificationInput | Promise<AnswerReleaseVerificationInput>);
  runtimeConfig?: AnswerRuntimeConfig;
  admission?: AnswerAdmissionController;
  environment?: () => NodeJS.ProcessEnv;
  now?: () => number;
  execute?: typeof executeAuthorizedAnswer;
}

export function createProgramAnswerRoutes(pool: Pool | undefined, dependencies: ProgramAnswerDependencies = {}): Router {
  const router = Router();
  const config = dependencies.runtimeConfig ?? getAnswerRuntimeConfig();
  const admission = dependencies.admission ?? new AnswerAdmissionController(config);
  const environment = dependencies.environment ?? (() => process.env);
  const now = dependencies.now ?? Date.now;
  const answerRateLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'answer_unavailable', reason: 'rate_limit_exceeded' }
  });

  router.post('/program/answer', answerAvailabilityGuard(environment), answerRateLimiter, answerPrincipalGuard(environment), answerQuestionGuard, async (req: Request, res: Response) => {
    const contract = res.locals.answerQuestionContract as AnswerQuestionContract;
    if (contract.outcome.type !== 'inspection_required') {
      return respondToQuestionOutcome(contract.outcome, res);
    }
    let canaryStage: number;
    try {
      const liveEnvironment = environment();
      canaryStage = getAnswerCanaryStage(liveEnvironment);
      if (liveEnvironment.F1QL_ANSWER_KILL_SWITCH === 'true') {
        return killSwitchResponse(res);
      }
      if (canaryStage === 0) {
        metrics.recordF1QLAnswer('execution', 'blocked', 'canary_control');
        return res.status(503).json({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
      }
    } catch {
      metrics.recordF1QLAnswer('gate', 'blocked', 'release_not_approved');
      return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
    }
    const release = await resolveReleaseAttestation(dependencies.releaseVerification, config, environment(), now());
    if (!release || !runtimeMatchesAttestation(config, release.attestation)) {
      metrics.recordF1QLAnswer('gate', 'blocked', 'release_not_approved');
      return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
    }
    try {
      const liveEnvironment = environment();
      const subjectCanary = selectAnswerCanarySubjectCohort({
        kill_switch: liveEnvironment.F1QL_ANSWER_KILL_SWITCH === 'true',
        stage: getAnswerCanaryStage(liveEnvironment),
        attestation: release.attestation,
        subject_id: res.locals.answerCanarySubject as string,
        hmac_key_base64: liveEnvironment.F1QL_ANSWER_CANARY_HMAC_KEY_BASE64,
        now_ms: now()
      });
      if (subjectCanary.reason === 'kill_switch') {
        return killSwitchResponse(res);
      }
      if (subjectCanary.cohort !== 'canary') {
        metrics.recordF1QLAnswer('execution', 'blocked', 'canary_control');
        return res.status(503).json({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
      }
    } catch {
      metrics.recordF1QLAnswer('gate', 'blocked', 'release_not_approved');
      return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
    }
    if (!pool) {
      metrics.recordF1QLAnswer('gate', 'blocked', 'answer_database_not_configured');
      return res.status(503).json({ error: 'answer_unavailable', reason: 'answer_database_not_configured' });
    }
    const requestId = answerRequestId(res);
    const controller = new AbortController();
    const requestDeadlineMs = now() + config.requestTimeoutMs;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.requestTimeoutMs);
    const abortOnDisconnect = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);

    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = await admission.acquire(controller.signal);

      let model: AnswerIntentModel;
      try {
        model = (dependencies.modelFactory ?? createAnswerIntentModel)();
      } catch (error) {
        return res.status(503).json({ error: 'answer_unavailable', reason: error instanceof AnswerProviderConfigurationError ? 'unsupported_provider' : 'provider_error' });
      }
      const translation = await (dependencies.translate ?? translateAnswerQuestion)(contract, model, controller.signal)
        .catch((): AnswerTranslationResult => ({ type: 'provider_unavailable', reason: 'provider_error' }));
      if (controller.signal.aborted) {
        return respondToAbort(timedOut, res);
      }
      if (translation.type !== 'intent_candidate') {
        metrics.recordF1QLAnswer('translation', translation.type, translation.reason);
        return respondToTranslationOutcome(translation, res);
      }

      let reparsedIntent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>;
      try {
        const parsed = parseAnswerIntent(translation.intent, contract);
        if (parsed.type === 'clarification' || parsed.type === 'unsupported') {
          return res.status(503).json({ error: 'answer_unavailable', reason: 'invalid_response' });
        }
        reparsedIntent = parsed;
      } catch {
        return res.status(503).json({ error: 'answer_unavailable', reason: 'invalid_response' });
      }

      let proof: VerifiedAnswerSemanticProof;
      try {
        proof = await proveWithBounds(pool, contract, reparsedIntent, config.statementTimeoutMs, requestDeadlineMs, now, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return respondToAbort(timedOut, res);
        }
        if (error instanceof F1QLLinkingError) {
          metrics.recordF1QLAnswer('linking', 'rejected', error.code);
          return respondToLinkingError(error, res);
        }
        if (error instanceof AnswerSemanticProofError) {
          metrics.recordF1QLAnswer('linking', 'rejected', error.reason);
          return res.status(422).json({ error: 'capability_unsupported', reason: error.reason });
        }
        if (error instanceof F1QLRequestDeadlineError) {
          return res.status(504).json({ error: 'answer_unavailable', reason: 'request_timeout' });
        }
        if (error instanceof F1QLStatementTimeoutError) {
          return res.status(504).json({ error: 'answer_unavailable', reason: 'statement_timeout' });
        }
        return res.status(503).json({ error: 'answer_unavailable', reason: 'linking_unavailable' });
      }
      if (controller.signal.aborted) {
        return respondToAbort(timedOut, res);
      }

      try {
        enforceVerifiedAnswerWorkBudget(proof, config.maxWorkUnits, config.maxRows);
      } catch (error) {
        if (error instanceof AnswerBoundError) {
          metrics.recordF1QLAnswer('bounds', 'rejected', error.bound);
          return res.status(422).json({ error: 'answer_bound_exceeded', reason: error.bound });
        }
        return res.status(500).json({ error: 'answer_failed', reason: 'budget_estimation_failed' });
      }

      try {
        const liveEnvironment = environment();
        const canary = selectAnswerCanaryCohort({
          kill_switch: liveEnvironment.F1QL_ANSWER_KILL_SWITCH === 'true',
          stage: getAnswerCanaryStage(liveEnvironment),
          template_id: proof.template_id,
          deployment_template_ids: release.verification.active_context.deployment_template_ids,
          attestation: release.attestation,
          subject_id: res.locals.answerCanarySubject as string,
          hmac_key_base64: liveEnvironment.F1QL_ANSWER_CANARY_HMAC_KEY_BASE64,
          now_ms: now()
        });
        if (canary.reason === 'kill_switch') {
          return killSwitchResponse(res);
        }
        if (canary.cohort !== 'canary') {
          metrics.recordF1QLAnswer('execution', 'blocked', 'canary_control');
          return res.status(503).json({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
        }
      } catch {
        return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
      }

      let authorization;
      try {
        authorization = buildAnswerExecutionAuthorization(requestId, res.locals.answerPrincipalClass as AnswerPrincipalClass, proof, release.attestation, now());
      } catch (error) {
        if (error instanceof AnswerAuthorizationError && error.code === 'release_expired') {
          return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
        }
        return res.status(500).json({
          error: 'answer_failed',
          reason: error instanceof AnswerAuthorizationError ? 'authorization_envelope_failed' : 'unexpected_error'
        });
      }

      try {
        const result: AnswerExecutionResult = await (dependencies.execute ?? executeAuthorizedAnswer)(pool, authorization, proof, {
          request_id: requestId,
          audience: release.attestation.audience,
          deployment_id: release.attestation.deployment_id,
          release_attestation: release.attestation,
          is_kill_switch_active: () => environment().F1QL_ANSWER_KILL_SWITCH === 'true'
        }, { now, signal: controller.signal, deadlineMs: requestDeadlineMs });
        if (controller.signal.aborted) {
          return respondToAbort(timedOut, res);
        }
        metrics.recordF1QLAnswer('execution', 'succeeded', proof.template_id);
        return res.status(200).type('application/json').send(result.serialized_response);
      } catch (error) {
        if (controller.signal.aborted) {
          return respondToAbort(timedOut, res);
        }
        if (error instanceof AnswerAuthorizationError) {
          if (error.code === 'kill_switch_active') {
            return killSwitchResponse(res);
          }
          metrics.recordF1QLAnswer('execution', 'blocked', error.code);
          return res.status(503).json({ error: 'answer_unavailable', reason: 'release_not_approved' });
        }
        if (error instanceof AnswerBoundError || error instanceof F1QLResultLimitError) {
          const bound = error instanceof AnswerBoundError ? error.bound : 'rows';
          metrics.recordF1QLAnswer('bounds', 'rejected', bound);
          return res.status(422).json({ error: 'answer_bound_exceeded', reason: bound });
        }
        if (error instanceof F1QLStatementTimeoutError || error instanceof F1QLRequestDeadlineError) {
          metrics.recordF1QLAnswer('execution', 'failed', 'statement_timeout');
          return res.status(504).json({
            error: 'answer_unavailable',
            reason: error instanceof F1QLRequestDeadlineError ? 'request_timeout' : 'statement_timeout'
          });
        }
        metrics.recordF1QLAnswer('execution', 'failed', 'execution_failed');
        return res.status(500).json({ error: 'answer_failed', reason: 'execution_failed' });
      }
    } catch (error) {
      if (error instanceof AnswerAdmissionError) {
        if (error.reason === 'request_cancelled') {
          return respondToAbort(timedOut, res);
        }
        return res.status(503).json({ error: 'answer_unavailable', reason: error.reason });
      }
      return res.status(500).json({ error: 'answer_failed', reason: 'unexpected_error' });
    } finally {
      releaseAdmission?.();
      clearTimeout(timeout);
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
    }
  });

  return router;
}

function answerPrincipalGuard(environment: () => NodeJS.ProcessEnv) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
  const env = environment();
  const expected = env.F1QL_ANSWER_INTERNAL_TOKEN;
  const expectedCanary = env.F1QL_ANSWER_INTERNAL_CANARY_TOKEN;
  if (!expected || expected.length < 32 ||
      (expectedCanary !== undefined && (expectedCanary.length < 32 || expectedCanary === expected))) {
    metrics.recordF1QLAnswer('gate', 'blocked', 'answer_auth_not_configured');
    return res.status(503).json({ error: 'answer_unavailable', reason: 'answer_auth_not_configured' });
  }
  const authorization = req.get('authorization');
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  const canaryBytes = expectedCanary === undefined ? undefined : Buffer.from(expectedCanary);
  const primaryMatches = suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
  const canaryMatches = canaryBytes !== undefined && suppliedBytes.length === canaryBytes.length && timingSafeEqual(suppliedBytes, canaryBytes);
  if (!primaryMatches && !canaryMatches) {
    metrics.recordF1QLAnswer('gate', 'rejected', 'answer_authentication_required');
    return res.status(401).json({ error: 'answer_unauthorized', reason: 'answer_authentication_required' });
  }
  const matchedBytes = canaryMatches ? canaryBytes as Buffer : expectedBytes;
  res.locals.answerCanarySubject = createHash('sha256').update(matchedBytes).digest('hex');
  res.locals.answerPrincipalClass = canaryMatches ? 'internal_canary' : 'internal';
  next();
  };
}

function answerRequestId(res: Response): string {
  if (typeof res.locals.requestId === 'string') {
    return res.locals.requestId;
  }
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  return requestId;
}

function respondToAbort(timedOut: boolean, res: Response): Response | void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  return res.status(timedOut ? 504 : 499).json({
    error: 'answer_unavailable',
    reason: timedOut ? 'request_timeout' : 'request_cancelled'
  });
}

async function proveWithBounds(
  pool: Pool,
  contract: AnswerQuestionContract,
  intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>,
  statementTimeoutMs: number,
  deadlineMs: number,
  now: () => number,
  signal: AbortSignal
): Promise<VerifiedAnswerSemanticProof> {
  const client = await acquireClient(pool, signal);
  try {
    await client.query('BEGIN READ ONLY');
    const boundedClient = deadlineBoundClient(client, deadlineMs, statementTimeoutMs, now, signal);
    const proof = await proveAnswerIntent(contract, intent, new AnswerEventIdentityResolver(boundedClient), new AnswerDriverIdentityResolver(boundedClient));
    await client.query('ROLLBACK');
    return proof;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function deadlineBoundClient(client: PoolClient, deadlineMs: number, statementTimeoutMs: number, now: () => number, signal: AbortSignal): PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (signal.aborted) {
        throw new AnswerAdmissionError('request_cancelled');
      }
      const remaining = Math.floor(deadlineMs - now());
      if (remaining < 1) {
        throw new F1QLRequestDeadlineError();
      }
      const deadlineLimited = remaining <= statementTimeoutMs;
      const timeoutMs = Math.min(remaining, statementTimeoutMs);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
      try {
        return await client.query(sql, params);
      } catch (error) {
        if ((error as { code?: string }).code === '57014') {
          throw deadlineLimited ? new F1QLRequestDeadlineError() : new F1QLStatementTimeoutError(timeoutMs);
        }
        throw error;
      }
    }
  } as PoolClient;
}

async function resolveReleaseAttestation(
  configured: ProgramAnswerDependencies['releaseVerification'],
  config: AnswerRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  nowMs: number
): Promise<{ attestation: VerifiedAnswerReleaseAttestation; verification: AnswerReleaseVerificationInput } | undefined> {
  try {
    const verification = typeof configured === 'function'
      ? await configured()
      : configured ?? loadAnswerReleaseVerificationInput(config, environment);
    const attestation = verifyAnswerReleaseAttestation(
      verification.raw_attestation,
      verification.trusted_key,
      verification.active_context,
      { ...verification.temporal_policy, now_ms: nowMs }
    );
    return { attestation, verification };
  } catch {
    return undefined;
  }
}

function runtimeMatchesAttestation(config: AnswerRuntimeConfig, attestation: VerifiedAnswerReleaseAttestation): boolean {
  const runtime = attestation.runtime_evidence;
  return runtime.max_concurrency === config.maxConcurrency &&
    runtime.queue_timeout_ms === config.queueTimeoutMs &&
    runtime.request_timeout_ms === config.requestTimeoutMs &&
    runtime.rate_limit_max === config.rateLimitMax &&
    runtime.rate_limit_window_ms === config.rateLimitWindowMs &&
    runtime.statement_timeout_ms === config.statementTimeoutMs &&
    runtime.max_work_units === config.maxWorkUnits &&
    runtime.max_rows === config.maxRows &&
    runtime.max_response_bytes === config.maxResponseBytes;
}

function acquireClient(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  if (signal.aborted) {
    return Promise.reject(new AnswerAdmissionError('request_cancelled'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new AnswerAdmissionError('request_cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pool.connect().then(client => {
      if (settled) {
        client.release();
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(client);
    }, error => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function answerAvailabilityGuard(environment: () => NodeJS.ProcessEnv) {
  return (_req: Request, res: Response, next: NextFunction): Response | void => {
  const env = environment();
  if (env.F1QL_ANSWER_KILL_SWITCH === 'true') {
    return killSwitchResponse(res);
  }
  if (env.F1QL_ANSWER_ENABLED !== 'true') {
    metrics.recordF1QLAnswer('gate', 'blocked', 'answer_disabled');
    return res.status(503).json({ error: 'answer_unavailable', reason: 'answer_disabled' });
  }
  next();
  };
}

function killSwitchResponse(res: Response): Response {
  metrics.recordF1QLAnswer('gate', 'blocked', 'kill_switch_active');
  return res.status(503).json({ error: 'answer_unavailable', reason: 'kill_switch_active' });
}

function answerQuestionGuard(req: Request, res: Response, next: NextFunction): Response | void {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !Object.prototype.hasOwnProperty.call(req.body, 'question')) {
    metrics.recordF1QLAnswer('input', 'rejected', 'question_invalid');
    return res.status(400).json({ error: 'answer_invalid', reason: 'question_invalid' });
  }
  try {
    res.locals.answerQuestionContract = createAnswerQuestionContract(req.body.question);
  } catch (error) {
    if (error instanceof AnswerQuestionError) {
      metrics.recordF1QLAnswer('input', 'rejected', 'question_invalid');
      return res.status(400).json({ error: 'answer_invalid', reason: 'question_invalid' });
    }
    throw error;
  }
  next();
}

function respondToTranslationOutcome(translation: Exclude<AnswerTranslationResult, { type: 'intent_candidate' }>, res: Response): Response {
  if (translation.type === 'provider_unavailable') {
    return res.status(503).json({ error: 'answer_unavailable', reason: translation.reason });
  }
  if (translation.type === 'clarification_required') {
    return clarificationResponse(translation.reason, res);
  }
  return res.status(422).json({ error: 'capability_unsupported', reason: translation.reason });
}

function respondToQuestionOutcome(outcome: Exclude<AnswerQuestionContract['outcome'], { type: 'inspection_required' }>, res: Response): Response {
  if (outcome.type === 'clarification_required') {
    return clarificationResponse(outcome.reason, res);
  }
  return res.status(422).json({ error: 'capability_unsupported', reason: outcome.reason });
}

function clarificationResponse(reason: string, res: Response, options?: readonly string[]): Response {
  const questions: Record<string, string> = {
    season_missing: 'Which season did you mean?',
    session_ambiguous: 'Did you mean the race or qualifying?',
    metric_ambiguous: 'Did you mean points or official championship position?',
    event_ambiguous: 'Which event did you mean?',
    entity_ambiguous: 'Which driver did you mean?'
  };
  const boundedOptions = options?.slice(0, 5);
  return res.status(422).json({ error: 'clarification_required', reason, question: questions[reason] ?? 'Please clarify the question.', ...(boundedOptions ? { options: boundedOptions } : {}) });
}

function respondToLinkingError(error: F1QLLinkingError, res: Response): Response {
  if (error.code === 'event_ambiguous' || error.code === 'entity_ambiguous') {
    return clarificationResponse(error.code, res, error.options);
  }
  return res.status(422).json({ error: 'capability_unsupported', reason: error.code });
}
