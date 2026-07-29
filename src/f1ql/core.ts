import { AggregateMeasure, StandingsFilter } from './ast';

export interface CoreSourceNode {
  op: 'source';
  source: 'standings' | 'event_classification' | 'qualifying_classification' | 'event_metadata' | 'lap_pace' | 'official_lap_timing';
}

export interface CoreEventClassificationFilter {
  season?: number | number[];
  round?: number;
  classification_status?: string[];
  driver_id?: string;
  team_id?: string;
  finishing_position?: number[];
}

export interface CoreLapPaceFilter {
  season: number;
  driver_id: string;
  rounds?: number[];
  lap_time_seconds: 'not_null';
  is_valid_lap: true;
  is_pit_lap: false;
  is_in_lap: false;
  is_out_lap: false;
  clean_air_only: boolean;
  compound?: string;
}

export interface CoreOfficialLapTimingFilter {
  season: number;
  round: number;
  session_type: 'R';
  driver_id: string;
  lap_start: number;
  lap_end: number;
  complete_requested_window: true;
  official_deleted_lap: false;
  official_pit_marker: false;
}

export interface CoreOfficialEventMeanFilter {
  season: number;
  round: number;
  session_type: 'R';
  driver_id: string;
  complete_event: true;
  official_deleted_lap: false;
  official_pit_marker: false;
}

export interface CoreQualifyingClassificationFilter {
  season?: number | number[];
  round?: number;
  classification_status?: string[];
  driver_id?: string;
  team_id?: string;
  qualifying_position?: number[];
}

export interface CoreEventMetadataFilter {
  season?: number | number[];
  round?: number;
  session_scope?: 'race' | 'qualifying';
}

export interface CoreStandingsFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: StandingsFilter;
}

export interface CoreEventClassificationFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: CoreEventClassificationFilter;
}

export interface CoreLapPaceFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: CoreLapPaceFilter;
}

export interface CoreOfficialLapTimingFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: CoreOfficialLapTimingFilter | CoreOfficialEventMeanFilter;
}

export interface CoreQualifyingClassificationFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: CoreQualifyingClassificationFilter;
}

export interface CoreEventMetadataFilterNode {
  op: 'filter';
  input: CorePipelineNode;
  where: CoreEventMetadataFilter;
}

export type CoreFilterNode = CoreStandingsFilterNode | CoreEventClassificationFilterNode | CoreQualifyingClassificationFilterNode | CoreEventMetadataFilterNode | CoreLapPaceFilterNode | CoreOfficialLapTimingFilterNode;

export type CoreAggregateMeasure = AggregateMeasure | {
  as: string;
  function: 'median' | 'avg' | 'count';
  field?: string;
  where?: {
    field: string;
    min: number;
    max: number;
  };
};

export interface CoreAggregateNode {
  op: 'aggregate';
  input: CorePipelineNode | CoreJoinNode;
  group_by: string[];
  measures: CoreAggregateMeasure[];
  minimum_rows?: number;
  source_integrity?: CoreAggregateSourceIntegrity;
  source_record_integrity?: CoreSourceRecordIntegrity;
  metric_id?: string;
}

export interface CoreSourceRecordIntegrity {
  key: string[];
  position_field: string;
  position_min: number;
  position_max: number;
  require_source_presence: true;
  require_non_null_keys: true;
  require_unique_keys: true;
  require_unique_positions: true;
}

export interface CoreAggregateSourceIntegrity {
  left_key: string[];
  left_key_scope?: 'before_outer_filter';
  right_key: string[];
  require_unique_left_keys: boolean;
  require_exactly_one_right_match: boolean;
  require_non_null_right_fields: string[];
}

export interface CoreSortNode {
  op: 'sort';
  input: CorePipelineNode;
  by: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface CoreLimitNode {
  op: 'limit';
  input: CorePipelineNode;
  limit: number;
}

export type CorePipelineNode = CoreSourceNode | CoreFilterNode | CoreAggregateNode | CoreSortNode | CoreLimitNode;

export interface CoreJoinNode {
  op: 'join';
  left: CorePipelineNode;
  right: CorePipelineNode;
  on: string[];
  type: 'inner' | 'left';
}

export interface CoreCompareNode {
  op: 'compare';
  input: CoreJoinNode;
  left: { field: string; as: string };
  right: { field: string; as: string };
}

export const CORE_COMPARISON_SUMMARY_SIGNATURES = {
  event_classification: { comparison_fields: ['finishing_position'], comparison_aliases: ['driver_a_position', 'driver_b_position'] },
  qualifying_classification: { comparison_fields: ['qualifying_position'], comparison_aliases: ['driver_a_position', 'driver_b_position'] }
} as const;

export interface CoreDeltaNode {
  op: 'delta';
  input: CoreCompareNode;
  left_id: string;
  right_id: string;
  metric_id?: 'official_non_deleted_non_pit_window_median_v1' | 'official_non_deleted_non_pit_event_mean_v1';
  lower_is_better?: true;
}

export interface CoreComparisonSummaryNode {
  op: 'comparison_summary';
  input: CoreCompareNode;
  metric_id: string;
  lower_is_better: boolean;
  require_unique_source_keys: boolean;
  require_source_presence: boolean;
  require_exactly_one_shared_event?: true;
}

export interface CoreComposeInput {
  as: string;
  input: CoreAggregateNode | CoreComparisonSummaryNode;
  require?: { field: string; equals: number; non_null_fields: string[] };
}

export interface CoreComposeSelection {
  input: string;
  field: string;
  as: string;
}

export interface CoreComposeNode {
  op: 'compose';
  metric_id: string;
  inputs: CoreComposeInput[];
  select: CoreComposeSelection[];
  require_exactly_one_row_per_input: true;
}

export interface CoreProgram {
  version: 1;
  root: CoreAggregateNode | CoreFilterNode | CoreSortNode | CoreLimitNode | CoreDeltaNode | CoreComparisonSummaryNode | CoreComposeNode;
}
