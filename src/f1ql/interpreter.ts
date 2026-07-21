import { AggregateMeasure, StandingsFilter } from './ast';
import { CoreAggregateNode, CoreEventClassificationFilterNode, CoreLimitNode, CorePaceAggregateNode, CoreProgram, CoreSubtractNode } from './core';

export interface StandingsRow {
  season: number;
  driver_id: string;
  championship_position: number | null;
  points: number;
  championship_won: boolean;
}

export interface PaceLapRow {
  season: number;
  round: number;
  driver_id: string;
  lap_time_seconds: number | null;
  is_valid_lap: boolean;
  is_pit_lap: boolean;
  is_in_lap: boolean;
  is_out_lap: boolean;
  clean_air_flag: boolean;
  compound: string | null;
}

export interface EventClassificationRow {
  season: number;
  round: number;
  driver_id: string;
  team_id: string | null;
  finishing_position: number | null;
  points: number;
  classification_status: string;
  status_reason: string | null;
}

export function interpretEventClassification(program: CoreProgram, rows: EventClassificationRow[]): Array<Record<string, unknown>> {
  if (!isEventClassificationProgram(program)) {
    throw new Error('interpretEventClassification expects a classification core program');
  }
  const { where } = program.root.input.input;
  const sort = program.root.input;
  if (sort.by !== 'finishing_position') {
    throw new Error(`Unsupported event classification sort field: ${sort.by}`);
  }
  const direction = sort.direction === 'asc' ? 1 : -1;
  const nullValue = sort.nulls === 'first' ? -Infinity : Infinity;
  return rows
    .filter((row) => row.season === where.season && row.round === where.round)
    .filter((row) => where.classification_status === undefined || where.classification_status.includes(row.classification_status))
    .filter((row) => where.driver_id === undefined || row.driver_id === where.driver_id)
    .filter((row) => where.team_id === undefined || row.team_id === where.team_id)
    .sort((a, b) => ((a.finishing_position ?? nullValue) - (b.finishing_position ?? nullValue)) * direction || a.driver_id.localeCompare(b.driver_id))
    .slice(0, program.root.limit)
    .map(({ driver_id, finishing_position, points, classification_status, status_reason }) => ({ driver_id, finishing_position, points, classification_status, status_reason }));
}

export function interpretStandingsProgram(
  program: CoreProgram,
  rows: StandingsRow[]
): Array<Record<string, unknown>> {
  if (program.root.op === 'subtract' || program.root.op === 'pace_aggregate' || isEventClassificationProgram(program)) {
    throw new Error('interpretStandingsProgram does not accept pace programs');
  }
  const aggregate = getAggregateRoot(program);
  const filter = aggregate.input.op === 'filter' ? aggregate.input.where : {};
  const filtered = rows.filter((row) => matchesFilter(row, filter));
  const grouped = new Map<string, StandingsRow[]>();

  for (const row of filtered) {
    const key = row.driver_id;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }

  const result = Array.from(grouped.entries()).map(([driverId, group]) => {
    const output: Record<string, unknown> = { driver_id: driverId };
    for (const measure of aggregate.measures) {
      output[measure.as] = evaluateMeasure(measure, group);
    }
    return output;
  });

  if (program.root.op === 'limit') {
    return limitRows(result, program.root);
  }
  return result;
}

function isEventClassificationProgram(program: CoreProgram): program is CoreProgram & { root: CoreLimitNode & { input: { input: CoreEventClassificationFilterNode } } } {
  return program.root.op === 'limit'
    && program.root.input.input.op === 'filter'
    && program.root.input.input.input.source === 'event_classification';
}

function getAggregateRoot(program: CoreProgram): CoreAggregateNode {
  if (program.root.op === 'limit' && program.root.input.input.op === 'aggregate') {
    return program.root.input.input;
  }
  if (program.root.op === 'sort' && program.root.input.op === 'aggregate') {
    return program.root.input;
  }
  if (program.root.op === 'aggregate') {
    return program.root;
  }
  throw new Error('Expected a standings aggregate core program');
}

