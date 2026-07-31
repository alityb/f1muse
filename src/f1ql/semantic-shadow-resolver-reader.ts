import { createHash } from 'node:crypto';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  ANSWER_DRIVER_IDENTITY_MAX_ROWS,
  ANSWER_EVENT_IDENTITY_MAX_ROWS,
  AnswerDriverIdentityResolver,
  AnswerEventIdentityResolver
} from '../identity/answer-identity-resolvers';

export const SEMANTIC_SHADOW_RESOLVER_MAX_STATEMENTS = 2;
export const SEMANTIC_SHADOW_RESOLVER_MAX_RETURNED_ROWS =
  ANSWER_DRIVER_IDENTITY_MAX_ROWS + ANSWER_EVENT_IDENTITY_MAX_ROWS + 2;
export const SEMANTIC_SHADOW_RESOLVER_MAX_TIMEOUT_MS = 5_000;

export const SEMANTIC_SHADOW_RESOLVER_STATEMENTS = Object.freeze({
  driver_inventory_unscoped: `
      SELECT driver_id, identity
      FROM f1ql.answer_driver_identity
      WHERE char_length(identity) BETWEEN 1 AND 200
      ORDER BY identity, driver_id
      LIMIT $1
    `,
  driver_inventory_scoped: `
        SELECT i.driver_id, i.identity, p.participation_source
        FROM f1ql.answer_driver_identity i
        LEFT JOIN f1ql.answer_season_participation p
          ON p.driver_id = i.driver_id AND p.season = $1
        WHERE char_length(i.identity) BETWEEN 1 AND 200
        ORDER BY i.identity, i.driver_id, p.participation_source
        LIMIT $2
      `,
  event_name: `
      SELECT season, round, identity
      FROM f1ql.answer_event_identity
      WHERE season = $1 AND char_length(identity) BETWEEN 1 AND 200
      ORDER BY round, identity
      LIMIT $2
    `,
  event_round: `
      SELECT DISTINCT season, round
      FROM f1ql.answer_event_identity
      WHERE season = $1 AND round = $2
      ORDER BY round
      LIMIT $3
    `
});

export type SemanticShadowResolverStatement = keyof typeof SEMANTIC_SHADOW_RESOLVER_STATEMENTS;

export const SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINTS: Readonly<Record<SemanticShadowResolverStatement, string>> =
  Object.freeze(Object.fromEntries(Object.entries(SEMANTIC_SHADOW_RESOLVER_STATEMENTS)
    .map(([name, sql]) => [name, createHash('sha256').update(sql).digest('hex')])) as Record<SemanticShadowResolverStatement, string>);

export type SemanticShadowResolverReaderErrorCode =
  | 'connection_failed'
  | 'invalid_configuration'
  | 'metadata_read_failed'
  | 'parameter_contract_invalid'
  | 'reader_closed'
  | 'request_cancelled'
  | 'returned_row_limit_exceeded'
  | 'statement_limit_exceeded'
  | 'statement_not_allowed'
  | 'statement_timeout'
  | 'transaction_cleanup_failed'
  | 'transaction_setup_failed';

export class SemanticShadowResolverReaderError extends Error {
  constructor(readonly code: SemanticShadowResolverReaderErrorCode) {
    super(code);
    this.name = 'SemanticShadowResolverReaderError';
  }
}

export interface SemanticShadowResolverCounters {
  readonly statement_count: number;
  readonly returned_row_count: number;
  readonly statements: Readonly<Record<SemanticShadowResolverStatement, number>>;
}

export interface SemanticShadowResolverAccess {
  readonly driver_resolver: Pick<AnswerDriverIdentityResolver, 'inventoryMentions'>;
  readonly event_resolver: Pick<AnswerEventIdentityResolver, 'resolve' | 'resolveRound'>;
  readonly counters: () => SemanticShadowResolverCounters;
}

