import { AnswerCapability } from './answer-policy';
import { F1QLProgram } from './ast';
import { renderF1QL } from './render';
import { F1QL_DEFINITIONS_VERSION } from './validation';
import { F1QL_COMPILER_VERSION, F1QL_FACT_SPACE_VERSION, getF1QLProgramHash } from './verified-programs';

export type AnswerCoverageStatus = 'sufficient' | 'empty' | 'possibly_truncated';

export interface AnswerFact {
  subject: string;
  values: Record<string, string | null>;
}

export interface FormattedAnswer {
  headline: string;
  facts: AnswerFact[];
}

export interface AnswerEnvelope {
  mode: 'gated_execution';
  program: F1QLProgram;
  program_hash: string;
  answer: FormattedAnswer;
  rows: Array<Record<string, unknown>>;
  rendering: string;
  metadata: {
    source: AnswerCapability['source'];
    definitions_version: string;
    compiler_version: string;
    fact_space_version: string;
    coverage: { status: AnswerCoverageStatus; rows_returned: number };
    caveats: string[];
  };
}

export class AnswerFormatError extends Error {}

export function buildAnswerEnvelope(program: F1QLProgram, capability: AnswerCapability, rows: Array<Record<string, unknown>>): AnswerEnvelope {
  const formatted = formatAnswerRows(program, capability, rows);
  return {
    mode: 'gated_execution',
    program,
    program_hash: getF1QLProgramHash(program),
    answer: formatted.answer,
    rows,
    rendering: renderF1QL(program),
    metadata: {
      source: capability.source,
      definitions_version: F1QL_DEFINITIONS_VERSION,
      compiler_version: F1QL_COMPILER_VERSION,
      fact_space_version: F1QL_FACT_SPACE_VERSION,
      coverage: { status: formatted.coverage, rows_returned: rows.length },
      caveats: formatted.caveats
    }
  };
}

export function formatAnswerRows(
  program: F1QLProgram,
  capability: AnswerCapability,
  rows: Array<Record<string, unknown>>
): { answer: FormattedAnswer; coverage: AnswerCoverageStatus; caveats: string[] } {
  if (program.root.op === 'race_season_finishing_position_h2h') {
    if (capability.source !== 'race_classification' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Race H2H capability did not match program');
    }
    return formatRaceSeasonH2H(program.root, rows);
  }
  if (rows.length === 0) {
    const root = program.root;
    const positionSelected = (root.op === 'event_classification' && root.filters?.finishing_position !== undefined)
      || (root.op === 'qualifying_classification' && root.filters?.qualifying_position !== undefined);
    if (positionSelected) {
      throw new AnswerFormatError('Selected classification positions were incomplete');
    }
    return {
      answer: { headline: 'No matching source rows were available.', facts: [] },
      coverage: 'empty',
      caveats: ['empty_result_is_not_zero']
    };
  }
  if (capability.source === 'final_driver_standings' || capability.source === 'current_driver_standings') {
    return formatStandings(program, rows, capability.source === 'current_driver_standings');
  }
  if (capability.source === 'race_classification') {
    return formatClassification(program, rows, 'race');
  }
  if (capability.source === 'qualifying_classification') {
    return formatClassification(program, rows, 'qualifying');
  }
  if (capability.source === 'race_date_metadata') {
    return formatMetadata(rows);
  }
  throw new AnswerFormatError('Unsupported answer source');
}

function formatRaceSeasonH2H(root: Extract<F1QLProgram['root'], { op: 'race_season_finishing_position_h2h' }>, rows: Array<Record<string, unknown>>) {
  if (rows.length !== 1) {
    throw new AnswerFormatError('Race H2H rows were invalid');
  }
  const row = rows[0];
  if (row.metric_id !== root.metric || row.season !== root.season || row.driver_a_id !== root.driver_a_id || row.driver_b_id !== root.driver_b_id ||
      row.source_integrity_ok !== true || row.source_presence_ok !== true || row.source_unique_keys_ok !== true) {
    throw new AnswerFormatError('Race H2H rows were invalid');
  }
  const driverAAhead = requiredBoundedCount(row.driver_a_ahead, 'driver_a_ahead');
  const driverBAhead = requiredBoundedCount(row.driver_b_ahead, 'driver_b_ahead');
  const ties = requiredBoundedCount(row.ties, 'ties');
  const sharedEvents = requiredBoundedCount(row.shared_events, 'shared_events');
  const driverASourceRows = requiredBoundedCount(row.driver_a_source_rows, 'driver_a_source_rows');
  const driverBSourceRows = requiredBoundedCount(row.driver_b_source_rows, 'driver_b_source_rows');
  const distinctSourceKeys = requiredBoundedCount(row.distinct_source_keys, 'distinct_source_keys', 60);
  const duplicateSourceRows = requiredBoundedCount(row.duplicate_source_rows, 'duplicate_source_rows');
  if (sharedEvents === 0 || driverASourceRows === 0 || driverBSourceRows === 0 || duplicateSourceRows !== 0 ||
      distinctSourceKeys !== driverASourceRows + driverBSourceRows || sharedEvents > Math.min(driverASourceRows, driverBSourceRows) ||
      driverAAhead + driverBAhead + ties !== sharedEvents) {
    throw new AnswerFormatError('Race H2H rows were invalid');
  }
  let outcome = `${root.driver_a_id} and ${root.driver_b_id} finished ahead equally often.`;
  if (driverAAhead > driverBAhead) {
    outcome = `${root.driver_a_id} finished ahead more often.`;
  } else if (driverBAhead > driverAAhead) {
    outcome = `${root.driver_b_id} finished ahead more often.`;
  }
  return {
    answer: {
      headline: `${outcome} Final ${root.season} race finishing-position H2H.`,
      facts: [{
        subject: `${root.driver_a_id} vs ${root.driver_b_id}`,
        values: {
          driver_a_ahead: String(driverAAhead), driver_b_ahead: String(driverBAhead), ties: String(ties), shared_events: String(sharedEvents)
        }
      }]
    },
    coverage: 'sufficient' as const,
    caveats: ['shared_events_require_both_recorded_numeric_finishing_positions', 'null_or_one_sided_events_excluded']
  };
}

