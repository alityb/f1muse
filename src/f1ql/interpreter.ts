import { AggregateMeasure, StandingsFilter } from './ast';
import { CoreAggregateNode, CoreDeltaNode, CoreEventClassificationFilter, CoreLapPaceFilter, CoreLimitNode, CorePipelineNode, CoreProgram } from './core';

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
  return interpretEventClassificationNode(program.root as CorePipelineNode, rows)
    .map(({ driver_id, finishing_position, points, classification_status, status_reason }) => ({ driver_id, finishing_position, points, classification_status, status_reason }));
}

export function interpretStandingsProgram(
  program: CoreProgram,
  rows: StandingsRow[]
): Array<Record<string, unknown>> {
  if (program.root.op === 'delta' || isLapPaceAggregate(program.root) || getSourceName(program.root) === 'event_classification') {
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
    for (const measure of aggregate.measures as AggregateMeasure[]) {
      output[measure.as] = evaluateMeasure(measure, group);
    }
    return output;
  });

  if (program.root.op === 'limit') {
    return limitRows(result, program.root);
  }
  return result;
}

function interpretEventClassificationNode(node: CorePipelineNode, rows: EventClassificationRow[]): EventClassificationRow[] {
  if (node.op === 'source') {
    if (node.source !== 'event_classification') {
      throw new Error(`interpretEventClassification received ${node.source}`);
    }
    return rows;
  }
  if (node.op === 'filter') {
    const where = node.where as CoreEventClassificationFilter;
    return interpretEventClassificationNode(node.input, rows)
      .filter((row) => row.season === where.season && row.round === where.round)
      .filter((row) => where.classification_status === undefined || where.classification_status.includes(row.classification_status))
      .filter((row) => where.driver_id === undefined || row.driver_id === where.driver_id)
      .filter((row) => where.team_id === undefined || row.team_id === where.team_id);
  }
  if (node.op === 'sort') {
    const direction = node.direction === 'asc' ? 1 : -1;
    const nullValue = node.nulls === 'first' ? -Infinity : Infinity;
    return [...interpretEventClassificationNode(node.input, rows)]
      .sort((a, b) => (Number(a[node.by as keyof EventClassificationRow] ?? nullValue) - Number(b[node.by as keyof EventClassificationRow] ?? nullValue)) * direction || a.driver_id.localeCompare(b.driver_id));
  }
  if (node.op === 'limit') {
    return interpretEventClassificationNode(node.input, rows).slice(0, node.limit);
  }
  throw new Error(`Unsupported event classification core operator ${node.op}`);
}

function getSourceName(node: CorePipelineNode | CoreDeltaNode): string {
  if (node.op === 'source') {
    return node.source;
  }
  if (node.op === 'delta') {
    return getSourceName(node.input.input.left);
  }
  return getSourceName(node.input);
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

export function interpretLapPaceProgram(program: CoreProgram, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (program.root.op === 'delta') {
    return interpretDelta(program.root, rows);
  }
  if (!isLapPaceAggregate(program.root)) {
    throw new Error('interpretLapPaceProgram expects a lap pace core program');
  }
  const eventMedians = aggregateLapPace(program.root.input as CoreAggregateNode, rows);
  const values = Array.from(eventMedians.values());
  const filter = (program.root.input as CoreAggregateNode).input as { where: CoreLapPaceFilter };
  return [{
    driver_id: filter.where.driver_id,
    events: values.length,
    avg_lap_time_seconds: mean(values)
  }];
}

function interpretDelta(node: CoreDeltaNode, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  const leftByRound = aggregateLapPace(node.input.input.left, rows);
  const rightByRound = aggregateLapPace(node.input.input.right, rows);
  const sharedRounds = Array.from(leftByRound.keys()).filter((round) => rightByRound.has(round));
  const driverAValues = sharedRounds.map((round) => leftByRound.get(round)!);
  const driverBValues = sharedRounds.map((round) => rightByRound.get(round)!);
  const driverAAvg = mean(driverAValues);
  const driverBAvg = mean(driverBValues);

  return [{
    driver_a_id: node.left_id,
    driver_b_id: node.right_id,
    shared_events: sharedRounds.length,
    driver_a_avg_lap_time_seconds: driverAAvg,
    driver_b_avg_lap_time_seconds: driverBAvg,
    delta_seconds: driverAAvg === null || driverBAvg === null ? null : driverAAvg - driverBAvg,
    delta_percent: driverAAvg === null || driverBAvg === null || driverBAvg === 0
      ? null
      : ((driverAAvg - driverBAvg) / driverBAvg) * 100
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

function isLapPaceAggregate(node: CoreProgram['root']): node is CoreAggregateNode {
  return node.op === 'aggregate'
    && node.input.op === 'aggregate'
    && node.input.input.op === 'filter'
    && node.input.input.input.source === 'lap_pace';
}

function aggregateLapPace(node: CoreAggregateNode, rows: PaceLapRow[]): Map<number, number> {
  if (!isLapPaceEventAggregate(node)) {
    throw new Error('Expected per-round lap pace aggregate');
  }
  const filter = node.input as { where: CoreLapPaceFilter };
  const byRound = new Map<number, number[]>();
  for (const row of rows) {
    if (!matchesLapPaceFilter(row, filter.where)) {
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

function isLapPaceEventAggregate(node: CoreAggregateNode): boolean {
  return node.input.op === 'filter' && node.input.input.source === 'lap_pace'
    && node.group_by.length === 1 && node.group_by[0] === 'round';
}

function matchesLapPaceFilter(row: PaceLapRow, filter: CoreLapPaceFilter): boolean {
  const matchesRounds = filter.rounds === undefined ? true : filter.rounds.includes(row.round);
  const matchesCleanAir = filter.clean_air_only ? row.clean_air_flag : true;
  const matchesCompound = filter.compound === undefined ? true : row.compound === filter.compound;
  return [
    row.season === filter.season,
    row.driver_id === filter.driver_id,
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
