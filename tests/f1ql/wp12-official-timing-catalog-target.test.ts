import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { SEMANTIC_CAPABILITY_PROFILES } from '../../src/f1ql/semantic-capability-registry';
import {
  buildSemanticCatalogSnapshot,
  parseSemanticCatalog,
  SEMANTIC_CATALOG,
  SEMANTIC_CATALOG_HASH
} from '../../src/f1ql/semantic-catalog';
import {
  parseWP12OfficialTimingCatalogTarget,
  WP12_OFFICIAL_TIMING_CATALOG_TARGET,
  WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-catalog-target';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import {
  ANSWER_PRINCIPAL_ALLOWED_ROUTINES,
  ANSWER_PRINCIPAL_AUDIT_VERSION,
  ANSWER_PRINCIPAL_REQUIRED_RELATIONS
} from '../../scripts/audit-answer-principal';
import { emitSemanticCatalogSnapshot } from '../../scripts/snapshot-semantic-catalog';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_CATALOG_TARGET);
}

describe('WP12 detached official timing catalog target', () => {
  it('derives the exact catalog-v2 source concepts and certified pins from the activation bundle', () => {
    const source = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog.sources
      .find(candidate => candidate.id === 'official_race_lap_timing')!;
    expect(source).toMatchObject({
      family_id: 'official_historical_laps',
      view: 'f1ql.official_race_lap_timing',
      governance: 'certified',
      view_security_barrier: true,
      grain: {
        kind: 'driver_event_lap',
        key: ['season', 'round', 'driver_id', 'lap_number'],
        uniqueness: 'required'
      }
    });
    expect([...source.dimensions, ...source.measures].map(concept => concept.id).sort()).toEqual(
      WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.concepts.map(concept => concept.id).sort()
    );
    expect(source.certified_scope).toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope);
    expect(source.prohibited_claims).toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.prohibited_claims);
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding.views
      .find(view => view.source_id === source.id)?.columns.map(column => column.id))
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.target_view_columns);
  });

  it('requires physical nullable true and semantic nullable false without generic lap aggregation', () => {
    const source = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog.sources
      .find(candidate => candidate.id === 'official_race_lap_timing')!;
    expect([...source.dimensions, ...source.measures].every(concept =>
      concept.physical_nullable === true && concept.nullable === false)).toBe(true);
    expect(source.measures).toEqual([
      expect.objectContaining({
        id: 'lap_time_seconds',
        semantic_type: 'duration_seconds_exact',
        allowed_aggregations: []
      })
    ]);
    expect(source.prohibited_claims).toEqual(expect.arrayContaining([
      'generic_average', 'generic_median', 'generic_pace'
    ]));
    const genericAggregation = structuredClone(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog) as any;
    genericAggregation.sources.find((candidate: any) => candidate.id === source.id)
      .measures[0].allowed_aggregations = ['sum'];
    expect(() => parseSemanticCatalog(genericAggregation)).toThrow('certified catalog v2 contract');
  });

  it('adds only the bundle three relationships and retains every active relationship', () => {
    const targetRelationships = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog.relationships;
    expect(targetRelationships.filter(relationship => relationship.id.startsWith('official_timing_')))
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships);
    for (const activeRelationship of SEMANTIC_CATALOG.relationships) {
      expect(targetRelationships).toContainEqual(activeRelationship);
    }
    expect(targetRelationships).toHaveLength(SEMANTIC_CATALOG.relationships.length + 3);
  });

  it('defines exact eight-view database-binding and principal-v5 expectations', () => {
    const expectedRelations = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.exact_select_relations_after_activation;
    expect(expectedRelations).toHaveLength(8);
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding.views.map(view => view.view)).toEqual(expectedRelations);
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET.principal_audit).toMatchObject({
      version: 5,
      predecessor_version: 4,
      statement_timeout_ms: 5000,
      login_principal: {
        identity: 'current_user',
        current_user_sha256_observation_required: true,
        current_database_sha256_observation_required: true,
        transaction_read_only: 'on',
        role_attributes: {
          superuser: false, create_role: false, create_database: false,
          replication: false, bypass_row_level_security: false
        },
        database_privileges: { create: false, temporary: false },
        schema_privileges: { f1ql_usage: true, f1ql_create: false, public_create: false },
        private_schema_access: 'none',
        exact_select_relations: expectedRelations,
        writable_relations: [],
        routine_observation_count_required: true,
        effective_routine_execute_count: 0
      },
      sole_group_membership: {
        role_name: 'f1ql_answer', depth: 1, admin_option: false, can_set_role: true,
        role_attributes: {
          login: false, inherit: false, superuser: false, create_role: false,
          create_database: false, replication: false, bypass_row_level_security: false
        }
      }
    });
    expect(ANSWER_PRINCIPAL_ALLOWED_ROUTINES).toEqual([]);
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding).toMatchObject({
      evidence_status: 'expectations_only_not_observed',
      identity_expectations: {
        database_target_sha256_observation_required: true,
        current_user_sha256_observation_required: true,
        current_database_sha256_observation_required: true,
        must_match_principal_audit_current_user_sha256: true,
        must_match_principal_audit_current_database_sha256: true
      },
      observed_evidence: null
    });
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding.views
      .filter(view => view.grain_expectation !== null).map(view => view.view)).toEqual([
      'f1ql.official_race_lap_timing',
      'f1ql.qualifying_classification'
    ]);
    expect(JSON.stringify(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding))
      .not.toContain('"duplicate_grain":false');
  });

  it('pins the real physical column order for all eight views', () => {
    const expectedOrders = {
      'f1ql.answer_driver_identity': ['driver_id', 'identity'],
      'f1ql.answer_event_identity': ['season', 'round', 'identity'],
      'f1ql.answer_season_participation': ['season', 'driver_id', 'participation_source'],
      'f1ql.driver_standings': ['season', 'driver_id', 'championship_position', 'points', 'championship_won'],
      'f1ql.event_classification': [
        'season', 'round', 'driver_id', 'team_id', 'finishing_position', 'points',
        'classification_status', 'status_reason'
      ],
      'f1ql.event_metadata': ['season', 'round', 'event_id', 'event_name', 'circuit_id', 'date'],
      'f1ql.official_race_lap_timing': WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.target_view_columns,
      'f1ql.qualifying_classification': [
        'season', 'round', 'driver_id', 'team_id', 'qualifying_position', 'best_time_ms',
        'best_session', 'eliminated_in_round', 'classification_status'
      ]
    };
    expect(Object.fromEntries(WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding.views.map(view => [
      view.view,
      view.columns.map(column => column.physical_field)
    ]))).toEqual(expectedOrders);
  });

  it('binds reviewed definition artifacts and explicit owner policies without claiming observations', () => {
    const binding = WP12_OFFICIAL_TIMING_CATALOG_TARGET.database_binding;
    for (const view of binding.views) {
      const migration = readFileSync(`migrations/${view.reviewed_definition.migration}`);
      expect(createHash('sha256').update(migration).digest('hex'), view.view)
        .toBe(view.reviewed_definition.migration_sha256);
      expect(view.reviewed_definition.observed_definition_sha256_required).toBe(true);
      expect(view.owner_expectation).toMatchObject({
        owner_identity_sha256_observation_required: true,
        prohibited_owner_roles: ['answer_login_principal', 'f1ql_answer']
      });
      expect(view.owner_expectation.policy).toBe(view.view === 'f1ql.official_race_lap_timing'
        ? 'must_match_activation_migration_executor'
        : 'must_match_signed_active_catalog_binding');
    }
    expect(binding.observed_evidence).toBeNull();
  });

  it.each([
    ['security barrier', (catalog: any) => { officialSource(catalog).view_security_barrier = false; }],
    ['certified governance', (catalog: any) => { officialSource(catalog).governance = 'verified'; }],
    ['immutable freshness', (catalog: any) => { officialSource(catalog).coverage.freshness_class = 'latest_recorded'; }],
    ['required uniqueness', (catalog: any) => { officialSource(catalog).grain.uniqueness = 'verified_at_query'; }],
    ['source presence', (catalog: any) => { officialSource(catalog).integrity.source_presence_required = false; }],
    ['unique key', (catalog: any) => { officialSource(catalog).integrity.unique_key_required = false; }],
    ['exact source checks', (catalog: any) => { officialSource(catalog).integrity.required_checks.shift(); }],
    ['dataset pin', (catalog: any) => { officialSource(catalog).certified_scope.dataset_sha256 = '0'.repeat(64); }],
    ['physical nullability', (catalog: any) => { officialSource(catalog).dimensions[0].physical_nullable = false; }],
    ['semantic nullability', (catalog: any) => { officialSource(catalog).dimensions[0].nullable = true; }],
    ['driver relationship semantics', (catalog: any) => { officialRelationship(catalog, 'official_timing_driver_resolution').optionality = 'left'; }],
    ['event relationship checks', (catalog: any) => { officialRelationship(catalog, 'official_timing_event_resolution').required_checks.shift(); }],
    ['shared-event branch filter', (catalog: any) => { officialRelationship(catalog, 'official_timing_shared_event').required_branch_filters = []; }],
    ['shared-event semantics', (catalog: any) => { officialRelationship(catalog, 'official_timing_shared_event').direction = 'from_to'; }]
  ])('public catalog parser rejects direct v2 %s mutation', (_name, mutate) => {
    const catalog: any = structuredClone(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog);
    mutate(catalog);
    expect(() => parseSemanticCatalog(catalog)).toThrow();
  });

  it.each([
    ['source check', (catalog: any) => {
      catalog.sources[0].integrity.required_checks.push('certified_scope_pin');
      catalog.sources[0].integrity.required_checks.sort();
    }],
    ['operation check', (catalog: any) => {
      const source = catalog.sources.find((candidate: any) => candidate.id === 'event_classification');
      source.integrity.operation_checks[0].required_checks.push('certified_scope_pin');
      source.integrity.operation_checks[0].required_checks.sort();
    }]
  ])('public catalog parser rejects certified scope pin in non-lap v2 %s', (_name, mutate) => {
    const catalog: any = structuredClone(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog);
    mutate(catalog);
    expect(() => parseSemanticCatalog(catalog)).toThrow('without driver-event-lap grain');
  });

  it.each([
    ['source check', (catalog: any) => {
      catalog.sources[0].integrity.required_checks.push('certified_scope_pin');
      catalog.sources[0].integrity.required_checks.sort();
    }],
    ['operation check', (catalog: any) => {
      catalog.sources.find((source: any) => source.id === 'event_classification')
        .integrity.operation_checks[0].required_checks.push('certified_scope_pin');
      catalog.sources.find((source: any) => source.id === 'event_classification')
        .integrity.operation_checks[0].required_checks.sort();
    }],
    ['relationship check', (catalog: any) => {
      catalog.relationships[0].required_checks.push('certified_scope_pin');
      catalog.relationships[0].required_checks.sort();
    }]
  ])('public catalog parser rejects v2-only %s in catalog v1', (_name, mutate) => {
    const catalog: any = structuredClone(SEMANTIC_CATALOG);
    mutate(catalog);
    expect(() => parseSemanticCatalog(catalog)).toThrow('catalog v1');
  });

  it('keeps active catalog bytes, exclusions, principal v4, policy, and capabilities unchanged', () => {
    const committedSnapshot = readFileSync('tests/fixtures/semantic-catalog.snapshot.json', 'utf8');
    expect(emitSemanticCatalogSnapshot()).toBe(committedSnapshot);
    expect(JSON.parse(committedSnapshot)).toEqual(buildSemanticCatalogSnapshot());
    expect(SEMANTIC_CATALOG.version).toBe(1);
    expect(SEMANTIC_CATALOG_HASH).toBe('19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8');
    expect(SEMANTIC_CATALOG.excluded_families).toContain('official_historical_laps');
    expect(SEMANTIC_CATALOG.sources.some(source => source.id === 'official_race_lap_timing')).toBe(false);
    expect(ANSWER_PRINCIPAL_AUDIT_VERSION).toBe(4);
    expect(ANSWER_PRINCIPAL_REQUIRED_RELATIONS).toHaveLength(7);
    expect(SEMANTIC_CAPABILITY_PROFILES.some(profile =>
      profile.source_sets.some(sourceSet => sourceSet.includes('official_race_lap_timing' as never)))).toBe(false);
    expect(authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'official_event_mean_compare',
        metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso'
      }
    })).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
  });

  it('is detached from execution code, deeply frozen, and hash-bound', () => {
    const source = readFileSync('src/f1ql/wp12-official-timing-catalog-target.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:executor|interpreter|planned|route|result-format|translator)/);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_CATALOG_TARGET)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog.sources)).toBe(true);
    expect(WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256)
      .toBe('44abf16a8731b25e505afdbdcbb24855eff7d91de81aeb6cf0587465f81dbe57');
    expect(WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256)
      .toBe('2d6ea575fea5a384f4144f97c095719635c42042d3ea898cc540e0b45c568844');
    expect(WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256)
      .toBe('afcd23e625f84bc863c5ef465511a9b8e50633c21a99d41c3ca58309776f19ab');
    expect(WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256)
      .toBe('46da8fc3918e9b0d8b948336f0cb52a5bac28436caf7455c894b360d6fba4b39');
    expect(parseWP12OfficialTimingCatalogTarget(cloneTarget())).toEqual(WP12_OFFICIAL_TIMING_CATALOG_TARGET);
  });

  it.each([
    ['unknown target field', (target: any) => { target.extra = true; }],
    ['catalog version', (target: any) => { target.catalog.version = 1; }],
    ['source concept', (target: any) => { target.catalog.sources.find((source: any) => source.id === 'official_race_lap_timing').dimensions.pop(); }],
    ['dataset pin', (target: any) => { target.catalog.sources.find((source: any) => source.id === 'official_race_lap_timing').certified_scope.dataset_sha256 = '0'.repeat(64); }],
    ['semantic nullability', (target: any) => { target.catalog.sources.find((source: any) => source.id === 'official_race_lap_timing').dimensions[0].nullable = true; }],
    ['physical nullability', (target: any) => { target.catalog.sources.find((source: any) => source.id === 'official_race_lap_timing').dimensions[0].physical_nullable = false; }],
    ['relationship key', (target: any) => { target.catalog.relationships.find((relationship: any) => relationship.id === 'official_timing_shared_event').from_keys.pop(); }],
    ['binding relation', (target: any) => { target.database_binding.views.pop(); }],
    ['principal relation', (target: any) => { target.principal_audit.login_principal.exact_select_relations.reverse(); }],
    ['target hash', (target: any) => { target.catalog_sha256 = '0'.repeat(64); }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingCatalogTarget(target)).toThrow();
  });
});

function officialSource(catalog: any): any {
  return catalog.sources.find((source: any) => source.id === 'official_race_lap_timing');
}

function officialRelationship(catalog: any, id: string): any {
  return catalog.relationships.find((relationship: any) => relationship.id === id);
}
