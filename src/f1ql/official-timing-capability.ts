import { createHash } from 'node:crypto';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_CAPABILITY_PROFILE_ID = 'semantic_official_timing_comparison_v1' as const;
export const OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION = 34 as const;
export const OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION = 'semantic-capability-interaction-v34' as const;
export const OFFICIAL_TIMING_CATALOG_V2_SHA256 =
  '44abf16a8731b25e505afdbdcbb24855eff7d91de81aeb6cf0587465f81dbe57' as const;
export const OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256 =
  '2d6ea575fea5a384f4144f97c095719635c42042d3ea898cc540e0b45c568844' as const;
export const OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256 =
  'afcd23e625f84bc863c5ef465511a9b8e50633c21a99d41c3ca58309776f19ab' as const;

const bundle = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE;

// Derived identically to the reviewed semantic target's capability_profile component; the
// conformance test pins the canonical hash against the target's sealed profile contract hash.
export const OFFICIAL_TIMING_CAPABILITY_PROFILE = deepFreeze({
  id: OFFICIAL_TIMING_CAPABILITY_PROFILE_ID,
  version: OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION,
  catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
  topology: ['same_source_scalar_comparison'],
  source_sets: [[bundle.source.source_id]],
  relationship_ids: ['official_timing_shared_event'],
  operator_signatures: [bundle.topologies[0].operator_signature],
  interaction_descriptor_version: OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION,
  operators: ['aggregate', 'compare', 'filter', 'limit', 'project', 'sort', 'source'],
  filter_operators: ['eq', 'range'],
  aggregate_functions: bundle.metrics.map(metric => metric.aggregation).sort(compareText),
  output_kinds: ['certified_metric_result'],
  sort_directions: ['asc'],
  null_orders: ['last'],
  dimension_ids: [
    'official_race_lap_timing.driver_id', 'official_race_lap_timing.lap_number',
    'official_race_lap_timing.round', 'official_race_lap_timing.season',
    'official_race_lap_timing.session_type'
  ],
  measure_ids: ['official_race_lap_timing.lap_time_seconds'],
  complete_interactions: bundle.topologies.map(topology => {
    const metric = bundle.metrics.find(candidate => candidate.metric_id === topology.metric_id)!;
    const output = bundle.output_schemas.find(candidate => candidate.metric_id === topology.metric_id)!;
    return {
      metric_id: topology.metric_id,
      entity_count: { min: 2, max: 2 },
      season_values: [2022],
      event_count: 1,
      predicate_bindings: [
        'official_race_lap_timing.driver_id:eq', 'official_race_lap_timing.driver_id:eq',
        'official_race_lap_timing.round:eq', 'official_race_lap_timing.round:eq',
        'official_race_lap_timing.season:eq', 'official_race_lap_timing.season:eq',
        'official_race_lap_timing.session_type:eq', 'official_race_lap_timing.session_type:eq',
        ...(topology.window_predicate === null
          ? []
          : ['official_race_lap_timing.lap_number:range', 'official_race_lap_timing.lap_number:range'])
      ].sort(compareText),
      aggregate_bindings: [
        `official_race_lap_timing.lap_time_seconds:${metric.aggregation}->driver_a_metric`,
        `official_race_lap_timing.lap_time_seconds:${metric.aggregation}->driver_b_metric`
      ],
      group_bindings: [],
      output_bindings: output.field_ids
        .map(fieldId => `certified_metric_result:${topology.metric_id}.${fieldId}->${fieldId}`),
      sort_bindings: ['metric_id:asc:last'],
      requested_rows: 1,
      integrity_checks: topology.integrity_checks,
      work: topology.work
    };
  }),
  generic_average_or_median_allowed: false,
  coverage_witness_required: true,
  principal_classes: ['internal', 'internal_canary', 'public'],
  canary_stages: [100],
  scope: 'certified_immutable_historical',
  result_collection: { version: 'semantic-limit-plus-one-v1', completeness_probe_rows: 0 },
  limits: {
    sources: 1, source_scans: 2, joins: 0, comparisons: 1, depth: 7, outputs: 24,
    groups: 0, entities: 2, events: 1, seasons: 1, rows: 1, work_units: 10
  }
});

export type OfficialTimingCapabilityProfile = typeof OFFICIAL_TIMING_CAPABILITY_PROFILE;

export function getOfficialTimingCapabilityProfileHash(): string {
  return hashCanonical(OFFICIAL_TIMING_CAPABILITY_PROFILE);
}

export function hashOfficialTimingCanonical(value: unknown): string {
  return hashCanonical(value);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing capability value is not canonically serializable');
  }
  return serialized;
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
