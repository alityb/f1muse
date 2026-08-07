/* eslint-disable complexity, max-lines-per-function */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackHostname } from '../db/network-target';

export const CONSTRUCTOR_AUTHORITY_AUDIT_VERSION = 2 as const;
export const CONSTRUCTOR_AUTHORITY_AUDIT_SEASON = 2025 as const;
export const CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS = 5_000;
export const CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES = 100;
export const CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT = 24;

const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const RAW_ID = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMPTY_SET_SHA256 = sha256('[]');
const EXPECTED_ROUNDS = Array.from({ length: CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT }, (_, index) => index + 1);
const EXPECTED_ROUND_SET_SHA256 = hashNumberSet(EXPECTED_ROUNDS);

const requiredColumns = [
  { relation: 'public.season_constructor_standing', column: 'year', type: 'integer', not_null: true },
  { relation: 'public.season_constructor_standing', column: 'constructor_id', type: 'text', not_null: true },
  { relation: 'public.season_constructor_standing', column: 'points', type: 'numeric', not_null: true },
  { relation: 'public.constructor', column: 'id', type: 'text', not_null: true },
  { relation: 'public.race', column: 'id', type: 'integer', not_null: true },
  { relation: 'public.race', column: 'year', type: 'integer', not_null: true },
  { relation: 'public.race', column: 'round', type: 'integer', not_null: true },
  { relation: 'public.race_data', column: 'race_id', type: 'integer', not_null: true },
  { relation: 'public.race_data', column: 'type', type: 'text', not_null: true },
  { relation: 'public.race_data', column: 'constructor_id', type: 'text', not_null: false }
] as const;

const requiredRelations = [
  'public.season_constructor_standing',
  'public.constructor',
  'public.race',
  'public.race_data'
] as const;

const requiredKeys = [
  { relation: 'public.constructor', type: 'p', columns: ['id'] },
  { relation: 'public.race', type: 'p', columns: ['id'] },
  { relation: 'public.season_constructor_standing', type: 'u', columns: ['year', 'constructor_id'] },
  { relation: 'public.race_data', type: 'p', columns: ['race_id', 'type', 'driver_id'] }
] as const;

export type ConstructorAuthorityAuditTarget = 'localhost' | 'production';
export type ConstructorAuthorityAuditReason =
  | 'passed'
  | 'source_relation_missing'
  | 'identity_relation_missing'
  | 'participation_relation_missing'
  | 'schema_mismatch'
  | 'source_bound_exceeded'
  | 'identity_bound_exceeded'
  | 'participation_bound_exceeded'
  | 'source_absent'
  | 'duplicate_grain'
  | 'null_identity'
  | 'malformed_identity'
  | 'normalization_collision'
  | 'null_points'
  | 'invalid_points'
  | 'identity_membership_mismatch'
  | 'season_round_coverage_mismatch'
  | 'participation_absent'
  | 'participation_identity_invalid'
  | 'participation_round_coverage_mismatch'
  | 'participation_membership_mismatch';

interface QueryResult<Row extends object> { readonly rows: Row[]; }

export interface ConstructorAuthorityAuditClient {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
  release(error?: Error): void;
}

export interface ConstructorAuthorityAuditPool {
  connect(): Promise<ConstructorAuthorityAuditClient>;
  end(): Promise<void>;
}

export interface ConstructorAuthorityAuditConfiguration {
  readonly connection_string: string;
  readonly target: ConstructorAuthorityAuditTarget;
  readonly database_target_sha256: string;
}

export interface ConstructorAuthorityAuditReport {
  readonly version: typeof CONSTRUCTOR_AUTHORITY_AUDIT_VERSION;
  readonly kind: 'f1ql_constructor_authority_audit';
  readonly target: ConstructorAuthorityAuditTarget;
  readonly scope: {
    readonly season: typeof CONSTRUCTOR_AUTHORITY_AUDIT_SEASON;
    readonly standing: 'retained_final_candidate';
    readonly authority_candidate: 'recorded_constructor_championship_points';
    readonly derivation: 'none';
    readonly required_round_count: typeof CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT;
  };
  readonly database_provenance: {
    readonly target_sha256: string;
    readonly current_database_sha256: string;
    readonly current_user_sha256: string;
    readonly server_version_num: string;
    readonly transaction_read_only: 'on';
  };
  readonly transaction: {
    readonly isolation: 'repeatable_read';
    readonly read_only: true;
    readonly statement_timeout_ms: typeof CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS;
    readonly max_identity_count: typeof CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES;
    readonly completion: 'rolled_back';
  };
  readonly schema: {
    readonly contract: 'constructor_authority_schema_v2';
    readonly required_relation_count: 4;
    readonly required_column_count: 10;
    readonly required_key_count: 4;
    readonly observed_relation_count: number;
    readonly observed_column_count: number;
    readonly observed_key_count: number;
    readonly matched_key_count: number;
    readonly relation_presence: {
      readonly source: boolean;
      readonly identity: boolean;
      readonly race: boolean;
      readonly race_data: boolean;
    };
    readonly column_contract_matches: boolean;
    readonly key_contract_matches: boolean;
    readonly fingerprint_sha256: string;
    readonly key_fingerprint_sha256: string;
  };
  readonly source: {
    readonly relation: 'public.season_constructor_standing';
    readonly bound_exceeded: boolean;
    readonly row_count: number;
    readonly raw_identity_count: number;
    readonly normalized_identity_count: number;
    readonly normalized_identity_set_sha256: string;
    readonly fact_count: number;
    readonly fact_set_sha256: string;
    readonly duplicate_grain_count: number;
    readonly null_identity_count: number;
    readonly malformed_identity_count: number;
    readonly normalization_collision_count: number;
    readonly null_points_count: number;
    readonly invalid_points_count: number;
  };
  readonly identity: {
    readonly relation: 'public.constructor';
    readonly bound_exceeded: boolean;
    readonly observed_row_count: number;
    readonly matched_normalized_identity_count: number;
    readonly matched_normalized_identity_set_sha256: string;
    readonly missing_normalized_identity_count: number;
    readonly missing_normalized_identity_set_sha256: string;
    readonly malformed_identity_count: number;
    readonly normalization_collision_count: number;
  };
  readonly participation: {
    readonly relations: readonly ['public.race', 'public.race_data'];
    readonly bound_exceeded: boolean;
    readonly observed_identity_group_count: number;
    readonly classification_row_count: number;
    readonly raw_identity_count: number;
    readonly normalized_identity_count: number;
    readonly normalized_identity_set_sha256: string;
    readonly null_identity_count: number;
    readonly malformed_identity_count: number;
    readonly normalization_collision_count: number;
    readonly season_round_count: number;
    readonly season_round_set_sha256: string;
    readonly duplicate_season_round_count: number;
    readonly invalid_season_round_count: number;
    readonly incomplete_constructor_round_count: number;
  };
  readonly membership: {
    readonly final_standings_only_count: number;
    readonly final_standings_only_sha256: string;
    readonly participation_only_count: number;
    readonly participation_only_sha256: string;
  };
  readonly status: 'passed' | 'failed';
  readonly reason: ConstructorAuthorityAuditReason;
}

