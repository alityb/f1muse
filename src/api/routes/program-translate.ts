import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { DriverResolver } from '../../identity/driver-resolver';
import { EventResolver } from '../../identity/event-resolver';
import { createF1QLTextModel, F1QLTextModel, F1QLTranslationResult, translateF1QLQuestion } from '../../f1ql/translator';
import { AggregateNode, F1QLProgram } from '../../f1ql/ast';
import { F1QLProgramCandidate, isNamedEventProgram } from '../../f1ql/translation-schema';
import { parseF1QLProgram } from '../../f1ql/schema';
import { F1QLValidationError, validateF1QLProgram, validateParticipation } from '../../f1ql/validation';
import { metrics } from '../../observability/metrics';

export function createProgramTranslateRoutes(pool: Pool, model?: F1QLTextModel, _executor?: () => never): Router {
  const router = Router();
  const translator = model ?? createF1QLTextModel();
  const drivers = new DriverResolver(pool);
  const events = new EventResolver(pool);

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
      const program = await canonicalizeEvent(translation.program, events);
      const resolved = parseF1QLProgram(await resolveDriverIds(program, drivers));
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

class F1QLLinkingError extends Error {
  constructor(readonly code: 'event_ambiguous' | 'entity_ambiguous' | 'source_coverage_missing' | 'temporal_scope_unsupported', readonly options?: string[]) {
    super(code);
  }
}

function respondToLinkingError(error: F1QLLinkingError, res: Response, startedAt: number): Response {
  recordOutcome('unsupported', error.code, Date.now() - startedAt);
  if (error.code === 'event_ambiguous' || error.code === 'entity_ambiguous') {
    const question = error.code === 'event_ambiguous' ? 'Which event did you mean?' : 'Which driver did you mean?';
    return res.status(422).json({ error: 'clarification_required', reason: error.code, question, options: error.options });
  }
  return res.status(422).json({ error: 'program_unsupported', reason: error.code });
}

async function canonicalizeEvent(candidate: F1QLProgramCandidate, resolver: EventResolver): Promise<F1QLProgram> {
  if (!isNamedEventProgram(candidate)) {
    return parseF1QLProgram(candidate);
  }
  const resolution = await resolver.resolve(candidate.root.season, candidate.root.event_name);
  if (resolution.type === 'missing') {
    throw new F1QLLinkingError('source_coverage_missing');
  }
  if (resolution.type === 'ambiguous') {
    throw new F1QLLinkingError('event_ambiguous', resolution.candidates.map(event => `${event.season} round ${event.round}`));
  }
  const root = candidate.root;
  if (root.op === 'event_metadata') {
    return parseF1QLProgram({ version: 1, root: { op: root.op, season: root.season, round: resolution.round, session_scope: root.session_scope } });
  }
  return parseF1QLProgram({ version: 1, root: { op: root.op, season: root.season, round: resolution.round, limit: root.limit, filters: root.filters } });
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

async function resolveDriverIds(program: F1QLProgram, resolver: DriverResolver): Promise<F1QLProgram> {
  const { ids, season } = driverResolutionScope(program);
  const resolved = new Map<string, string>();
  for (const id of ids) {
    const result = await resolver.resolveUnambiguous(id, season);
    if (result.error === 'ambiguous_driver') {
      throw new F1QLLinkingError('entity_ambiguous', result.candidates?.map(candidate => candidate.replace(/_/g, '-')));
    }
    if (!result.success || !result.f1db_driver_id) {
      throw new Error(`identity_unresolved: ${id}`);
    }
    resolved.set(id, result.f1db_driver_id.replace(/_/g, '-'));
  }
  return applyResolvedDriverIds(program, resolved);
}

function driverResolutionScope(program: F1QLProgram): { ids: string[]; season?: number } {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { ids: [root.driver_a_id, root.driver_b_id], season: root.scope.season };
  }
  if (root.op === 'pace_summary') {
    return { ids: [root.driver_id], season: root.scope.season };
  }
  if (root.op === 'event_classification' && root.filters?.driver_id) {
    return { ids: [root.filters.driver_id], season: root.season };
  }
  if (root.op === 'qualifying_classification' && root.filters?.driver_id) {
    return { ids: [root.filters.driver_id], season: root.season };
  }
  if (root.op === 'aggregate') {
    return standingsResolutionScope(root);
  }
  if (root.op === 'rank') {
    return standingsResolutionScope(root.input);
  }
  return { ids: [] };
}

function standingsResolutionScope(aggregate: AggregateNode): { ids: string[]; season?: number } {
  if (aggregate.input.op !== 'filter' || !aggregate.input.where.driver_id) {
    return { ids: [] };
  }
  if (typeof aggregate.input.where.season !== 'number') {
    throw new F1QLLinkingError('temporal_scope_unsupported');
  }
  const driverId = aggregate.input.where.driver_id;
  return { ids: Array.isArray(driverId) ? driverId : [driverId], season: aggregate.input.where.season };
}

function applyResolvedDriverIds(program: F1QLProgram, resolved: Map<string, string>): F1QLProgram {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { ...program, root: { ...root, driver_a_id: resolved.get(root.driver_a_id)!, driver_b_id: resolved.get(root.driver_b_id)! } };
  }
  if (root.op === 'pace_summary') {
    return { ...program, root: { ...root, driver_id: resolved.get(root.driver_id)! } };
  }
  if (root.op === 'event_classification' && root.filters?.driver_id) {
    return { ...program, root: { ...root, filters: { ...root.filters, driver_id: resolved.get(root.filters.driver_id) } } };
  }
  if (root.op === 'qualifying_classification' && root.filters?.driver_id) {
    return { ...program, root: { ...root, filters: { ...root.filters, driver_id: resolved.get(root.filters.driver_id) } } };
  }
  if (root.op === 'aggregate') {
    return { ...program, root: applyResolvedStandingsDrivers(root, resolved) };
  }
  if (root.op === 'rank') {
    return { ...program, root: { ...root, input: applyResolvedStandingsDrivers(root.input, resolved) } };
  }
  return program;
}

function applyResolvedStandingsDrivers(aggregate: AggregateNode, resolved: Map<string, string>): AggregateNode {
  if (aggregate.input.op !== 'filter' || !aggregate.input.where.driver_id) {
    return aggregate;
  }
  const original = aggregate.input.where.driver_id;
  const driver_id = Array.isArray(original) ? original.map(id => resolved.get(id)!) : resolved.get(original)!;
  return { ...aggregate, input: { ...aggregate.input, where: { ...aggregate.input.where, driver_id } } };
}
