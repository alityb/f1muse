const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const SCALAR_COUNT = 'Show count of qualifying position in final 2025 qualifying classification.';
const RACE_SCALAR_COUNT = 'Show count of finishing position in final 2025 race classification.';
const FILTERED_RACE_SCALAR_COUNT = 'Show count of finishing position for Norris in final 2025 race classification.';
const HOLDOUT_STANDINGS = 'Give driver and championship points from 2024 final driver standings.';
const HOLDOUT_RACE_METADATA = 'Give driver and finishing position, event name, and circuit identifier for round 2 of final 2024 race classification and event metadata.';
const HOLDOUT_COMPOSE = 'In final 2024, show count of finishing position from race classification and count of qualifying position from qualifying classification for Piastri.';
const FILTERED_STANDINGS = 'List driver and championship points for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from final 2025 driver standings.';
const STANDINGS_POSITION_RANKING = 'Rank Max Verstappen, Lando Norris, Oscar Piastri by championship position in final 2025 driver standings.';
const FILTERED_RACE_CLASSIFICATION = 'List driver and finishing position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from round 1 of final 2025 race classification.';
const RACE_POSITION_RANKING = 'Rank drivers Max Verstappen, Lando Norris, Oscar Piastri by finishing position from round 1 of final 2025 race classification.';
const QUALIFYING_POSITION_RANKING = 'Rank drivers Max Verstappen, Lando Norris, Oscar Piastri by qualifying position from round 1 of final 2025 qualifying classification.';
const FILTERED_QUALIFYING_CLASSIFICATION = 'List driver and qualifying position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from round 1 of final 2025 qualifying classification.';
const EVENT_DATE = 'List race date from round 1 of final 2025 event metadata.';
const EVENT_CIRCUIT = 'List circuit identifier from final 2025 event metadata at Monaco.';
const EVENT_NAME = 'List event name from round 1 of final 2025 event metadata.';

const noResolvers = {
  driver_mentions: [],
  event_resolution: { type: 'missing' }
} as const;