interface RelationRow { readonly relation: string; readonly relation_kind: string; }
interface SchemaRow {
  readonly relation: string;
  readonly relation_kind: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly not_null: boolean;
  readonly ordinal_position: number;
}
interface ConstraintRow {
  readonly relation: string;
  readonly constraint_type: string;
  readonly columns: string[];
}
interface SourceRow { readonly constructor_id: string | null; readonly points_text: string | null; }
interface ParticipationRow {
  readonly constructor_id: string | null;
  readonly classification_rows: string;
  readonly rounds_text: string;
}
interface IdentityRow { readonly id: string | null; }
interface RaceRoundRow { readonly round: number | null; }
interface ProvenanceRow {
  readonly current_database: string;
  readonly current_user: string;
  readonly server_version_num: string;
  readonly transaction_read_only: string;
}
interface IdentityAnalysis {
  readonly rawCount: number;
  readonly normalized: string[];
  readonly nullCount: number;
  readonly malformedCount: number;
  readonly collisionCount: number;
  readonly duplicateCount: number;
}

export function requireConstructorAuthorityAuditConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): ConstructorAuthorityAuditConfiguration {
  if (environment.F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED !== 'true') {
    throw new Error('constructor_authority_audit_not_enabled');
  }
  const target = environment.F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET;
  if (target !== 'localhost' && target !== 'production') {
    throw new Error('constructor_authority_audit_target_invalid');
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new Error('constructor_authority_audit_database_missing');
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('constructor_authority_audit_database_target_invalid');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname ||
      !url.username || url.pathname.length < 2 || url.search || url.hash) {
    throw new Error('constructor_authority_audit_database_target_invalid');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if ((target === 'localhost' && !loopback) ||
      (target === 'production' && (loopback || isUnspecifiedHostname(url.hostname)))) {
    throw new Error('constructor_authority_audit_target_mismatch');
  }
  const targetIdentity = [
    'f1ql-constructor-authority-database-target-v2',
    normalizeHostname(url.hostname),
    url.port || '5432',
    url.pathname
  ].join('\n');
  const databaseTargetSha256 = sha256(targetIdentity);
  if (target === 'production') {
    const expected = environment.F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256;
    if (typeof expected !== 'string' || !SHA256.test(expected)) {
      throw new Error('constructor_authority_audit_expected_target_hash_invalid');
    }
    if (!constantTimeHashEqual(databaseTargetSha256, expected)) {
      throw new Error('constructor_authority_audit_expected_target_mismatch');
    }
  }
  return { connection_string: connectionString, target, database_target_sha256: databaseTargetSha256 };
}

export async function runConstructorAuthorityAudit(
  pool: ConstructorAuthorityAuditPool,
  context: Pick<ConstructorAuthorityAuditConfiguration, 'target' | 'database_target_sha256'>,
  controlTimeoutMs = CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS
): Promise<ConstructorAuthorityAuditReport> {
  if ((context.target !== 'localhost' && context.target !== 'production') ||
      !SHA256.test(context.database_target_sha256) || !Number.isSafeInteger(controlTimeoutMs) ||
      controlTimeoutMs < 1 || controlTimeoutMs > CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS) {
    throw new Error('constructor_authority_audit_context_invalid');
  }
  const client = await pool.connect();
  let transactionOpen = false;
  let released = false;
  try {
    await controlQuery(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', undefined, controlTimeoutMs);
    transactionOpen = true;
    await controlQuery(client, "SELECT set_config('statement_timeout', $1, true)",
      [`${CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS}ms`], controlTimeoutMs);

    const provenance = (await client.query<ProvenanceRow>(`
      SELECT current_database() AS current_database, current_user AS current_user,
        current_setting('server_version_num') AS server_version_num,
        current_setting('transaction_read_only') AS transaction_read_only
    `)).rows[0];
    if (!provenance || provenance.transaction_read_only !== 'on' ||
        !/^\d{5,6}$/.test(provenance.server_version_num)) {
      throw new Error('constructor_authority_audit_database_provenance_invalid');
    }

    const relationRows = (await client.query<RelationRow>(`
      SELECT n.nspname || '.' || c.relname AS relation, c.relkind::text AS relation_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
      ORDER BY (n.nspname || '.' || c.relname) COLLATE "C"
    `, [requiredRelations.map(relation => relation.slice('public.'.length))])).rows;
    const observedRelations = new Set(relationRows.map(row => row.relation));
    const presence = {
      source: observedRelations.has('public.season_constructor_standing'),
      identity: observedRelations.has('public.constructor'),
      race: observedRelations.has('public.race'),
      race_data: observedRelations.has('public.race_data')
    };

    const schemaRows = (await client.query<SchemaRow>(`
      SELECT n.nspname || '.' || c.relname AS relation, c.relkind::text AS relation_kind,
        a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS not_null, a.attnum::integer AS ordinal_position
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND ((n.nspname = 'public' AND c.relname = 'season_constructor_standing' AND a.attname = ANY($1::text[]))
          OR (n.nspname = 'public' AND c.relname = 'constructor' AND a.attname = ANY($2::text[]))
          OR (n.nspname = 'public' AND c.relname = 'race' AND a.attname = ANY($3::text[]))
          OR (n.nspname = 'public' AND c.relname = 'race_data' AND a.attname = ANY($4::text[])))
      ORDER BY (n.nspname || '.' || c.relname) COLLATE "C", a.attnum
    `, [['year', 'constructor_id', 'points'], ['id'], ['id', 'year', 'round'],
      ['race_id', 'type', 'constructor_id']])).rows;

    const constraintRows = (await client.query<ConstraintRow>(`
      SELECT n.nspname || '.' || c.relname AS relation, con.contype::text AS constraint_type,
        array_agg(a.attname ORDER BY key.ordinality)::text[] AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND con.contype IN ('p', 'u')
      GROUP BY n.nspname, c.relname, con.oid, con.contype
      ORDER BY (n.nspname || '.' || c.relname) COLLATE "C", con.contype, con.oid
    `, [requiredRelations.map(relation => relation.slice('public.'.length))])).rows;
    const columnContractMatches = requiredColumns.every(expected => schemaRows.some(observed =>
      observed.relation === expected.relation && observed.column_name === expected.column &&
      observed.data_type === expected.type && observed.not_null === expected.not_null
    )) && schemaRows.length === requiredColumns.length;
    const columnQueryable = requiredColumns.every(expected => schemaRows.some(observed =>
      observed.relation === expected.relation && observed.column_name === expected.column &&
      observed.data_type === expected.type
    )) && schemaRows.length === requiredColumns.length;
    const matchedKeyCount = requiredKeys.filter(expected => constraintRows.some(observed =>
      observed.relation === expected.relation && observed.constraint_type === expected.type &&
      sameStrings(observed.columns, expected.columns)
    )).length;
    const keyContractMatches = matchedKeyCount === requiredKeys.length;
    const schemaQueryable = columnQueryable && presence.source && presence.identity &&
      presence.race && presence.race_data;

    let sourceRows: SourceRow[] = [];
    let identityRows: IdentityRow[] = [];
    let participationRows: ParticipationRow[] = [];
    let raceRoundRows: RaceRoundRow[] = [];
    if (schemaQueryable) {
      sourceRows = (await client.query<SourceRow>(`
        SELECT constructor_id, points::text AS points_text
        FROM public.season_constructor_standing
        WHERE year = $1
        ORDER BY constructor_id COLLATE "C" NULLS FIRST, points::text COLLATE "C" NULLS FIRST
        LIMIT $2
      `, [CONSTRUCTOR_AUTHORITY_AUDIT_SEASON, CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES + 1])).rows;
      raceRoundRows = (await client.query<RaceRoundRow>(`
        SELECT round
        FROM public.race
        WHERE year = $1
        ORDER BY round NULLS FIRST, id
        LIMIT $2
      `, [CONSTRUCTOR_AUTHORITY_AUDIT_SEASON, CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT + 1])).rows;
      participationRows = (await client.query<ParticipationRow>(`
        SELECT rd.constructor_id, COUNT(*)::text AS classification_rows,
          array_to_string(array_agg(DISTINCT r.round ORDER BY r.round), ',') AS rounds_text
        FROM public.race_data rd
        JOIN public.race r ON r.id = rd.race_id
        WHERE r.year = $1 AND lower(btrim(rd.type)) IN ('race', 'race_result')
        GROUP BY rd.constructor_id
        ORDER BY rd.constructor_id COLLATE "C" NULLS FIRST
        LIMIT $2
      `, [CONSTRUCTOR_AUTHORITY_AUDIT_SEASON, CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES + 1])).rows;
      const sourceAnalysis = analyzeIdentities(sourceRows.map(row => row.constructor_id));
      if (sourceRows.length <= CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES && sourceAnalysis.normalized.length > 0) {
        identityRows = (await client.query<IdentityRow>(`
          SELECT id
          FROM public.constructor
          WHERE replace(id, '_', '-') = ANY($1::text[])
          ORDER BY id COLLATE "C"
          LIMIT $2
        `, [sourceAnalysis.normalized, CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES + 1])).rows;
      }
    }

    const sourceAnalysis = analyzeIdentities(sourceRows.map(row => row.constructor_id));
    const identityAnalysis = analyzeIdentities(identityRows.map(row => row.id));
    const participationAnalysis = analyzeIdentities(participationRows.map(row => row.constructor_id));
    const sourceSet = new Set(sourceAnalysis.normalized);
    const identitySet = new Set(identityAnalysis.normalized);
    const participationSet = new Set(participationAnalysis.normalized);
    const identityMissing = difference(sourceSet, identitySet);
    const standingsOnly = difference(sourceSet, participationSet);
    const participationOnly = difference(participationSet, sourceSet);
    const nullPoints = sourceRows.filter(row => row.points_text === null).length;
    const invalidPoints = sourceRows.filter(row => row.points_text !== null && canonicalDecimal(row.points_text) === null).length;
    const facts = sourceRows.flatMap(row => {
      const identity = row.constructor_id === null ? null : normalizeIdentity(row.constructor_id);
      const points = row.points_text === null ? null : canonicalDecimal(row.points_text);
      return identity === null || points === null ? [] : [`${identity}\n${points}`];
    }).sort(compareText);
    const classificationRowCount = participationRows.reduce(
      (total, row) => total + parseCount(row.classification_rows), 0
    );
    const rounds = raceRoundRows.flatMap(row => Number.isSafeInteger(row.round) ? [row.round as number] : []);
    const uniqueRounds = [...new Set(rounds)].sort((left, right) => left - right);
    const invalidRoundCount = raceRoundRows.length - rounds.filter(round => round >= 1 && round <= 24).length;
    const duplicateRoundCount = rounds.length - uniqueRounds.length;
    const incompleteConstructorRoundCount = participationRows.filter(row =>
      !sameNumbers(parseRoundList(row.rounds_text), EXPECTED_ROUNDS)
    ).length;

    const draft = {
      version: CONSTRUCTOR_AUTHORITY_AUDIT_VERSION,
      kind: 'f1ql_constructor_authority_audit' as const,
      target: context.target,
      scope: {
        season: CONSTRUCTOR_AUTHORITY_AUDIT_SEASON,
        standing: 'retained_final_candidate' as const,
        authority_candidate: 'recorded_constructor_championship_points' as const,
        derivation: 'none' as const,
        required_round_count: CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT
      },
      database_provenance: {
        target_sha256: context.database_target_sha256,
        current_database_sha256: sha256(provenance.current_database),
        current_user_sha256: sha256(provenance.current_user),
        server_version_num: provenance.server_version_num,
        transaction_read_only: 'on' as const
      },
      transaction: {
        isolation: 'repeatable_read' as const,
        read_only: true as const,
        statement_timeout_ms: CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS,
        max_identity_count: CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES,
        completion: 'rolled_back' as const
      },
      schema: {
        contract: 'constructor_authority_schema_v2' as const,
        required_relation_count: 4 as const,
        required_column_count: 10 as const,
        required_key_count: 4 as const,
        observed_relation_count: relationRows.length,
        observed_column_count: schemaRows.length,
        observed_key_count: constraintRows.length,
        matched_key_count: matchedKeyCount,
        relation_presence: presence,
        column_contract_matches: columnContractMatches,
        key_contract_matches: keyContractMatches,
        fingerprint_sha256: sha256(stableSerialize(schemaRows)),
        key_fingerprint_sha256: sha256(stableSerialize(constraintRows))
      },
      source: {
        relation: 'public.season_constructor_standing' as const,
        bound_exceeded: sourceRows.length > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES,
        row_count: sourceRows.length,
        raw_identity_count: sourceAnalysis.rawCount,
        normalized_identity_count: sourceAnalysis.normalized.length,
        normalized_identity_set_sha256: hashIdentitySet(sourceAnalysis.normalized),
        fact_count: facts.length,
        fact_set_sha256: hashStringList(facts),
        duplicate_grain_count: sourceAnalysis.duplicateCount,
        null_identity_count: sourceAnalysis.nullCount,
        malformed_identity_count: sourceAnalysis.malformedCount,
        normalization_collision_count: sourceAnalysis.collisionCount,
        null_points_count: nullPoints,
        invalid_points_count: invalidPoints
      },
      identity: {
        relation: 'public.constructor' as const,
        bound_exceeded: identityRows.length > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES,
        observed_row_count: identityRows.length,
        matched_normalized_identity_count: identityAnalysis.normalized.length,
        matched_normalized_identity_set_sha256: hashIdentitySet(identityAnalysis.normalized),
        missing_normalized_identity_count: identityMissing.length,
        missing_normalized_identity_set_sha256: hashIdentitySet(identityMissing),
        malformed_identity_count: identityAnalysis.malformedCount,
        normalization_collision_count: identityAnalysis.collisionCount
      },
      participation: {
        relations: ['public.race', 'public.race_data'] as const,
        bound_exceeded: participationRows.length > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES,
        observed_identity_group_count: participationRows.length,
        classification_row_count: classificationRowCount,
        raw_identity_count: participationAnalysis.rawCount,
        normalized_identity_count: participationAnalysis.normalized.length,
        normalized_identity_set_sha256: hashIdentitySet(participationAnalysis.normalized),
        null_identity_count: participationAnalysis.nullCount,
        malformed_identity_count: participationAnalysis.malformedCount,
        normalization_collision_count: participationAnalysis.collisionCount,
        season_round_count: uniqueRounds.length,
        season_round_set_sha256: hashNumberSet(uniqueRounds),
        duplicate_season_round_count: duplicateRoundCount,
        invalid_season_round_count: invalidRoundCount,
        incomplete_constructor_round_count: incompleteConstructorRoundCount
      },
      membership: {
        final_standings_only_count: standingsOnly.length,
        final_standings_only_sha256: hashIdentitySet(standingsOnly),
        participation_only_count: participationOnly.length,
        participation_only_sha256: hashIdentitySet(participationOnly)
      }
    };
    const reason = determineReason(draft);

    await controlQuery(client, 'ROLLBACK', undefined, controlTimeoutMs);
    transactionOpen = false;
    return parseConstructorAuthorityAuditReport({
      ...draft,
      status: reason === 'passed' ? 'passed' : 'failed',
      reason
    });
  } catch (error) {
    if (error instanceof ConstructorAuthorityControlTimeoutError && !released) {
      client.release(error);
      released = true;
      transactionOpen = false;
      throw error;
    }
    if (transactionOpen && !released) {
      try {
        await controlQuery(client, 'ROLLBACK', undefined, controlTimeoutMs);
        transactionOpen = false;
      } catch {
        const cleanupError = new Error('constructor_authority_audit_cleanup_failed');
        client.release(cleanupError);
        released = true;
        transactionOpen = false;
        throw cleanupError;
      }
    }
    throw error;
  } finally {
    if (!released) {client.release();}
  }
}

export function parseConstructorAuthorityAuditReport(input: unknown): ConstructorAuthorityAuditReport {
  const report = strictRecord(input, [
    'version', 'kind', 'target', 'scope', 'database_provenance', 'transaction', 'schema',
    'source', 'identity', 'participation', 'membership', 'status', 'reason'
  ]);
  const scope = strictRecord(report.scope, [
    'season', 'standing', 'authority_candidate', 'derivation', 'required_round_count'
  ]);
  const provenance = strictRecord(report.database_provenance, [
    'target_sha256', 'current_database_sha256', 'current_user_sha256', 'server_version_num',
    'transaction_read_only'
  ]);
  const transaction = strictRecord(report.transaction, [
    'isolation', 'read_only', 'statement_timeout_ms', 'max_identity_count', 'completion'
  ]);
  const schema = strictRecord(report.schema, [
    'contract', 'required_relation_count', 'required_column_count', 'required_key_count',
    'observed_relation_count', 'observed_column_count', 'observed_key_count', 'matched_key_count',
    'relation_presence', 'column_contract_matches', 'key_contract_matches', 'fingerprint_sha256',
    'key_fingerprint_sha256'
  ]);
  const presence = strictRecord(schema.relation_presence, ['source', 'identity', 'race', 'race_data']);
  const source = strictRecord(report.source, [
    'relation', 'bound_exceeded', 'row_count', 'raw_identity_count', 'normalized_identity_count',
    'normalized_identity_set_sha256', 'fact_count', 'fact_set_sha256', 'duplicate_grain_count',
    'null_identity_count', 'malformed_identity_count', 'normalization_collision_count',
    'null_points_count', 'invalid_points_count'
  ]);
  const identity = strictRecord(report.identity, [
    'relation', 'bound_exceeded', 'observed_row_count', 'matched_normalized_identity_count',
    'matched_normalized_identity_set_sha256', 'missing_normalized_identity_count',
    'missing_normalized_identity_set_sha256', 'malformed_identity_count',
    'normalization_collision_count'
  ]);
  const participation = strictRecord(report.participation, [
    'relations', 'bound_exceeded', 'observed_identity_group_count', 'classification_row_count',
    'raw_identity_count', 'normalized_identity_count', 'normalized_identity_set_sha256',
    'null_identity_count', 'malformed_identity_count', 'normalization_collision_count',
    'season_round_count', 'season_round_set_sha256', 'duplicate_season_round_count',
    'invalid_season_round_count', 'incomplete_constructor_round_count'
  ]);
  const membership = strictRecord(report.membership, [
    'final_standings_only_count', 'final_standings_only_sha256', 'participation_only_count',
    'participation_only_sha256'
  ]);
  const valid = report.version === CONSTRUCTOR_AUTHORITY_AUDIT_VERSION &&
    report.kind === 'f1ql_constructor_authority_audit' &&
    (report.target === 'localhost' || report.target === 'production') &&
    scope.season === CONSTRUCTOR_AUTHORITY_AUDIT_SEASON &&
    scope.standing === 'retained_final_candidate' &&
    scope.authority_candidate === 'recorded_constructor_championship_points' &&
    scope.derivation === 'none' && scope.required_round_count === CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT &&
    hashFields(provenance, ['target_sha256', 'current_database_sha256', 'current_user_sha256']) &&
    typeof provenance.server_version_num === 'string' && /^\d{5,6}$/.test(provenance.server_version_num) &&
    provenance.transaction_read_only === 'on' && transaction.isolation === 'repeatable_read' &&
    transaction.read_only === true && transaction.statement_timeout_ms === CONSTRUCTOR_AUTHORITY_AUDIT_TIMEOUT_MS &&
    transaction.max_identity_count === CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES &&
    transaction.completion === 'rolled_back' && schema.contract === 'constructor_authority_schema_v2' &&
    schema.required_relation_count === 4 && schema.required_column_count === 10 &&
    schema.required_key_count === 4 && counts(schema, [
      'observed_relation_count', 'observed_column_count', 'observed_key_count', 'matched_key_count'
    ]) && booleans(schema, ['column_contract_matches', 'key_contract_matches']) &&
    booleans(presence, ['source', 'identity', 'race', 'race_data']) &&
    hashFields(schema, ['fingerprint_sha256', 'key_fingerprint_sha256']) &&
    source.relation === 'public.season_constructor_standing' && booleans(source, ['bound_exceeded']) &&
    counts(source, ['row_count', 'raw_identity_count', 'normalized_identity_count', 'fact_count',
      'duplicate_grain_count', 'null_identity_count', 'malformed_identity_count',
      'normalization_collision_count', 'null_points_count', 'invalid_points_count']) &&
    hashFields(source, ['normalized_identity_set_sha256', 'fact_set_sha256']) &&
    identity.relation === 'public.constructor' && booleans(identity, ['bound_exceeded']) &&
    counts(identity, ['observed_row_count', 'matched_normalized_identity_count',
      'missing_normalized_identity_count', 'malformed_identity_count', 'normalization_collision_count']) &&
    hashFields(identity, ['matched_normalized_identity_set_sha256', 'missing_normalized_identity_set_sha256']) &&
    sameStrings(participation.relations, ['public.race', 'public.race_data']) &&
    booleans(participation, ['bound_exceeded']) && counts(participation, [
      'observed_identity_group_count', 'classification_row_count', 'raw_identity_count',
      'normalized_identity_count', 'null_identity_count', 'malformed_identity_count',
      'normalization_collision_count', 'season_round_count', 'duplicate_season_round_count',
      'invalid_season_round_count', 'incomplete_constructor_round_count'
    ]) && hashFields(participation, ['normalized_identity_set_sha256', 'season_round_set_sha256']) &&
    counts(membership, ['final_standings_only_count', 'participation_only_count']) &&
    hashFields(membership, ['final_standings_only_sha256', 'participation_only_sha256']) &&
    isReason(report.reason) && (report.status === 'passed' || report.status === 'failed');
  if (!valid || !reportConsistency({ report, schema, presence, source, identity, participation, membership })) {
    throw new Error('constructor_authority_audit_report_invalid');
  }
  return report as unknown as ConstructorAuthorityAuditReport;
}

export function serializeConstructorAuthorityAuditReport(input: unknown): string {
  return stableSerialize(parseConstructorAuthorityAuditReport(input));
}

export function computeConstructorAuthorityAuditSha256(input: unknown): string {
  return sha256(serializeConstructorAuthorityAuditReport(input));
}

export function verifyConstructorAuthorityAuditReport(
  input: unknown,
  expectedSha256: string
): ConstructorAuthorityAuditReport {
  if (!SHA256.test(expectedSha256)) {
    throw new Error('constructor_authority_audit_expected_hash_invalid');
  }
  const report = parseConstructorAuthorityAuditReport(input);
  if (!constantTimeHashEqual(computeConstructorAuthorityAuditSha256(report), expectedSha256)) {
    throw new Error('constructor_authority_audit_hash_mismatch');
  }
  return report;
}

class ConstructorAuthorityControlTimeoutError extends Error {
  constructor() {
    super('constructor_authority_audit_control_timeout');
    this.name = 'ConstructorAuthorityControlTimeoutError';
  }
}

async function controlQuery(
  client: ConstructorAuthorityAuditClient,
  sql: string,
  params: readonly unknown[] | undefined,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.query(sql, params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ConstructorAuthorityControlTimeoutError()), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

function analyzeIdentities(values: readonly (string | null)[]): IdentityAnalysis {
  const raw = new Map<string, number>();
  let nullCount = 0;
  let malformedCount = 0;
  for (const value of values) {
    if (value === null) {nullCount++;}
    else {raw.set(value, (raw.get(value) ?? 0) + 1);}
  }
  const normalizedToRaw = new Map<string, Set<string>>();
  for (const value of raw.keys()) {
    const normalized = normalizeIdentity(value);
    if (normalized === null) {
      malformedCount++;
      continue;
    }
    const sourceValues = normalizedToRaw.get(normalized) ?? new Set<string>();
    sourceValues.add(value);
    normalizedToRaw.set(normalized, sourceValues);
  }
  return {
    rawCount: raw.size,
    normalized: [...normalizedToRaw.keys()].sort(compareText),
    nullCount,
    malformedCount,
    collisionCount: [...normalizedToRaw.values()].filter(values => values.size > 1).length,
    duplicateCount: [...raw.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
  };
}

function normalizeIdentity(value: string): string | null {
  if (value.length < 1 || value.length > 100 || !RAW_ID.test(value)) {return null;}
  const normalized = value.replace(/_/g, '-');
  return CANONICAL_ID.test(normalized) ? normalized : null;
}

function canonicalDecimal(value: string): string | null {
  if (value.length > 64 || !DECIMAL.test(value)) {return null;}
  if (!value.includes('.')) {return value;}
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

function determineReason(input: {
  readonly schema: ConstructorAuthorityAuditReport['schema'];
  readonly source: ConstructorAuthorityAuditReport['source'];
  readonly identity: ConstructorAuthorityAuditReport['identity'];
  readonly participation: ConstructorAuthorityAuditReport['participation'];
  readonly membership: ConstructorAuthorityAuditReport['membership'];
}): ConstructorAuthorityAuditReason {
  const { schema, source, identity, participation, membership } = input;
  if (!schema.relation_presence.source) {return 'source_relation_missing';}
  if (!schema.relation_presence.identity) {return 'identity_relation_missing';}
  if (!schema.relation_presence.race || !schema.relation_presence.race_data) {return 'participation_relation_missing';}
  if (source.bound_exceeded) {return 'source_bound_exceeded';}
  if (identity.bound_exceeded) {return 'identity_bound_exceeded';}
  if (participation.bound_exceeded) {return 'participation_bound_exceeded';}
  if ((!schema.column_contract_matches || !schema.key_contract_matches) && source.row_count === 0) {
    return 'schema_mismatch';
  }
  if (source.row_count === 0) {return 'source_absent';}
  if (source.duplicate_grain_count > 0) {return 'duplicate_grain';}
  if (source.null_identity_count > 0) {return 'null_identity';}
  if (source.malformed_identity_count > 0) {return 'malformed_identity';}
  if (source.normalization_collision_count > 0) {return 'normalization_collision';}
  if (source.null_points_count > 0) {return 'null_points';}
  if (source.invalid_points_count > 0) {return 'invalid_points';}
  if (!schema.column_contract_matches || !schema.key_contract_matches) {return 'schema_mismatch';}
  if (identity.malformed_identity_count > 0 || identity.normalization_collision_count > 0 ||
      identity.missing_normalized_identity_count > 0) {return 'identity_membership_mismatch';}
  if (participation.season_round_count !== CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT ||
      participation.season_round_set_sha256 !== EXPECTED_ROUND_SET_SHA256 ||
      participation.duplicate_season_round_count > 0 || participation.invalid_season_round_count > 0) {
    return 'season_round_coverage_mismatch';
  }
  if (participation.classification_row_count === 0) {return 'participation_absent';}
  if (participation.null_identity_count > 0 || participation.malformed_identity_count > 0 ||
      participation.normalization_collision_count > 0) {return 'participation_identity_invalid';}
  if (participation.incomplete_constructor_round_count > 0) {return 'participation_round_coverage_mismatch';}
  if (membership.final_standings_only_count > 0 || membership.participation_only_count > 0) {
    return 'participation_membership_mismatch';
  }
  return 'passed';
}

function reportConsistency(input: {
  readonly report: Record<string, unknown>;
  readonly schema: Record<string, unknown>;
  readonly presence: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly identity: Record<string, unknown>;
  readonly participation: Record<string, unknown>;
  readonly membership: Record<string, unknown>;
}): boolean {
  const { report, schema, presence, source, identity, participation, membership } = input;
  const expectedRelationCount = ['source', 'identity', 'race', 'race_data']
    .filter(key => presence[key] === true).length;
  const expectedColumnCeiling = (presence.source === true ? 3 : 0) +
    (presence.identity === true ? 1 : 0) + (presence.race === true ? 3 : 0) +
    (presence.race_data === true ? 3 : 0);
  const allRelationsPresent = expectedRelationCount === schema.required_relation_count;
  const sourceRows = source.row_count as number;
  const sourceRaw = source.raw_identity_count as number;
  const sourceNull = source.null_identity_count as number;
  const sourceDuplicates = source.duplicate_grain_count as number;
  const sourceNormalized = source.normalized_identity_count as number;
  const identityMatched = identity.matched_normalized_identity_count as number;
  const identityMissing = identity.missing_normalized_identity_count as number;
  const participationGroups = participation.observed_identity_group_count as number;
  const participationRaw = participation.raw_identity_count as number;
  const participationNull = participation.null_identity_count as number;
  const reason = determineReason({ schema, source, identity, participation, membership } as unknown as {
    schema: ConstructorAuthorityAuditReport['schema'];
    source: ConstructorAuthorityAuditReport['source'];
    identity: ConstructorAuthorityAuditReport['identity'];
    participation: ConstructorAuthorityAuditReport['participation'];
    membership: ConstructorAuthorityAuditReport['membership'];
  });
  const passedConsistency = reason !== 'passed' || (
    sourceRows > 0 && sourceRaw === sourceNormalized && source.fact_count === sourceRows &&
    source.duplicate_grain_count === 0 && source.null_identity_count === 0 &&
    source.malformed_identity_count === 0 && source.normalization_collision_count === 0 &&
    source.null_points_count === 0 && source.invalid_points_count === 0 &&
    identityMatched === sourceNormalized && identityMissing === 0 &&
    identity.malformed_identity_count === 0 && identity.normalization_collision_count === 0 &&
    participationRaw === sourceNormalized && participation.normalized_identity_count === sourceNormalized &&
    (participation.classification_row_count as number) >= sourceNormalized * CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT &&
    participation.season_round_count === CONSTRUCTOR_AUTHORITY_AUDIT_ROUND_COUNT &&
    participation.season_round_set_sha256 === EXPECTED_ROUND_SET_SHA256 &&
    participation.duplicate_season_round_count === 0 && participation.invalid_season_round_count === 0 &&
    participation.incomplete_constructor_round_count === 0 &&
    membership.final_standings_only_count === 0 && membership.participation_only_count === 0
  );
  return schema.observed_relation_count === expectedRelationCount &&
    (schema.observed_column_count as number) <= expectedColumnCeiling &&
    (schema.observed_column_count as number) >= (schema.matched_key_count as number) &&
    (schema.column_contract_matches !== true ||
      (allRelationsPresent && schema.observed_column_count === schema.required_column_count)) &&
    (schema.observed_key_count as number) >= (schema.matched_key_count as number) &&
    (schema.matched_key_count as number) <= expectedRelationCount &&
    (schema.matched_key_count as number) <= (schema.required_key_count as number) &&
    schema.key_contract_matches === (allRelationsPresent &&
      schema.matched_key_count === schema.required_key_count) &&
    sourceRows === sourceRaw + sourceNull + sourceDuplicates &&
    sourceNormalized <= sourceRaw && (source.fact_count as number) <= sourceRows &&
    identityMatched <= (identity.observed_row_count as number) &&
    identityMatched + identityMissing === sourceNormalized &&
    participationGroups === participationRaw + participationNull &&
    (source.bound_exceeded === (sourceRows > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES)) &&
    (identity.bound_exceeded === ((identity.observed_row_count as number) > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES)) &&
    (participation.bound_exceeded === (participationGroups > CONSTRUCTOR_AUTHORITY_AUDIT_MAX_IDENTITIES)) &&
    zeroHashConsistent(source.normalized_identity_count as number, source.normalized_identity_set_sha256) &&
    zeroHashConsistent(source.fact_count as number, source.fact_set_sha256) &&
    zeroHashConsistent(identityMatched, identity.matched_normalized_identity_set_sha256) &&
    zeroHashConsistent(identityMissing, identity.missing_normalized_identity_set_sha256) &&
    zeroHashConsistent(participation.normalized_identity_count as number, participation.normalized_identity_set_sha256) &&
    zeroHashConsistent(participation.season_round_count as number, participation.season_round_set_sha256) &&
    zeroHashConsistent(membership.final_standings_only_count as number, membership.final_standings_only_sha256) &&
    zeroHashConsistent(membership.participation_only_count as number, membership.participation_only_sha256) &&
    (identityMissing !== 0 || identity.matched_normalized_identity_set_sha256 === source.normalized_identity_set_sha256) &&
    ((membership.final_standings_only_count as number) !== 0 ||
      (membership.participation_only_count as number) !== 0 ||
      source.normalized_identity_set_sha256 === participation.normalized_identity_set_sha256) &&
    passedConsistency &&
    report.reason === reason && report.status === (reason === 'passed' ? 'passed' : 'failed');
}

function parseRoundList(value: string): number[] {
  if (value === '') {return [];}
  return value.split(',').flatMap(part => /^\d+$/.test(part) ? [Number(part)] : []);
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(value => !right.has(value)).sort(compareText);
}

function hashIdentitySet(values: readonly string[]): string {
  return hashStringList([...new Set(values)].sort(compareText));
}

function hashStringList(values: readonly string[]): string {
  return values.length === 0 ? EMPTY_SET_SHA256 : sha256(stableSerialize(values));
}

function hashNumberSet(values: readonly number[]): string {
  return values.length === 0 ? EMPTY_SET_SHA256 : sha256(stableSerialize([...new Set(values)].sort((a, b) => a - b)));
}

function zeroHashConsistent(count: number, hash: unknown): boolean {
  return count === 0 ? hash === EMPTY_SET_SHA256 : hash !== EMPTY_SET_SHA256;
}

function parseCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('constructor_authority_audit_count_invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {throw new Error('constructor_authority_audit_count_invalid');}
  return parsed;
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      !sameStrings(Object.keys(input).sort(compareText), [...keys].sort(compareText))) {
    throw new Error('constructor_authority_audit_report_invalid');
  }
  return input as Record<string, unknown>;
}

function counts(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0);
}

function booleans(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => typeof record[key] === 'boolean');
}

function hashFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => typeof record[key] === 'string' && SHA256.test(record[key] as string));
}

