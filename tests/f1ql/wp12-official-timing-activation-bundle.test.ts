import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE,
  OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE
} from '../../src/f1ql/official-historical-lap-candidate';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { SEMANTIC_CAPABILITY_PROFILES } from '../../src/f1ql/semantic-capability-registry';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import {
  parseWP12OfficialTimingActivationBundle,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL,
  WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL
} from '../../src/f1ql/wp12-official-timing-activation-bundle';

function cloneBundle(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE);
}

describe('WP12 official timing atomic activation bundle', () => {
  it('is strict, deeply frozen, and hash-bound', () => {
    expect(parseWP12OfficialTimingActivationBundle(cloneBundle())).toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions[0])).toBe(true);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256)
      .toBe('e02ea6b00b55fbc8774c735b34eb04bf92177373fb31cd9c66079d8bb3f219aa');
    const reordered = Object.fromEntries(Object.entries(cloneBundle()).reverse());
    expect(parseWP12OfficialTimingActivationBundle(reordered)).toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE);
  });

  it('pins both reviewed inactive candidate commits and factual authority', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.baseline).toMatchObject({
      lap_candidate_commit: 'e2ce639c9071fe966a2ebf6936d04a2590c7cd6d',
      event_mean_candidate_commit: '947214471d7c5fcd9d3e74b465cdeb2a63cd8e50',
      active_catalog_sha256: SEMANTIC_CATALOG_HASH
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope).toMatchObject({
      dataset_sha256: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.dataset_sha256,
      source_manifest_sha256: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.source_manifest_sha256,
      identity_map_sha256: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.identity_map_sha256,
      identity_fingerprint: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.identity_fingerprint,
      fact_fingerprint: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.fact_fingerprint,
      race_history_artifact_sha256: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.race_history_artifact_sha256,
      event_name: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope.event,
      identity_count: 20,
      fact_count: 790,
      fact_bearing_driver_count: 19
    });
  });

  it('keeps the active catalog, capability registry, and answer policy unchanged', () => {
    expect(SEMANTIC_CATALOG_HASH).toBe('19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8');
    expect(SEMANTIC_CATALOG.excluded_families).toContain('official_historical_laps');
    expect(SEMANTIC_CATALOG.sources.some(source => source.id === 'official_race_lap_timing')).toBe(false);
    expect(SEMANTIC_CAPABILITY_PROFILES.some(profile =>
      profile.source_sets.some(sourceSet => sourceSet.includes('official_race_lap_timing' as never))
    )).toBe(false);
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

  it('requires a narrowed security-barrier answer view with no prohibited physical fields', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source).toMatchObject({
      view: 'f1ql.official_race_lap_timing',
      view_security_barrier: true,
      grain: { kind: 'driver_event_lap', key: ['season', 'round', 'driver_id', 'lap_number'], uniqueness: 'required' }
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.inaccessible_columns)
      .toEqual(['leader_gap_seconds', 'official_name', 'racing_number']);
    for (const field of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.inaccessible_columns) {
      expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.target_view_columns).not.toContain(field);
    }
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.concepts.find(concept => concept.id === 'lap_time_seconds'))
      .toMatchObject({ kind: 'measure', operators: [], physical_nullable: true, nullable: false });
  });

  it('binds two metric-specific contracts without generic median or average', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics.map(metric => metric.metric_id)).toEqual([
      OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE.metric.id,
      OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.metric.id
    ]);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics).toContainEqual(expect.objectContaining({
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      complete_requested_window_required: true,
      maximum_inclusive_window_laps: 50,
      minimum_eligible_laps_per_driver: 2
    }));
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics).toContainEqual(expect.objectContaining({
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      complete_classified_event_required: true,
      completed_lap_counts_may_differ: true,
      minimum_eligible_laps_per_driver: 2
    }));
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.prohibited_claims)
      .toEqual(expect.arrayContaining(['generic_average', 'generic_median', 'generic_pace']));
  });

  it('requires two named branches over one source and counts both source scans', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies).toHaveLength(2);
    for (const topology of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies) {
      expect(topology).toMatchObject({
        id: 'same_source_scalar_comparison',
        source_id: 'official_race_lap_timing',
        branch_ids: ['driver_a', 'driver_b'],
        pre_eligibility_predicates: [],
        comparison: { relation: 'lower', delta: 'absolute', winner_on_equal: null, decimal_scale: 4 },
        work: { sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0, requested_rows: 1 }
      });
      expect(topology.common_predicates).toContain('driver_id:eq:branch_local');
      expect(topology.integrity_checks).toContain('non_overlapping_exclusions');
    }
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[0]).toMatchObject({
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      window_predicate: null,
      integrity_checks: expect.arrayContaining(['complete_classified_event'])
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[0].integrity_checks)
      .not.toContain('complete_requested_window');
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[1]).toMatchObject({
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      window_predicate: 'lap_number:range:inclusive:max_50',
      integrity_checks: expect.arrayContaining(['complete_requested_window'])
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[1].integrity_checks)
      .not.toContain('complete_classified_event');
  });

  it('binds exact driver, event, and same-source relationship edges', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships).toEqual([
      expect.objectContaining({
        id: 'official_timing_driver_resolution', from_source: 'answer_driver_identity',
        to_source: 'official_race_lap_timing', from_keys: ['driver_id'], to_keys: ['driver_id'],
        cardinality: 'many_to_many', direction: 'from_to', optionality: 'inner', join_stage: 'resolution',
        filter_propagation: 'resolved_identity', governance: 'verified', required_scope_predicates: []
      }),
      expect.objectContaining({
        id: 'official_timing_event_resolution', from_source: 'answer_event_identity',
        to_source: 'official_race_lap_timing', from_keys: ['season', 'round'], to_keys: ['season', 'round'],
        cardinality: 'many_to_many', direction: 'from_to', optionality: 'inner', join_stage: 'resolution',
        filter_propagation: 'resolved_identity', governance: 'verified', required_scope_predicates: []
      }),
      expect.objectContaining({
        id: 'official_timing_shared_event', from_source: 'official_race_lap_timing',
        to_source: 'official_race_lap_timing', from_keys: ['dataset_sha256', 'season', 'round'],
        to_keys: ['dataset_sha256', 'season', 'round'], cardinality: 'many_to_many', direction: 'bidirectional',
        optionality: 'inner', join_stage: 'row', filter_propagation: 'same_event', governance: 'verified',
        required_branch_filters: ['driver_id'], required_scope_predicates: []
      })
    ]);
    for (const relationship of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships) {
      expect(relationship.required_checks.length).toBeGreaterThan(0);
      expect(relationship.integrity_checks.length).toBeGreaterThan(0);
    }
  });

  it('requires typed coverage abstention before planning and execution', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision).toEqual({
      eligible_type: 'eligible',
      abstain_type: 'abstain',
      abstain_reason: 'source_coverage_missing',
      stage: 'official_timing_coverage',
      timing: 'before_planning_and_result_execution',
      integrity_failures_are_coverage: false,
      integrity_failure_type: 'abstain',
      integrity_failure_reason: 'source_integrity_failed',
      integrity_failure_stage: 'official_timing_integrity'
    });
  });

  it('binds exact public output fields and keeps integrity internal', () => {
    for (const output of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas) {
      expect(output.internal_only_fields).toEqual(['f1ql_integrity_ok']);
      expect(output.field_ids).not.toContain('f1ql_integrity_ok');
      expect(output.exact_decimal_fields).toHaveLength(3);
      expect(output.required_caveats).toEqual(expect.arrayContaining([
        'fia_official_raw_race_lap_timing',
        'not_clean_air_or_causal_pace',
        'official_deleted_and_explicit_pit_rows_excluded'
      ]));
    }
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.map(output => output.decimal_representation)).toEqual([
      'canonical_rounded_decimal_string_seconds_scale_4_half_away_from_zero',
      'canonical_exact_decimal_string_seconds_scale_4'
    ]);
  });

  it('requires exact least privilege and all coordinated version transitions', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database).toMatchObject({
      answer_role: 'f1ql_answer',
      private_schema_access: 'none',
      writable_relations: 0,
      executable_routines: 0,
      database_temporary: false,
      statement_timeout_required: true,
      read_only_transaction_required: true
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.exact_select_relations_after_activation).toEqual([
      'f1ql.answer_driver_identity', 'f1ql.answer_event_identity', 'f1ql.answer_season_participation',
      'f1ql.driver_standings', 'f1ql.event_classification', 'f1ql.event_metadata',
      'f1ql.official_race_lap_timing', 'f1ql.qualifying_classification'
    ]);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database).toMatchObject({
      target_activation_migration: '20260807_f1ql_official_race_lap_timing_activation.sql',
      target_activation_migration_sha256: 'feee77471d5d80342a2a22b3480b3ac3a8d74df628b7a7ab433ea6aa414b6eaf'
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.filter(version => version.transition === 'atomic').length)
      .toBeGreaterThan(20);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.filter(version => version.transition === 'unchanged'))
      .toEqual([
        { component: 'legacy_compiler', current: 'core-v11', target: 'core-v11', transition: 'unchanged' },
        { component: 'legacy_definitions', current: 'v10', target: 'v10', transition: 'unchanged' },
        { component: 'result_collection', current: 'semantic-limit-plus-one-v1', target: 'semantic-limit-plus-one-v1', transition: 'unchanged' }
      ]);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation).toMatchObject({
      signed_release_attestation_required: true,
      production_database_binding_required: true,
      partial_hash_set_rejected: true
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes)
      .toEqual(expect.arrayContaining(['catalog', 'capability_registry', 'catalog_database_binding', 'principal_audit']));
    const atomicComponents = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions
      .filter(version => version.transition === 'atomic')
      .map(version => version.component);
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes)
      .toEqual(expect.arrayContaining(atomicComponents));
  });

  it('pins an unapplied narrow-view activation migration with exact grant scope', () => {
    const path = 'migrations/20260807_f1ql_official_race_lap_timing_activation.sql';
    const migration = fs.readFileSync(path);
    expect(createHash('sha256').update(migration).digest('hex'))
      .toBe(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration_sha256);
    const sql = migration.toString('utf8');
    expect(sql).toContain('CREATE OR REPLACE VIEW f1ql.official_race_lap_timing');
    expect(sql).toContain('WITH (security_barrier = true)');
    expect(sql).toContain('GRANT SELECT ON f1ql.official_race_lap_timing TO f1ql_answer');
    expect(sql).toContain('REVOKE ALL ON f1ql.official_race_lap_timing FROM f1ql_answer');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(sql).not.toContain('leader_gap_seconds');
    expect(sql).not.toContain('official_name');
    expect(sql).not.toContain('racing_number');
  });

  it('preserves shadow non-execution and has no runtime dependency imports', () => {
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution).toMatchObject({
      shadow_result_query_calls: 0,
      shadow_translated_execution: false,
      throwing_executor_test_required: true
    });
    const source = fs.readFileSync('src/f1ql/wp12-official-timing-activation-bundle.ts', 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports).toEqual(['node:crypto', 'zod']);
    expect(source.match(/^import .*;$/gm)).toEqual([
      "import { createHash } from 'node:crypto';",
      "import { z } from 'zod';"
    ]);
    for (const forbidden of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.forbidden_imports) {
      expect(imports.some(specifier => specifier.includes(forbidden))).toBe(false);
    }
  });

  it('binds coverage to exact aggregate-only statements and execution bounds', () => {
    const statements = [WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL, WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL];
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_query_calls_max).toBe(1);
    WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries.forEach((query, index) => {
      expect(query).toMatchObject({
        target_relation: 'f1ql.official_race_lap_timing',
        statement_timeout_ms: 2000,
        transaction: 'repeatable_read_read_only',
        maximum_rows: 2,
        projected_fields: [
          'driver_id', 'completed_laps', 'eligible_laps', 'deleted_laps', 'pit_marker_laps',
          'first_lap', 'last_lap', 'distinct_laps', 'dataset_count'
        ]
      });
      expect(query.statement_sha256).toBe(createHash('sha256').update(statements[index]).digest('hex'));
      expect(statements[index]).not.toContain('lap_time_seconds');
      expect(statements[index]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    });
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries.map(query => query.parameter_order)).toEqual([
      ['season', 'round', 'driver_ids'],
      ['season', 'round', 'driver_ids', 'lap_start', 'lap_end']
    ]);
  });

  it('matches real artifact pins and closed-emitter output field order', () => {
    const sourceFixture = JSON.parse(fs.readFileSync('data/phase8-belgium-2022-pilot.json', 'utf8')) as any;
    const windowFixture = JSON.parse(fs.readFileSync('data/phase8-belgium-2022-f1ql-result.json', 'utf8')) as any;
    const meanFixture = JSON.parse(fs.readFileSync('data/phase9-belgium-2022-event-mean-result.json', 'utf8')) as any;
    const scope = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
    expect(scope.final_classification_artifact_sha256).toBe(sourceFixture.artifacts.final_race_classification.sha256);
    expect(scope.deleted_laps_artifact_sha256).toBe(sourceFixture.artifacts.deleted_race_lap_times.sha256);
    expect(scope.race_history_artifact_sha256).toBe(sourceFixture.artifacts.race_history_chart.sha256);
    const identities = JSON.parse(fs.readFileSync('data/phase8-belgium-2022-identity-map.json', 'utf8')) as any;
    const classifiedByRacingNumber = new Map(sourceFixture.identities.map((identity: any) => [identity.racing_number, identity.classified_laps]));
    expect(scope.classified_laps_by_driver).toEqual(identities.mappings.map((mapping: any) => ({
      driver_id: mapping.driver_id.replaceAll('_', '-'),
      classified_laps: classifiedByRacingNumber.get(mapping.racing_number)
    })).sort((left: any, right: any) => left.driver_id.localeCompare(right.driver_id)));
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas[0].field_ids).toEqual(Object.keys(meanFixture.rows[0]));
    expect(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas[1].field_ids).toEqual(Object.keys(windowFixture.rows[0]));
  });

  it.each([
    ['unknown field', (bundle: any) => { bundle.extra = true; }],
    ['catalog hash', (bundle: any) => { bundle.baseline.active_catalog_sha256 = '0'.repeat(64); }],
    ['dataset pin', (bundle: any) => { bundle.source.certified_scope.dataset_sha256 = '0'.repeat(64); }],
    ['final classification artifact', (bundle: any) => { bundle.source.certified_scope.final_classification_artifact_sha256 = '0'.repeat(64); }],
    ['deleted laps artifact', (bundle: any) => { bundle.source.certified_scope.deleted_laps_artifact_sha256 = '0'.repeat(64); }],
    ['classified lap map', (bundle: any) => { bundle.source.certified_scope.classified_laps_by_driver[0].classified_laps = 43; }],
    ['prohibited column', (bundle: any) => { bundle.source.target_view_columns.push('leader_gap_seconds'); }],
    ['relationship key', (bundle: any) => { bundle.relationships[1].to_keys = ['season']; }],
    ['metric rule', (bundle: any) => { bundle.metrics[0].minimum_eligible_laps_per_driver = 1; }],
    ['branch identity', (bundle: any) => { bundle.topologies[0].branch_ids = ['driver_a', 'driver_a']; }],
    ['source scan accounting', (bundle: any) => { bundle.topologies[0].work.source_scans = 1; }],
    ['pre-eligibility filtering', (bundle: any) => { bundle.topologies[0].pre_eligibility_predicates = ['official_deleted_lap:eq:false']; }],
    ['coverage query hash', (bundle: any) => { bundle.non_execution.coverage_queries[0].statement_sha256 = '0'.repeat(64); }],
    ['coverage timing', (bundle: any) => { bundle.coverage_decision.timing = 'after_execution'; }],
    ['public integrity field', (bundle: any) => { bundle.output_schemas[0].field_ids.push('f1ql_integrity_ok'); }],
    ['private schema access', (bundle: any) => { bundle.database.private_schema_access = 'select'; }],
    ['activation migration hash', (bundle: any) => { bundle.database.target_activation_migration_sha256 = '0'.repeat(64); }],
    ['partial version transition', (bundle: any) => { bundle.versions[0].target = bundle.versions[0].current; }],
    ['shadow result execution', (bundle: any) => { bundle.non_execution.shadow_result_query_calls = 1; }],
    ['missing activation gate', (bundle: any) => { bundle.activation_gates.pop(); }]
  ])('rejects %s mutation', (_name, mutate) => {
    const bundle = cloneBundle();
    mutate(bundle);
    expect(() => parseWP12OfficialTimingActivationBundle(bundle)).toThrow();
  });
});