function formatStandings(program: F1QLProgram, rows: Array<Record<string, unknown>>, current: boolean) {
  if (program.root.op !== 'aggregate' && program.root.op !== 'rank') {
    throw new AnswerFormatError('Standings capability did not match program');
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const aliases = aggregate.measures.map(measure => measure.as);
  if (aliases.includes('recorded_final_standings_rows')) {
    return formatDriverCareerSummary(program, aggregate, rows);
  }
  if (aliases.includes('standing_rows')) {
    return formatDriverSeasonSummary(program, aggregate, rows);
  }
  const ordered = program.root.op === 'rank' ? rows : [...rows].sort((left, right) => requiredString(left.driver_id, 'driver_id').localeCompare(requiredString(right.driver_id, 'driver_id')));
  if (current) {
    const positions = ordered.map(row => requiredPosition(row.championship_position, 'championship_position'));
    if (positions.some((position, index) => position !== index + 1)) {
      throw new AnswerFormatError('Current standings positions were invalid');
    }
  }
  const facts = ordered.map(row => ({
    subject: requiredString(row.driver_id, 'driver_id'),
    values: Object.fromEntries(aliases.map(alias => [alias, displayNumeric(row[alias], alias)]))
  }));
  return {
    answer: { headline: current ? `Latest recorded ${capabilitySeason(program)} driver standings.` : `Final ${capabilitySeason(program)} driver standings result.`, facts },
    coverage: 'sufficient' as const,
    caveats: current ? ['season_in_progress'] : [] as string[]
  };
}

function formatDriverCareerSummary(program: F1QLProgram, aggregate: Extract<F1QLProgram['root'], { op: 'aggregate' }>, rows: Array<Record<string, unknown>>) {
  if (program.root.op !== 'aggregate' || aggregate.input.op !== 'filter' || typeof aggregate.input.where.driver_id !== 'string' || rows.length !== 1) {
    throw new AnswerFormatError('Driver career summary rows were invalid');
  }
  const row = rows[0];
  const driverId = requiredString(row.driver_id, 'driver_id');
  if (driverId !== aggregate.input.where.driver_id) {
    throw new AnswerFormatError('Driver career summary rows were invalid');
  }
  return {
    answer: {
      headline: `Recorded final championship standings career summary for ${driverId}.`,
      facts: [{
        subject: driverId,
        values: {
          best_championship_position: displayNumeric(requiredPositiveInteger(row.best_championship_position, 'best_championship_position'), 'best_championship_position'),
          recorded_final_standings_rows: displayNumeric(requiredPositiveInteger(row.recorded_final_standings_rows, 'recorded_final_standings_rows'), 'recorded_final_standings_rows')
        }
      }]
    },
    coverage: 'sufficient' as const,
    caveats: ['final_standings_rows_only']
  };
}

function formatDriverSeasonSummary(program: F1QLProgram, aggregate: Extract<F1QLProgram['root'], { op: 'aggregate' }>, rows: Array<Record<string, unknown>>) {
  if (program.root.op !== 'aggregate' || aggregate.input.op !== 'filter' || typeof aggregate.input.where.driver_id !== 'string' || rows.length !== 1) {
    throw new AnswerFormatError('Driver season summary rows were invalid');
  }
  const row = rows[0];
  const driverId = requiredString(row.driver_id, 'driver_id');
  if (driverId !== aggregate.input.where.driver_id || requiredPosition(row.standing_rows, 'standing_rows') !== 1) {
    throw new AnswerFormatError('Driver season summary rows were invalid');
  }
  return {
    answer: {
      headline: `Official final ${capabilitySeason(program)} championship standing summary for ${driverId}.`,
      facts: [{
        subject: driverId,
        values: {
          championship_position: displayNumeric(requiredPositiveInteger(row.championship_position, 'championship_position'), 'championship_position'),
          points: displayNumeric(row.points, 'points')
        }
      }]
    },
    coverage: 'sufficient' as const,
    caveats: [] as string[]
  };
}

function formatClassification(program: F1QLProgram, rows: Array<Record<string, unknown>>, kind: 'race' | 'qualifying') {
  const root = program.root;
  if ((kind === 'race' && root.op !== 'event_classification') || (kind === 'qualifying' && root.op !== 'qualifying_classification')) {
    throw new AnswerFormatError('Classification capability did not match program');
  }
  if (root.op !== 'event_classification' && root.op !== 'qualifying_classification') {
    throw new AnswerFormatError('Classification program was invalid');
  }
  const keys = kind === 'race'
    ? ['finishing_position', 'points', 'classification_status', 'status_reason']
    : ['qualifying_position', 'best_time_ms', 'best_session', 'eliminated_in_round', 'classification_status'];
  const selectedPositions = root.op === 'event_classification'
    ? root.filters?.finishing_position
    : root.filters?.qualifying_position;
  if (selectedPositions !== undefined) {
    const positionField = root.op === 'event_classification' ? 'finishing_position' : 'qualifying_position';
    const returnedPositions = rows.map(row => requiredPosition(row[positionField], positionField)).sort((left, right) => left - right);
    if (returnedPositions.length !== selectedPositions.length || returnedPositions.some((position, index) => position !== selectedPositions[index])) {
      throw new AnswerFormatError('Selected classification positions were incomplete');
    }
  }
  const facts = rows.map(row => ({
    subject: requiredString(row.driver_id, 'driver_id'),
    values: Object.fromEntries(keys.map(key => [key, isNumericClassificationField(key) ? displayNumeric(row[key], key) : displayText(row[key], key)]))
  }));
  const positionSelected = selectedPositions !== undefined;
  const possiblyTruncated = root.filters?.driver_id === undefined && !positionSelected && rows.length === root.limit;
  return {
    answer: { headline: `${kind === 'race' ? 'Race' : 'Qualifying'} classification for ${root.season} round ${root.round}.`, facts },
    coverage: possiblyTruncated ? 'possibly_truncated' as const : 'sufficient' as const,
    caveats: possiblyTruncated ? [`classification_limited_to_${root.limit}_rows`] : []
  };
}

function requiredPosition(value: unknown, field: string): number {
  const position = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > 30) {
    throw new AnswerFormatError(`Invalid ${field} value`);
  }
  return position;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const integer = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof integer !== 'number' || !Number.isSafeInteger(integer) || integer < 1) {
    throw new AnswerFormatError(`Invalid ${field} value`);
  }
  return integer;
}

