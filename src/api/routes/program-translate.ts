import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { createF1QLTextModel, F1QLTextModel, F1QLTranslationResult, translateF1QLQuestion } from '../../f1ql/translator';
import { F1QLLinkingError, linkF1QLCandidate } from '../../f1ql/translation-linking';
import { F1QLValidationError, validateF1QLProgram, validateParticipation } from '../../f1ql/validation';
import { metrics } from '../../observability/metrics';

export function createProgramTranslateRoutes(pool: Pool, model?: F1QLTextModel, _executor?: () => never): Router {
  const router = Router();
  const translator = model ?? createF1QLTextModel();

  router.post('/program/translate', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 1000) {
      recordOutcome('invalid', 'question_invalid', Date.now() - startedAt);
      return res.status(400).json({ error: 'translation_invalid', reason: 'question must be 1-1000 characters' });
    }
    if (process.env.F1QL_TRANSLATION_SHADOW !== 'true') {
      recordOutcome('unavailable', 'shadow_disabled', Date.now() - startedAt);
      return res.status(503).json({ error: 'translation_unavailable', reason: 'shadow mode is not enabled' });
    }

    try {
      const translation = await translateF1QLQuestion(question, translator);
      if (translation.type !== 'program_candidate') {
        return respondToTranslationOutcome(translation, res, startedAt);
      }
      const resolved = await linkF1QLCandidate(pool, translation.program);
      validateF1QLProgram(resolved);
      await validateParticipation(pool, resolved);
      recordOutcome('succeeded', 'validated_shadow_program', Date.now() - startedAt, resolved.root.op);
      return res.status(200).json({ mode: 'shadow', program: resolved });
    } catch (error) {
      if (error instanceof F1QLLinkingError) {
        return respondToLinkingError(error, res, startedAt);
      }
      const reason = validationReason(error);
      const identityMiss = reason.startsWith('identity_unresolved');
      const status = identityMiss ? 422 : 400;
      recordOutcome(identityMiss ? 'identity_miss' : 'unsupported', identityMiss ? 'identity_unresolved' : reason, Date.now() - startedAt);
      return res.status(status).json({ error: identityMiss ? 'identity_unresolved' : 'program_unsupported', reason });
    }
  });

  return router;
}

function respondToLinkingError(error: F1QLLinkingError, res: Response, startedAt: number): Response {
  recordOutcome('unsupported', error.code, Date.now() - startedAt);
  if (error.code === 'event_ambiguous' || error.code === 'entity_ambiguous') {
    const question = error.code === 'event_ambiguous' ? 'Which event did you mean?' : 'Which driver did you mean?';
    return res.status(422).json({ error: 'clarification_required', reason: error.code, question, options: error.options });
  }
  return res.status(422).json({ error: 'program_unsupported', reason: error.code });
}

function respondToTranslationOutcome(translation: Exclude<F1QLTranslationResult, { type: 'program_candidate' }>, res: Response, startedAt: number): Response {
  if (translation.type === 'provider_unavailable') {
    recordOutcome('unavailable', translation.reason, Date.now() - startedAt);
    return res.status(503).json({ error: 'translation_unavailable', reason: translation.reason });
  }
  recordOutcome('unsupported', translation.reason, Date.now() - startedAt);
  if (translation.type === 'clarification_required') {
    return res.status(422).json({ error: 'clarification_required', reason: translation.reason, question: translation.question, options: translation.options });
  }
  return res.status(422).json({ error: 'program_unsupported', reason: translation.reason });
}

function validationReason(error: unknown): string {
  if (error instanceof F1QLValidationError) {
    return error.code;
  }
  if (error instanceof Error && error.message.startsWith('identity_unresolved')) {
    return error.message;
  }
  return 'program_invalid';
}

function recordOutcome(outcome: 'succeeded' | 'invalid' | 'unsupported' | 'identity_miss' | 'unavailable', reason: string, latency_ms: number, operation?: string): void {
  metrics.recordF1QLTranslation(outcome, reason, latency_ms);
  console.log('[F1QLTranslation]', JSON.stringify({ timestamp: new Date().toISOString(), outcome, reason, latency_ms, operation }));
}
