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

export interface EventFilter {
  season: number;
  round: number;
}

export interface ClassificationEntityFilters {
  classification_status?: Array<'classified' | 'dnf' | 'dns' | 'dsq' | 'not_classified' | 'withdrawn'>;
  driver_id?: string;
  team_id?: string;
  finishing_position?: number[];
}

export interface EventClassificationNode extends EventFilter {
  op: 'event_classification';
  limit: number;
  filters?: ClassificationEntityFilters;
}

export interface QualifyingClassificationNode extends EventFilter {
  op: 'qualifying_classification';
  limit: number;
  filters?: {
    classification_status?: Array<'classified' | 'dnf' | 'dns'>;
    driver_id?: string;
    team_id?: string;
    qualifying_position?: number[];
  };
}

export interface EventMetadataNode extends EventFilter {
  op: 'event_metadata';
  session_scope?: 'race' | 'qualifying';
}

export interface OfficialLapWindowMedianCompareNode extends EventFilter {
  op: 'official_lap_window_median_compare';
  metric: 'official_non_deleted_non_pit_window_median_v1';
  driver_a_id: string;
  driver_b_id: string;
  lap_start: number;
  lap_end: number;
}

export interface OfficialEventMeanCompareNode extends EventFilter {
  op: 'official_event_mean_compare';
  metric: 'official_non_deleted_non_pit_event_mean_v1';
  driver_a_id: string;
  driver_b_id: string;
}

export interface RaceSeasonFinishingPositionH2HNode {
  op: 'race_season_finishing_position_h2h';
  metric: 'official_race_finishing_position_shared_events_v1';
  season: number;
  driver_a_id: string;
  driver_b_id: string;
}

export interface RaceEventFinishingPositionComparisonNode extends EventFilter {
  op: 'race_event_finishing_position_comparison';
  metric: 'official_race_finishing_position_single_event_v1';
  driver_a_id: string;
  driver_b_id: string;
}

export interface QualifyingSeasonPositionH2HNode {
  op: 'qualifying_season_position_h2h';
  metric: 'official_qualifying_position_shared_events_v1';
  season: number;
  driver_a_id: string;
  driver_b_id: string;
}

export interface OfficialDriverResultsComparisonNode {
  op: 'official_driver_results_comparison';
  metric: 'official_driver_results_comparison_v1';
  season: number;
  driver_a_id: string;
  driver_b_id: string;
}

export interface DriverCareerWinsByCircuitNode {
  op: 'driver_career_wins_by_circuit';
  metric: 'official_race_p1_by_circuit_1950_2025_v1';
  seasons: number[];
  driver_id: string;
}

export interface F1QLProgram {
  version: 1;
  root: AggregateNode | RankNode | PaceDeltaNode | PaceSummaryNode | EventClassificationNode | QualifyingClassificationNode | EventMetadataNode | OfficialLapWindowMedianCompareNode | OfficialEventMeanCompareNode | RaceSeasonFinishingPositionH2HNode | RaceEventFinishingPositionComparisonNode | QualifyingSeasonPositionH2HNode | OfficialDriverResultsComparisonNode | DriverCareerWinsByCircuitNode;
}

export interface F1QLResult {
  program: F1QLProgram;
  core_program: import('./core').CoreProgram;
  rendering: string;
  rows: Array<Record<string, unknown>>;
}
