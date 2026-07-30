import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  buildSemanticCatalogDatabaseBinding,
  buildSemanticCatalogSnapshot,
  computeSemanticCatalogHash,
  parseSemanticCatalog,
  SEMANTIC_CATALOG,
  SEMANTIC_CATALOG_HASH
} from '../../src/f1ql/semantic-catalog';
import { emitSemanticCatalogSnapshot } from '../../scripts/snapshot-semantic-catalog';
import { auditSemanticCatalogBinding, parseSemanticCatalogBindingArtifact, verifySemanticCatalogBindingArtifact, writeSemanticCatalogBindingAudit } from '../../scripts/audit-semantic-catalog-binding';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;
const auditKeys = generateKeyPairSync('ed25519');

describe('semantic catalog', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    await pool.query('CREATE TABLE driver_aliases (driver_id text, alias text, is_primary boolean)');
    const standingsMigration = readFileSync(path.resolve(process.cwd(), 'migrations/20260718_create_f1ql_standings_view.sql'), 'utf8');
    await pool.query(standingsMigration.split('CREATE OR REPLACE VIEW f1ql.lap_pace')[0]);
    for (const migration of [
      '20260727_normalize_f1ql_nonstarter_statuses.sql',
      '20260730_filter_f1ql_qualifying_classification.sql',
      '20260721_add_f1ql_event_metadata.sql',
      '20260729_f1ql_answer_identity_views.sql',
      '20260730_normalize_f1ql_answer_identity_driver_ids.sql',
      '20260730_f1ql_answer_role_grants.sql'
    ]) {
      await pool.query(readFileSync(path.resolve(process.cwd(), 'migrations', migration), 'utf8'));
    }
    await pool.query(`
      INSERT INTO driver (id, name, full_name, abbreviation) VALUES
        ('catalog_driver_a', 'Catalog A', 'Catalog Driver A', 'CDA'),
        ('catalog_driver_b', 'Catalog B', 'Catalog Driver B', 'CDB');
      INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
        VALUES ('catalog_gp', 'Catalog Grand Prix', 'Formula 1 Catalog Grand Prix', 'Catalog GP', 'CAT');
      INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9901, 2025, 1, 'catalog_gp', 'catalog_circuit', 'FORMULA 1 CATALOG GRAND PRIX', '2025-01-01');
      INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
        (2025, 'catalog-entrant', 'catalog-team', 'catalog_driver_a', false),
        (2024, 'catalog-entrant', 'catalog-team', 'catalog_driver_b', false);
      INSERT INTO season_driver_standing
        (year, position_display_order, position_number, driver_id, points, championship_won) VALUES
        (2025, 1, 1, 'catalog_driver_a', 25, true),
        (2025, 2, 2, 'catalog_driver_b', 18, false);
      INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points) VALUES
        (9901, 'race', 'catalog_driver_a', 'catalog-team', 1, 1, 25),
        (9901, 'race', 'catalog_driver_b', 'catalog-team', 2, 2, 18);
      INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type) VALUES
        (2025, 1, 'catalog_driver_a', 'catalog-team', 1, 'RACE_QUALIFYING'),
        (2025, 1, 'catalog_driver_b', 'catalog-team', 2, 'RACE_QUALIFYING');
    `);
  });

  afterAll(async () => {
    await pool.query(`DO $cleanup$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1ql_answer') THEN
          EXECUTE 'DROP OWNED BY f1ql_answer';
          EXECUTE 'DROP ROLE f1ql_answer';
        END IF;
      END
    $cleanup$`);
    await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
    await pool.query('DROP TABLE IF EXISTS driver_aliases');
    await pool.end();
  });

  it('exports five immutable families over the seven governed answer views', () => {
    expect(SEMANTIC_CATALOG.families).toHaveLength(5);
    expect(SEMANTIC_CATALOG.sources.map(source => source.view)).toEqual([
      'f1ql.answer_driver_identity',
      'f1ql.answer_event_identity',
      'f1ql.answer_season_participation',
      'f1ql.driver_standings',
      'f1ql.event_classification',
      'f1ql.event_metadata',
      'f1ql.qualifying_classification'
    ]);
    expect(SEMANTIC_CATALOG.excluded_families).toContain('pace');
    expect(Object.isFrozen(SEMANTIC_CATALOG)).toBe(true);
    expect(Object.isFrozen(SEMANTIC_CATALOG.sources[0].dimensions)).toBe(true);
    expect(SEMANTIC_CATALOG_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps excluded concepts and conditional fanout machine-readable', () => {
    const race = SEMANTIC_CATALOG.sources.find(source => source.id === 'event_classification')!;
    const qualifying = SEMANTIC_CATALOG.sources.find(source => source.id === 'qualifying_classification')!;
    expect(race.dimensions.find(item => item.id === 'team_id')).toMatchObject({ filter_operators: [], groupable: false });
    expect(qualifying.dimensions.find(item => item.id === 'team_id')).toMatchObject({ filter_operators: [], groupable: false });
    expect(qualifying.measures.find(item => item.id === 'best_time_ms')).toMatchObject({ allowed_aggregations: [] });
    expect(qualifying.measures.find(item => item.id === 'qualifying_position')).toMatchObject({ filter_operators: ['eq', 'in', 'range'] });
    expect(qualifying.dimensions.find(item => item.id === 'classification_status')?.allowed_values).toEqual(['classified', 'dnf', 'dns']);
    expect(SEMANTIC_CATALOG.relationships.find(item => item.id === 'qualifying_shared_event')).toMatchObject({
      cardinality: 'many_to_many',
      required_branch_filters: ['driver_id'],
      required_checks: ['non_null_measure', 'source_presence', 'unique_filtered_branch']
    });
    expect(SEMANTIC_CATALOG.relationships.find(item => item.id === 'driver_participation_resolution')?.required_scope_predicates)
      .toEqual([{ side: 'to', concept_id: 'season', operator: 'eq_parameter', parameter: 'season' }]);
    expect(race.integrity.operation_checks).toContainEqual({
      operation_class: 'position_filter',
      required_checks: ['non_null_position', 'unique_relevant_position']
    });
  });

  it('is reproduced exactly by the committed real-emitter snapshot', () => {
    const committed = readFileSync(path.resolve(process.cwd(), 'tests/fixtures/semantic-catalog.snapshot.json'), 'utf8');
    expect(committed).toBe(emitSemanticCatalogSnapshot());
    expect(JSON.parse(committed)).toEqual(buildSemanticCatalogSnapshot());
  });

  it('changes its hash for a valid semantic authority mutation', () => {
    const mutated = structuredClone(SEMANTIC_CATALOG);
    mutated.sources[3].authority.primary = `${mutated.sources[3].authority.primary} Reviewed mutation.`;
    expect(computeSemanticCatalogHash(mutated)).not.toBe(SEMANTIC_CATALOG_HASH);
  });

  it.each([
    ['duplicate source ID', (catalog: any) => { catalog.sources[1].id = catalog.sources[0].id; }],
    ['unknown family source', (catalog: any) => { catalog.families[0].source_ids = ['missing_source']; }],
    ['duplicate physical field', (catalog: any) => { catalog.sources[3].measures[0].physical_field = 'driver_id'; }],
    ['unknown relationship endpoint', (catalog: any) => { catalog.relationships[0].to_source = 'missing_source'; }],
    ['relationship type mismatch', (catalog: any) => { catalog.relationships[1].to_keys = ['event_name', 'round']; }],
    ['range filtering on status', (catalog: any) => { catalog.sources[4].dimensions[0].filter_operators.push('range'); catalog.sources[4].dimensions[0].filter_operators.sort(); }],
    ['missing null contract', (catalog: any) => { catalog.sources[4].measures[0].null_meaning = ''; }],
    ['missing coverage boundary', (catalog: any) => { catalog.sources[4].coverage.unsupported_ids = []; }],
    ['unsecured identity view', (catalog: any) => { catalog.sources[0].view_security_barrier = false; }],
    ['answer-eligible identity source', (catalog: any) => { catalog.sources[0].usage = 'answer_fact'; }],
    ['groupable resolution concept', (catalog: any) => { catalog.sources[0].dimensions[0].groupable = true; }],
    ['unconditional nullable position check', (catalog: any) => { catalog.sources[4].integrity.required_checks.push('non_null_position'); catalog.sources[4].integrity.required_checks.sort(); }],
    ['missing position-filter safety', (catalog: any) => { catalog.sources[4].integrity.operation_checks.find((item: any) => item.operation_class === 'position_filter').required_checks = ['unique_relevant_position']; }],
    ['missing position bounds', (catalog: any) => { catalog.sources[3].integrity.position_bounds = []; }],
    ['missing position bounds contract', (catalog: any) => { catalog.sources[3].integrity.position_bounds = []; catalog.sources[3].integrity.required_checks = ['source_presence', 'unique_grain']; }],
    ['duplicate position bounds', (catalog: any) => { catalog.sources[3].integrity.position_bounds.push(structuredClone(catalog.sources[3].integrity.position_bounds[0])); }],
    ['missing ranking safety', (catalog: any) => { catalog.sources[3].integrity.operation_checks[0].required_checks = ['non_null_position']; }],
    ['missing ranking contract', (catalog: any) => { catalog.sources[3].integrity.operation_checks = []; }],
    ['missing participation season scope', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'driver_participation_resolution').required_scope_predicates = []; }],
    ['missing resolution deduplication', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'driver_identity_race_resolution').required_checks = ['single_resolved_key']; }],
    ['missing single-resolution guarantee', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'driver_identity_race_resolution').required_checks = ['deduplicate_keys']; }],
    ['missing verified target check', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'race_event_metadata').required_checks = ['source_presence']; }],
    ['missing shared-branch uniqueness', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'race_shared_event').required_checks = ['non_null_measure', 'source_presence']; }],
    ['unsafe self-join cardinality', (catalog: any) => { catalog.relationships.find((item: any) => item.id === 'race_shared_event').cardinality = 'one_to_one'; }],
    ['disconnected relationship graph', (catalog: any) => { catalog.relationships = catalog.relationships.filter((item: any) => item.to_source !== 'driver_standings'); }],
    ['noncanonical source order', (catalog: any) => { catalog.sources.reverse(); }]
  ])('rejects %s mutations', (_name, mutate) => {
    const mutated: any = structuredClone(SEMANTIC_CATALOG);
    mutate(mutated);
    expect(() => parseSemanticCatalog(mutated)).toThrow();
  });

  it('rejects cyclic derived measures', () => {
    const mutated: any = structuredClone(SEMANTIC_CATALOG);
    mutated.sources[3].measures.push({
      id: 'derived_a', physical_field: null, physical_type: 'numeric', semantic_type: 'number', units: null,
      physical_nullable: false, nullable: false, null_meaning: 'A missing derived value is invalid.', authority: 'Catalog-derived test measure.',
      expression_class: 'derived', filter_operators: [], allowed_aggregations: [], additivity: 'non_additive', depends_on: ['derived_b']
    }, {
      id: 'derived_b', physical_field: null, physical_type: 'numeric', semantic_type: 'number', units: null,
      physical_nullable: false, nullable: false, null_meaning: 'A missing derived value is invalid.', authority: 'Catalog-derived test measure.',
      expression_class: 'derived', filter_operators: [], allowed_aggregations: [], additivity: 'non_additive', depends_on: ['derived_a']
    });
    mutated.sources[3].measures.sort((left: any, right: any) => left.id.localeCompare(right.id));
    expect(() => parseSemanticCatalog(mutated)).toThrow('cyclic derived measures');
  });

  it('binds exact PostgreSQL view definitions, fields, types, and principal grants', async () => {
    const binding = await buildSemanticCatalogDatabaseBinding(pool);
    expect(binding.catalog_hash).toBe(SEMANTIC_CATALOG_HASH);
    expect(binding.views).toHaveLength(7);
    expect(binding.views.every(view => /^[a-f0-9]{64}$/.test(view.definition_sha256))).toBe(true);
    expect(binding.principal.selectable_relations).toEqual(SEMANTIC_CATALOG.sources.map(source => source.view));
    expect(binding.principal.writable_relations).toEqual([]);
    expect(binding.database_identity.current_user_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.database_identity.current_database_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.required_grain_checks).toEqual([{
      view: 'f1ql.qualifying_classification',
      key: ['driver_id', 'round', 'season'],
      duplicate_grain: false
    }]);
    expect(binding.views.filter(view => view.relation_options.includes('security_barrier=true')).map(view => view.view)).toEqual([
      'f1ql.answer_driver_identity',
      'f1ql.answer_event_identity',
      'f1ql.answer_season_participation'
    ]);
    expect(binding.database_binding_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds a context-bound production-audit artifact and rejects tampering or unsafe configuration', async () => {
    const artifact = await auditSemanticCatalogBinding(pool, {
      commit_sha: 'a'.repeat(40),
      deployment_id: 'catalog-test-deployment',
      release_id: 'catalog-test-release',
      key_id: 'catalog-test-key',
      private_key: auditKeys.privateKey
    }, '2026-07-30T00:00:00.000Z');
    expect(artifact).toMatchObject({
      catalog_hash: SEMANTIC_CATALOG_HASH,
      database_binding_hash: artifact.binding.database_binding_hash,
      production_evidence: { key_id: 'catalog-test-key', algorithm: 'Ed25519' }
    });
    expect(verifySemanticCatalogBindingArtifact(artifact, {
      key_id: 'catalog-test-key', public_key: auditKeys.publicKey
    }, artifact)).toEqual(artifact);
    expect(() => verifySemanticCatalogBindingArtifact({
      ...artifact,
      observed_at: '2026-07-30T00:00:01.000Z'
    }, { key_id: 'catalog-test-key', public_key: auditKeys.publicKey }, artifact)).toThrow('signature');
    expect(() => parseSemanticCatalogBindingArtifact({ ...artifact, database_binding_hash: '0'.repeat(64) })).toThrow('mismatch');
    await expect(writeSemanticCatalogBindingAudit('/tmp/unused-catalog-audit.json', {})).rejects.toThrow('not enabled');
  });

  it.each(['localhost', '127.0.0.2', '127.1', '2130706433', '0x7f000001', '017700000001', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]'])
  ('refuses semantic-catalog production audit loopback target %s', async hostname => {
    await expect(writeSemanticCatalogBindingAudit('/tmp/unused-catalog-audit.json', {
      F1QL_SEMANTIC_CATALOG_AUDIT_ENABLED: 'true',
      F1QL_SEMANTIC_CATALOG_AUDIT_TARGET: 'production',
      F1QL_ANSWER_DATABASE_URL: `postgres://${hostname}/f1`
    })).rejects.toThrow('refuses local');
  });

  it('uses a bounded read-only transaction and rolls back binding failures', async () => {
    const statements: string[] = [];
    let released = false;
    const database = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql.trim());
          if (sql.includes('pg_get_viewdef')) {
            throw new Error('catalog inspection failed');
          }
          return { rows: [] };
        },
        release: () => { released = true; }
      })
    };
    await expect(buildSemanticCatalogDatabaseBinding(database as never)).rejects.toThrow('catalog inspection failed');
    expect(statements).toEqual([
      'BEGIN READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      expect.stringContaining('pg_get_viewdef'),
      'ROLLBACK'
    ]);
    expect(released).toBe(true);
  });

  it('changes the database binding when a governed view definition changes', async () => {
    const original = await buildSemanticCatalogDatabaseBinding(pool);
    await pool.query(`CREATE OR REPLACE VIEW f1ql.event_metadata AS
      SELECT r.year AS season, r.round,
        COALESCE(REPLACE(r.grand_prix_id, '_', '-'), r.circuit_id) AS event_id,
        COALESCE(gp.full_name, gp.name, r.official_name) AS event_name,
        r.circuit_id, r.date
      FROM race r LEFT JOIN grand_prix gp ON gp.id = r.grand_prix_id
      WHERE r.year >= 1950`);
    const mutated = await buildSemanticCatalogDatabaseBinding(pool);
    expect(mutated.database_binding_hash).not.toBe(original.database_binding_hash);
    await pool.query(readFileSync(path.resolve(process.cwd(), 'migrations/20260721_add_f1ql_event_metadata.sql'), 'utf8'));
  });

  it('rejects changed view security options and effective write grants', async () => {
    await pool.query('ALTER VIEW f1ql.answer_event_identity SET (security_barrier=false)');
    await expect(buildSemanticCatalogDatabaseBinding(pool)).rejects.toThrow('relation options mismatch');
    await pool.query('ALTER VIEW f1ql.answer_event_identity SET (security_barrier=true)');

    await pool.query('GRANT UPDATE ON f1ql.qualifying_classification TO f1ql_answer');
    await expect(buildSemanticCatalogDatabaseBinding(pool)).rejects.toThrow('effective write privileges');
    await pool.query('REVOKE UPDATE ON f1ql.qualifying_classification FROM f1ql_answer');
  });

  it('rejects duplicate rows for database-required source grain', async () => {
    await pool.query('ALTER TABLE qualifying_results DROP CONSTRAINT qualifying_results_pkey');
    try {
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2025, 1, 'catalog_driver_b', 'catalog-team', 2, 'RACE_QUALIFYING')`);
      await expect(buildSemanticCatalogDatabaseBinding(pool)).rejects.toThrow('required grain is not unique');
    } finally {
      await pool.query(`DELETE FROM qualifying_results WHERE season = 2025 AND round = 1 AND driver_id = 'catalog_driver_b'`);
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2025, 1, 'catalog_driver_b', 'catalog-team', 2, 'RACE_QUALIFYING')`);
      await pool.query('ALTER TABLE qualifying_results ADD CONSTRAINT qualifying_results_pkey PRIMARY KEY (season, round, driver_id)');
    }
  });

  it('executes every governed relationship with normalized keys and scoped fanout', async () => {
    const cases = [
      ['driver_identity_qualifying_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_driver_identity i JOIN f1ql.qualifying_classification q USING (driver_id) WHERE i.identity = 'Catalog Driver A'`, 1],
      ['driver_identity_race_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_driver_identity i JOIN f1ql.event_classification r USING (driver_id) WHERE i.identity = 'Catalog Driver A'`, 1],
      ['driver_identity_standings_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_driver_identity i JOIN f1ql.driver_standings s USING (driver_id) WHERE i.identity = 'Catalog Driver A'`, 1],
      ['driver_participation_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_driver_identity i JOIN f1ql.answer_season_participation p ON p.driver_id = i.driver_id AND p.season = 2025 WHERE i.identity = 'Catalog Driver A'`, 1],
      ['event_identity_metadata_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_event_identity i JOIN f1ql.event_metadata m USING (season, round) WHERE i.identity = 'Catalog Grand Prix'`, 1],
      ['event_identity_qualifying_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_event_identity i JOIN f1ql.qualifying_classification q USING (season, round) WHERE i.identity = 'Catalog Grand Prix'`, 2],
      ['event_identity_race_resolution', `SELECT count(*)::integer AS count FROM f1ql.answer_event_identity i JOIN f1ql.event_classification r USING (season, round) WHERE i.identity = 'Catalog Grand Prix'`, 2],
      ['qualifying_shared_event', `SELECT count(*)::integer AS count FROM f1ql.qualifying_classification a JOIN f1ql.qualifying_classification b USING (season, round) WHERE a.driver_id = 'catalog-driver-a' AND b.driver_id = 'catalog-driver-b'`, 1],
      ['race_event_metadata', `SELECT count(*)::integer AS count FROM f1ql.event_classification r JOIN f1ql.event_metadata m USING (season, round) WHERE r.season = 2025 AND r.round = 1`, 2],
      ['race_shared_event', `SELECT count(*)::integer AS count FROM f1ql.event_classification a JOIN f1ql.event_classification b USING (season, round) WHERE a.driver_id = 'catalog-driver-a' AND b.driver_id = 'catalog-driver-b'`, 1]
    ] as const;
    expect(cases.map(([id]) => id)).toEqual(SEMANTIC_CATALOG.relationships.map(relationship => relationship.id));
    for (const [id, sql, expectedCount] of cases) {
      const result = await pool.query<{ count: number }>(sql);
      expect(result.rows[0]?.count, id).toBe(expectedCount);
    }
    const crossSeason = await pool.query(`
      SELECT count(*)::integer AS count
      FROM f1ql.answer_driver_identity i
      JOIN f1ql.answer_season_participation p ON p.driver_id = i.driver_id AND p.season = 2025
      WHERE i.identity = 'Catalog Driver B'
    `);
    expect(crossSeason.rows).toEqual([{ count: 0 }]);
  });

  it('detects duplicate target keys and filtered self-join branches', async () => {
    await pool.query('BEGIN');
    try {
      await pool.query(`
        INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
          VALUES (9902, 2025, 1, 'catalog_gp', 'catalog_circuit', 'DUPLICATE CATALOG EVENT', '2025-01-02');
        INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9901, 'race_result', 'catalog_driver_a', 'catalog-team', 1, 1, 25);
      `);
      const duplicateMetadata = await pool.query(`
        SELECT count(*)::integer AS count FROM (
          SELECT season, round FROM f1ql.event_metadata GROUP BY season, round HAVING count(*) > 1
        ) duplicate_keys
      `);
      const duplicateRaceBranch = await pool.query(`
        SELECT count(*)::integer AS count FROM (
          SELECT season, round, driver_id FROM f1ql.event_classification
          WHERE driver_id = 'catalog-driver-a'
          GROUP BY season, round, driver_id HAVING count(*) > 1
        ) duplicate_keys
      `);
      expect(duplicateMetadata.rows).toEqual([{ count: 1 }]);
      expect(duplicateRaceBranch.rows).toEqual([{ count: 1 }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('demonstrates identity and participation fanout that resolution must deduplicate', async () => {
    await pool.query('BEGIN');
    try {
      await pool.query(`
        INSERT INTO driver_aliases (driver_id, alias, is_primary)
          VALUES ('catalog_driver_a', 'Catalog Driver A', false);
        INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver)
          VALUES (2025, 'catalog-entrant-two', 'catalog-team-two', 'catalog_driver_a', false);
      `);
      const identity = await pool.query(`
        SELECT count(*)::integer AS raw_count, count(DISTINCT driver_id)::integer AS resolved_count
        FROM f1ql.answer_driver_identity WHERE identity = 'Catalog Driver A'
      `);
      const participation = await pool.query(`
        SELECT count(*)::integer AS raw_count, count(DISTINCT driver_id)::integer AS resolved_count
        FROM f1ql.answer_season_participation WHERE season = 2025 AND driver_id = 'catalog-driver-a'
      `);
      expect(identity.rows).toEqual([{ raw_count: 2, resolved_count: 1 }]);
      expect(participation.rows).toEqual([{ raw_count: 2, resolved_count: 1 }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('demonstrates nullable and tied standings positions plus out-of-range qualifying positions', async () => {
    await pool.query('BEGIN');
    try {
      await pool.query(`UPDATE season_driver_standing SET position_number = 1
        WHERE year = 2025 AND driver_id = 'catalog_driver_b'`);
      const tiedStandings = await pool.query(`
        SELECT count(*)::integer AS count FROM f1ql.driver_standings
        WHERE season = 2025 AND championship_position = 1
      `);
      await pool.query(`UPDATE season_driver_standing SET position_number = NULL
        WHERE year = 2025 AND driver_id = 'catalog_driver_a'`);
      const nullStandings = await pool.query(`
        SELECT count(*)::integer AS count FROM f1ql.driver_standings
        WHERE season = 2025 AND championship_position IS NULL
      `);
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2026, 2, 'out_of_range_driver', 'team', 31, 'RACE_QUALIFYING')`);
      const outOfRangeQualifying = await pool.query(`
        SELECT count(*)::integer AS count FROM f1ql.qualifying_classification
        WHERE qualifying_position > 30
      `);
      expect(tiedStandings.rows).toEqual([{ count: 2 }]);
      expect(nullStandings.rows).toEqual([{ count: 1 }]);
      expect(outOfRangeQualifying.rows).toEqual([{ count: 1 }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('excludes sprint qualifying and records physical-versus-semantic nullability', async () => {
    await pool.query(`INSERT INTO qualifying_results
      (season, round, driver_id, team_id, session_type, qualifying_position)
      VALUES (2026, 1, 'race_driver', 'team', 'RACE_QUALIFYING', 1),
             (2026, 1, 'sprint_driver', 'team', 'SPRINT_QUALIFYING', 1)`);
    const rows = await pool.query('SELECT driver_id FROM f1ql.qualifying_classification WHERE season = 2026 ORDER BY driver_id');
    expect(rows.rows).toEqual([{ driver_id: 'race-driver' }]);

    const standingsPoints = SEMANTIC_CATALOG.sources.find(source => source.id === 'driver_standings')!.measures.find(item => item.id === 'points')!;
    const qualifyingPosition = SEMANTIC_CATALOG.sources.find(source => source.id === 'qualifying_classification')!.measures.find(item => item.id === 'qualifying_position')!;
    expect(standingsPoints).toMatchObject({ physical_nullable: true, nullable: true });
    expect(qualifyingPosition).toMatchObject({ physical_nullable: true, nullable: true });
    expect(SEMANTIC_CATALOG.sources[0].dimensions[0]).toMatchObject({ physical_nullable: true, nullable: false });
  });
});
