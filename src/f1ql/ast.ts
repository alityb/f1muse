export type StandingsDimension = 'driver_id';
export type StandingsMeasureField = 'points' | 'championship_position';
export type AggregateFunction = 'sum' | 'count' | 'min' | 'max';

export interface SourceNode {
  op: 'source';
  source: 'standings';
}

export interface StandingsFilter {
  season?: number | number[];
  driver_id?: string | string[];
}

export interface FilterNode {
  op: 'filter';
  input: SourceNode;
  where: StandingsFilter;
}

export interface AggregateMeasure {
  as: string;
  function: AggregateFunction;
  field?: StandingsMeasureField;
}

export interface AggregateNode {
  op: 'aggregate';
  input: FilterNode | SourceNode;
  group_by: StandingsDimension[];
  measures: AggregateMeasure[];
}

export interface RankNode {
  op: 'rank';
  input: AggregateNode;
  by: string;
  direction: 'asc' | 'desc';
  limit: number;
}

export interface PaceDeltaNode {
  op: 'pace_delta';
  driver_a_id: string;
  driver_b_id: string;
  scope: {
    season: number;
    rounds?: number[];
  };
  filters?: {
    clean_air_only?: boolean;
    compound?: string;
  };
}

export interface PaceSummaryNode {
  op: 'pace_summary';
  driver_id: string;
  scope: {
    season: number;
    rounds?: number[];
  };
  filters?: {
    clean_air_only?: boolean;
    compound?: string;
  };
}

export interface EventClassificationNode {
  op: 'event_classification';
  season: number;
  round: number;
  limit: number;
  filters?: {
    classification_status?: Array<'classified' | 'dnf' | 'dns' | 'dsq' | 'not_classified' | 'withdrawn'>;
    driver_id?: string;
    team_id?: string;
  };
}

export interface QualifyingClassificationNode {
  op: 'qualifying_classification';
  season: number;
  round: number;
  limit: number;
  filters?: {
    classification_status?: Array<'classified' | 'dnf' | 'dns'>;
    driver_id?: string;
    team_id?: string;
  };
}

export interface F1QLProgram {
  version: 1;
  root: AggregateNode | RankNode | PaceDeltaNode | PaceSummaryNode | EventClassificationNode | QualifyingClassificationNode;
}

export interface F1QLResult {
  program: F1QLProgram;
  core_program: import('./core').CoreProgram;
  rendering: string;
  rows: Array<Record<string, unknown>>;
}
