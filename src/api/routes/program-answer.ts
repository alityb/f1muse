import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool, PoolClient } from 'pg';
import { AnswerPolicyDecision, authorizeAnswerProgram } from '../../f1ql/answer-policy';
import { AnswerBoundError, enforceAnswerWorkBudget } from '../../f1ql/answer-bounds';
import { AnswerAdmissionController, AnswerAdmissionError, AnswerRuntimeConfig, getAnswerRuntimeConfig } from '../../f1ql/answer-runtime';
import { F1QLProgram } from '../../f1ql/ast';
import { F1QLLinkingError, linkF1QLCandidate } from '../../f1ql/translation-linking';
import { F1QLProgramCandidate } from '../../f1ql/translation-schema';
import { createF1QLTextModel, F1QLTextModel, F1QLTranslationResult, translateF1QLQuestion } from '../../f1ql/translator';
import { metrics } from '../../observability/metrics';

export interface ProgramAnswerDependencies {
  modelFactory?: () => F1QLTextModel;
  translate?: (question: string, model: F1QLTextModel, signal?: AbortSignal) => Promise<F1QLTranslationResult>;
  link?: (candidate: F1QLProgramCandidate) => Promise<F1QLProgram>;
  authorize?: (program: F1QLProgram) => AnswerPolicyDecision;
  runtimeConfig?: AnswerRuntimeConfig;
  admission?: AnswerAdmissionController;
}

export function createProgramAnswerRoutes(pool: Pool, dependencies: ProgramAnswerDependencies = {}): Router {
  const router = Router();
  const config = dependencies.runtimeConfig ?? getAnswerRuntimeConfig();
  const admission = dependencies.admission ?? new AnswerAdmissionController(config);
  const answerRateLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'answer_unavailable', reason: 'rate_limit_exceeded' }
  });

  router.post('/program/answer', answerAvailabilityGuard, answerQuestionGuard, answerRateLimiter, async (req: Request, res: Response) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const controller = new AbortController();
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

    let release: (() => void) | undefined;
    try {
      release = await admission.acquire(controller.signal);

      let model: F1QLTextModel;
      try {
        model = (dependencies.modelFactory ?? createF1QLTextModel)();
      } catch {
        return res.status(503).json({ error: 'answer_unavailable', reason: 'provider_error' });
      }
      const translation = await (dependencies.translate ?? translateF1QLQuestion)(question, model, controller.signal)
        .catch((): F1QLTranslationResult => ({ type: 'provider_unavailable', reason: 'provider_error' }));
      if (controller.signal.aborted) {
        return respondToAbort(timedOut, res);
      }
      if (translation.type !== 'program_candidate') {
        metrics.recordF1QLAnswer('translation', translation.type, translation.reason);
        return respondToTranslationOutcome(translation, res);
      }

      let program: F1QLProgram;
      try {
        program = await (dependencies.link ?? (candidate => linkWithBounds(pool, candidate, config.statementTimeoutMs, controller.signal)))(translation.program);
      } catch (error) {
        if (controller.signal.aborted) {
          return respondToAbort(timedOut, res);
        }
        if (error instanceof F1QLLinkingError) {
          metrics.recordF1QLAnswer('linking', 'rejected', error.code);
          return respondToLinkingError(error, res);
        }
        return res.status(503).json({ error: 'answer_unavailable', reason: 'linking_unavailable' });
      }
      if (controller.signal.aborted) {
        return respondToAbort(timedOut, res);
      }

      let decision: AnswerPolicyDecision;
      try {
        decision = (dependencies.authorize ?? authorizeAnswerProgram)(program);
      } catch {
        return res.status(500).json({ error: 'answer_failed', reason: 'authorization_failed' });
      }
      if (decision.type === 'rejected') {
        metrics.recordF1QLAnswer('policy', 'rejected', decision.reason);
        return res.status(422).json({ error: 'capability_unsupported', reason: decision.reason });
      }
      try {
        enforceAnswerWorkBudget(program, decision.capability, config.maxWorkUnits, config.maxRows);
      } catch (error) {
        if (error instanceof AnswerBoundError) {
          metrics.recordF1QLAnswer('bounds', 'rejected', error.bound);
          return res.status(422).json({ error: 'answer_bound_exceeded', reason: error.bound });
        }
        return res.status(500).json({ error: 'answer_failed', reason: 'budget_estimation_failed' });
      }

      // Execution remains structurally unavailable until budget enforcement and least-privilege proof land.
      metrics.recordF1QLAnswer('execution', 'blocked', 'execution_bounds_not_enforced');
      return res.status(503).json({
        error: 'answer_unavailable',
        reason: 'execution_bounds_not_enforced',
        mode: 'gated_non_execution',
        program,
        capability: decision.capability
      });
    } catch (error) {
      if (error instanceof AnswerAdmissionError) {
        if (error.reason === 'request_cancelled') {
          return respondToAbort(timedOut, res);
        }
        return res.status(503).json({ error: 'answer_unavailable', reason: error.reason });
      }
      return res.status(500).json({ error: 'answer_failed', reason: 'unexpected_error' });
    } finally {
      release?.();
      clearTimeout(timeout);
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
    }
  });

  return router;
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

async function linkWithBounds(pool: Pool, candidate: F1QLProgramCandidate, statementTimeoutMs: number, signal: AbortSignal): Promise<F1QLProgram> {
  const client = await acquireClient(pool, signal);
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
    const program = await linkF1QLCandidate(client, candidate);
    await client.query('ROLLBACK');
    return program;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

function answerAvailabilityGuard(_req: Request, res: Response, next: NextFunction): Response | void {
  if (process.env.F1QL_ANSWER_KILL_SWITCH === 'true') {
    metrics.recordF1QLAnswer('gate', 'blocked', 'kill_switch_active');
    return res.status(503).json({ error: 'answer_unavailable', reason: 'kill_switch_active' });
  }
  if (process.env.F1QL_ANSWER_ENABLED !== 'true') {
    metrics.recordF1QLAnswer('gate', 'blocked', 'answer_disabled');
    return res.status(503).json({ error: 'answer_unavailable', reason: 'answer_disabled' });
  }
  next();
}

function answerQuestionGuard(req: Request, res: Response, next: NextFunction): Response | void {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question || question.length > 1000) {
    metrics.recordF1QLAnswer('input', 'rejected', 'question_invalid');
    return res.status(400).json({ error: 'answer_invalid', reason: 'question must be 1-1000 characters' });
  }
  next();
}

function respondToTranslationOutcome(translation: Exclude<F1QLTranslationResult, { type: 'program_candidate' }>, res: Response): Response {
  if (translation.type === 'provider_unavailable') {
    return res.status(503).json({ error: 'answer_unavailable', reason: translation.reason });
  }
  if (translation.type === 'clarification_required') {
    return res.status(422).json({ error: 'clarification_required', reason: translation.reason, question: translation.question, options: translation.options });
  }
  return res.status(422).json({ error: 'capability_unsupported', reason: translation.reason });
}

function respondToLinkingError(error: F1QLLinkingError, res: Response): Response {
  if (error.code === 'event_ambiguous' || error.code === 'entity_ambiguous') {
    const question = error.code === 'event_ambiguous' ? 'Which event did you mean?' : 'Which driver did you mean?';
    return res.status(422).json({ error: 'clarification_required', reason: error.code, question, options: error.options });
  }
  return res.status(422).json({ error: 'capability_unsupported', reason: error.code });
}
