import { createHash, timingSafeEqual } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AnswerQuestionError, createAnswerQuestionContract } from '../../f1ql/answer-question';
import {
  ConfiguredSemanticCandidateModelIdentity,
  createSemanticCandidateModel,
  getConfiguredSemanticCandidateModelIdentity,
  SemanticCandidateProposalAdapter,
  SemanticCandidateProposalError
} from '../../f1ql/semantic-candidate-translator';
import { sanitizeSemanticShadowObservation } from '../../f1ql/semantic-shadow-observations';
import {
  orchestrateSemanticShadow,
  SemanticShadowDependencyError,
  SemanticShadowProposalError,
  SemanticShadowProposer,
  SemanticShadowProposalRequest
} from '../../f1ql/semantic-shadow-planner';
import {
  SEMANTIC_SHADOW_RESOLVER_MAX_TIMEOUT_MS,
  SemanticShadowResolverAccess,
  SemanticShadowResolverCounters,
  SemanticShadowResolverReaderError,
  withSemanticShadowResolverReader
} from '../../f1ql/semantic-shadow-resolver-reader';
import {
  SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION,
  sanitizeSemanticShadowRetainedObservation
} from '../../f1ql/semantic-shadow-retained-observation';
import { AnswerAdmissionController, AnswerAdmissionError } from '../../f1ql/answer-runtime';

const DEFAULT_METADATA_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 15_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTITY_KEYS: readonly (keyof ConfiguredSemanticCandidateModelIdentity)[] = [
  'provider',
  'endpoint_sha256',
  'model_sha256',
  'catalog_projection_sha256',
  'prompt_sha256',
  'schema_sha256',
  'request_config_sha256'
];

interface AbortableSemanticShadowProposer {
  propose(request: Parameters<SemanticShadowProposer['propose']>[0], signal?: AbortSignal): Promise<unknown>;
}

export interface ProgramSemanticShadowDependencies {
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly proposer?: AbortableSemanticShadowProposer;
  readonly providerIdentity?: unknown;
  readonly logger?: (line: string) => void;
  readonly timestamp?: () => string;
  readonly metadataStatementTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly admission?: Pick<AnswerAdmissionController, 'acquire'>;
}