export function interpretPaceSubtract(
  node: CoreSubtractNode,
  rows: PaceLapRow[]
): Array<Record<string, unknown>> {
  const leftByRound = aggregatePace(node.left, rows);
  const rightByRound = aggregatePace(node.right, rows);
  const sharedRounds = Array.from(leftByRound.keys()).filter((round) => rightByRound.has(round));
  const driverAValues = sharedRounds.map((round) => leftByRound.get(round)!);
  const driverBValues = sharedRounds.map((round) => rightByRound.get(round)!);
  const driverAAvg = mean(driverAValues);
  const driverBAvg = mean(driverBValues);

  return [{
    driver_a_id: node.left.driver_id,
    driver_b_id: node.right.driver_id,
    shared_events: sharedRounds.length,
    driver_a_avg_lap_time_seconds: driverAAvg,
    driver_b_avg_lap_time_seconds: driverBAvg,
    delta_seconds: driverAAvg === null || driverBAvg === null ? null : driverAAvg - driverBAvg,
    delta_percent: driverAAvg === null || driverBAvg === null || driverBAvg === 0
      ? null
      : ((driverAAvg - driverBAvg) / driverBAvg) * 100
  }];
}

export function interpretPaceAggregate(
  node: CorePaceAggregateNode,
  rows: PaceLapRow[]
): Array<Record<string, unknown>> {
  const eventMedians = aggregatePace(node, rows);
  const values = Array.from(eventMedians.values());
  return [{
    driver_id: node.driver_id,
    events: values.length,
    avg_lap_time_seconds: mean(values)
  }];
}

function matchesFilter(row: StandingsRow, filter: StandingsFilter): boolean {
  return matchesValue(row.season, filter.season) && matchesValue(row.driver_id, filter.driver_id);
}

function matchesValue<T>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

function evaluateMeasure(measure: AggregateMeasure, rows: StandingsRow[]): number | null {
  if (measure.function === 'count') {
    return rows.length;
  }
  const values = rows
    .map((row) => row[measure.field!])
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) {
    return null;
  }
  if (measure.function === 'sum') {
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (measure.function === 'min') {
    return Math.min(...values);
  }
  return Math.max(...values);
}

function limitRows(rows: Array<Record<string, unknown>>, node: CoreLimitNode): Array<Record<string, unknown>> {
  const direction = node.input.direction === 'asc' ? 1 : -1;
  return [...rows]
    .sort((a, b) => {
      const aValue = Number(a[node.input.by]);
      const bValue = Number(b[node.input.by]);
      if (aValue !== bValue) {
        return (aValue - bValue) * direction;
      }
      return String(a.driver_id).localeCompare(String(b.driver_id));
    })
    .slice(0, node.limit);
}

function aggregatePace(node: CorePaceAggregateNode, rows: PaceLapRow[]): Map<number, number> {
  const byRound = new Map<number, number[]>();
  for (const row of rows) {
    if (!matchesPaceAggregate(row, node)) {
      continue;
    }
    const values = byRound.get(row.round) ?? [];
    if (row.lap_time_seconds !== null) {
      values.push(row.lap_time_seconds);
    }
    byRound.set(row.round, values);
  }

  return new Map(Array.from(byRound.entries()).map(([round, values]) => [round, median(values)]));
}

function matchesPaceAggregate(row: PaceLapRow, node: CorePaceAggregateNode): boolean {
  const matchesRounds = node.rounds === undefined ? true : node.rounds.includes(row.round);
  const matchesCleanAir = node.clean_air_only ? row.clean_air_flag : true;
  const matchesCompound = node.compound === undefined ? true : row.compound === node.compound;
  return [
    row.season === node.season,
    row.driver_id === node.driver_id,
    matchesRounds,
    row.lap_time_seconds !== null,
    row.is_valid_lap,
    !row.is_pit_lap,
    !row.is_in_lap,
    !row.is_out_lap,
    matchesCleanAir,
    matchesCompound
  ].every(Boolean);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
