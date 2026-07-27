import { AggregateMeasure, StandingsFilter } from './ast';

export interface CoreSourceNode {
  op: 'source';
  source: 'standings' | 'event_classification' | 'qualifying_classification' | 'event_metadata' | 'lap_pace' | 'official_lap_timing';
}

export interface CoreEventClassificationFilter {
  season?: number;
  round?: number;
  classification_status?: string[];
  driver_id?: string;
  team_id?: string;
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

export interface CoreQualifyingClassificationFilter {
  season?: number;
  round?: number;
  classification_status?: string[];
  driver_id?: string;
  team_id?: string;
}

export interface CoreEventMetadataFilter {
  season?: number;
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
  where: CoreOfficialLapTimingFilter;
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
};

export interface CoreAggregateNode {
  op: 'aggregate';
  input: CorePipelineNode;
  group_by: string[];
  measures: CoreAggregateMeasure[];
  minimum_rows?: number;
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
  type: 'inner';
}

export interface CoreCompareNode {
  op: 'compare';
  input: CoreJoinNode;
  left: { field: string; as: string };
  right: { field: string; as: string };
}

export interface CoreDeltaNode {
  op: 'delta';
  input: CoreCompareNode;
  left_id: string;
  right_id: string;
  metric_id?: 'official_non_deleted_non_pit_window_median_v1';
  lower_is_better?: true;
}

export interface CoreProgram {
  version: 1;
  root: CoreAggregateNode | CoreFilterNode | CoreSortNode | CoreLimitNode | CoreDeltaNode;
}