export interface SemanticShadowResolverTransactionOptions {
  readonly statementTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface SemanticShadowResolverTransactionResult<T> {
  readonly value: T;
  readonly counters: SemanticShadowResolverCounters;
}

interface StatementContract {
  readonly name: SemanticShadowResolverStatement;
  readonly sql: string;
  readonly maxRows: number;
  readonly validParameters: (parameters: readonly unknown[]) => boolean;
}

const DRIVER_LIMIT = ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1;
const EVENT_NAME_LIMIT = ANSWER_EVENT_IDENTITY_MAX_ROWS + 1;
const EVENT_ROUND_LIMIT = 2;
const APPROVED_RELATIONS = new Set([
  'f1ql.answer_driver_identity',
  'f1ql.answer_event_identity',
  'f1ql.answer_season_participation'
]);

const STATEMENT_CONTRACTS: readonly StatementContract[] = [
  {
    name: 'driver_inventory_unscoped',
    sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_unscoped,
    maxRows: DRIVER_LIMIT,
    validParameters: parameters => parameters.length === 1 && parameters[0] === DRIVER_LIMIT
  },
  {
    name: 'driver_inventory_scoped',
    sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped,
    maxRows: DRIVER_LIMIT,
    validParameters: parameters => parameters.length === 2 && isSeason(parameters[0]) && parameters[1] === DRIVER_LIMIT
  },
  {
    name: 'event_name',
    sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name,
    maxRows: EVENT_NAME_LIMIT,
    validParameters: parameters => parameters.length === 2 && isSeason(parameters[0]) && parameters[1] === EVENT_NAME_LIMIT
  },
  {
    name: 'event_round',
    sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round,
    maxRows: EVENT_ROUND_LIMIT,
    validParameters: parameters => parameters.length === 3 && isSeason(parameters[0]) && isRound(parameters[1]) && parameters[2] === EVENT_ROUND_LIMIT
  }
];

export function identifySemanticShadowResolverRead(
  sql: string,
  parameters: readonly unknown[] | undefined
): SemanticShadowResolverStatement {
  if (typeof sql !== 'string' || !/^\s*SELECT\b/.test(sql) || /;|--|\/\*|\*\//.test(sql) || !hasOnlyApprovedRelations(sql)) {
    throw new SemanticShadowResolverReaderError('statement_not_allowed');
  }
  const contract = STATEMENT_CONTRACTS.find(candidate => candidate.sql === sql &&
    SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINTS[candidate.name] === createHash('sha256').update(sql).digest('hex'));
  if (!contract) {
    throw new SemanticShadowResolverReaderError('statement_not_allowed');
  }
  if (!Array.isArray(parameters) || !contract.validParameters(parameters)) {
    throw new SemanticShadowResolverReaderError('parameter_contract_invalid');
  }
  return contract.name;
}

export async function withSemanticShadowResolverReader<T>(
  database: Pick<Pool, 'connect'>,
  options: SemanticShadowResolverTransactionOptions,
  callback: (access: SemanticShadowResolverAccess) => Promise<T>
): Promise<SemanticShadowResolverTransactionResult<T>> {
  const timeoutMs = options.statementTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEMANTIC_SHADOW_RESOLVER_MAX_TIMEOUT_MS) {
    throw new SemanticShadowResolverReaderError('invalid_configuration');
  }
  if (typeof callback !== 'function') {
    throw new SemanticShadowResolverReaderError('invalid_configuration');
  }

