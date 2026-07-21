import { AggregateMeasure, StandingsFilter } from './ast';

export interface CoreSourceNode {
  op: 'source';
  source: 'standings' | 'event_classification';
}

export interface CoreEventClassificationFilter {
  season: number;
  round: number;
  classification_status?: string[];
  driver_id?: string;
  team_id?: string;
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

export type CoreFilterNode = CoreStandingsFilterNode | CoreEventClassificationFilterNode;

export interface CoreAggregateNode {
  op: 'aggregate';
  input: CoreStandingsFilterNode | (CoreSourceNode & { source: 'standings' });
  group_by: ['driver_id'];
  measures: AggregateMeasure[];
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

export interface CoreProgram {
  version: 1;
  root: CoreAggregateNode | CoreSortNode | CoreLimitNode | CorePaceAggregateNode | CoreSubtractNode;
}
