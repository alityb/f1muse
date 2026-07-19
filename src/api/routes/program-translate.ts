import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { DriverResolver } from '../../identity/driver-resolver';
import { createF1QLTextModel, F1QLTextModel, translateF1QLQuestion } from '../../f1ql/translator';
import { F1QLProgram } from '../../f1ql/ast';
import { metrics } from '../../observability/metrics';

export function createProgramTranslateRoutes(pool: Pool, model?: F1QLTextModel, _executor?: () => never): Router {
  const router = Router();
  const translator = model ?? createF1QLTextModel();
  const drivers = new DriverResolver(pool);

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
      const program = await translateF1QLQuestion(question, translator);
      const resolved = await resolveDriverIds(program, drivers);
      recordOutcome('succeeded', 'validated_shadow_program', Date.now() - startedAt, resolved.root.op);
      return res.status(200).json({ mode: 'shadow', program: resolved });
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith('identity_unresolved') ? error.message : 'translation did not produce a supported program';
      const status = reason.startsWith('identity_unresolved') ? 422 : 400;
      recordOutcome(status === 422 ? 'identity_miss' : 'unsupported', status === 422 ? 'identity_unresolved' : 'program_invalid', Date.now() - startedAt);
      return res.status(status).json({ error: status === 422 ? 'identity_unresolved' : 'program_unsupported', reason });
    }
  });

  return router;
}

function recordOutcome(outcome: 'succeeded' | 'invalid' | 'unsupported' | 'identity_miss' | 'unavailable', reason: string, latency_ms: number, operation?: string): void {
  metrics.recordF1QLTranslation(outcome, latency_ms);
  console.log('[F1QLTranslation]', JSON.stringify({ timestamp: new Date().toISOString(), outcome, reason, latency_ms, operation }));
}

async function resolveDriverIds(program: F1QLProgram, resolver: DriverResolver): Promise<F1QLProgram> {
  const root = program.root;
  const ids = root.op === 'pace_delta' ? [root.driver_a_id, root.driver_b_id]
    : root.op === 'pace_summary' ? [root.driver_id]
    : root.op === 'event_classification' && root.filters?.driver_id ? [root.filters.driver_id]
    : [];
  const resolved = new Map<string, string>();
  for (const id of ids) {
    const result = await resolver.resolve(id);
    if (!result.success || !result.f1db_driver_id) throw new Error(`identity_unresolved: ${id}`);
    resolved.set(id, result.f1db_driver_id.replace(/_/g, '-'));
  }
  if (root.op === 'pace_delta') return { ...program, root: { ...root, driver_a_id: resolved.get(root.driver_a_id)!, driver_b_id: resolved.get(root.driver_b_id)! } };
  if (root.op === 'pace_summary') return { ...program, root: { ...root, driver_id: resolved.get(root.driver_id)! } };
  if (root.op === 'event_classification' && root.filters?.driver_id) return { ...program, root: { ...root, filters: { ...root.filters, driver_id: resolved.get(root.filters.driver_id) } } };
  return program;
}