export function createProgramSemanticShadowRoutes(
  pool: Pool | undefined,
  dependencies: ProgramSemanticShadowDependencies = {},
  _executor?: () => never
): Router {
  const router = Router();
  const environment = dependencies.environment ?? (() => process.env);
  const logger = dependencies.logger ?? ((line: string) => console.log(line));
  const admission = dependencies.admission ?? new AnswerAdmissionController({ maxConcurrency: 1, queueTimeoutMs: 1_000 });

  router.post('/program/semantic-shadow', async (req: Request, res: Response) => {
    const env = environment();
    if (env.F1QL_SEMANTIC_SHADOW_ENABLED !== 'true') {
      return unavailable(res, 'semantic_shadow_disabled');
    }
    if (env.F1QL_SEMANTIC_SHADOW_KILL_SWITCH === 'true') {
      return unavailable(res, 'kill_switch_active');
    }
    if (env.F1QL_SEMANTIC_SHADOW_STAGE !== '0') {
      return unavailable(res, 'rollout_stage_unavailable');
    }

    const expectedToken = env.F1QL_SEMANTIC_SHADOW_INTERNAL_TOKEN;
    if (!expectedToken || expectedToken.length < 32) {
      return unavailable(res, 'semantic_shadow_auth_not_configured');
    }
    const authorization = req.get('authorization');
    const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!safeTokenEqual(suppliedToken, expectedToken)) {
      return res.status(401).json({
        error: 'semantic_shadow_unauthorized',
        reason: 'semantic_shadow_authentication_required'
      });
    }

    if (!isExactQuestionBody(req.body)) {
      return invalidQuestion(res);
    }
    try {
      createAnswerQuestionContract(req.body.question);
    } catch (error) {
      if (error instanceof AnswerQuestionError) {
        return invalidQuestion(res);
      }
      return res.status(500).json({ error: 'semantic_shadow_failed', reason: 'unexpected_error' });
    }
    if (!pool) {
      return unavailable(res, 'answer_database_not_configured');
    }

    let metadataStatementTimeoutMs: number;
    let requestTimeoutMs: number;
    try {
      metadataStatementTimeoutMs = boundedTimeout(
        dependencies.metadataStatementTimeoutMs,
        env.F1QL_SEMANTIC_SHADOW_METADATA_STATEMENT_TIMEOUT_MS,
        DEFAULT_METADATA_STATEMENT_TIMEOUT_MS,
        SEMANTIC_SHADOW_RESOLVER_MAX_TIMEOUT_MS
      );
      requestTimeoutMs = boundedTimeout(
        dependencies.requestTimeoutMs,
        env.F1QL_SEMANTIC_SHADOW_REQUEST_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
        MAX_REQUEST_TIMEOUT_MS
      );
    } catch {
      return unavailable(res, 'semantic_shadow_configuration_invalid');
    }

    let provider: { readonly proposer: AbortableSemanticShadowProposer; readonly identity: ConfiguredSemanticCandidateModelIdentity };
    try {
      provider = resolveProvider(dependencies, env);
    } catch {
      return unavailable(res, 'semantic_shadow_provider_not_configured');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
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
      const resolverCounters = emptyResolverCounters();
      let resolverTransactionCount = 0;
      const metadataRead = async <T>(operation: (access: SemanticShadowResolverAccess) => Promise<T>): Promise<T> => {
        let transaction;
        try {
          transaction = await withSemanticShadowResolverReader(pool, {
            statementTimeoutMs: metadataStatementTimeoutMs,
            signal: controller.signal
          }, operation);
        } catch (error) {
          throw new SemanticShadowDependencyError(error);
        }
        resolverTransactionCount += 1;
        mergeResolverCounters(resolverCounters, transaction.counters);
        return transaction.value;
      };
      const observation = sanitizeSemanticShadowObservation(await orchestrateSemanticShadow(req.body.question, {
        proposer: {
          propose: async (request: SemanticShadowProposalRequest) => {
            try {
              return await provider.proposer.propose(request, controller.signal);
            } catch (error) {
              if (error instanceof SemanticCandidateProposalError) {
                throw new SemanticShadowProposalError(isMalformedProviderDiagnostic(error.code)
                  ? 'provider_malformed' : 'provider_unavailable');
              }
              throw error;
            }
          }
        },
        entity_inventory_resolver: {
          inventoryMentions: (question: string, season: number) =>
            metadataRead(access => access.driver_resolver.inventoryMentions(question, season))
        },
        event_resolver: {
          resolve: (season: number, name: string) =>
            metadataRead(access => access.event_resolver.resolve(season, name)),
          resolveRound: (season: number, round: number) =>
            metadataRead(access => access.event_resolver.resolveRound(season, round))
        },
        template_dual: true
      }));
      if (controller.signal.aborted) {
        return abortResponse(timedOut, res);
      }
      const retained = sanitizeSemanticShadowRetainedObservation({
        version: SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION,
        timestamp: validatedTimestamp(dependencies.timestamp),
        mode: 'semantic_shadow' as const,
        rollout_stage: 0 as const,
        provider_identity: provider.identity,
        resolver_transaction_count: resolverTransactionCount,
        resolver_transaction_counters: freezeResolverCounters(resolverCounters),
        observation
      });
      logger(JSON.stringify(retained));
      return res.status(observation.outcome === 'unavailable' ? 503 : 200)
        .json({ mode: 'semantic_shadow', rollout_stage: 0, observation });
    } catch (error) {
      if (controller.signal.aborted) {
        return abortResponse(timedOut, res);
      }
      if (error instanceof AnswerAdmissionError) {
        return unavailable(res, error.reason === 'answer_busy' ? 'semantic_shadow_busy' : error.reason);
      }
      const dependencyError = error instanceof SemanticShadowDependencyError
        ? error.dependencyError : error;
      if (dependencyError instanceof SemanticShadowResolverReaderError) {
        if (dependencyError.code === 'request_cancelled') {
          return abortResponse(timedOut, res);
        }
        if (dependencyError.code === 'statement_timeout') {
          return res.status(504).json({ error: 'semantic_shadow_unavailable', reason: 'metadata_statement_timeout' });
        }
        if (dependencyError.code === 'connection_failed') {
          return unavailable(res, 'answer_database_unavailable');
        }
        return unavailable(res, 'semantic_shadow_metadata_unavailable');
      }
      return res.status(503).json({ error: 'semantic_shadow_unavailable', reason: 'semantic_shadow_planning_unavailable' });
    } finally {
      releaseAdmission?.();
      clearTimeout(timeout);
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
    }
  });

  return router;
}