function requiredBoundedCount(value: unknown, field: string, maximum = 30): number {
  const integer = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof integer !== 'number' || !Number.isSafeInteger(integer) || integer < 0 || integer > maximum) {
    throw new AnswerFormatError(`Invalid ${field} value`);
  }
  return integer;
}

function formatMetadata(rows: Array<Record<string, unknown>>) {
  const ordered = [...rows].sort((left, right) => requiredString(left.event_id, 'event_id').localeCompare(requiredString(right.event_id, 'event_id')));
  return {
    answer: {
      headline: 'Race event date metadata.',
      facts: ordered.map(row => ({
        subject: requiredString(row.event_name, 'event_name'),
        values: {
          event_id: requiredString(row.event_id, 'event_id'),
          circuit_id: displayText(row.circuit_id, 'circuit_id'),
          date: displayText(row.date, 'date'),
          session_scope: displayText(row.session_scope, 'session_scope')
        }
      }))
    },
    coverage: 'sufficient' as const,
    caveats: [] as string[]
  };
}

function displayNumeric(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const negative = value.startsWith('-');
    const [integerPart, fractionPart = ''] = (negative ? value.slice(1) : value).split('.');
    const integer = integerPart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    const normalized = `${integer}${fraction ? `.${fraction}` : ''}`;
    return negative && normalized !== '0' ? `-${normalized}` : normalized;
  }
  throw new AnswerFormatError(`Invalid ${field} value`);
}

function displayText(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AnswerFormatError(`Invalid ${field} value`);
  }
  return value;
}

function isNumericClassificationField(field: string): boolean {
  return field === 'finishing_position' || field === 'points' || field === 'qualifying_position' || field === 'best_time_ms' || field === 'eliminated_in_round';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AnswerFormatError(`Missing ${field}`);
  }
  return value;
}

function capabilitySeason(program: F1QLProgram): number {
  const root = program.root;
  if (root.op !== 'aggregate' && root.op !== 'rank') {
    throw new AnswerFormatError('Standings program was invalid');
  }
  const aggregate = root.op === 'rank' ? root.input : root;
  if (aggregate.input.op !== 'filter' || typeof aggregate.input.where.season !== 'number') {
    throw new AnswerFormatError('Standings season was invalid');
  }
  return aggregate.input.where.season;
}
