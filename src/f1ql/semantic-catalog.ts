import { createHash } from 'node:crypto';
import { z } from 'zod';

const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const nonEmptyText = z.string().trim().min(1).max(500);
const governanceSchema = z.enum(['experimental', 'verified', 'certified']);
const physicalTypeSchema = z.enum(['boolean', 'date', 'integer', 'numeric', 'text']);
const semanticTypeSchema = z.enum([
  'boolean', 'circuit_id', 'date', 'driver_id', 'duration_ms', 'event_id',
  'identity', 'number', 'position', 'provenance', 'round', 'season', 'status',
  'team_id', 'text'
]);
const filterOperatorSchema = z.enum(['eq', 'in', 'range']);
const aggregationSchema = z.enum(['count', 'max', 'min', 'sum']);
const operationClassSchema = z.enum(['comparison', 'position_filter', 'ranking']);
const sourceIntegrityCheckSchema = z.enum([
  'ambiguity_preserved', 'entrant_precedence', 'non_null_position', 'position_bounds',
  'single_resolved_identity', 'source_presence', 'unique_event_key', 'unique_grain',
  'unique_relevant_position'
]);
const relationshipIntegrityCheckSchema = z.enum([
  'deduplicate_keys', 'entrant_precedence', 'non_null_measure', 'non_null_requested_to_concepts',
  'single_resolved_key', 'source_presence', 'unique_filtered_branch', 'unique_from_key', 'unique_to_key'
]);
const SEMANTIC_CATALOG_CONTROL_TIMEOUT_MS = 2_000;

const languageSchema = z.object({
  names: z.array(nonEmptyText).min(1).max(20),
  synonyms: z.array(nonEmptyText).max(30),
  abbreviations: z.array(nonEmptyText).max(20),
  ambiguity_groups: z.array(idSchema).max(20),
  forbidden_conflations: z.array(nonEmptyText).min(1).max(30)
}).strict();

const dimensionSchema = z.object({
  id: idSchema,
  physical_field: idSchema,
  physical_type: physicalTypeSchema,
  semantic_type: semanticTypeSchema,
  units: z.string().trim().min(1).max(80).nullable(),
  physical_nullable: z.boolean(),
  nullable: z.boolean(),
  null_meaning: nonEmptyText,
  filter_operators: z.array(filterOperatorSchema).max(3),
  allowed_values: z.array(nonEmptyText).max(20),
  groupable: z.boolean(),
  language: languageSchema.nullable()
}).strict();

const measureSchema = z.object({
  id: idSchema,
  physical_field: idSchema.nullable(),
  physical_type: physicalTypeSchema,
  semantic_type: semanticTypeSchema,
  units: z.string().trim().min(1).max(80).nullable(),
  physical_nullable: z.boolean(),
  nullable: z.boolean(),
  null_meaning: nonEmptyText,
  authority: nonEmptyText,
  expression_class: z.enum(['column', 'derived']),
  filter_operators: z.array(filterOperatorSchema).max(3),
  allowed_aggregations: z.array(aggregationSchema).max(4),
  additivity: z.enum(['additive', 'non_additive', 'semi_additive']),
  depends_on: z.array(idSchema).max(12),
  language: languageSchema.nullable()
}).strict();

const sourceSchema = z.object({
  id: idSchema,
  family_id: idSchema,
  view: z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/),
  usage: z.enum(['answer_fact', 'resolution_only']),
  view_security_barrier: z.boolean(),
  owner: idSchema,
  governance: governanceSchema,
  description: nonEmptyText,
  grain: z.object({
    kind: z.enum(['driver_event', 'driver_season', 'event', 'identity_value', 'participation_evidence']),
    key: z.array(idSchema).min(1).max(5),
    uniqueness: z.enum(['required', 'verified_at_query', 'not_unique'])
  }).strict(),
  scope: z.object({
    season_min: z.number().int().min(1950).max(2200).nullable(),
    season_max: z.number().int().min(1950).max(2200).nullable(),
    final_season_through: z.number().int().min(1950).max(2200).nullable(),
    sessions: z.array(z.enum(['identity', 'qualifying', 'race', 'season'])).min(1).max(4),
    temporal_rule: nonEmptyText,
    current_semantics: nonEmptyText.nullable()
  }).strict(),
  dimensions: z.array(dimensionSchema).min(1).max(30),
  measures: z.array(measureSchema).max(20),
  authority: z.object({
    primary: nonEmptyText,
    supplementary: z.array(nonEmptyText).max(10),
    prohibited_derivations: z.array(nonEmptyText).min(1).max(20)
  }).strict(),
  integrity: z.object({
    source_presence_required: z.boolean(),
    unique_key_required: z.boolean(),
    required_checks: z.array(sourceIntegrityCheckSchema).min(1).max(12),
    operation_checks: z.array(z.object({
      operation_class: operationClassSchema,
      required_checks: z.array(sourceIntegrityCheckSchema).min(1).max(12),
      null_position_policy: z.enum(['preserve_last', 'reject']).optional(),
      equal_position_policy: z.enum(['preserve', 'reject']).optional()
    }).strict()).max(10),
    position_bounds: z.array(z.object({
      measure_id: idSchema,
      min: z.number().int().positive(),
      max: z.number().int().positive().nullable()
    }).strict()).max(5),
    completeness_checks: z.array(nonEmptyText).min(1).max(20)
  }).strict(),
  coverage: z.object({
    observed: nonEmptyText,
    certified: nonEmptyText,
    freshness: nonEmptyText,
    observed_seasons: z.object({
      min: z.number().int().min(1950).max(2200),
      max: z.number().int().min(1950).max(2200),
      as_of: z.string().date()
    }).strict().nullable(),
    certification_class: z.enum(['cited_facts_only', 'inventory_only', 'operational_projection']),
    freshness_class: z.enum(['current_projection', 'latest_recorded', 'mixed_final_and_latest']),
    unsupported_ids: z.array(idSchema).min(1).max(30),
    unsupported: z.array(nonEmptyText).min(1).max(30)
  }).strict(),
  language: languageSchema
}).strict();

const relationshipSchema = z.object({
  id: idSchema,
  from_source: idSchema,
  to_source: idSchema,
  from_keys: z.array(idSchema).min(1).max(5),
  to_keys: z.array(idSchema).min(1).max(5),
  cardinality: z.enum(['many_to_many', 'many_to_one', 'one_to_many', 'one_to_one']),
  direction: z.enum(['bidirectional', 'from_to']),
  optionality: z.enum(['inner', 'left']),
  join_stage: z.enum(['resolution', 'row']),
  filter_propagation: z.enum(['none', 'resolved_identity', 'same_event']),
  governance: governanceSchema,
  required_branch_filters: z.array(idSchema).max(5),
  required_scope_predicates: z.array(z.object({
    side: z.enum(['from', 'to']),
    concept_id: idSchema,
    operator: z.literal('eq_parameter'),
    parameter: z.literal('season')
  }).strict()).max(5),
  required_checks: z.array(relationshipIntegrityCheckSchema).min(1).max(12),
  integrity_checks: z.array(nonEmptyText).min(1).max(20)
}).strict().superRefine((relationship, context) => {
  if (relationship.from_keys.length !== relationship.to_keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'relationship key arity must match' });
  }
});

const catalogSchema = z.object({
  version: z.literal(1),
  owner: idSchema,
  governance: governanceSchema,
  families: z.array(z.object({
    id: idSchema,
    description: nonEmptyText,
    source_ids: z.array(idSchema).min(1).max(10)
  }).strict()).min(1).max(20),
  sources: z.array(sourceSchema).min(1).max(30),
  relationships: z.array(relationshipSchema).max(50),
  excluded_families: z.array(idSchema).min(1).max(30)
}).strict();

export type SemanticCatalog = z.infer<typeof catalogSchema>;
export type SemanticCatalogSource = SemanticCatalog['sources'][number];

function dimension(
  id: string,
  physicalField: string,
  physicalType: z.infer<typeof physicalTypeSchema>,
  semanticType: z.infer<typeof semanticTypeSchema>,
  nullable: boolean,
  nullMeaning: string,
  filterOperators: z.infer<typeof filterOperatorSchema>[],
  groupable: boolean,
  units: string | null = null,
  allowedValues: string[] = [],
  physicalNullable = true,
  language: z.infer<typeof languageSchema> | null = null
) {
  return {
    id,
    physical_field: physicalField,
    physical_type: physicalType,
    semantic_type: semanticType,
    units,
    physical_nullable: physicalNullable,
    nullable,
    null_meaning: nullMeaning,
    filter_operators: filterOperators,
    allowed_values: allowedValues,
    groupable,
    language
  };
}

