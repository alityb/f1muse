import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  computeSemanticCatalogHash,
  parseSemanticCatalog,
  SEMANTIC_CATALOG,
  SEMANTIC_CATALOG_HASH,
  type SemanticCatalog
} from './semantic-catalog';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relationSchema = z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/);
const safeRoleAttributesSchema = z.object({
  superuser: z.literal(false),
  create_role: z.literal(false),
  create_database: z.literal(false),
  replication: z.literal(false),
  bypass_row_level_security: z.literal(false)
}).strict();

const principalTargetSchema = z.object({
  version: z.literal(5),
  predecessor_version: z.literal(4),
  statement_timeout_ms: z.literal(5000),
  login_principal: z.object({
    identity: z.literal('current_user'),
    current_user_sha256_observation_required: z.literal(true),
    current_database_sha256_observation_required: z.literal(true),
    transaction_read_only: z.literal('on'),
    role_attributes: safeRoleAttributesSchema,
    database_privileges: z.object({ create: z.literal(false), temporary: z.literal(false) }).strict(),
    schema_privileges: z.object({
      f1ql_usage: z.literal(true),
      f1ql_create: z.literal(false),
      public_create: z.literal(false)
    }).strict(),
    private_schema_access: z.literal('none'),
    exact_select_relations: z.array(relationSchema).length(8),
    writable_relations: z.array(relationSchema).length(0),
    routine_observation_count_required: z.literal(true),
    effective_routine_execute_count: z.literal(0)
  }).strict(),
  sole_group_membership: z.object({
    role_name: z.literal('f1ql_answer'),
    depth: z.literal(1),
    admin_option: z.literal(false),
    can_set_role: z.literal(true),
    role_attributes: safeRoleAttributesSchema.extend({
      login: z.literal(false),
      inherit: z.literal(false)
    }).strict()
  }).strict()
}).strict();

const databaseBindingTargetSchema = z.object({
  version: z.literal(2),
  evidence_status: z.literal('expectations_only_not_observed'),
  catalog_hash: sha256Schema,
  activation_migration: z.literal('20260807_f1ql_official_race_lap_timing_activation.sql'),
  activation_migration_sha256: sha256Schema,
  binding_requirements: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  identity_expectations: z.object({
    database_target_sha256_observation_required: z.literal(true),
    current_user_sha256_observation_required: z.literal(true),
    current_database_sha256_observation_required: z.literal(true),
    must_match_principal_audit_current_user_sha256: z.literal(true),
    must_match_principal_audit_current_database_sha256: z.literal(true)
  }).strict(),
  views: z.array(z.object({
    source_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    view: relationSchema,
    relation_options: z.array(z.string()),
    owner_expectation: z.object({
      policy: z.enum(['must_match_activation_migration_executor', 'must_match_signed_active_catalog_binding']),
      owner_identity_sha256_observation_required: z.literal(true),
      prohibited_owner_roles: z.tuple([z.literal('answer_login_principal'), z.literal('f1ql_answer')])
    }).strict(),
    reviewed_definition: z.object({
      migration: z.string().regex(/^20[0-9]{6}_[a-z0-9_]+\.sql$/),
      migration_sha256: sha256Schema,
      observed_definition_sha256_required: z.literal(true)
    }).strict(),
    columns: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_]*$/),
      physical_field: z.string().regex(/^[a-z][a-z0-9_]*$/),
      physical_type: z.enum(['boolean', 'date', 'integer', 'numeric', 'text']),
      physical_nullable: z.boolean(),
      semantic_nullable: z.boolean()
    }).strict()).min(1),
    grain_expectation: z.object({
      key: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
      uniqueness: z.literal('required'),
      duplicate_grain_observation_required: z.literal(true)
    }).strict().nullable()
  }).strict()).length(8),
  principal_target_sha256: sha256Schema,
  observed_evidence: z.null()
}).strict();

const targetSchema = z.object({
  version: z.literal(1),
  status: z.literal('detached_inactive_target'),
  active_catalog_sha256: sha256Schema,
  catalog: z.unknown(),
  catalog_sha256: sha256Schema,
  database_binding: databaseBindingTargetSchema,
  database_binding_sha256: sha256Schema,
  principal_audit: principalTargetSchema,
  principal_audit_sha256: sha256Schema
}).strict();

function conceptLanguage(names: readonly string[], forbiddenConflations: readonly string[]) {
  return {
    names: [...names].sort(compareText),
    synonyms: [],
    abbreviations: [],
    ambiguity_groups: ['official_timing'],
    forbidden_conflations: [...forbiddenConflations].sort(compareText)
  };
}