export const compositionalRegressionCorpusInput: unknown = {
  version: 1,
  expected_coverage: {
    cases_total: 30,
    action_counts: { answer: 18, clarify: 5, abstain: 7 },
    split_counts: { development: 15, public_holdout: 3, ambiguity: 5, abstention: 7 },
    topology_counts: {
      single_source_rows: 11,
      single_source_aggregate: 3,
      row_dimension_join: 2,
      scalar_aggregate_compose: 2
    },
    source_set_counts: {
      driver_standings: 4,
      event_classification: 4,
      qualifying_classification: 3,
      event_metadata: 3,
      event_classification_event_metadata: 2,
      event_classification_qualifying_classification: 2
    },
    plan_family_counts: {
      single_source: 14,
      safe_dimension_join: 2,
      aggregate_locality: 2,
      other: 0
    },
    ambiguity_reason_counts: {
      attachment_ambiguous: 1,
      entity_ambiguous: 1,
      metric_ambiguous: 1,
      output_shape_ambiguous: 1,
      scope_ambiguous: 1,
      temporal_ambiguous: 0
    },
    abstention_reason_counts: {
      candidate_overflow: 1,
      provider_candidate_not_enumerated: 1,
      unknown_language: 1,
      unsupported_comparison: 1,
      unsupported_concept: 1,
      unsupported_source_combination: 1,
      unsupported_scope: 1
    },
    coverage_tag_counts: {
      promoted_topology: 15,
      public_holdout: 3,
      ambiguity: 5,
      abstention: 7,
      plan_family_single_source: 14,
      plan_family_safe_dimension_join: 2,
      plan_family_aggregate_locality: 2,
      provider_admission: 1
    },
    risk_tag_counts: {
      clean: 1,
      aggregation: 3,
      aggregate_locality: 2,
      join_cardinality: 2,
      resolver_event: 9,
      resolver_identity: 9,
      template_free: 13,
      metric_ambiguity: 1,
      output_shape_ambiguity: 1,
      scope_ambiguity: 1,
      attachment_ambiguity: 1,
      entity_type_ambiguity: 1,
      candidate_overflow: 1,
      provider_substitution: 1,
      unknown_language: 1,
      unsupported_comparison: 1,
      unsupported_concept: 1,
      unsupported_source_combination: 1,
      unsupported_scope: 1
    }
  },
  cases: [
    {
      id: 'promoted-single-source-rows', split: 'development', question: STANDINGS,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'], risk_tags: ['clean'], entities: [],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['driver_standings'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-filtered-standings-points', split: 'development', question: FILTERED_STANDINGS,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Charles Leclerc' },
        { type: 'driver', text: 'George Russell' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] },
          { text: 'George Russell', candidates: ['george-russell'], active_candidates: ['george-russell'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['driver_standings'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-standings-position-ranking', split: 'development', question: STANDINGS_POSITION_RANKING,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Max Verstappen' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Max Verstappen', candidates: ['max-verstappen'], active_candidates: ['max-verstappen'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['driver_standings'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-filtered-race-classification', split: 'development', question: FILTERED_RACE_CLASSIFICATION,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Charles Leclerc' },
        { type: 'driver', text: 'George Russell' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] },
          { text: 'George Russell', candidates: ['george-russell'], active_candidates: ['george-russell'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'resolved', season: 2025, round: 1 }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['event_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-race-position-ranking', split: 'development', question: RACE_POSITION_RANKING,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Max Verstappen' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Max Verstappen', candidates: ['max-verstappen'], active_candidates: ['max-verstappen'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'resolved', season: 2025, round: 1 }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['event_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-filtered-qualifying-classification', split: 'development', question: FILTERED_QUALIFYING_CLASSIFICATION,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Charles Leclerc' },
        { type: 'driver', text: 'George Russell' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] },
          { text: 'George Russell', candidates: ['george-russell'], active_candidates: ['george-russell'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'resolved', season: 2025, round: 1 }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-qualifying-position-ranking', split: 'development', question: QUALIFYING_POSITION_RANKING,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event', 'resolver_identity'],
      entities: [
        { type: 'driver', text: 'Max Verstappen' },
        { type: 'driver', text: 'Lando Norris' },
        { type: 'driver', text: 'Oscar Piastri' }
      ],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [
          { text: 'Max Verstappen', candidates: ['max-verstappen'], active_candidates: ['max-verstappen'] },
          { text: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
          { text: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
        ],
        event_resolution: { type: 'resolved', season: 2025, round: 1 }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-event-date', split: 'development', question: EVENT_DATE,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event'], entities: [], provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2025, round: 1 } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['event_metadata'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-event-circuit', split: 'development', question: EVENT_CIRCUIT,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event'],
      entities: [{ type: 'event', text: 'Monaco' }], provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2025, round: 8 } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['event_metadata'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-event-name', split: 'development', question: EVENT_NAME,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['template_free', 'resolver_event'], entities: [], provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2025, round: 1 } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['event_metadata'], plan_family: 'single_source'
      }
    },
    {
      id: 'promoted-safe-dimension-join', split: 'development', question: RACE_METADATA,
      coverage_tags: ['promoted_topology', 'plan_family_safe_dimension_join'],
      risk_tags: ['join_cardinality', 'resolver_event'], entities: [], provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2025, round: 1 } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'row_dimension_join',
        source_ids: ['event_classification', 'event_metadata'], plan_family: 'safe_dimension_join'
      }
    },
    {
      id: 'promoted-aggregate-locality', split: 'development', question: COMPOSE,
      coverage_tags: ['promoted_topology', 'plan_family_aggregate_locality'],
      risk_tags: ['aggregate_locality', 'resolver_identity'], entities: [{ type: 'driver', text: 'Norris' }],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [{ text: 'Norris', candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'scalar_aggregate_compose',
        source_ids: ['event_classification', 'qualifying_classification'], plan_family: 'aggregate_locality'
      }
    },
    {
      id: 'promoted-single-source-aggregate', split: 'development', question: SCALAR_COUNT,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'], risk_tags: ['aggregation'], entities: [],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-race-scalar-aggregate', split: 'development', question: RACE_SCALAR_COUNT,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'], risk_tags: ['aggregation'], entities: [],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['event_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'family-filtered-race-scalar-aggregate', split: 'development', question: FILTERED_RACE_SCALAR_COUNT,
      coverage_tags: ['promoted_topology', 'plan_family_single_source'],
      risk_tags: ['aggregation', 'resolver_identity', 'template_free'],
      entities: [{ type: 'driver', text: 'Norris' }], provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [{
          text: 'Norris', candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris']
        }],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['event_classification'], plan_family: 'single_source'
      }
    },
    {
      id: 'holdout-single-source-rows', split: 'public_holdout', question: HOLDOUT_STANDINGS,
      coverage_tags: ['public_holdout', 'plan_family_single_source'], risk_tags: ['template_free'], entities: [],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['driver_standings'], plan_family: 'single_source'
      }
    },
    {
      id: 'holdout-safe-dimension-join', split: 'public_holdout', question: HOLDOUT_RACE_METADATA,
      coverage_tags: ['public_holdout', 'plan_family_safe_dimension_join'],
      risk_tags: ['template_free', 'join_cardinality', 'resolver_event'], entities: [], provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2024, round: 2 } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'row_dimension_join',
        source_ids: ['event_classification', 'event_metadata'], plan_family: 'safe_dimension_join'
      }
    },
    {
      id: 'holdout-aggregate-locality', split: 'public_holdout', question: HOLDOUT_COMPOSE,
      coverage_tags: ['public_holdout', 'plan_family_aggregate_locality'],
      risk_tags: ['template_free', 'aggregate_locality', 'resolver_identity'], entities: [{ type: 'driver', text: 'Piastri' }],
      provider_mode: 'enumerated',
      resolver: {
        driver_mentions: [{ text: 'Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'scalar_aggregate_compose',
        source_ids: ['event_classification', 'qualifying_classification'], plan_family: 'aggregate_locality'
      }
    },
    {
      id: 'ambiguity-metric', split: 'ambiguity', question: 'List position for final 2025.',
      coverage_tags: ['ambiguity'], risk_tags: ['metric_ambiguity'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'clarify', reason: 'metric_ambiguous' }
    },
    {
      id: 'ambiguity-output-shape', split: 'ambiguity', question: 'Show final 2025 driver standings.',
      coverage_tags: ['ambiguity'], risk_tags: ['output_shape_ambiguity'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'clarify', reason: 'output_shape_ambiguous' }
    },
    {
      id: 'ambiguity-scope', split: 'ambiguity', question: 'List championship points from final 2024 or 2025 driver standings.',
      coverage_tags: ['ambiguity'], risk_tags: ['scope_ambiguity'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'clarify', reason: 'scope_ambiguous' }
    },
    {
      id: 'ambiguity-attachment', split: 'ambiguity',
      question: 'List driver and finishing position for final 2025 race classification at Monaco or Silverstone.',
      coverage_tags: ['ambiguity'], risk_tags: ['attachment_ambiguity'],
      entities: [{ type: 'event', text: 'Monaco' }, { type: 'event', text: 'Silverstone' }],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: { action: 'clarify', reason: 'attachment_ambiguous' }
    },
    {
      id: 'ambiguity-entity-type', split: 'ambiguity',
      question: 'List driver and finishing position for final 2025 race classification at Monaco.',
      coverage_tags: ['ambiguity'], risk_tags: ['entity_type_ambiguity'],
      entities: [{ type: 'driver', text: 'Monaco' }, { type: 'event', text: 'Monaco' }],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: { action: 'clarify', reason: 'entity_ambiguous' }
    },
    {
      id: 'abstain-candidate-overflow', split: 'abstention', question: 'List position for final 2024 or 2025.',
      coverage_tags: ['abstention'], risk_tags: ['candidate_overflow'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'abstain', reason: 'candidate_overflow' }
    },
    {
      id: 'abstain-provider-substitution', split: 'abstention',
      question: 'List driver, championship points, and championship position from final 2025 driver standings.',
      coverage_tags: ['abstention', 'provider_admission'], risk_tags: ['provider_substitution'], entities: [],
      provider_mode: 'omit_last_output', resolver: noResolvers,
      expected: { action: 'abstain', reason: 'provider_candidate_not_enumerated' }
    },
    {
      id: 'abstain-unknown-language', split: 'abstention',
      question: 'List secret championship points from final 2025 driver standings.',
      coverage_tags: ['abstention'], risk_tags: ['unknown_language'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'abstain', reason: 'unknown_language' }
    },
    {
      id: 'abstain-unsupported-comparison', split: 'abstention',
      question: 'Compare finishing position for final 2025 race classification.',
      coverage_tags: ['abstention'], risk_tags: ['unsupported_comparison'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'abstain', reason: 'unsupported_comparison' }
    },
    {
      id: 'abstain-unsupported-concept', split: 'abstention',
      question: 'List Norris championship points and Piastri championship position from final 2025 driver standings.',
      coverage_tags: ['abstention'], risk_tags: ['unsupported_concept'],
      entities: [{ type: 'driver', text: 'Norris' }, { type: 'driver', text: 'Piastri' }],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: { action: 'abstain', reason: 'unsupported_concept' }
    },
    {
      id: 'abstain-unsupported-source-combination', split: 'abstention',
      question: 'List championship points and finishing position from final 2025 driver standings and race classification.',
      coverage_tags: ['abstention'], risk_tags: ['unsupported_source_combination'], entities: [],
      provider_mode: 'enumerated', resolver: noResolvers,
      expected: { action: 'abstain', reason: 'unsupported_source_combination' }
    },
    {
      id: 'abstain-unsupported-scope', split: 'abstention',
      question: 'List championship points from final driver standings.',
      coverage_tags: ['abstention'], risk_tags: ['unsupported_scope'], entities: [], provider_mode: 'enumerated',
      resolver: noResolvers, expected: { action: 'abstain', reason: 'unsupported_scope' }
    }
  ]
};
