import { AggregateMeasure, StandingsFilter } from './ast';

export interface CoreSourceNode {
  op: 'source';
  source: 'standings' | 'event_classification' | 'lap_pace';
}

export interface CoreEventClassificationFilter {
  season: number;
  round: number;
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

export interface CoreStandingsFilterNode {
  op: 'filter';
  input: CoreSourceNode & { source: 'standings' };
  where: StandingsFilter;
}

export interface CoreEventClassificationFilterNode {
  op: 'filter';
  input: CoreSourceNode & { source: 'event_classification' };
  where: CoreEventClassificationFilter;
}

export interface CoreLapPaceFilterNode {
  op: 'filter';
  input: CoreSourceNode & { source: 'lap_pace' };
  where: CoreLapPaceFilter;
}

export type CoreFilterNode = CoreStandingsFilterNode | CoreEventClassificationFilterNode | CoreLapPaceFilterNode;

export type CoreAggregateMeasure = AggregateMeasure | {
  as: string;
  function: 'median' | 'avg' | 'count';
  field?: string;
};

export interface CoreAggregateNode {
  op: 'aggregate';
  input: CoreSourceNode | CoreFilterNode | CoreAggregateNode;
  group_by: string[];
  measures: CoreAggregateMeasure[];
}

export interface CoreSortNode {
  op: 'sort';
  input: CoreAggregateNode | CoreEventClassificationFilterNode;
  by: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface CoreLimitNode {
  op: 'limit';
  input: CoreSortNode;
  limit: number;
}

export interface CoreJoinNode {
  op: 'join';
  left: CoreAggregateNode;
  right: CoreAggregateNode;
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
}

export interface CoreProgram {
  version: 1;
  root: CoreAggregateNode | CoreSortNode | CoreLimitNode | CoreDeltaNode;
}
