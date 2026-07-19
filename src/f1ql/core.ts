import { AggregateMeasure, SourceNode, StandingsFilter } from './ast';

export interface CoreFilterNode {
  op: 'filter';
  input: SourceNode;
  where: StandingsFilter;
}

export interface CoreAggregateNode {
  op: 'aggregate';
  input: CoreFilterNode | SourceNode;
  group_by: ['driver_id'];
  measures: AggregateMeasure[];
}

export interface CoreSortLimitNode {
  op: 'sort_limit';
  input: CoreAggregateNode;
  by: string;
  direction: 'asc' | 'desc';
  limit: number;
}

export interface CorePaceAggregateNode {
  op: 'pace_aggregate';
  driver_id: string;
  season: number;
  rounds?: number[];
  clean_air_only: boolean;
  compound?: string;
}

export interface CoreSubtractNode {
  op: 'subtract';
  left: CorePaceAggregateNode;
  right: CorePaceAggregateNode;
  alignment: 'shared_events';
}

export interface CoreEventClassificationNode {
  op: 'event_classification';
  season: number;
  round: number;
  limit: number;
}

export interface CoreProgram {
  version: 1;
  root: CoreAggregateNode | CoreSortLimitNode | CorePaceAggregateNode | CoreSubtractNode | CoreEventClassificationNode;
}
