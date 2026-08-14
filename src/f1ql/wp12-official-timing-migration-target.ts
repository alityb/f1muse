import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from './wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256 } from './wp12-official-timing-catalog-target';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const migrationNameSchema = z.string().regex(/^20[0-9]{6}_[a-z0-9_]+\.sql$/);
const statusSchema = z.literal('detached_inactive_target');
const implementationStatusSchema = z.literal('contract_expectations_only_not_runtime_implementation');
const WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256 =
  '1b06103fa99c9556484cbba46c1bf83a9fcfaaba2572eed1e012e391dcf053bc';
const WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256 =
  '9d416a60f46520896a9173669d80ba5e4a0777f99d085d1d4cb52bee28b51d28';
const WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET_SHA256 =
  '9944df93551cdaacb527028c790db4eddd451d8d4388085706f22c92bf702912';

const activationMigrationSchema = z.object({
  name: migrationNameSchema,
  sha256: sha256Schema,
  applied_locally: z.literal(false),
  applied_production: z.literal(false)
}).strict();

const targetSchema = z.object({
  version: z.literal(1),
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  activation_bundle_sha256: sha256Schema,
  catalog_target_sha256: sha256Schema,
  semantic_target_sha256: sha256Schema,
  interface_target_sha256: sha256Schema,
  shadow_release_target_sha256: sha256Schema,
  activation_migration: z.object({
    status: statusSchema,
    implementation_status: implementationStatusSchema,
    activation_target_name: z.literal('activation_migration'),
    contract: z.object({
      version_transition: z.object({
        current: z.literal('unapplied'),
        target: z.literal('applied_with_signed_evidence'),
        transition: z.literal('atomic')
      }).strict(),
      migration: activationMigrationSchema,
      prerequisite_migrations: z.array(activationMigrationSchema).length(2),
      exact_statements: z.object({
        ddl: z.object({
          operation: z.literal('create_or_replace_view'),
          relation: z.literal('f1ql.official_race_lap_timing'),
          security_barrier: z.literal(true),
          base_relation: z.literal('f1ql.official_lap_timing'),
          select_columns_in_order: z.array(idSchema).length(17),
          filter_predicates: z.object({
            authority: z.literal('FIA'),
            contract_version: z.literal('immutable_official_lap_event_v1'),
            season: z.literal(2022),
            round: z.literal(14),
            session_type: z.literal('R'),
            event_name: z.literal('2022 Belgian Grand Prix'),
            dataset_sha256: sha256Schema,
            source_manifest_sha256: sha256Schema,
            identity_map_sha256: sha256Schema,
            identity_fingerprint: sha256Schema,
            fact_fingerprint: sha256Schema,
            source_artifact_sha256: sha256Schema
          }).strict(),
          inaccessible_columns_excluded: z.array(idSchema).length(3)
        }).strict(),
        grants: z.object({
          revoke_all_from_public: z.literal(true),
          revoke_all_from_answer_role: z.literal(true),
          grant_select_to_answer_role: z.literal(true),
          answer_role: z.literal('f1ql_answer'),
          no_other_grants_or_revokes: z.literal(true)
        }).strict(),
        comment_required: z.literal(true)
      }).strict(),
      replaces_broad_legacy_view_preserving_compiler_regression_source: z.literal(true),
      exposes_only_reviewed_semantic_fields: z.literal(true),
      application_requirements: z.object({
        applied_only_during_atomic_activation: z.literal(true),
        never_applied_to_shared_database_outside_release_gate: z.literal(true),
        statement_timeout_required: z.literal(true),
        no_ddl_or_dml_beyond_reviewed_statements: z.literal(true),
        observed_post_application_evidence_required: z.array(idSchema).min(1),
        evidence_hashes: z.object({
          observed_definition_sha256: z.null(),
          observed_owner_sha256: z.null(),
          observed_grants_sha256: z.null(),
          application_evidence_artifact_sha256: z.null()
        }).strict()
      }).strict(),
      implementation_evidence: z.null()
    }).strict()
  }).strict()
}).strict();

function migration(name: string) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join('migrations', name));
  } catch (error) {
    throw new Error(`FAIL_CLOSED: WP12 activation migration ${name} is unreadable from the repository root`);
  }
  return {
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    applied_locally: false as const,
    applied_production: false as const
  };
}

const scope = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
const activationMigration = migration(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration);
const prerequisites = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.required_migrations
  .filter(name => name !== WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration)
  .map(migration);
