import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseWP12OfficialTimingMigrationTarget,
  WP12_OFFICIAL_TIMING_MIGRATION_TARGET,
  WP12_OFFICIAL_TIMING_MIGRATION_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-migration-target';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_MIGRATION_TARGET);
}

const MIGRATION_PATH = 'migrations/20260807_f1ql_official_race_lap_timing_activation.sql';

describe('WP12 detached official timing activation-migration target', () => {
  it('binds the exact migration bytes named by the activation bundle', () => {
    const target = WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract;
    const bytes = readFileSync(MIGRATION_PATH);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(target.migration.name).toBe('20260807_f1ql_official_race_lap_timing_activation.sql');
    expect(target.migration.sha256).toBe(sha256);
    expect(target.migration.sha256)
      .toBe(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration_sha256);
    expect(target.migration.applied_locally).toBe(false);
    expect(target.migration.applied_production).toBe(false);
  });

  it('binds both prerequisite migrations in bundle order with verified bytes', () => {
    const target = WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract;
    expect(target.prerequisite_migrations.map(item => item.name)).toEqual([
      '20260801_official_timing_historical_laps.sql',
      '20260802_f1ql_official_lap_timing.sql'
    ]);
    for (const prerequisite of target.prerequisite_migrations) {
      const bytes = readFileSync(`migrations/${prerequisite.name}`);
      expect(prerequisite.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(prerequisite.applied_locally).toBe(false);
      expect(prerequisite.applied_production).toBe(false);
    }
  });

  it('seals the exact DDL contract against the migration file content', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const ddl = WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract.exact_statements.ddl;
    expect(sql).toContain('CREATE OR REPLACE VIEW f1ql.official_race_lap_timing');
    expect(sql).toContain('security_barrier = true');
    expect(sql).toContain('FROM f1ql.official_lap_timing');
    expect(ddl.select_columns_in_order)
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.target_view_columns);
    expect(ddl.select_columns_in_order).toHaveLength(17);
    const selectList = sql.match(/SELECT([\s\S]*?)FROM f1ql\.official_lap_timing/)![1];
    const selectColumns = selectList.split(',').map(item => item.trim()).filter(item => item.length > 0);
    expect(selectColumns).toEqual([...ddl.select_columns_in_order]);
    const whereClause = sql.match(/WHERE([\s\S]*?);\s*$/s)![1];
    const scope = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
    const predicates = [
      `authority = 'FIA'`,
      `contract_version = 'immutable_official_lap_event_v1'`,
      `season = ${scope.season}`,
      `round = ${scope.round}`,
      `session_type = 'R'`,
      `event_name = '${scope.event_name}'`,
      `dataset_sha256 = '${scope.dataset_sha256}'`,
      `source_manifest_sha256 = '${scope.source_manifest_sha256}'`,
      `identity_map_sha256 = '${scope.identity_map_sha256}'`,
      `identity_fingerprint = '${scope.identity_fingerprint}'`,
      `fact_fingerprint = '${scope.fact_fingerprint}'`,
      `source_artifact_sha256 = '${scope.race_history_artifact_sha256}'`
    ];
    for (const predicate of predicates) {
      expect(whereClause).toContain(predicate);
    }
    expect(whereClause.match(/\bAND\b/g)).toHaveLength(predicates.length - 1);
    expect(ddl.inaccessible_columns_excluded)
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.inaccessible_columns);
    for (const excluded of ddl.inaccessible_columns_excluded) {
      expect(selectList).not.toContain(excluded);
    }
  });

  it('seals the exact grant contract against the migration file content', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const grants = WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract.exact_statements.grants;
    expect(grants).toEqual({
      revoke_all_from_public: true,
      revoke_all_from_answer_role: true,
      grant_select_to_answer_role: true,
      answer_role: 'f1ql_answer',
      no_other_grants_or_revokes: true
    });
    expect(sql).toContain('REVOKE ALL ON f1ql.official_race_lap_timing FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON f1ql.official_race_lap_timing FROM f1ql_answer;');
    expect(sql).toContain('GRANT SELECT ON f1ql.official_race_lap_timing TO f1ql_answer;');
    expect(sql.match(/\bGRANT\b/g)).toHaveLength(1);
    expect(sql.match(/\bREVOKE\b/g)).toHaveLength(2);
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract
      .exact_statements.comment_required).toBe(true);
    expect(sql).toContain('COMMENT ON VIEW f1ql.official_race_lap_timing');
  });

  it('forbids application outside the atomic activation gate and keeps all evidence absent', () => {
    const target = WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract;
    expect(target.version_transition).toEqual({
      current: 'unapplied',
      target: 'applied_with_signed_evidence',
      transition: 'atomic'
    });
    expect(Object.keys(target.application_requirements).sort()).toEqual([
      'applied_only_during_atomic_activation',
      'evidence_hashes',
      'never_applied_to_shared_database_outside_release_gate',
      'no_ddl_or_dml_beyond_reviewed_statements',
      'observed_post_application_evidence_required',
      'statement_timeout_required'
    ]);
    expect(target.application_requirements.applied_only_during_atomic_activation).toBe(true);
    expect(target.application_requirements.never_applied_to_shared_database_outside_release_gate).toBe(true);
    expect(target.application_requirements.statement_timeout_required).toBe(true);
    expect(target.application_requirements.no_ddl_or_dml_beyond_reviewed_statements).toBe(true);
    expect(target.application_requirements.evidence_hashes).toEqual({
      observed_definition_sha256: null,
      observed_owner_sha256: null,
      observed_grants_sha256: null,
      application_evidence_artifact_sha256: null
    });
    expect(target.application_requirements.observed_post_application_evidence_required)
      .toEqual(expect.arrayContaining([
        'definition_sha256', 'owner_identity', 'security_barrier', 'grain_uniqueness',
        'select_grant_exactly_f1ql_answer', 'row_count_matches_certified_scope'
      ]));
    expect(target.implementation_evidence).toBeNull();
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.implementation_status)
      .toBe('contract_expectations_only_not_runtime_implementation');
  });

  it('binds every sibling detached target composite hash', () => {
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_bundle_sha256)
      .toBe('e02ea6b00b55fbc8774c735b34eb04bf92177373fb31cd9c66079d8bb3f219aa');
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.catalog_target_sha256)
      .toBe('46da8fc3918e9b0d8b948336f0cb52a5bac28436caf7455c894b360d6fba4b39');
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.semantic_target_sha256)
      .toBe('1b06103fa99c9556484cbba46c1bf83a9fcfaaba2572eed1e012e391dcf053bc');
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.interface_target_sha256)
      .toBe('ec33aa2ec7e2bdee332aeef309de7b541d9eb5616a0242aeeed80e6553e380e7');
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.shadow_release_target_sha256)
      .toBe('8c0ab5273787757e8c32066cdd7cd1175a5011b3405188e3b799c2668dc14638');
  });

  it('is detached from execution code and deeply frozen', () => {
    const source = readFileSync('src/f1ql/wp12-official-timing-migration-target.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:executor|interpreter|route|translator|semantic-plan-execution|semantic-result-format|result-database|answer-authorization|wp12-official-timing-interface-target|wp12-official-timing-semantic-target|wp12-official-timing-shadow-release-target)/);
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_MIGRATION_TARGET)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_MIGRATION_TARGET.activation_migration.contract
      .application_requirements.evidence_hashes)).toBe(true);
  });

  it('round-trips through the fail-closed parser', () => {
    expect(parseWP12OfficialTimingMigrationTarget(cloneTarget()))
      .toEqual(WP12_OFFICIAL_TIMING_MIGRATION_TARGET);
    expect(WP12_OFFICIAL_TIMING_MIGRATION_TARGET_SHA256)
      .toBe('69f79cefbbdb74393d942472063d0a9026a9b21a27a9caba4cb40358c6094313');
  });

  it.each([
    ['unknown target field', (target: any) => { target.extra = true; }],
    ['migration hash', (target: any) => { target.activation_migration.contract.migration.sha256 = '0'.repeat(64); }],
    ['migration applied', (target: any) => { target.activation_migration.contract.migration.applied_locally = true; }],
    ['prerequisite removed', (target: any) => { target.activation_migration.contract.prerequisite_migrations.pop(); }],
    ['ddl column order', (target: any) => { target.activation_migration.contract.exact_statements.ddl.select_columns_in_order.reverse(); }],
    ['filter predicate', (target: any) => { target.activation_migration.contract.exact_statements.ddl.filter_predicates.round = 15; }],
    ['grant loosened', (target: any) => { target.activation_migration.contract.exact_statements.grants.revoke_all_from_public = false; }],
    ['evidence present', (target: any) => { target.activation_migration.contract.application_requirements.evidence_hashes.observed_definition_sha256 = '0'.repeat(64); }],
    ['implementation evidence', (target: any) => { target.activation_migration.contract.implementation_evidence = {}; }],
    ['sibling hash', (target: any) => { target.shadow_release_target_sha256 = '0'.repeat(64); }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingMigrationTarget(target)).toThrow();
  });
});