function sameStrings(input: unknown, expected: readonly string[]): boolean {
  return Array.isArray(input) && input.length === expected.length &&
    input.every((value, index) => value === expected[index]);
}

function sameNumbers(input: readonly number[], expected: readonly number[]): boolean {
  return input.length === expected.length && input.every((value, index) => value === expected[index]);
}

function isReason(input: unknown): input is ConstructorAuthorityAuditReason {
  return typeof input === 'string' && [
    'passed', 'source_relation_missing', 'identity_relation_missing', 'participation_relation_missing',
    'schema_mismatch', 'source_bound_exceeded', 'identity_bound_exceeded', 'participation_bound_exceeded',
    'source_absent', 'duplicate_grain', 'null_identity', 'malformed_identity', 'normalization_collision',
    'null_points', 'invalid_points', 'identity_membership_mismatch', 'season_round_coverage_mismatch',
    'participation_absent', 'participation_identity_invalid', 'participation_round_coverage_mismatch',
    'participation_membership_mismatch'
  ].includes(input);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isUnspecifiedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const zeroIpv4 = /^0+(?:\.0+){0,3}$/.test(normalized);
  const zeroIpv6 = normalized.includes(':') && normalized.replace(/[:0]/g, '') === '';
  const mappedZeroIpv4 = normalized === '::ffff:0:0';
  return zeroIpv4 || zeroIpv6 || mappedZeroIpv4 || normalized === '*';
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
