import { AggregateMeasure, StandingsFilter } from './ast';
import { CoreAggregateNode, CoreDeltaNode, CoreEventClassificationFilter, CoreLapPaceFilter, CoreLimitNode, CorePipelineNode, CoreProgram, CoreQualifyingClassificationFilter } from './core';

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

export interface QualifyingClassificationRow {
  season: number;
  round: number;
  driver_id: string;
  team_id: string | null;
  qualifying_position: number | null;
  best_time_ms: number | null;
  best_session: string | null;
  eliminated_in_round: string | null;
  classification_status: string;
}

export function interpretEventClassification(program: CoreProgram, rows: EventClassificationRow[]): Array<Record<string, unknown>> {
  return interpretEventClassificationNode(program.root as CorePipelineNode, rows)
    .map(({ driver_id, finishing_position, points, classification_status, status_reason }) => ({ driver_id, finishing_position, points, classification_status, status_reason }));
}

export function interpretQualifyingClassification(program: CoreProgram, rows: QualifyingClassificationRow[]): Array<Record<string, unknown>> {
  return interpretQualifyingClassificationNode(program.root as CorePipelineNode, rows)
    .map(({ driver_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, classification_status }) => ({
      driver_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, classification_status
    }));
}

export function interpretStandingsProgram(
  program: CoreProgram,
  rows: StandingsRow[]
): Array<Record<string, unknown>> {
  if (program.root.op === 'delta' || getSourceName(program.root) !== 'standings') {
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

function interpretQualifyingClassificationNode(node: CorePipelineNode, rows: QualifyingClassificationRow[]): QualifyingClassificationRow[] {
  if (node.op === 'source') {
    if (node.source !== 'qualifying_classification') {
      throw new Error(`interpretQualifyingClassification received ${node.source}`);
    }
    return rows;
  }
  if (node.op === 'filter') {
    const where = node.where as CoreQualifyingClassificationFilter;
    return interpretQualifyingClassificationNode(node.input, rows)
      .filter((row) => row.season === where.season && row.round === where.round)
      .filter((row) => where.classification_status === undefined || where.classification_status.includes(row.classification_status))
      .filter((row) => where.driver_id === undefined || row.driver_id === where.driver_id)
      .filter((row) => where.team_id === undefined || row.team_id === where.team_id);
  }
  if (node.op === 'sort') {
    const direction = node.direction === 'asc' ? 1 : -1;
    const nullValue = node.nulls === 'first' ? -Infinity : Infinity;
    return [...interpretQualifyingClassificationNode(node.input, rows)]
      .sort((a, b) => (Number(a[node.by as keyof QualifyingClassificationRow] ?? nullValue) - Number(b[node.by as keyof QualifyingClassificationRow] ?? nullValue)) * direction || a.driver_id.localeCompare(b.driver_id));
  }
  if (node.op === 'limit') {
    return interpretQualifyingClassificationNode(node.input, rows).slice(0, node.limit);
  }
  throw new Error(`Unsupported qualifying classification core operator ${node.op}`);
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
  if (program.root.op === 'limit' && program.root.input.op === 'sort' && program.root.input.input.op === 'aggregate') {
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
    return interpretPaceDelta(program.root, rows);
  }
  const result = interpretPacePipeline(program.root, rows);
  const driverId = getPaceConstant(program.root, 'driver_id');
  if (driverId === undefined) {
    throw new Error('Lap pace summary requires a driver filter');
  }
  return result.map((row) => ({ driver_id: driverId, ...row }));
}

function interpretPaceDelta(node: CoreDeltaNode, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  const comparisons = interpretPaceCompare(node.input, rows);
  const driverAValues = comparisons.map((row) => row.driver_a_median as number);
  const driverBValues = comparisons.map((row) => row.driver_b_median as number);
  const driverAAvg = mean(driverAValues);
  const driverBAvg = mean(driverBValues);

  return [{
    driver_a_id: node.left_id,
    driver_b_id: node.right_id,
    shared_events: comparisons.length,
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
  if (node.input.op !== 'sort') {
    throw new Error('Expected a sort before limit');
  }
  const sort = node.input;
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows]
    .sort((a, b) => {
      const aValue = Number(a[sort.by]);
      const bValue = Number(b[sort.by]);
      if (aValue !== bValue) {
        return (aValue - bValue) * direction;
      }
      return String(a.driver_id).localeCompare(String(b.driver_id));
    })
    .slice(0, node.limit);
}

function interpretPacePipeline(node: CorePipelineNode, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (node.op === 'source') {
    if (node.source !== 'lap_pace') {
      throw new Error(`interpretLapPaceProgram received ${node.source}`);
    }
    return rows.map((row) => ({ ...row }));
  }
  if (node.op === 'filter') {
    const where = node.where as CoreLapPaceFilter;
    return interpretPacePipeline(node.input, rows)
      .filter((row) => matchesLapPaceFilter(row as unknown as PaceLapRow, where));
  }
  if (node.op === 'aggregate') {
    const input = interpretPacePipeline(node.input, rows);
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of input) {
      const key = JSON.stringify(node.group_by.map((field) => row[field]));
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    if (node.group_by.length === 0 && groups.size === 0) {
      groups.set('[]', []);
    }
    return Array.from(groups.values()).map((group) => {
      const output: Record<string, unknown> = {};
      for (const field of node.group_by) {
        output[field] = group[0]?.[field];
      }
      for (const measure of node.measures) {
        output[measure.as] = evaluatePaceMeasure(measure, group);
      }
      return output;
    });
  }
  throw new Error(`Unsupported lap pace core operator ${node.op}`);
}

function interpretPaceCompare(node: CoreDeltaNode['input'], rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (node.op !== 'compare') {
    throw new Error(`Expected lap pace compare, received ${node.op}`);
  }
  return interpretPaceJoin(node.input, rows).map(({ left, right }) => ({
    [node.left.as]: left[node.left.field],
    [node.right.as]: right[node.right.field]
  }));
}

function interpretPaceJoin(node: CoreDeltaNode['input']['input'], rows: PaceLapRow[]): Array<{ left: Record<string, unknown>; right: Record<string, unknown> }> {
  if (node.op !== 'join') {
    throw new Error(`Expected lap pace join, received ${node.op}`);
  }
  const left = interpretPacePipeline(node.left, rows);
  const right = interpretPacePipeline(node.right, rows);
  return left.flatMap((leftRow) => right
    .filter((rightRow) => node.on.every((field) => leftRow[field] === rightRow[field]))
    .map((rightRow) => ({ left: leftRow, right: rightRow })));
}

function evaluatePaceMeasure(measure: CoreAggregateNode['measures'][number], rows: Array<Record<string, unknown>>): number | null {
  if (measure.function === 'count') {
    return rows.length;
  }
  const values = rows
    .map((row) => row[measure.field!])
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) {
    return null;
  }
  if (measure.function === 'median') {
    return median(values);
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getPaceConstant(node: CorePipelineNode, field: keyof CoreLapPaceFilter): unknown {
  if (node.op === 'source') {
    return undefined;
  }
  if (node.op === 'filter') {
    return (node.where as CoreLapPaceFilter)[field] ?? getPaceConstant(node.input, field);
  }
  return getPaceConstant(node.input, field);
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
