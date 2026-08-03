import { createHash } from 'node:crypto';
import { SEMANTIC_RESULT_COLLECTION_VERSION } from './planned-compiler';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from './semantic-catalog';

export const SEMANTIC_CAPABILITY_PROFILE_VERSION = 5 as const;

export const SEMANTIC_CAPABILITY_PROFILES = deepFreeze([
  {
    id: 'semantic-single-source-v1',
    version: SEMANTIC_CAPABILITY_PROFILE_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    topology: ['single_source_rows'],
    source_sets: [
      ['driver_standings']
    ],
    relationship_ids: [],
    operator_signatures: [
      'limit(sort(project(filter(source))))'
    ],
    operators: ['aggregate', 'filter', 'limit', 'project', 'sort', 'source'],
    filter_operators: ['eq', 'in'],
    aggregate_functions: ['count', 'max', 'min', 'sum'],
    output_kinds: ['aggregate', 'concept'],
    sort_directions: ['asc', 'desc'],
    null_orders: ['first', 'last'],
    complete_interactions: [
      {
        predicate_bindings: ['driver_standings.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: [
          'concept:driver_standings.driver_id->driver_id',
          'concept:driver_standings.points->points'
        ],
        sort_bindings: ['driver_id:asc:last'],
        requested_rows: 100
      },
      {
        question_sha256: sha256('What were Charles Leclerc final standings points in 2024?'),
        season_values: [2024],
        entity_values: ['charles-leclerc'],
        predicate_bindings: ['driver_standings.driver_id:eq', 'driver_standings.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: [
          'concept:driver_standings.driver_id->driver_id',
          'concept:driver_standings.points->points'
        ],
        sort_bindings: ['driver_id:asc:last'],
        requested_rows: 1
      },
      {
        question_sha256: sha256('Final 2025 standings points for Lando Norris and Oscar Piastri.'),
        season_values: [2025],
        entity_values: ['lando-norris', 'oscar-piastri'],
        predicate_bindings: ['driver_standings.driver_id:in', 'driver_standings.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: [
          'concept:driver_standings.driver_id->driver_id',
          'concept:driver_standings.points->points'
        ],
        sort_bindings: ['driver_id:asc:last'],
        requested_rows: 100
      },
      {
        question_sha256: sha256('Final 2025 standings points for Oscar Piastri and Lando Norris.'),
        season_values: [2025],
        entity_values: ['oscar-piastri', 'lando-norris'],
        predicate_bindings: ['driver_standings.driver_id:in', 'driver_standings.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: [
          'concept:driver_standings.driver_id->driver_id',
          'concept:driver_standings.points->points'
        ],
        sort_bindings: ['driver_id:asc:last'],
        requested_rows: 100
      }
    ],
    ...catalogConceptAllowlist(['driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification']),
    principal_classes: ['internal', 'internal_canary'],
    canary_stages: [100],
    scope: 'historical_final',
    result_collection: { version: SEMANTIC_RESULT_COLLECTION_VERSION, completeness_probe_rows: 1 },
    limits: { sources: 1, joins: 0, depth: 6, outputs: 8, groups: 3, entities: 4, events: 30, seasons: 20, rows: 100, work_units: 60 }
  },
  {
    id: 'semantic-safe-dimension-join-v1',
    version: SEMANTIC_CAPABILITY_PROFILE_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    topology: ['row_dimension_join'],
    source_sets: [['event_classification', 'event_metadata']],
    relationship_ids: ['race_event_metadata'],
    operator_signatures: ['limit(sort(project(join(filter(source),filter(source)))))'],
    operators: ['filter', 'join', 'limit', 'project', 'sort', 'source'],
    filter_operators: ['eq', 'in'],
    aggregate_functions: [],
    output_kinds: ['concept'],
    sort_directions: ['asc', 'desc'],
    null_orders: ['first', 'last'],
    complete_interactions: [{
      predicate_bindings: [
        'event_classification.round:eq', 'event_classification.season:eq',
        'event_metadata.round:eq', 'event_metadata.season:eq'
      ],
      aggregate_bindings: [],
      group_bindings: [],
      output_bindings: [
        'concept:event_classification.driver_id->driver_id',
        'concept:event_classification.finishing_position->finishing_position',
        'concept:event_metadata.event_name->event_name',
        'concept:event_metadata.circuit_id->circuit_id'
      ],
      sort_bindings: ['driver_id:asc:last'],
      requested_rows: 100
    }],
    ...catalogConceptAllowlist(['event_classification', 'event_metadata']),
    principal_classes: ['internal', 'internal_canary'],
    canary_stages: [100],
    scope: 'historical_final',
    result_collection: { version: SEMANTIC_RESULT_COLLECTION_VERSION, completeness_probe_rows: 1 },
    limits: { sources: 2, joins: 1, depth: 6, outputs: 8, groups: 0, entities: 4, events: 1, seasons: 1, rows: 100, work_units: 60 }
  },
  {
    id: 'semantic-aggregate-locality-v1',
    version: SEMANTIC_CAPABILITY_PROFILE_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    topology: ['scalar_aggregate_compose'],
    source_sets: [['event_classification', 'qualifying_classification']],
    relationship_ids: [],
    operator_signatures: ['limit(sort(project(compose(aggregate(filter(source)),aggregate(filter(source))))))'],
    operators: ['aggregate', 'compose', 'filter', 'limit', 'project', 'sort', 'source'],
    filter_operators: ['eq', 'in'],
    aggregate_functions: ['count', 'max', 'min', 'sum'],
    output_kinds: ['composed_aggregate'],
    sort_directions: ['asc', 'desc'],
    null_orders: ['first', 'last'],
    complete_interactions: [{
      predicate_bindings: [
        'event_classification.driver_id:eq', 'event_classification.season:eq',
        'qualifying_classification.driver_id:eq', 'qualifying_classification.season:eq'
      ],
      aggregate_bindings: [
        'event_classification.finishing_position:count->count_finishing_position',
        'qualifying_classification.qualifying_position:count->count_qualifying_position'
      ],
      group_bindings: [],
      output_bindings: [
        'composed_aggregate:event_classification.count_finishing_position->event_classification__count_finishing_position',
        'composed_aggregate:qualifying_classification.count_qualifying_position->qualifying_classification__count_qualifying_position'
      ],
      sort_bindings: ['event_classification__count_finishing_position:asc:last'],
      requested_rows: 1
    }],
    ...catalogConceptAllowlist(['event_classification', 'qualifying_classification']),
    principal_classes: ['internal', 'internal_canary'],
    canary_stages: [100],
    scope: 'historical_final',
    result_collection: { version: SEMANTIC_RESULT_COLLECTION_VERSION, completeness_probe_rows: 0 },
    limits: { sources: 2, joins: 0, depth: 6, outputs: 8, groups: 0, entities: 4, events: 30, seasons: 20, rows: 1, work_units: 60 }
  }
] as const);