const VIEW_COLUMN_ORDERS: Readonly<Record<string, readonly string[]>> = {
  answer_driver_identity: ['driver_id', 'identity'],
  answer_event_identity: ['season', 'round', 'identity'],
  answer_season_participation: ['season', 'driver_id', 'participation_source'],
  driver_standings: ['season', 'driver_id', 'championship_position', 'points', 'championship_won'],
  event_classification: [
    'season', 'round', 'driver_id', 'team_id', 'finishing_position', 'points',
    'classification_status', 'status_reason'
  ],
  event_metadata: ['season', 'round', 'event_id', 'event_name', 'circuit_id', 'date'],
  official_race_lap_timing: [
    'authority', 'contract_version', 'dataset_sha256', 'driver_id', 'event_name', 'fact_fingerprint',
    'identity_fingerprint', 'identity_map_sha256', 'lap_number', 'lap_time_seconds',
    'official_deleted_lap', 'official_pit_marker', 'round', 'season', 'session_type',
    'source_artifact_sha256', 'source_manifest_sha256'
  ],
  qualifying_classification: [
    'season', 'round', 'driver_id', 'team_id', 'qualifying_position', 'best_time_ms',
    'best_session', 'eliminated_in_round', 'classification_status'
  ]
};

const REVIEWED_VIEW_DEFINITIONS: Readonly<Record<string, {
  readonly migration: string;
  readonly migration_sha256: string;
}>> = {
  answer_driver_identity: {
    migration: '20260730_normalize_f1ql_answer_identity_driver_ids.sql',
    migration_sha256: '262ab40627e512d66008268d4898fd9b73d3bb220180e5386ed31163220e878b'
  },
  answer_event_identity: {
    migration: '20260730_normalize_f1ql_answer_identity_driver_ids.sql',
    migration_sha256: '262ab40627e512d66008268d4898fd9b73d3bb220180e5386ed31163220e878b'
  },
  answer_season_participation: {
    migration: '20260730_normalize_f1ql_answer_identity_driver_ids.sql',
    migration_sha256: '262ab40627e512d66008268d4898fd9b73d3bb220180e5386ed31163220e878b'
  },
  driver_standings: {
    migration: '20260718_create_f1ql_standings_view.sql',
    migration_sha256: '2c01146dd7ec3d167410f957c4974bd579916a214c12a37a481a8ca03751901f'
  },
  event_classification: {
    migration: '20260727_normalize_f1ql_nonstarter_statuses.sql',
    migration_sha256: '10dbd2bbe8661cae14c8494288ff3f6d2955bc7d054c97f8f14e020670533d84'
  },
  event_metadata: {
    migration: '20260721_add_f1ql_event_metadata.sql',
    migration_sha256: '8a3a2809543c2b214547cd3a0e281a1fc319c72a9f43f229777f140312715e73'
  },
  official_race_lap_timing: {
    migration: '20260807_f1ql_official_race_lap_timing_activation.sql',
    migration_sha256: 'feee77471d5d80342a2a22b3480b3ac3a8d74df628b7a7ab433ea6aa414b6eaf'
  },
  qualifying_classification: {
    migration: '20260730_filter_f1ql_qualifying_classification.sql',
    migration_sha256: 'bb65c6a6bed3cc77ec735da4668bc9098cd8a81acc0e606d009da0a6871163b9'
  }
};

function buildOfficialTimingConcepts() {
  const bundleSource = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source;
  const dimensions = bundleSource.concepts.filter(concept => concept.kind !== 'measure').map(concept => ({
    id: concept.id,
    physical_field: concept.id,
    physical_type: concept.physical_type,
    semantic_type: concept.semantic_type,
    units: concept.units,
    physical_nullable: concept.physical_nullable,
    nullable: concept.nullable,
    null_meaning: concept.null_meaning,
    filter_operators: [...concept.operators],
    allowed_values: [...concept.allowed_values],
    groupable: false,
    language: conceptLanguage(concept.language_names, bundleSource.coverage.unsupported)
  }));
  const measures = bundleSource.concepts.filter(concept => concept.kind === 'measure').map(concept => ({
    id: concept.id,
    physical_field: concept.id,
    physical_type: concept.physical_type,
    semantic_type: concept.semantic_type,
    units: concept.units,
    physical_nullable: concept.physical_nullable,
    nullable: concept.nullable,
    null_meaning: concept.null_meaning,
    authority: concept.authority,
    expression_class: 'column' as const,
    filter_operators: [...concept.operators],
    allowed_aggregations: [],
    additivity: 'non_additive' as const,
    depends_on: [],
    language: conceptLanguage(concept.language_names, bundleSource.coverage.unsupported)
  }));
  return { dimensions, measures };
}