function resolveProvider(
  dependencies: ProgramSemanticShadowDependencies,
  environment: NodeJS.ProcessEnv
): { readonly proposer: AbortableSemanticShadowProposer; readonly identity: ConfiguredSemanticCandidateModelIdentity } {
  if ((dependencies.proposer === undefined) !== (dependencies.providerIdentity === undefined)) {
    throw new Error('semantic shadow provider dependencies are incomplete');
  }
  const proposer = dependencies.proposer ?? new SemanticCandidateProposalAdapter(createSemanticCandidateModel(environment));
  if (!proposer || typeof proposer.propose !== 'function') {
    throw new Error('semantic shadow proposer is invalid');
  }
  const identity = parseProviderIdentity(
    dependencies.providerIdentity ?? getConfiguredSemanticCandidateModelIdentity(environment)
  );
  return Object.freeze({ proposer, identity });
}

function parseProviderIdentity(input: unknown): ConfiguredSemanticCandidateModelIdentity {
  if (!isPlainObject(input) || Reflect.ownKeys(input).length !== IDENTITY_KEYS.length ||
      IDENTITY_KEYS.some(key => !Object.prototype.hasOwnProperty.call(input, key)) ||
      input.provider !== 'openai-compatible' ||
      IDENTITY_KEYS.slice(1).some(key => typeof input[key] !== 'string' || !HASH_PATTERN.test(input[key] as string))) {
    throw new Error('semantic shadow provider identity is invalid');
  }
  return Object.freeze({
    provider: input.provider,
    endpoint_sha256: input.endpoint_sha256 as string,
    model_sha256: input.model_sha256 as string,
    catalog_projection_sha256: input.catalog_projection_sha256 as string,
    prompt_sha256: input.prompt_sha256 as string,
    schema_sha256: input.schema_sha256 as string,
    request_config_sha256: input.request_config_sha256 as string
  });
}

function boundedTimeout(
  injected: number | undefined,
  configured: string | undefined,
  defaultValue: number,
  maximum: number
): number {
  const value = injected ?? (configured === undefined || configured === '' ? defaultValue : Number(configured));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum ||
      (injected === undefined && configured !== undefined && configured !== '' && !/^[1-9]\d*$/u.test(configured))) {
    throw new Error('semantic shadow timeout is invalid');
  }
  return value;
}

type MutableResolverCounters = {
  statement_count: number;
  returned_row_count: number;
  statements: Record<keyof SemanticShadowResolverCounters['statements'], number>;
};

function emptyResolverCounters(): MutableResolverCounters {
  return {
    statement_count: 0,
    returned_row_count: 0,
    statements: {
      driver_inventory_unscoped: 0,
      driver_inventory_scoped: 0,
      event_name: 0,
      event_round: 0
    }
  };
}

function mergeResolverCounters(target: MutableResolverCounters, addition: SemanticShadowResolverCounters): void {
  target.statement_count += addition.statement_count;
  target.returned_row_count += addition.returned_row_count;
  for (const statement of Object.keys(target.statements) as (keyof typeof target.statements)[]) {
    target.statements[statement] += addition.statements[statement];
  }
  const inventoryReads = target.statements.driver_inventory_unscoped + target.statements.driver_inventory_scoped;
  const eventReads = target.statements.event_name + target.statements.event_round;
  if (target.statement_count > 2 || inventoryReads > 1 || eventReads > 1 || target.returned_row_count > 10_502) {
    throw new SemanticShadowResolverReaderError('statement_limit_exceeded');
  }
}

function freezeResolverCounters(counters: MutableResolverCounters): SemanticShadowResolverCounters {
  return Object.freeze({
    statement_count: counters.statement_count,
    returned_row_count: counters.returned_row_count,
    statements: Object.freeze({ ...counters.statements })
  });
}

function isMalformedProviderDiagnostic(code: string): boolean {
  return code === 'malformed' || code === 'incomplete' || code === 'schema_invalid' ||
    code === 'forbidden_output' || code === 'oversize';
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function isExactQuestionBody(input: unknown): input is { question: unknown } {
  return isPlainObject(input) && Object.keys(input).length === 1 &&
    Object.prototype.hasOwnProperty.call(input, 'question');
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
}

function validatedTimestamp(factory: ProgramSemanticShadowDependencies['timestamp']): string {
  const timestamp = factory?.() ?? new Date().toISOString();
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('semantic shadow timestamp is invalid');
  }
  return timestamp;
}

function invalidQuestion(res: Response): Response {
  return res.status(400).json({ error: 'semantic_shadow_invalid', reason: 'question_invalid' });
}

function unavailable(res: Response, reason: string): Response {
  return res.status(503).json({ error: 'semantic_shadow_unavailable', reason });
}

function abortResponse(timedOut: boolean, res: Response): Response | void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  return res.status(timedOut ? 504 : 499).json({
    error: 'semantic_shadow_unavailable',
    reason: timedOut ? 'request_timeout' : 'request_cancelled'
  });
}