  const client = await acquireClient(database, options.signal);
  let value: T | undefined;
  let primaryError: unknown;
  let reader: FixedResolverReader | undefined;
  let finalCounters: SemanticShadowResolverCounters | undefined;
  try {
    throwIfAborted(options.signal);
    await controlQuery(client, 'BEGIN READ ONLY');
    throwIfAborted(options.signal);
    await controlQuery(client, "SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`], timeoutMs);
    reader = new FixedResolverReader(client, options.signal);
    const queryable = { query: reader.query.bind(reader) } as Pick<Pool, 'query'>;
    const driver = new AnswerDriverIdentityResolver(queryable);
    const event = new AnswerEventIdentityResolver(queryable);
    const access: SemanticShadowResolverAccess = Object.freeze({
      driver_resolver: Object.freeze({
        inventoryMentions: async (question: string, season?: number) => {
          reader!.assertOpen();
          return driver.inventoryMentions(question, season);
        }
      }),
      event_resolver: Object.freeze({
        resolve: async (season: number, name: string) => {
          reader!.assertOpen();
          return event.resolve(season, name);
        },
        resolveRound: async (season: number, round: number) => {
          reader!.assertOpen();
          return event.resolveRound(season, round);
        }
      }),
      counters: () => reader!.counters()
    });
    try {
      value = await callback(access);
      throwIfAborted(options.signal);
    } finally {
      finalCounters = reader.close();
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    await client.query('ROLLBACK');
  } catch {
    cleanupError = new SemanticShadowResolverReaderError('transaction_cleanup_failed');
  }
  try {
    client.release(cleanupError === undefined ? undefined : cleanupError as Error);
  } catch {
    cleanupError ??= new SemanticShadowResolverReaderError('transaction_cleanup_failed');
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  return Object.freeze({ value: value as T, counters: finalCounters! });
}

class FixedResolverReader {
  private closed = false;
  private statementCount = 0;
  private returnedRowCount = 0;
  private readonly counts: Record<SemanticShadowResolverStatement, number> = {
    driver_inventory_unscoped: 0,
    driver_inventory_scoped: 0,
    event_name: 0,
    event_round: 0
  };

  constructor(
    private readonly client: PoolClient,
    private readonly signal: AbortSignal | undefined
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, parameters?: unknown[]): Promise<QueryResult<R>> {
    this.assertOpen();
    throwIfAborted(this.signal);
    const statement = identifySemanticShadowResolverRead(sql, parameters);
    const sameKindCount = statement.startsWith('driver_inventory_')
      ? this.counts.driver_inventory_unscoped + this.counts.driver_inventory_scoped
      : this.counts.event_name + this.counts.event_round;
    if (this.statementCount >= SEMANTIC_SHADOW_RESOLVER_MAX_STATEMENTS || sameKindCount >= 1) {
      throw new SemanticShadowResolverReaderError('statement_limit_exceeded');
    }
    this.statementCount += 1;
    this.counts[statement] += 1;

    let result: QueryResult<R>;
    try {
      result = await this.client.query<R>(sql, parameters);
    } catch (error) {
      this.assertOpen();
      if ((error as { code?: unknown }).code === '57014') {
        throw new SemanticShadowResolverReaderError('statement_timeout');
      }
      throw new SemanticShadowResolverReaderError('metadata_read_failed');
    }
    this.assertOpen();
    throwIfAborted(this.signal);
    if (!Array.isArray(result.rows)) {
      throw new SemanticShadowResolverReaderError('metadata_read_failed');
    }
    const rows = result.rows.length;
    this.returnedRowCount += rows;
    const contract = STATEMENT_CONTRACTS.find(candidate => candidate.name === statement)!;
    if (rows > contract.maxRows || this.returnedRowCount > SEMANTIC_SHADOW_RESOLVER_MAX_RETURNED_ROWS) {
      throw new SemanticShadowResolverReaderError('returned_row_limit_exceeded');
    }
    return result;
  }

  counters(): SemanticShadowResolverCounters {
    this.assertOpen();
    return this.snapshotCounters();
  }

  assertOpen(): void {
    if (this.closed) {
      throw new SemanticShadowResolverReaderError('reader_closed');
    }
  }

  close(): SemanticShadowResolverCounters {
    this.closed = true;
    return this.snapshotCounters();
  }

  private snapshotCounters(): SemanticShadowResolverCounters {
    return Object.freeze({
      statement_count: this.statementCount,
      returned_row_count: this.returnedRowCount,
      statements: Object.freeze({ ...this.counts })
    });
  }
}

async function acquireClient(database: Pick<Pool, 'connect'>, signal: AbortSignal | undefined): Promise<PoolClient> {
  throwIfAborted(signal);
  if (!signal) {
    try {
      return await database.connect();
    } catch {
      throw new SemanticShadowResolverReaderError('connection_failed');
    }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(new SemanticShadowResolverReaderError('request_cancelled'));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    database.connect().then(client => {
      if (settled) {
        client.release();
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(client);
    }, () => {
      if (!settled) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(new SemanticShadowResolverReaderError('connection_failed'));
      }
    });
  });
}

async function controlQuery(
  client: PoolClient,
  sql: string,
  parameters?: unknown[],
  timeoutMs?: number
): Promise<void> {
  try {
    await client.query(sql, parameters);
  } catch (error) {
    if (timeoutMs !== undefined && (error as { code?: unknown }).code === '57014') {
      throw new SemanticShadowResolverReaderError('statement_timeout');
    }
    throw new SemanticShadowResolverReaderError('transaction_setup_failed');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SemanticShadowResolverReaderError('request_cancelled');
  }
}

function hasOnlyApprovedRelations(sql: string): boolean {
  const relations = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi)].map(match => match[1].toLowerCase());
  return relations.length > 0 && relations.every(relation => APPROVED_RELATIONS.has(relation));
}

function isSeason(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1950 && (value as number) <= 2100;
}

function isRound(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 30;
}