export type SemanticCapabilityProfile = (typeof SEMANTIC_CAPABILITY_PROFILES)[number];
export type SemanticCapabilityProfileId = SemanticCapabilityProfile['id'];

export const SEMANTIC_CAPABILITY_PROFILE_IDS = deepFreeze(
  SEMANTIC_CAPABILITY_PROFILES.map(profile => profile.id)
) as readonly SemanticCapabilityProfileId[];

export const SEMANTIC_CAPABILITY_REGISTRY_HASH = sha256(stableSerialize({
  version: SEMANTIC_CAPABILITY_PROFILE_VERSION,
  profiles: SEMANTIC_CAPABILITY_PROFILES
}));

export function getSemanticCapabilityProfile(id: string): SemanticCapabilityProfile | undefined {
  return SEMANTIC_CAPABILITY_PROFILES.find(profile => profile.id === id);
}

export function getSemanticCapabilityProfileHash(profile: SemanticCapabilityProfile): string {
  if (!SEMANTIC_CAPABILITY_PROFILES.includes(profile)) {throw new Error('semantic capability profile provenance is invalid');}
  return sha256(stableSerialize(profile));
}

function catalogConceptAllowlist(sourceIds: readonly string[]) {
  const sources = sourceIds.map(sourceId => {
    const source = SEMANTIC_CATALOG.sources.find(candidate => candidate.id === sourceId);
    if (!source || source.usage !== 'answer_fact' || source.governance === 'experimental') {
      throw new Error(`semantic capability source is not eligible: ${sourceId}`);
    }
    return source;
  });
  return {
    dimension_ids: sources.flatMap(source => source.dimensions.map(dimension => `${source.id}.${dimension.id}`)).sort(),
    measure_ids: sources.flatMap(source => source.measures.map(measure => `${source.id}.${measure.id}`)).sort()
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