function buildOfficialTimingSource() {
  const bundleSource = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source;
  const { dimensions, measures } = buildOfficialTimingConcepts();
  const completenessChecks = [...new Set(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships
    .flatMap(relationship => relationship.integrity_checks))].sort(compareText);
  return {
    id: bundleSource.source_id,
    family_id: bundleSource.family_id,
    view: bundleSource.view,
    usage: bundleSource.usage,
    view_security_barrier: bundleSource.view_security_barrier,
    owner: SEMANTIC_CATALOG.owner,
    governance: bundleSource.governance,
    description: `${bundleSource.authority}: ${bundleSource.classification.replaceAll('_', ' ')}.`,
    grain: structuredClone(bundleSource.grain),
    scope: {
      season_min: bundleSource.certified_scope.season,
      season_max: bundleSource.certified_scope.season,
      final_season_through: bundleSource.certified_scope.season,
      sessions: ['race'] as const,
      temporal_rule: bundleSource.coverage.freshness,
      current_semantics: null
    },
    dimensions,
    measures,
    authority: {
      primary: bundleSource.authority,
      supplementary: [],
      prohibited_derivations: [...bundleSource.coverage.unsupported]
    },
    integrity: {
      source_presence_required: true,
      unique_key_required: true,
      required_checks: ['certified_scope_pin', 'source_presence', 'unique_grain'] as const,
      operation_checks: [],
      position_bounds: [],
      completeness_checks: completenessChecks
    },
    coverage: {
      observed: bundleSource.coverage.observed,
      certified: bundleSource.coverage.certified,
      freshness: bundleSource.coverage.freshness,
      observed_seasons: null,
      certification_class: 'cited_facts_only' as const,
      freshness_class: 'immutable_historical' as const,
      unsupported_ids: [...bundleSource.prohibited_claims],
      unsupported: [...bundleSource.coverage.unsupported]
    },
    language: conceptLanguage(
      [bundleSource.classification.replaceAll('_', ' ')],
      bundleSource.coverage.unsupported
    ),
    certified_scope: structuredClone(bundleSource.certified_scope),
    prohibited_claims: [...bundleSource.prohibited_claims]
  };
}

function buildCatalogTarget(): SemanticCatalog {
  const catalog = structuredClone(SEMANTIC_CATALOG) as any;
  const source = buildOfficialTimingSource();
  catalog.version = 2;
  catalog.families.push({
    id: source.family_id,
    description: source.description,
    source_ids: [source.id]
  });
  catalog.families.sort((left: { id: string }, right: { id: string }) => compareText(left.id, right.id));
  catalog.sources.push(source);
  catalog.sources.sort((left: { id: string }, right: { id: string }) => compareText(left.id, right.id));
  catalog.relationships.push(...structuredClone(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships));
  catalog.relationships.sort((left: { id: string }, right: { id: string }) => compareText(left.id, right.id));
  catalog.excluded_families = catalog.excluded_families.filter((id: string) => id !== source.family_id);
  return parseSemanticCatalog(catalog);
}

function orderedSourceConcepts(source: SemanticCatalog['sources'][number]) {
  const concepts = new Map([...source.dimensions, ...source.measures].map(concept => [concept.id, concept]));
  const ids = VIEW_COLUMN_ORDERS[source.id];
  if (!ids) {throw new Error(`WP12 catalog target lacks column order for ${source.id}`);}
  return ids.map(id => {
    const concept = concepts.get(id);
    if (!concept || concept.physical_field === null) {
      throw new Error(`WP12 catalog target lacks physical concept ${source.id}.${id}`);
    }
    return {
      id: concept.id,
      physical_field: concept.physical_field,
      physical_type: concept.physical_type,
      physical_nullable: concept.physical_nullable,
      semantic_nullable: concept.nullable
    };
  });
}

function grainExpectation(source: SemanticCatalog['sources'][number]) {
  if (source.grain.uniqueness !== 'required') {return null;}
  return {
    key: [...source.grain.key],
    uniqueness: 'required' as const,
    duplicate_grain_observation_required: true as const
  };
}

function reviewedDefinition(sourceId: string) {
  const definition = REVIEWED_VIEW_DEFINITIONS[sourceId];
  if (!definition) {throw new Error(`WP12 catalog target lacks reviewed definition for ${sourceId}`);}
  return { ...definition, observed_definition_sha256_required: true as const };
}