function measure(
  id: string,
  physicalField: string,
  physicalType: z.infer<typeof physicalTypeSchema>,
  semanticType: z.infer<typeof semanticTypeSchema>,
  nullable: boolean,
  nullMeaning: string,
  authority: string,
  allowedAggregations: z.infer<typeof aggregationSchema>[],
  additivity: 'additive' | 'non_additive' | 'semi_additive',
  units: string | null = null,
  physicalNullable = true,
  filterOperators: z.infer<typeof filterOperatorSchema>[] = [],
  language: z.infer<typeof languageSchema> | null = null
) {
  return {
    id,
    physical_field: physicalField,
    physical_type: physicalType,
    semantic_type: semanticType,
    units,
    physical_nullable: physicalNullable,
    nullable,
    null_meaning: nullMeaning,
    authority,
    expression_class: 'column' as const,
    filter_operators: filterOperators,
    allowed_aggregations: allowedAggregations,
    additivity,
    depends_on: [],
    language
  };
}

const rawCatalog = {
  version: 1,
  owner: 'f1ql_governance',
  governance: 'verified',
  families: [
    {
      id: 'event_metadata',
      description: 'Recorded event identity, circuit, and race-date metadata.',
      source_ids: ['event_metadata']
    },
    {
      id: 'identity_participation',
      description: 'Operational driver and event identity values plus season participation evidence used before fact planning.',
      source_ids: ['answer_driver_identity', 'answer_event_identity', 'answer_season_participation']
    },
    {
      id: 'qualifying_classification',
      description: 'Recorded final qualifying classifications and available timing attributes.',
      source_ids: ['qualifying_classification']
    },
    {
      id: 'race_classification',
      description: 'Recorded final race classifications, points, and normalized source status.',
      source_ids: ['event_classification']
    },
    {
      id: 'standings',
      description: 'Recorded final-season and latest-current driver championship standings.',
      source_ids: ['driver_standings']
    }
  ],
  sources: [
    {
      id: 'answer_driver_identity',
      family_id: 'identity_participation',
      view: 'f1ql.answer_driver_identity',
      usage: 'resolution_only',
      view_security_barrier: true,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Ambiguity-preserving driver identity and alias values used only for deterministic resolution.',
      grain: { kind: 'identity_value', key: ['driver_id', 'identity'], uniqueness: 'not_unique' },
      scope: {
        season_min: null,
        season_max: null,
        final_season_through: null,
        sessions: ['identity'],
        temporal_rule: 'Identity values are not season-scoped; participation evidence must resolve historical namesakes.',
        current_semantics: null
      },
      dimensions: [
        dimension('driver_id', 'driver_id', 'text', 'driver_id', false, 'A null canonical driver identifier is invalid.', ['eq', 'in'], false),
        dimension('identity', 'identity', 'text', 'identity', false, 'Null identity values are excluded by the governed view.', ['eq'], false)
      ],
      measures: [],
      authority: {
        primary: 'Operational driver and alias records projected by the governed identity view.',
        supplementary: [],
        prohibited_derivations: ['Do not choose one driver from a shared identity without participation evidence or clarification.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: false,
        required_checks: ['ambiguity_preserved', 'source_presence'],
        operation_checks: [],
        position_bounds: [],
        completeness_checks: ['Preserve every matching driver candidate after normalization and deduplicate only identical driver identifiers.']
      },
      coverage: {
        observed: 'The deployed identity projection covers recorded driver names, abbreviations, identifiers, and aliases.',
        certified: 'No claim of globally complete or historically stable aliases.',
        freshness: 'Reflects the current operational driver and alias relations.',
        observed_seasons: null,
        certification_class: 'operational_projection',
        freshness_class: 'current_projection',
        unsupported_ids: ['cross_domain_identity', 'team_identity', 'winner_take_all_resolution'],
        unsupported: ['Cross-domain person identity.', 'Team identity.', 'Winner-take-all resolution of ambiguous names.']
      },
      language: {
        names: ['driver identity'],
        synonyms: ['driver alias', 'driver name'],
        abbreviations: ['driver id'],
        ambiguity_groups: ['driver_identity'],
        forbidden_conflations: ['Do not treat an abbreviation or surname as globally unique.']
      }
    },
    {
      id: 'answer_event_identity',
      family_id: 'identity_participation',
      view: 'f1ql.answer_event_identity',
      usage: 'resolution_only',
      view_security_barrier: true,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Season-scoped event identity values used to resolve a literal event to recorded round candidates.',
      grain: { kind: 'identity_value', key: ['identity', 'round', 'season'], uniqueness: 'not_unique' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['identity'],
        temporal_rule: 'Event resolution is always season-scoped and returns recorded race-event keys.',
        current_semantics: 'The 2026 inventory is the latest recorded calendar, not a live session schedule.'
      },
      dimensions: [
        dimension('identity', 'identity', 'text', 'identity', false, 'Null identity values are excluded by the governed view.', ['eq'], false),
        dimension('round', 'round', 'integer', 'round', false, 'A null round cannot identify an event.', ['eq', 'in', 'range'], false),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot scope event resolution.', ['eq', 'in', 'range'], false)
      ],
      measures: [],
      authority: {
        primary: 'Operational race and Grand Prix identity records projected by the governed identity view.',
        supplementary: [],
        prohibited_derivations: ['Do not infer event aliases across seasons or select among multiple matching event keys.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: false,
        required_checks: ['ambiguity_preserved', 'single_resolved_identity', 'source_presence'],
        operation_checks: [],
        position_bounds: [],
        completeness_checks: ['Deduplicate identical season-round candidates while preserving distinct matching events.']
      },
      coverage: {
        observed: 'Recorded event identity inventory was observed for seasons 1950 through 2026.',
        certified: 'No complete historical event-alias or session-calendar claim.',
        freshness: 'Reflects the current operational race and Grand Prix relations.',
        observed_seasons: { min: 1950, max: 2026, as_of: '2026-07-22' },
        certification_class: 'inventory_only',
        freshness_class: 'current_projection',
        unsupported_ids: ['cross_season_alias', 'session_identity', 'unscoped_resolution'],
        unsupported: ['Cross-season alias inference.', 'Practice or sprint session identity.', 'Unscoped event resolution.']
      },
      language: {
        names: ['event identity'],
        synonyms: ['grand prix identity', 'race event name'],
        abbreviations: ['gp'],
        ambiguity_groups: ['event_identity'],
        forbidden_conflations: ['Do not treat a circuit, country, and Grand Prix name as interchangeable without a reviewed alias.']
      }
    },
    {
      id: 'answer_season_participation',
      family_id: 'identity_participation',
      view: 'f1ql.answer_season_participation',
      usage: 'resolution_only',
      view_security_barrier: true,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Recorded entrant participation and explicit legacy fallback evidence for season-scoped driver resolution.',
      grain: { kind: 'participation_evidence', key: ['driver_id', 'participation_source', 'season'], uniqueness: 'not_unique' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['season'],
        temporal_rule: 'Participation evidence narrows identity candidates only within the requested season.',
        current_semantics: 'Current-season evidence is recorded entrant inventory and may be incomplete.'
      },
      dimensions: [
        dimension('driver_id', 'driver_id', 'text', 'driver_id', false, 'A null driver identifier is invalid participation evidence.', ['eq', 'in'], false),
        dimension('participation_source', 'participation_source', 'text', 'provenance', false, 'Every participation row must identify entrant or legacy fallback provenance.', ['eq', 'in'], false, null, ['entrant', 'legacy_fallback']),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot scope participation evidence.', ['eq', 'in', 'range'], false)
      ],
      measures: [],
      authority: {
        primary: 'Recorded non-test season entrants with an explicit legacy fallback projection.',
        supplementary: [],
        prohibited_derivations: ['Absence of a row is not proof that a driver did not participate.', 'Legacy fallback must not outrank entrant evidence.']
      },
      integrity: {
        source_presence_required: false,
        unique_key_required: false,
        required_checks: ['entrant_precedence'],
        operation_checks: [],
        position_bounds: [],
        completeness_checks: ['Entrant evidence takes precedence over legacy fallback and duplicate driver candidates are deduplicated.']
      },
      coverage: {
        observed: 'Participation evidence is available where entrant or legacy season-entry records exist.',
        certified: 'No complete historical entrant inventory claim.',
        freshness: 'Reflects current entrant and legacy fallback relations.',
        observed_seasons: null,
        certification_class: 'operational_projection',
        freshness_class: 'current_projection',
        unsupported_ids: ['constructor_membership', 'negative_participation', 'test_drivers'],
        unsupported: ['Constructor membership claims.', 'Negative participation claims.', 'Test-driver participation.']
      },
      language: {
        names: ['season participation'],
        synonyms: ['driver season entrant', 'recorded participation'],
        abbreviations: [],
        ambiguity_groups: ['driver_identity'],
        forbidden_conflations: ['Do not equate missing participation evidence with non-participation.']
      }
    },
    {
      id: 'driver_standings',
      family_id: 'standings',
      view: 'f1ql.driver_standings',
      usage: 'answer_fact',
      view_security_barrier: false,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Recorded driver championship positions, points, and winner flags by season.',
      grain: { kind: 'driver_season', key: ['driver_id', 'season'], uniqueness: 'verified_at_query' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['season'],
        temporal_rule: 'Seasons through 2025 are final; 2026 is only the latest recorded current snapshot.',
        current_semantics: 'Current standings mean the latest recorded snapshot, not live, as-of, or cutoff standings.'
      },
      dimensions: [
        dimension('driver_id', 'driver_id', 'text', 'driver_id', false, 'A null driver identifier is invalid at driver-season grain.', ['eq', 'in'], true, null, [], true, {
          names: ['driver'], synonyms: ['drivers'], abbreviations: [], ambiguity_groups: ['driver_identity'],
          forbidden_conflations: ['Do not treat a driver reference as a canonical driver identifier.']
        }),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot identify a championship standing.', ['eq', 'in', 'range'], true)
      ],
      measures: [
        measure('championship_position', 'championship_position', 'integer', 'position', true, 'Null is not a calculated championship rank.', 'Recorded season-driver standing position.', ['min'], 'non_additive', 'position', true, [], {
          names: ['championship position'], synonyms: ['championship rank', 'position', 'standings position'], abbreviations: [], ambiguity_groups: ['classification_position', 'standings_rank'],
          forbidden_conflations: ['Do not derive official championship position by sorting points.']
        }),
        measure('championship_won', 'championship_won', 'boolean', 'boolean', true, 'Null is an unavailable source flag, not false.', 'Recorded championship-winner flag.', [], 'non_additive'),
        measure('points', 'points', 'numeric', 'number', true, 'Null is unavailable recorded championship points, not zero.', 'Recorded championship points; never recomputed from race points.', [], 'non_additive', 'points', true, [], {
          names: ['championship points'], synonyms: ['points', 'standings points'], abbreviations: [], ambiguity_groups: ['points_authority'],
          forbidden_conflations: ['Do not derive championship points by summing recorded race points.']
        })
      ],
      authority: {
        primary: 'Recorded season_driver_standing values; FIA final championship records are external final authority.',
        supplementary: ['Official Formula 1 championship records.'],
        prohibited_derivations: ['Do not derive championship points or rank from race classification points.', 'Do not label 2026 as final.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: true,
        required_checks: ['position_bounds', 'source_presence', 'unique_grain'],
        operation_checks: [
          {
            operation_class: 'ranking',
            required_checks: ['non_null_position', 'unique_relevant_position'],
            null_position_policy: 'reject',
            equal_position_policy: 'reject'
          }
        ],
        position_bounds: [{ measure_id: 'championship_position', min: 1, max: null }],
        completeness_checks: ['Scalar standings answers require exactly one recorded row for every requested driver-season.']
      },
      coverage: {
        observed: 'Recorded standings inventory was observed for seasons 1950 through 2026.',
        certified: 'Only cited production facts and reviewed answer fixtures are independently evidenced.',
        freshness: 'Final seasons are immutable by contract; 2026 is refreshed as a latest-recorded snapshot.',
        observed_seasons: { min: 1950, max: 2026, as_of: '2026-07-22' },
        certification_class: 'cited_facts_only',
        freshness_class: 'mixed_final_and_latest',
        unsupported_ids: ['as_of_standings', 'constructor_standings', 'historical_scoring_rules', 'shared_drive_completeness'],
        unsupported: ['As-of or cutoff standings.', 'Constructor standings.', 'Historical scoring-rule reconstruction.', 'Shared-drive and dropped-score completeness claims.']
      },
      language: {
        names: ['driver standings'],
        synonyms: ['championship standings', 'final driver standings'],
        abbreviations: ['wdc'],
        ambiguity_groups: ['current_final', 'standings_rank'],
        forbidden_conflations: ['Do not conflate championship points with summed race points.', 'Do not conflate current and final standings.']
      }
    },
    {
      id: 'event_classification',
      family_id: 'race_classification',
      view: 'f1ql.event_classification',
      usage: 'answer_fact',
      view_security_barrier: false,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Recorded race-event classification rows with official position, source points, and normalized status.',
      grain: { kind: 'driver_event', key: ['driver_id', 'round', 'season'], uniqueness: 'verified_at_query' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['race'],
        temporal_rule: 'Rows represent recorded race classifications; sprint classifications are excluded.',
        current_semantics: 'Current-season rows are the latest recorded classifications and may be corrected upstream.'
      },
      dimensions: [
        dimension('classification_status', 'classification_status', 'text', 'status', false, 'Every row receives one normalized race classification status.', ['eq', 'in'], true, null, ['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'], true, {
          names: ['race classification status'], synonyms: ['race status', 'status'], abbreviations: [], ambiguity_groups: ['classification_status'],
          forbidden_conflations: ['Do not infer a classification status from a null finishing position.']
        }),
        dimension('driver_id', 'driver_id', 'text', 'driver_id', false, 'A null driver identifier is invalid at driver-event grain.', ['eq', 'in'], true, null, [], true, {
          names: ['driver'], synonyms: ['drivers'], abbreviations: [], ambiguity_groups: ['driver_identity'],
          forbidden_conflations: ['Do not treat a driver reference as a canonical driver identifier.']
        }),
        dimension('round', 'round', 'integer', 'round', false, 'A null round cannot identify a race event.', ['eq', 'in', 'range'], true),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot identify a race event.', ['eq', 'in', 'range'], true),
        dimension('status_reason', 'status_reason', 'text', 'text', true, 'Null means no explanatory position text or retirement reason was recorded.', [], false),
        dimension('team_id', 'team_id', 'text', 'team_id', true, 'Null means no team identifier was recorded for the classification row.', [], false)
      ],
      measures: [
        measure('finishing_position', 'finishing_position', 'integer', 'position', true, 'Null is not a finish position.', 'Recorded final race classification position.', ['count', 'max', 'min'], 'non_additive', 'position', true, ['eq', 'in', 'range'], {
          names: ['finishing position'], synonyms: ['position', 'race position'], abbreviations: [], ambiguity_groups: ['classification_position'],
          forbidden_conflations: ['Do not conflate finishing position with grid, qualifying, time-gap, or pace semantics.']
        }),
        measure('points', 'points', 'numeric', 'number', true, 'Null is unavailable race points and must not be replaced by zero.', 'Recorded points for this race classification only.', [], 'non_additive', 'points', true, [], {
          names: ['race points'], synonyms: ['points'], abbreviations: [], ambiguity_groups: ['points_authority'],
          forbidden_conflations: ['Do not treat race points as championship standings points.']
        })
      ],
      authority: {
        primary: 'FIA final race classification represented by the governed race-result projection.',
        supplementary: ['Official Formula 1 race results.'],
        prohibited_derivations: ['Do not infer missing classifications or points.', 'Do not treat driver identity ordering as sporting precedence for equal or null positions.', 'Do not treat race points as championship standings authority.', 'Do not include sprint results.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: true,
        required_checks: ['position_bounds', 'source_presence', 'unique_grain'],
        operation_checks: [
          { operation_class: 'comparison', required_checks: ['non_null_position'] },
          { operation_class: 'position_filter', required_checks: ['non_null_position', 'unique_relevant_position'] },
          {
            operation_class: 'ranking',
            required_checks: ['position_bounds'],
            null_position_policy: 'preserve_last',
            equal_position_policy: 'preserve'
          }
        ],
        position_bounds: [{ measure_id: 'finishing_position', min: 1, max: 30 }],
        completeness_checks: ['Comparison and join plans must reject duplicate logical driver-event keys.', 'Position comparisons use only non-null numeric positions.', 'Selected-driver ranking preserves null positions last and equal recorded positions; driver identity only stabilizes presentation order.']
      },
      coverage: {
        observed: 'Recorded race classification inventory was observed for seasons 1950 through 2026.',
        certified: 'No event-complete historical or steward-decision ledger claim.',
        freshness: 'Current-season results may be refreshed from recorded upstream corrections.',
        observed_seasons: { min: 1950, max: 2026, as_of: '2026-07-22' },
        certification_class: 'cited_facts_only',
        freshness_class: 'latest_recorded',
        unsupported_ids: ['grid_positions', 'missing_steward_decisions', 'sprint_classification', 'unrecorded_events'],
        unsupported: ['Grid positions.', 'Missing steward decisions.', 'Sprint classifications.', 'Unrecorded events.']
      },
      language: {
        names: ['race classification'],
        synonyms: ['finishing order', 'race result'],
        abbreviations: ['race result'],
        ambiguity_groups: ['classification_position', 'race_qualifying'],
        forbidden_conflations: ['Do not conflate finishing position with grid or qualifying position.', 'Do not conflate official classification with race pace.']
      }
    },
    {
      id: 'event_metadata',
      family_id: 'event_metadata',
      view: 'f1ql.event_metadata',
      usage: 'answer_fact',
      view_security_barrier: false,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Recorded race-event identifier, name, circuit, and date metadata.',
      grain: { kind: 'event', key: ['round', 'season'], uniqueness: 'verified_at_query' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['race'],
        temporal_rule: 'Metadata is keyed to the recorded race event and does not establish separate session schedules.',
        current_semantics: 'Current-season metadata is the latest recorded calendar projection.'
      },
      dimensions: [
        dimension('circuit_id', 'circuit_id', 'text', 'circuit_id', true, 'Null means no source circuit identifier was recorded.', ['eq', 'in'], true, null, [], true, {
          names: ['circuit identifier'], synonyms: ['circuit id'], abbreviations: [], ambiguity_groups: ['event_identity'],
          forbidden_conflations: ['Do not treat a circuit identifier as a Grand Prix or venue name.']
        }),
        dimension('date', 'date', 'date', 'date', true, 'Null means the race date is unavailable in the source.', ['eq', 'range'], true, null, [], true, {
          names: ['race date'], synonyms: ['event date'], abbreviations: [], ambiguity_groups: ['session_scope'],
          forbidden_conflations: ['Do not infer qualifying, practice, or sprint dates from the race date.']
        }),
        dimension('event_id', 'event_id', 'text', 'event_id', true, 'Null means neither a Grand Prix identifier nor circuit fallback was recorded.', ['eq', 'in'], true),
        dimension('event_name', 'event_name', 'text', 'text', true, 'Null means no Grand Prix or official race name was recorded.', ['eq'], true, null, [], true, {
          names: ['event name'], synonyms: ['grand prix name'], abbreviations: ['gp name'], ambiguity_groups: ['event_identity'],
          forbidden_conflations: ['Do not normalize an event name into a circuit identifier.']
        }),
        dimension('round', 'round', 'integer', 'round', false, 'A null round cannot identify an event.', ['eq', 'in', 'range'], true),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot identify an event.', ['eq', 'in', 'range'], true)
      ],
      measures: [],
      authority: {
        primary: 'Recorded race and Grand Prix metadata; FIA archive material is external authority.',
        supplementary: ['Official Formula 1 archive material.'],
        prohibited_derivations: ['Do not infer a general session calendar.', 'Do not normalize circuit identifiers into event identifiers.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: true,
        required_checks: ['source_presence', 'unique_event_key'],
        operation_checks: [],
        position_bounds: [],
        completeness_checks: ['Event joins require exactly one metadata row for each admitted season-round key.']
      },
      coverage: {
        observed: 'Recorded event metadata inventory was observed for seasons 1950 through 2026.',
        certified: 'No complete historical alias, date, circuit, or session-calendar claim.',
        freshness: 'Reflects the current race and Grand Prix relations.',
        observed_seasons: { min: 1950, max: 2026, as_of: '2026-07-22' },
        certification_class: 'cited_facts_only',
        freshness_class: 'current_projection',
        unsupported_ids: ['historical_alias_completeness', 'session_calendar', 'venue_normalization'],
        unsupported: ['General practice, qualifying, or sprint schedules.', 'Historical alias completeness.', 'Venue normalization.']
      },
      language: {
        names: ['event metadata'],
        synonyms: ['grand prix metadata', 'race date'],
        abbreviations: ['gp metadata'],
        ambiguity_groups: ['event_identity', 'session_scope'],
        forbidden_conflations: ['Do not conflate circuit identity with Grand Prix identity.', 'Do not infer separate session dates from the race date.']
      }
    },
    {
      id: 'qualifying_classification',
      family_id: 'qualifying_classification',
      view: 'f1ql.qualifying_classification',
      usage: 'answer_fact',
      view_security_barrier: false,
      owner: 'f1ql_governance',
      governance: 'verified',
      description: 'Recorded qualifying classification rows with available best-session timing and elimination attributes.',
      grain: { kind: 'driver_event', key: ['driver_id', 'round', 'season'], uniqueness: 'required' },
      scope: {
        season_min: 1950,
        season_max: 2026,
        final_season_through: 2025,
        sessions: ['qualifying'],
        temporal_rule: 'Rows describe qualifying classification, not post-penalty starting grid position.',
        current_semantics: 'Current-season rows are the latest recorded qualifying classifications.'
      },
      dimensions: [
        dimension('best_session', 'best_session', 'text', 'text', true, 'Null means no source session label accompanies the best time.', [], false),
        dimension('classification_status', 'classification_status', 'text', 'status', false, 'Every row is classified as classified, dnf, or dns from source flags.', ['eq', 'in'], true, null, ['classified', 'dnf', 'dns'], true, {
          names: ['qualifying classification status'], synonyms: ['qualifying status', 'status'], abbreviations: [], ambiguity_groups: ['classification_status'],
          forbidden_conflations: ['Do not infer unsupported steward statuses from qualifying timing.']
        }),
        dimension('driver_id', 'driver_id', 'text', 'driver_id', false, 'A null driver identifier is invalid at driver-event grain.', ['eq', 'in'], true, null, [], true, {
          names: ['driver'], synonyms: ['drivers'], abbreviations: [], ambiguity_groups: ['driver_identity'],
          forbidden_conflations: ['Do not treat a driver reference as a canonical driver identifier.']
        }),
        dimension('eliminated_in_round', 'eliminated_in_round', 'text', 'text', true, 'Null does not imply an elimination session.', [], false),
        dimension('round', 'round', 'integer', 'round', false, 'A null round cannot identify a qualifying event.', ['eq', 'in', 'range'], true),
        dimension('season', 'season', 'integer', 'season', false, 'A null season cannot identify a qualifying event.', ['eq', 'in', 'range'], true),
        dimension('team_id', 'team_id', 'text', 'team_id', false, 'A null team identifier is invalid for a qualifying row.', [], false)
      ],
      measures: [
        measure('best_time_ms', 'best_time_ms', 'integer', 'duration_ms', true, 'Null means no qualifying time was recorded.', 'Best recorded qualifying time in the source row.', [], 'non_additive', 'milliseconds', true, [], {
          names: ['best qualifying time'], synonyms: ['qualifying time'], abbreviations: [], ambiguity_groups: ['qualifying_metric'],
          forbidden_conflations: ['Do not treat a recorded best qualifying time as a time gap or race pace.']
        }),
        measure('qualifying_position', 'qualifying_position', 'integer', 'position', true, 'Null is not a grid or calculated qualifying position.', 'Recorded qualifying classification position.', ['count', 'max', 'min'], 'non_additive', 'position', true, ['eq', 'in', 'range'], {
          names: ['qualifying position'], synonyms: ['position'], abbreviations: [], ambiguity_groups: ['classification_position', 'qualifying_metric'],
          forbidden_conflations: ['Do not conflate qualifying position with grid position, time gap, or race pace.']
        })
      ],
      authority: {
        primary: 'FIA final qualifying classification represented by the governed qualifying projection.',
        supplementary: ['Official Formula 1 qualifying reports.'],
        prohibited_derivations: ['Do not infer grid position from qualifying position.', 'Do not infer missing timing or elimination values.', 'Do not claim unsupported steward statuses.']
      },
      integrity: {
        source_presence_required: true,
        unique_key_required: true,
        required_checks: ['position_bounds', 'source_presence', 'unique_grain'],
        operation_checks: [
          { operation_class: 'comparison', required_checks: ['non_null_position'] },
          { operation_class: 'position_filter', required_checks: ['non_null_position', 'unique_relevant_position'] },
          {
            operation_class: 'ranking',
            required_checks: ['non_null_position', 'unique_relevant_position'],
            null_position_policy: 'reject',
            equal_position_policy: 'reject'
          }
        ],
        position_bounds: [{ measure_id: 'qualifying_position', min: 1, max: 30 }],
        completeness_checks: ['Comparison and aggregate plans require unique driver-event keys.', 'Position rankings require unique relevant positions within each event.']
      },
      coverage: {
        observed: 'Recorded qualifying inventory was observed for seasons 1950 through 2026.',
        certified: 'No per-event complete historical qualifying or steward-decision claim.',
        freshness: 'Reflects the current qualifying_results relation.',
        observed_seasons: { min: 1950, max: 2026, as_of: '2026-07-22' },
        certification_class: 'cited_facts_only',
        freshness_class: 'current_projection',
        unsupported_ids: ['historical_session_completeness', 'post_penalty_grid', 'steward_status_ledger'],
        unsupported: ['Disqualification or withdrawal ledger.', 'Historical session completeness.', 'Post-penalty grid positions.']
      },
      language: {
        names: ['qualifying classification'],
        synonyms: ['qualifying order', 'qualifying result'],
        abbreviations: ['quali'],
        ambiguity_groups: ['classification_position', 'race_qualifying'],
        forbidden_conflations: ['Do not conflate qualifying position with qualifying time gap.', 'Do not conflate qualifying position with starting grid position.']
      }
    }
  ],
  relationships: [
    {
      id: 'driver_identity_qualifying_resolution',
      from_source: 'answer_driver_identity',
      to_source: 'qualifying_classification',
      from_keys: ['driver_id'],
      to_keys: ['driver_id'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one canonical driver before applying a qualifying fact filter.']
    },
    {
      id: 'driver_identity_race_resolution',
      from_source: 'answer_driver_identity',
      to_source: 'event_classification',
      from_keys: ['driver_id'],
      to_keys: ['driver_id'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one canonical driver before applying a race fact filter.']
    },
    {
      id: 'driver_identity_standings_resolution',
      from_source: 'answer_driver_identity',
      to_source: 'driver_standings',
      from_keys: ['driver_id'],
      to_keys: ['driver_id'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one canonical driver before applying a standings fact filter.']
    },
    {
      id: 'driver_participation_resolution',
      from_source: 'answer_driver_identity',
      to_source: 'answer_season_participation',
      from_keys: ['driver_id'],
      to_keys: ['driver_id'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'left',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [{ side: 'to', concept_id: 'season', operator: 'eq_parameter', parameter: 'season' }],
      required_checks: ['deduplicate_keys', 'entrant_precedence'],
      integrity_checks: ['Preserve ambiguity when multiple drivers retain same-priority participation evidence.', 'Prefer entrant evidence over legacy fallback.']
    },
    {
      id: 'event_identity_metadata_resolution',
      from_source: 'answer_event_identity',
      to_source: 'event_metadata',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_one',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key', 'unique_to_key'],
      integrity_checks: ['Deduplicate identical event keys.', 'Require exactly one retained event key before fact planning.']
    },
    {
      id: 'event_identity_qualifying_resolution',
      from_source: 'answer_event_identity',
      to_source: 'qualifying_classification',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one season-round key before applying qualifying fact filters.']
    },
    {
      id: 'event_identity_race_resolution',
      from_source: 'answer_event_identity',
      to_source: 'event_classification',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one season-round key before applying race fact filters.']
    },
    {
      id: 'qualifying_shared_event',
      from_source: 'qualifying_classification',
      to_source: 'qualifying_classification',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_many',
      direction: 'bidirectional',
      optionality: 'inner',
      join_stage: 'row',
      filter_propagation: 'same_event',
      governance: 'verified',
      required_branch_filters: ['driver_id'],
      required_scope_predicates: [],
      required_checks: ['non_null_measure', 'source_presence', 'unique_filtered_branch'],
      integrity_checks: ['Filter each branch to one driver before joining.', 'Require non-null positions and unique driver-event keys.']
    },
    {
      id: 'race_event_metadata',
      from_source: 'event_classification',
      to_source: 'event_metadata',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_one',
      direction: 'from_to',
      optionality: 'left',
      join_stage: 'row',
      filter_propagation: 'same_event',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['non_null_requested_to_concepts', 'source_presence', 'unique_to_key'],
      integrity_checks: ['Preserve classification source grain.', 'Require exactly one metadata row and a nonblank requested metadata key.']
    },
    {
      id: 'race_shared_event',
      from_source: 'event_classification',
      to_source: 'event_classification',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_many',
      direction: 'bidirectional',
      optionality: 'inner',
      join_stage: 'row',
      filter_propagation: 'same_event',
      governance: 'verified',
      required_branch_filters: ['driver_id'],
      required_scope_predicates: [],
      required_checks: ['non_null_measure', 'source_presence', 'unique_filtered_branch'],
      integrity_checks: ['Filter each branch to one driver before joining.', 'Require non-null positions and unique driver-event keys.']
    }
  ],
  excluded_families: ['constructors', 'grid', 'official_historical_laps', 'pace', 'sprint', 'weather']
};

export function parseSemanticCatalog(input: unknown): SemanticCatalog {
  const catalog = catalogSchema.parse(input);
  validateCatalogSemantics(catalog);
  return deepFreeze(catalog);
}

export function computeSemanticCatalogHash(input: unknown = SEMANTIC_CATALOG): string {
  const catalog = parseSemanticCatalog(input);
  return createHash('sha256').update(stableSerialize(catalog)).digest('hex');
}

export function buildSemanticCatalogSnapshot() {
  return deepFreeze({
    version: 1 as const,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    family_ids: SEMANTIC_CATALOG.families.map(family => family.id),
    source_ids: SEMANTIC_CATALOG.sources.map(source => source.id),
    relationship_ids: SEMANTIC_CATALOG.relationships.map(relationship => relationship.id),
    catalog: SEMANTIC_CATALOG
  });
}

export const SEMANTIC_CATALOG = parseSemanticCatalog(rawCatalog);
export const SEMANTIC_CATALOG_HASH = computeSemanticCatalogHash(SEMANTIC_CATALOG);

type CatalogQueryClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Row[] }>;
  release(error?: Error): void;
};

type CatalogDatabase = {
  connect(): Promise<CatalogQueryClient>;
};

const databaseBindingSchema = z.object({
  version: z.literal(1),
  catalog_hash: z.string().regex(/^[a-f0-9]{64}$/),
  views: z.array(z.object({
    view: z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/),
    database_owner: z.string().min(1).max(63),
    relation_options: z.array(nonEmptyText),
    definition_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()),
  principal: z.object({
    role: idSchema,
    selectable_relations: z.array(z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/)),
    writable_relations: z.array(z.object({
      relation: z.string().min(1),
      privileges: z.array(nonEmptyText).min(1)
    }).strict())
  }).strict(),
  database_identity: z.object({
    current_user_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    current_database_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  required_grain_checks: z.array(z.object({
    view: z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/),
    key: z.array(idSchema).min(1),
    duplicate_grain: z.boolean()
  }).strict()),
  database_binding_hash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type SemanticCatalogDatabaseBinding = z.infer<typeof databaseBindingSchema>;
export type SemanticCatalogDatabaseBindingMaterial = Omit<SemanticCatalogDatabaseBinding, 'database_binding_hash'>;

export function computeSemanticCatalogDatabaseBindingHash(material: SemanticCatalogDatabaseBindingMaterial): string {
  return createHash('sha256').update(stableSerialize(material)).digest('hex');
}

export function parseSemanticCatalogDatabaseBinding(input: unknown): SemanticCatalogDatabaseBinding {
  const binding = databaseBindingSchema.parse(input);
  const expectedViews = SEMANTIC_CATALOG.sources.map(source => source.view);
  if (binding.catalog_hash !== SEMANTIC_CATALOG_HASH ||
      stableSerialize(binding.views.map(view => view.view)) !== stableSerialize(expectedViews) ||
      stableSerialize(binding.principal.selectable_relations) !== stableSerialize(expectedViews) ||
      binding.principal.role !== 'f1ql_answer' || binding.principal.writable_relations.length > 0) {
    throw new Error('semantic catalog database binding does not match the active catalog');
  }
  for (const view of binding.views) {
    const source = SEMANTIC_CATALOG.sources.find(item => item.view === view.view)!;
    const expectedOptions = source.view_security_barrier ? ['security_barrier=true'] : [];
    if (stableSerialize(view.relation_options) !== stableSerialize(expectedOptions)) {
      throw new Error(`semantic catalog database relation options mismatch for ${view.view}`);
    }
  }
  const expectedGrainChecks = SEMANTIC_CATALOG.sources.filter(source => source.grain.uniqueness === 'required')
    .map(source => ({ view: source.view, key: source.grain.key, duplicate_grain: false }));
  if (stableSerialize(binding.required_grain_checks) !== stableSerialize(expectedGrainChecks)) {
    throw new Error('semantic catalog required-grain checks do not match the active catalog');
  }
  const { database_binding_hash, ...material } = binding;
  if (computeSemanticCatalogDatabaseBindingHash(material) !== database_binding_hash) {
    throw new Error('semantic catalog database binding hash mismatch');
  }
  return deepFreeze(binding);
}

export async function buildSemanticCatalogDatabaseBinding(
  database: CatalogDatabase,
  principal = 'f1ql_answer',
  observeReads?: (counters: {
    readonly transaction_count: 1;
    readonly statement_count: number;
    readonly required_grain_check_count: number;
  }) => void,
  controlTimeoutMs = SEMANTIC_CATALOG_CONTROL_TIMEOUT_MS
) {
  if (!Number.isSafeInteger(controlTimeoutMs) || controlTimeoutMs < 1 ||
      controlTimeoutMs > SEMANTIC_CATALOG_CONTROL_TIMEOUT_MS) {
    throw new Error('semantic catalog control timeout is invalid');
  }
  const client = await database.connect();
  let transactionOpen = false;
  let connectionReleased = false;
  let readStatementCount = 0;
  try {
    await catalogControlQuery(client, 'BEGIN READ ONLY', controlTimeoutMs);
    transactionOpen = true;
    await catalogControlQuery(client, `SET LOCAL statement_timeout = '2000ms'`, controlTimeoutMs);
    const viewNames = SEMANTIC_CATALOG.sources.map(source => source.view);
    readStatementCount += 1;
    const definitions = await client.query<{ view_name: string; definition: string; database_owner: string; relation_options: string[] }>(`
      SELECT n.nspname || '.' || c.relname AS view_name,
        pg_get_viewdef(c.oid, true) AS definition,
        pg_get_userbyid(c.relowner) AS database_owner,
        COALESCE(c.reloptions, ARRAY[]::text[]) AS relation_options
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname || '.' || c.relname = ANY($1::text[])
      ORDER BY view_name
    `, [viewNames]);
    readStatementCount += 1;
    const databaseIdentity = (await client.query<{ current_user: string; current_database: string }>(`
      SELECT current_user, current_database() AS current_database
    `)).rows[0];
    readStatementCount += 1;
    const columns = await client.query<{ view_name: string; column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>(`
      SELECT table_schema || '.' || table_name AS view_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema || '.' || table_name = ANY($1::text[])
      ORDER BY view_name, ordinal_position
    `, [viewNames]);
    readStatementCount += 1;
    const privileges = await client.query<{ relation: string; can_select: boolean; write_privileges: string[] }>(`
      SELECT n.nspname || '.' || c.relname AS relation,
        has_schema_privilege($1, n.oid, 'USAGE') AND has_table_privilege($1, c.oid, 'SELECT') AS can_select,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'INSERT' END,
          CASE WHEN has_table_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END,
          CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'DELETE' END,
          CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
          CASE WHEN has_table_privilege($1, c.oid, 'REFERENCES') THEN 'REFERENCES' END,
          CASE WHEN has_table_privilege($1, c.oid, 'TRIGGER') THEN 'TRIGGER' END
        ]::text[], NULL) AS write_privileges
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY relation
    `, [principal]);
    const requiredGrainChecks: Array<{ view: string; key: string[]; duplicate_grain: boolean }> = [];
    for (const source of SEMANTIC_CATALOG.sources.filter(item => item.grain.uniqueness === 'required')) {
      const keys = source.grain.key.map(key => `"${key}"`).join(', ');
      readStatementCount += 1;
      const duplicate = (await client.query<{ duplicate_grain: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${source.view} GROUP BY ${keys} HAVING count(*) > 1 LIMIT 1
        ) AS duplicate_grain
      `)).rows[0]?.duplicate_grain;
      if (duplicate !== false) {
        throw new Error(`semantic catalog required grain is not unique for ${source.view}`);
      }
      requiredGrainChecks.push({ view: source.view, key: [...source.grain.key], duplicate_grain: duplicate });
    }

    if (definitions.rows.length !== viewNames.length) {
      throw new Error('semantic catalog database binding is missing a governed view');
    }
    if (!databaseIdentity?.current_user || !databaseIdentity.current_database) {
      throw new Error('semantic catalog database identity is unavailable');
    }
    const sourceByView = new Map(SEMANTIC_CATALOG.sources.map(source => [source.view, source]));
    for (const definition of definitions.rows) {
      const source = sourceByView.get(definition.view_name);
      const expectedOptions = source?.view_security_barrier ? ['security_barrier=true'] : [];
      if (!source || stableSerialize([...definition.relation_options].sort(compareText)) !== stableSerialize(expectedOptions)) {
        throw new Error(`semantic catalog database relation options mismatch for ${definition.view_name}`);
      }
    }
    const actualColumns = new Map(columns.rows.map(row => [`${row.view_name}.${row.column_name}`, {
      type: normalizeDatabaseType(row.data_type),
      nullable: row.is_nullable === 'YES'
    }]));
    const expectedColumns: string[] = [];
    for (const source of SEMANTIC_CATALOG.sources) {
      for (const concept of [...source.dimensions, ...source.measures]) {
        if (concept.physical_field === null) {
          continue;
        }
        const key = `${source.view}.${concept.physical_field}`;
        expectedColumns.push(key);
        const actual = actualColumns.get(key);
        if (actual?.type !== concept.physical_type) {
          throw new Error(`semantic catalog database type mismatch for ${key}`);
        }
        if (actual.nullable !== concept.physical_nullable) {
          throw new Error(`semantic catalog database nullability mismatch for ${key}`);
        }
      }
    }
    if (stableSerialize([...actualColumns.keys()].sort(compareText)) !== stableSerialize(expectedColumns.sort(compareText))) {
      throw new Error('semantic catalog database columns do not match the governed views');
    }
    const principalRelations = privileges.rows.filter(row => row.can_select).map(row => row.relation);
    if (stableSerialize(principalRelations) !== stableSerialize([...viewNames].sort(compareText))) {
      throw new Error('semantic catalog principal grants do not match the governed views');
    }
    const writableRelations = privileges.rows.filter(row => row.write_privileges.length > 0).map(row => ({
      relation: row.relation,
      privileges: [...row.write_privileges].sort(compareText)
    }));
    if (writableRelations.length > 0) {
      throw new Error('semantic catalog principal has effective write privileges');
    }

    const views = definitions.rows.map(row => ({
      view: row.view_name,
      database_owner: row.database_owner,
      relation_options: [...row.relation_options].sort(compareText),
      definition_sha256: createHash('sha256').update(row.definition).digest('hex')
    }));
    const material = {
      version: 1 as const,
      catalog_hash: SEMANTIC_CATALOG_HASH,
      views,
      principal: { role: principal, selectable_relations: principalRelations, writable_relations: writableRelations },
      database_identity: {
        current_user_sha256: createHash('sha256').update(databaseIdentity.current_user).digest('hex'),
        current_database_sha256: createHash('sha256').update(databaseIdentity.current_database).digest('hex')
      },
      required_grain_checks: requiredGrainChecks
    };
    try {
      await catalogControlQuery(client, 'ROLLBACK', controlTimeoutMs);
    } catch {
      const cleanupError = new Error('semantic catalog transaction cleanup failed');
      client.release(cleanupError);
      connectionReleased = true;
      transactionOpen = false;
      throw cleanupError;
    }
    transactionOpen = false;
    const binding = parseSemanticCatalogDatabaseBinding({
      ...material,
      database_binding_hash: computeSemanticCatalogDatabaseBindingHash(material)
    });
    observeReads?.({
      transaction_count: 1,
      statement_count: readStatementCount,
      required_grain_check_count: requiredGrainChecks.length
    });
    client.release();
    connectionReleased = true;
    return binding;
  } catch (error) {
    if (error instanceof SemanticCatalogControlTimeoutError && !connectionReleased) {
      client.release(error);
      connectionReleased = true;
      transactionOpen = false;
      throw error;
    }
    if (transactionOpen && !connectionReleased) {
      try {
        await catalogControlQuery(client, 'ROLLBACK', controlTimeoutMs);
      } catch {
        const cleanupError = new Error('semantic catalog transaction cleanup failed');
        client.release(cleanupError);
        connectionReleased = true;
        throw cleanupError;
      }
    }
    if (!connectionReleased) {client.release();}
    throw error;
  }
}

class SemanticCatalogControlTimeoutError extends Error {
  constructor() {
    super('semantic catalog transaction control timed out');
    this.name = 'SemanticCatalogControlTimeoutError';
  }
}

async function catalogControlQuery(
  client: CatalogQueryClient,
  sql: string,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.query(sql),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SemanticCatalogControlTimeoutError()), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

function validateCatalogSemantics(catalog: SemanticCatalog): void {
  assertUniqueAndSorted(catalog.families.map(family => family.id), 'family IDs');
  assertUniqueAndSorted(catalog.sources.map(source => source.id), 'source IDs');
  assertUniqueAndSorted(catalog.relationships.map(relationship => relationship.id), 'relationship IDs');
  assertUniqueAndSorted(catalog.excluded_families, 'excluded family IDs');

  const families = new Map(catalog.families.map(family => [family.id, family]));
  const sources = new Map(catalog.sources.map(source => [source.id, source]));
  const allConceptIds = new Set<string>();

  for (const family of catalog.families) {
    assertUniqueAndSorted(family.source_ids, `source IDs for family ${family.id}`);
    const actual = catalog.sources.filter(source => source.family_id === family.id).map(source => source.id);
    if (stableSerialize(actual) !== stableSerialize(family.source_ids)) {
      throw new Error(`family ${family.id} source_ids do not match catalog sources`);
    }
  }

  for (const source of catalog.sources) {
    if (!families.has(source.family_id)) {
      throw new Error(`source ${source.id} references unknown family ${source.family_id}`);
    }
    if (source.family_id === 'identity_participation' && (source.usage !== 'resolution_only' || !source.view_security_barrier)) {
      throw new Error(`identity source ${source.id} must be resolution-only and use a security-barrier view`);
    }
    if (source.usage === 'resolution_only' && (source.measures.length > 0 || source.dimensions.some(item => item.groupable))) {
      throw new Error(`resolution-only source ${source.id} cannot expose answer outputs or measures`);
    }
    const dimensions = source.dimensions.map(item => item.id);
    const measures = source.measures.map(item => item.id);
    assertUniqueAndSorted(dimensions, `dimensions for source ${source.id}`);
    assertUniqueAndSorted(measures, `measures for source ${source.id}`);
    assertUnique([...dimensions, ...measures], `concept IDs for source ${source.id}`);
    assertUnique([...source.dimensions.map(item => item.physical_field), ...source.measures.flatMap(item => item.physical_field ? [item.physical_field] : [])], `physical fields for source ${source.id}`);
    assertUniqueAndSorted(source.grain.key, `grain key for source ${source.id}`);
    assertUniqueAndSorted(source.scope.sessions, `sessions for source ${source.id}`);
    assertUniqueAndSorted(source.integrity.required_checks, `integrity checks for source ${source.id}`);
    assertUniqueAndSorted(source.integrity.operation_checks.map(item => item.operation_class), `operation checks for source ${source.id}`);
    for (const operationCheck of source.integrity.operation_checks) {
      assertUniqueAndSorted(operationCheck.required_checks, `${operationCheck.operation_class} checks for source ${source.id}`);
      if (operationCheck.operation_class !== 'ranking' &&
          (operationCheck.null_position_policy !== undefined || operationCheck.equal_position_policy !== undefined)) {
        throw new Error(`source ${source.id} position policies require a ranking operation`);
      }
    }
    assertUniqueAndSorted(source.coverage.unsupported_ids, `unsupported coverage IDs for source ${source.id}`);
    validateLanguage(source.id, source.language);

    if ((source.scope.season_min === null) !== (source.scope.season_max === null)) {
      throw new Error(`source ${source.id} must set both season bounds or neither`);
    }
    if (source.scope.season_min !== null && source.scope.season_max !== null && source.scope.season_min > source.scope.season_max) {
      throw new Error(`source ${source.id} has inverted season bounds`);
    }
    if (source.scope.final_season_through !== null && (source.scope.season_max === null || source.scope.final_season_through > source.scope.season_max)) {
      throw new Error(`source ${source.id} final season exceeds source scope`);
    }
    if (source.coverage.observed_seasons !== null) {
      const observed = source.coverage.observed_seasons;
      if (observed.min > observed.max || source.scope.season_min === null || source.scope.season_max === null || observed.min < source.scope.season_min || observed.max > source.scope.season_max) {
        throw new Error(`source ${source.id} observed coverage exceeds source scope`);
      }
    }
    if (source.integrity.source_presence_required !== source.integrity.required_checks.includes('source_presence')) {
      throw new Error(`source ${source.id} source-presence contract is inconsistent`);
    }
    if (source.integrity.unique_key_required && !source.integrity.required_checks.some(check => check === 'unique_grain' || check === 'unique_event_key')) {
      throw new Error(`source ${source.id} unique-key contract lacks a machine check`);
    }

    const conceptMap = new Map([...source.dimensions, ...source.measures].map(item => [item.id, item]));
    for (const key of source.grain.key) {
      if (!source.dimensions.some(item => item.id === key)) {
        throw new Error(`source ${source.id} grain key ${key} is not a dimension`);
      }
    }
    for (const dimensionItem of source.dimensions) {
      assertUniqueAndSorted(dimensionItem.filter_operators, `filter operators for ${source.id}.${dimensionItem.id}`);
      assertUniqueAndSorted(dimensionItem.allowed_values, `allowed values for ${source.id}.${dimensionItem.id}`);
      if (dimensionItem.filter_operators.includes('range') && !['date', 'duration_ms', 'number', 'position', 'round', 'season'].includes(dimensionItem.semantic_type)) {
        throw new Error(`dimension ${source.id}.${dimensionItem.id} cannot use range filtering`);
      }
      if ((dimensionItem.semantic_type === 'status' || dimensionItem.semantic_type === 'provenance') && dimensionItem.allowed_values.length === 0) {
        throw new Error(`dimension ${source.id}.${dimensionItem.id} requires allowed values`);
      }
      if (dimensionItem.language !== null) {
        validateLanguage(`${source.id}.${dimensionItem.id}`, dimensionItem.language);
      }
      allConceptIds.add(`${source.id}.${dimensionItem.id}`);
    }
    for (const measureItem of source.measures) {
      assertUniqueAndSorted(measureItem.filter_operators, `filter operators for ${source.id}.${measureItem.id}`);
      assertUniqueAndSorted(measureItem.allowed_aggregations, `aggregations for ${source.id}.${measureItem.id}`);
      assertUniqueAndSorted(measureItem.depends_on, `dependencies for ${source.id}.${measureItem.id}`);
      if (measureItem.filter_operators.includes('range') && !['date', 'duration_ms', 'number', 'position', 'round', 'season'].includes(measureItem.semantic_type)) {
        throw new Error(`measure ${source.id}.${measureItem.id} cannot use range filtering`);
      }
      if (measureItem.expression_class === 'column' && (measureItem.physical_field === null || measureItem.depends_on.length > 0)) {
        throw new Error(`column measure ${source.id}.${measureItem.id} must have one physical field and no dependencies`);
      }
      if (measureItem.expression_class === 'derived' && (measureItem.physical_field !== null || measureItem.depends_on.length === 0)) {
        throw new Error(`derived measure ${source.id}.${measureItem.id} must have dependencies and no physical field`);
      }
      for (const dependency of measureItem.depends_on) {
        if (!conceptMap.has(dependency)) {
          throw new Error(`measure ${source.id}.${measureItem.id} references unknown dependency ${dependency}`);
        }
      }
      if (measureItem.language !== null) {
        validateLanguage(`${source.id}.${measureItem.id}`, measureItem.language);
      }
      allConceptIds.add(`${source.id}.${measureItem.id}`);
    }
    const nullablePosition = source.measures.some(item => item.semantic_type === 'position' && item.nullable);
    if (nullablePosition && source.integrity.required_checks.includes('non_null_position')) {
      throw new Error(`source ${source.id} cannot require non-null positions for every operation`);
    }
    if (source.measures.some(item => item.semantic_type === 'position' && item.filter_operators.length > 0)) {
      const positionFilterChecks = source.integrity.operation_checks.find(item => item.operation_class === 'position_filter')?.required_checks ?? [];
      if (!positionFilterChecks.includes('non_null_position') || !positionFilterChecks.includes('unique_relevant_position')) {
        throw new Error(`source ${source.id} position filters require non-null and uniqueness operation checks`);
      }
    }
    const positionMeasures = source.measures.filter(item => item.semantic_type === 'position').map(item => item.id);
    const boundedMeasures = source.integrity.position_bounds.map(item => item.measure_id);
    assertUniqueAndSorted(boundedMeasures, `position bounds for source ${source.id}`);
    if (positionMeasures.length > 0) {
      if (!source.integrity.required_checks.includes('position_bounds')) {
        throw new Error(`source ${source.id} position measures require bounds checks`);
      }
      if (stableSerialize(boundedMeasures) !== stableSerialize(positionMeasures)) {
        throw new Error(`source ${source.id} must bound every position measure exactly once`);
      }
    } else if (boundedMeasures.length > 0) {
      throw new Error(`source ${source.id} position bounds lack a required machine check`);
    }
    const ranking = source.integrity.operation_checks.find(item => item.operation_class === 'ranking');
    if (ranking && positionMeasures.length > 0) {
      if (ranking.null_position_policy === undefined || ranking.equal_position_policy === undefined) {
        throw new Error(`source ${source.id} ranking requires explicit null and equal-position policies`);
      }
      const effectiveRankingChecks = new Set([
        ...source.integrity.required_checks,
        ...ranking.required_checks
      ]);
      const rejectsNulls = effectiveRankingChecks.has('non_null_position');
      const rejectsEqualPositions = effectiveRankingChecks.has('unique_relevant_position');
      if ((ranking.null_position_policy === 'reject') !== rejectsNulls ||
          (ranking.equal_position_policy === 'reject') !== rejectsEqualPositions) {
        throw new Error(`source ${source.id} ranking checks do not match its position policies`);
      }
    }
    if (positionMeasures.length > 0 && !ranking) {
      throw new Error(`source ${source.id} must retain an explicit ranking position policy`);
    }
    for (const bound of source.integrity.position_bounds) {
      const bounded = source.measures.find(item => item.id === bound.measure_id);
      if (!bounded || bounded.semantic_type !== 'position') {
        throw new Error(`source ${source.id} position bound references a non-position measure`);
      }
      if (bound.max !== null && bound.max < bound.min) {
        throw new Error(`source ${source.id} has inverted position bounds`);
      }
    }
    assertAcyclicMeasures(source);
  }

  if (allConceptIds.size !== catalog.sources.reduce((count, source) => count + source.dimensions.length + source.measures.length, 0)) {
    throw new Error('catalog concept IDs must be globally unique by source and concept');
  }

  for (const relationship of catalog.relationships) {
    assertUniqueAndSorted(relationship.required_branch_filters, `branch filters for relationship ${relationship.id}`);
    assertUniqueAndSorted(relationship.required_checks, `checks for relationship ${relationship.id}`);
    assertUniqueAndSorted(relationship.required_scope_predicates.map(predicate => `${predicate.side}.${predicate.concept_id}.${predicate.operator}.${predicate.parameter}`), `scope predicates for relationship ${relationship.id}`);
    const from = sources.get(relationship.from_source);
    const to = sources.get(relationship.to_source);
    if (!from || !to) {
      throw new Error(`relationship ${relationship.id} references an unknown source`);
    }
    for (let index = 0; index < relationship.from_keys.length; index++) {
      const fromConcept = from.dimensions.find(item => item.id === relationship.from_keys[index]);
      const toConcept = to.dimensions.find(item => item.id === relationship.to_keys[index]);
      if (!fromConcept || !toConcept) {
        throw new Error(`relationship ${relationship.id} keys must reference dimensions`);
      }
      if (fromConcept.semantic_type !== toConcept.semantic_type) {
        throw new Error(`relationship ${relationship.id} key semantic types do not match`);
      }
    }
    for (const filter of relationship.required_branch_filters) {
      const fromConcept = [...from.dimensions, ...from.measures].find(item => item.id === filter);
      const toConcept = [...to.dimensions, ...to.measures].find(item => item.id === filter);
      if (!fromConcept || !toConcept || fromConcept.filter_operators.length === 0 || toConcept.filter_operators.length === 0) {
        throw new Error(`relationship ${relationship.id} branch filter must be filterable on both sources`);
      }
    }
    for (const predicate of relationship.required_scope_predicates) {
      const endpoint = predicate.side === 'from' ? from : to;
      const concept = endpoint.dimensions.find(item => item.id === predicate.concept_id);
      if (!concept || !concept.filter_operators.includes('eq') || concept.semantic_type !== predicate.parameter) {
        throw new Error(`relationship ${relationship.id} has an invalid required scope predicate`);
      }
    }
    for (const [side, endpoint] of [['from', from], ['to', to]] as const) {
      if (endpoint.grain.kind === 'participation_evidence' && !relationship.required_scope_predicates.some(predicate =>
        predicate.side === side && predicate.concept_id === 'season' && predicate.parameter === 'season')) {
        throw new Error(`relationship ${relationship.id} must scope participation evidence by season`);
      }
    }
    if (relationship.join_stage === 'row' && relationship.from_source === relationship.to_source) {
      const coveredGrain = new Set([...relationship.from_keys, ...relationship.required_branch_filters]);
      if (from.grain.key.some(key => !coveredGrain.has(key)) || relationship.cardinality !== 'many_to_many' ||
          !relationship.required_checks.includes('source_presence') || !relationship.required_checks.includes('unique_filtered_branch')) {
        throw new Error(`self relationship ${relationship.id} must expose raw fanout and complete branch-filter preconditions`);
      }
    }
    if (relationship.cardinality === 'many_to_one' || relationship.cardinality === 'one_to_one') {
      const targetKeys = new Set(relationship.to_keys);
      if (to.grain.uniqueness === 'not_unique' || to.grain.key.some(key => !targetKeys.has(key))) {
        throw new Error(`relationship ${relationship.id} cannot prove many-to-one target cardinality`);
      }
      if (to.grain.uniqueness === 'verified_at_query' && !relationship.required_checks.includes('unique_to_key')) {
        throw new Error(`relationship ${relationship.id} must verify target-key uniqueness`);
      }
    }
    if (relationship.join_stage === 'row' && relationship.optionality === 'left' &&
        !relationship.required_checks.includes('non_null_requested_to_concepts')) {
      throw new Error(`left relationship ${relationship.id} must verify requested target concepts`);
    }
    if (relationship.cardinality === 'one_to_many' || relationship.cardinality === 'one_to_one') {
      const sourceKeys = new Set(relationship.from_keys);
      if (from.grain.uniqueness === 'not_unique' || from.grain.key.some(key => !sourceKeys.has(key))) {
        throw new Error(`relationship ${relationship.id} cannot prove one-to-many source cardinality`);
      }
      if (from.grain.uniqueness === 'verified_at_query' && !relationship.required_checks.includes('unique_from_key')) {
        throw new Error(`relationship ${relationship.id} must verify source-key uniqueness`);
      }
    }
    if (relationship.join_stage === 'row' && (from.usage === 'resolution_only' || to.usage === 'resolution_only')) {
      throw new Error(`row relationship ${relationship.id} cannot use a resolution-only source`);
    }
    if (relationship.join_stage === 'resolution' &&
        (from.grain.uniqueness === 'not_unique' || to.grain.uniqueness === 'not_unique') &&
        !relationship.required_checks.includes('deduplicate_keys')) {
      throw new Error(`resolution relationship ${relationship.id} over non-unique evidence must deduplicate keys`);
    }
    if (relationship.join_stage === 'resolution' && from.usage !== to.usage &&
        !relationship.required_checks.includes('single_resolved_key')) {
      throw new Error(`resolution relationship ${relationship.id} into answer facts must require one resolved key`);
    }
  }
  assertConnectedSourceGraph(catalog);
}

function assertConnectedSourceGraph(catalog: SemanticCatalog): void {
  const adjacency = new Map(catalog.sources.map(source => [source.id, new Set<string>()]));
  for (const relationship of catalog.relationships) {
    adjacency.get(relationship.from_source)?.add(relationship.to_source);
    adjacency.get(relationship.to_source)?.add(relationship.from_source);
  }
  const visited = new Set<string>();
  const pending = [catalog.sources[0]?.id].filter((id): id is string => Boolean(id));
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  if (visited.size !== catalog.sources.length) {
    throw new Error('catalog source relationship graph must be connected');
  }
}

function assertAcyclicMeasures(source: SemanticCatalogSource): void {
  const measures = new Map(source.measures.map(item => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new Error(`source ${source.id} has cyclic derived measures`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of measures.get(id)?.depends_on ?? []) {
      if (measures.has(dependency)) {
        visit(dependency);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of measures.keys()) {
    visit(id);
  }
}

function validateLanguage(sourceId: string, language: SemanticCatalogSource['language']): void {
  assertUniqueAndSorted(language.names, `language names for source ${sourceId}`);
  assertUniqueAndSorted(language.synonyms, `language synonyms for source ${sourceId}`);
  assertUniqueAndSorted(language.abbreviations, `language abbreviations for source ${sourceId}`);
  assertUniqueAndSorted(language.ambiguity_groups, `ambiguity groups for source ${sourceId}`);
  assertUniqueAndSorted(language.forbidden_conflations, `forbidden conflations for source ${sourceId}`);
}

function assertUniqueAndSorted(values: readonly string[], label: string): void {
  assertUnique(values, label);
  const sorted = [...values].sort(compareText);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${label} must be canonically sorted`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function normalizeDatabaseType(type: string): z.infer<typeof physicalTypeSchema> | string {
  if (['bigint', 'integer', 'smallint'].includes(type)) {
    return 'integer';
  }
  if (['double precision', 'numeric', 'real'].includes(type)) {
    return 'numeric';
  }
  if (['character', 'character varying', 'text'].includes(type)) {
    return 'text';
  }
  return type;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