if (prerequisites.length !== 2) {
  throw new Error('FAIL_CLOSED: WP12 activation bundle must name exactly two prerequisite migrations');
}
if (activationMigration.sha256 !== WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration_sha256) {
  throw new Error('FAIL_CLOSED: WP12 activation migration bytes differ from the reviewed activation bundle hash');
}

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  catalog_target_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  semantic_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256,
  interface_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256,
  shadow_release_target_sha256: WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET_SHA256,
  activation_migration: {
    status: 'detached_inactive_target',
    implementation_status: 'contract_expectations_only_not_runtime_implementation',
    activation_target_name: 'activation_migration',
    contract: {
      version_transition: {
        current: 'unapplied',
        target: 'applied_with_signed_evidence',
        transition: 'atomic'
      },
      migration: activationMigration,
      prerequisite_migrations: prerequisites,
      exact_statements: {
        ddl: {
          operation: 'create_or_replace_view',
          relation: 'f1ql.official_race_lap_timing',
          security_barrier: true,
          base_relation: 'f1ql.official_lap_timing',
          select_columns_in_order: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.target_view_columns,
          filter_predicates: {
            authority: 'FIA',
            contract_version: 'immutable_official_lap_event_v1',
            season: scope.season,
            round: scope.round,
            session_type: scope.session_type,
            event_name: scope.event_name,
            dataset_sha256: scope.dataset_sha256,
            source_manifest_sha256: scope.source_manifest_sha256,
            identity_map_sha256: scope.identity_map_sha256,
            identity_fingerprint: scope.identity_fingerprint,
            fact_fingerprint: scope.fact_fingerprint,
            source_artifact_sha256: scope.race_history_artifact_sha256
          },
          inaccessible_columns_excluded: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.inaccessible_columns
        },
        grants: {
          revoke_all_from_public: true,
          revoke_all_from_answer_role: true,
          grant_select_to_answer_role: true,
          answer_role: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.answer_role,
          no_other_grants_or_revokes: true
        },
        comment_required: true
      },
      replaces_broad_legacy_view_preserving_compiler_regression_source: true,
      exposes_only_reviewed_semantic_fields: true,
      application_requirements: {
        applied_only_during_atomic_activation: true,
        never_applied_to_shared_database_outside_release_gate: true,
        statement_timeout_required: true,
        no_ddl_or_dml_beyond_reviewed_statements: true,
        observed_post_application_evidence_required: [
          'column_nullability', 'column_order', 'column_types', 'definition_sha256', 'grain_uniqueness',
          'owner_identity', 'relation_options', 'row_count_matches_certified_scope', 'security_barrier',
          'select_grant_exactly_f1ql_answer'
        ].sort(compareText),
        evidence_hashes: {
          observed_definition_sha256: null,
          observed_owner_sha256: null,
          observed_grants_sha256: null,
          application_evidence_artifact_sha256: null
        }
      },
      implementation_evidence: null
    }
  }
} as const;
const canonicalTarget = stableSerialize(rawTarget);

export type WP12OfficialTimingMigrationTarget = z.infer<typeof targetSchema>;

export function parseWP12OfficialTimingMigrationTarget(input: unknown): WP12OfficialTimingMigrationTarget {
  assertCanonicalData(input, 'target');
  const parsed = targetSchema.parse(input);
  if (stableSerialize(parsed) !== canonicalTarget) {
    throw new Error('FAIL_CLOSED: WP12 official timing migration target differs from the reviewed derivation');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_MIGRATION_TARGET = parseWP12OfficialTimingMigrationTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_MIGRATION_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_MIGRATION_TARGET);

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  assertCanonicalData(value, 'value');
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalData(
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): asserts value is null | boolean | number | string | object {
  if (depth > 100) {throw new Error(`FAIL_CLOSED: canonical depth exceeded at ${path}`);}
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return;}
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`FAIL_CLOSED: non-canonical number at ${path}`);
    }
    return;
  }
  if (typeof value !== 'object') {throw new Error(`FAIL_CLOSED: non-canonical value at ${path}`);}
  if (seen.has(value)) {throw new Error(`FAIL_CLOSED: cyclic or shared reference at ${path}`);}
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {throw new Error(`FAIL_CLOSED: symbol property at ${path}`);}
  if (Array.isArray(value)) {
    assertCanonicalArray(value, path, seen, depth);
    return;
  }
  assertCanonicalObject(value, path, seen, depth);
}

function assertCanonicalArray(value: unknown[], path: string, seen: WeakSet<object>, depth: number): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`FAIL_CLOSED: non-standard array prototype at ${path}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1 || !descriptors.length) {
    throw new Error(`FAIL_CLOSED: sparse or extended array at ${path}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`FAIL_CLOSED: sparse or accessor array at ${path}`);
    }
    assertCanonicalData(descriptor.value, `${path}[${index}]`, seen, depth + 1);
  }
}

function assertCanonicalObject(value: object, path: string, seen: WeakSet<object>, depth: number): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`FAIL_CLOSED: non-plain object at ${path}`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`FAIL_CLOSED: accessor or hidden property at ${path}.${key}`);
    }
    assertCanonicalData(descriptor.value, `${path}.${key}`, seen, depth + 1);
  }
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