function ownerExpectation(sourceId: string) {
  return {
    policy: sourceId === WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.source_id
      ? 'must_match_activation_migration_executor' as const
      : 'must_match_signed_active_catalog_binding' as const,
    owner_identity_sha256_observation_required: true as const,
    prohibited_owner_roles: ['answer_login_principal', 'f1ql_answer'] as const
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export const WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET = buildCatalogTarget();
export const WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256 =
  computeSemanticCatalogHash(WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET);

const rawPrincipalTarget = {
  version: 5,
  predecessor_version: 4,
  statement_timeout_ms: 5000,
  login_principal: {
    identity: 'current_user',
    current_user_sha256_observation_required: true,
    current_database_sha256_observation_required: true,
    transaction_read_only: 'on',
    role_attributes: {
      superuser: false,
      create_role: false,
      create_database: false,
      replication: false,
      bypass_row_level_security: false
    },
    database_privileges: { create: false, temporary: false },
    schema_privileges: { f1ql_usage: true, f1ql_create: false, public_create: false },
    private_schema_access: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.private_schema_access,
    exact_select_relations: [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.exact_select_relations_after_activation],
    writable_relations: [],
    routine_observation_count_required: true,
    effective_routine_execute_count: 0
  },
  sole_group_membership: {
    role_name: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.answer_role,
    depth: 1,
    admin_option: false,
    can_set_role: true,
    role_attributes: {
      login: false,
      inherit: false,
      superuser: false,
      create_role: false,
      create_database: false,
      replication: false,
      bypass_row_level_security: false
    }
  }
} as const;

export const WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET = deepFreeze(principalTargetSchema.parse(rawPrincipalTarget));
export const WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET);

const rawDatabaseBindingTarget = {
  version: 2,
  evidence_status: 'expectations_only_not_observed',
  catalog_hash: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  activation_migration: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration,
  activation_migration_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration_sha256,
  binding_requirements: [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.binding_requirements],
  identity_expectations: {
    database_target_sha256_observation_required: true,
    current_user_sha256_observation_required: true,
    current_database_sha256_observation_required: true,
    must_match_principal_audit_current_user_sha256: true,
    must_match_principal_audit_current_database_sha256: true
  },
  views: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET.sources.map(source => ({
    source_id: source.id,
    view: source.view,
    relation_options: source.view_security_barrier ? ['security_barrier=true'] : [],
    owner_expectation: ownerExpectation(source.id),
    reviewed_definition: reviewedDefinition(source.id),
    columns: orderedSourceConcepts(source),
    grain_expectation: grainExpectation(source)
  })),
  principal_target_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  observed_evidence: null
} as const;

export const WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET =
  deepFreeze(databaseBindingTargetSchema.parse(rawDatabaseBindingTarget));
export const WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256 =
  hash(WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET);

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  active_catalog_sha256: SEMANTIC_CATALOG_HASH,
  catalog: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET,
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  database_binding: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET,
  database_binding_sha256: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  principal_audit: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET,
  principal_audit_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256
} as const;
const canonicalTargetSerialization = stableSerialize(rawTarget);

export type WP12OfficialTimingCatalogTarget = z.infer<typeof targetSchema> & { readonly catalog: SemanticCatalog };

export function parseWP12OfficialTimingCatalogTarget(input: unknown): WP12OfficialTimingCatalogTarget {
  const envelope = targetSchema.parse(input);
  const catalog = parseSemanticCatalog(envelope.catalog);
  const principal = principalTargetSchema.parse(envelope.principal_audit);
  const binding = databaseBindingTargetSchema.parse(envelope.database_binding);
  if (computeSemanticCatalogHash(catalog) !== envelope.catalog_sha256 ||
      hash(principal) !== envelope.principal_audit_sha256 ||
      hash(binding) !== envelope.database_binding_sha256 ||
      binding.catalog_hash !== envelope.catalog_sha256 ||
      binding.principal_target_sha256 !== envelope.principal_audit_sha256 ||
      stableSerialize({ ...envelope, catalog, principal_audit: principal, database_binding: binding }) !==
        canonicalTargetSerialization) {
    throw new Error('FAIL_CLOSED: WP12 official timing catalog target differs from the reviewed derivation');
  }
  return deepFreeze({ ...envelope, catalog, principal_audit: principal, database_binding: binding });
}

export const WP12_OFFICIAL_TIMING_CATALOG_TARGET = parseWP12OfficialTimingCatalogTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_CATALOG_TARGET);

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
