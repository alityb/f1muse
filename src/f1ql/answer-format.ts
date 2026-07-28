import { AnswerCapability } from './answer-policy';
import { ANSWER_FINAL_STANDINGS_SEASONS } from './answer-templates';
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
  if (program.root.op === 'qualifying_season_position_h2h') {
    if (capability.source !== 'qualifying_classification' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Qualifying H2H capability did not match program');
    }
    return formatQualifyingSeasonH2H(program.root, rows);
  }
  if (program.root.op === 'driver_career_wins_by_circuit') {
    if (capability.source !== 'race_classification_event_metadata' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Driver career wins capability did not match program');
    }
    return formatDriverCareerWinsByCircuit(program.root, rows);
  }
  if (program.root.op === 'rank' && program.root.input.measures.some(measure => measure.as === 'standing_rows')) {
    if (capability.source !== 'final_driver_standings' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Final driver ranking capability did not match program');
    }
    return formatFinalDriverRanking(program.root, rows);
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

function formatFinalDriverRanking(root: Extract<F1QLProgram['root'], { op: 'rank' }>, rows: Array<Record<string, unknown>>) {
  const input = root.input.input;
  const requested = input.op === 'filter' && Array.isArray(input.where.driver_id) ? input.where.driver_id : [];
  if (requested.length !== 3 || rows.length !== 3) {
    throw new AnswerFormatError('Final driver ranking rows were invalid');
  }
  const requestedIds = new Set(requested);
  const returnedIds = new Set<string>();
  let previousPosition = 0;
  const facts = rows.map(row => {
    const driverId = requiredString(row.driver_id, 'driver_id');
    const position = requiredPositiveInteger(row.championship_position, 'championship_position');
    if (!requestedIds.has(driverId) || returnedIds.has(driverId) || requiredPositiveInteger(row.standing_rows, 'standing_rows') !== 1 || position <= previousPosition) {
      throw new AnswerFormatError('Final driver ranking rows were invalid');
    }
    returnedIds.add(driverId);
    previousPosition = position;
    return { subject: driverId, values: { championship_position: String(position) } };
  });
  if (returnedIds.size !== requestedIds.size) {
    throw new AnswerFormatError('Final driver ranking rows were invalid');
  }
  const season = input.op === 'filter' ? input.where.season : undefined;
  if (typeof season !== 'number' || !ANSWER_FINAL_STANDINGS_SEASONS.includes(season)) {
    throw new AnswerFormatError('Final driver ranking rows were invalid');
  }
  return {
    answer: { headline: `Final ${season} championship-position ranking for the requested drivers.`, facts },
    coverage: 'sufficient' as const,
    caveats: ['official_final_championship_positions']
  };
}

// eslint-disable-next-line complexity
function formatDriverCareerWinsByCircuit(
  root: Extract<F1QLProgram['root'], { op: 'driver_career_wins_by_circuit' }>,
  rows: Array<Record<string, unknown>>
) {
  if (rows.length === 0) {
    return {
      answer: { headline: `No recorded official race wins through 2025 for ${root.driver_id}.`, facts: [] },
      coverage: 'empty' as const,
      caveats: ['empty_result_is_not_zero']
    };
  }
  const first = rows[0];
  const sentinels = {
    winnerSourceRows: requiredBoundedCount(first.winner_source_rows, 'winner_source_rows', 4560, 1),
    distinctWinnerEventKeys: requiredBoundedCount(first.distinct_winner_event_keys, 'distinct_winner_event_keys', 4560, 1),
    duplicateWinnerRows: requiredBoundedCount(first.duplicate_winner_rows, 'duplicate_winner_rows', 4560),
    metadataSourceRows: requiredBoundedCount(first.metadata_source_rows, 'metadata_source_rows', 4560, 1),
    distinctMetadataEventKeys: requiredBoundedCount(first.distinct_metadata_event_keys, 'distinct_metadata_event_keys', 4560, 1),
    missingEventMetadataRows: requiredBoundedCount(first.missing_event_metadata_rows, 'missing_event_metadata_rows', 4560),
    duplicateEventMetadataRows: requiredBoundedCount(first.duplicate_event_metadata_rows, 'duplicate_event_metadata_rows', 4560),
    missingCircuitIdRows: requiredBoundedCount(first.missing_circuit_id_rows, 'missing_circuit_id_rows', 4560)
  };
  const sentinelFields = [
    'winner_source_rows', 'distinct_winner_event_keys', 'duplicate_winner_rows', 'metadata_source_rows',
    'distinct_metadata_event_keys', 'missing_event_metadata_rows', 'duplicate_event_metadata_rows', 'missing_circuit_id_rows'
  ] as const;
  if (first.metric_id !== root.metric || first.driver_id !== root.driver_id || first.source_presence_ok !== true || first.source_integrity_ok !== true ||
      sentinels.duplicateWinnerRows !== 0 || sentinels.missingEventMetadataRows !== 0 || sentinels.duplicateEventMetadataRows !== 0 || sentinels.missingCircuitIdRows !== 0 ||
      sentinels.winnerSourceRows !== sentinels.distinctWinnerEventKeys || sentinels.metadataSourceRows !== sentinels.distinctMetadataEventKeys ||
      sentinels.distinctWinnerEventKeys !== sentinels.distinctMetadataEventKeys) {
    throw new AnswerFormatError('Driver career wins rows were invalid');
  }
  const seen = new Set<string>();
  let totalWins = 0;
  const facts = rows.map((row, index) => {
    if (row.metric_id !== root.metric || row.driver_id !== root.driver_id || row.source_presence_ok !== true || row.source_integrity_ok !== true ||
        sentinelFields.some(field => row[field] !== first[field])) {
      throw new AnswerFormatError('Driver career wins rows were invalid');
    }
    const circuitId = requiredString(row.circuit_id, 'circuit_id');
    const wins = requiredBoundedCount(row.wins, 'wins', 4560, 1);
    if (circuitId.trim().length === 0 || seen.has(circuitId) ||
        (index > 0 && (wins > requiredBoundedCount(rows[index - 1].wins, 'wins', 4560, 1) ||
          (wins === rows[index - 1].wins && Buffer.compare(Buffer.from(requiredString(rows[index - 1].circuit_id, 'circuit_id'), 'utf8'), Buffer.from(circuitId, 'utf8')) >= 0)))) {
      throw new AnswerFormatError('Driver career wins rows were invalid');
    }
    seen.add(circuitId);
    totalWins += wins;
    return { subject: circuitId, values: { wins: String(wins) } };
  });
  if (totalWins !== sentinels.winnerSourceRows) {
    throw new AnswerFormatError('Driver career wins rows were invalid');
  }
  return {
    answer: { headline: `Official race wins by circuit through 2025 for ${root.driver_id}.`, facts },
    coverage: 'sufficient' as const,
    caveats: ['completed_seasons_1950_2025_only', 'canonical_circuit_ids']
  };
}

function formatQualifyingSeasonH2H(root: Extract<F1QLProgram['root'], { op: 'qualifying_season_position_h2h' }>, rows: Array<Record<string, unknown>>) {
  const counts = validateSeasonH2HRow(root, rows, 'Qualifying H2H');
  let outcome = `${root.driver_a_id} and ${root.driver_b_id} qualified ahead equally often.`;
  if (counts.driverAAhead > counts.driverBAhead) {
    outcome = `${root.driver_a_id} qualified ahead more often.`;
  } else if (counts.driverBAhead > counts.driverAAhead) {
    outcome = `${root.driver_b_id} qualified ahead more often.`;
  }
  return {
    answer: {
      headline: `${outcome} Final ${root.season} qualifying-position H2H.`,
      facts: [{
        subject: `${root.driver_a_id} vs ${root.driver_b_id}`,
        values: {
          driver_a_ahead: String(counts.driverAAhead), driver_b_ahead: String(counts.driverBAhead),
          ties: String(counts.ties), shared_events: String(counts.sharedEvents)
        }
      }]
    },
    coverage: 'sufficient' as const,
    caveats: ['shared_events_require_both_recorded_numeric_qualifying_positions', 'no_qualifying_time_gap_or_teammate_claim']
  };
}

function formatRaceSeasonH2H(root: Extract<F1QLProgram['root'], { op: 'race_season_finishing_position_h2h' }>, rows: Array<Record<string, unknown>>) {
  const { driverAAhead, driverBAhead, ties, sharedEvents } = validateSeasonH2HRow(root, rows, 'Race H2H');
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

function validateSeasonH2HRow(
  root: Extract<F1QLProgram['root'], { op: 'race_season_finishing_position_h2h' | 'qualifying_season_position_h2h' }>,
  rows: Array<Record<string, unknown>>,
  label: string
) {
  if (rows.length !== 1) {
    throw new AnswerFormatError(`${label} rows were invalid`);
  }
  const row = rows[0];
  if (row.metric_id !== root.metric || row.season !== root.season || row.driver_a_id !== root.driver_a_id || row.driver_b_id !== root.driver_b_id ||
      row.source_integrity_ok !== true || row.source_presence_ok !== true || row.source_unique_keys_ok !== true) {
    throw new AnswerFormatError(`${label} rows were invalid`);
  }
  const driverAAhead = requiredBoundedCount(row.driver_a_ahead, 'driver_a_ahead');
  const driverBAhead = requiredBoundedCount(row.driver_b_ahead, 'driver_b_ahead');
  const ties = requiredBoundedCount(row.ties, 'ties');
  const sharedEvents = requiredBoundedCount(row.shared_events, 'shared_events', 30, 1);
  const driverASourceRows = requiredBoundedCount(row.driver_a_source_rows, 'driver_a_source_rows', 30, 1);
  const driverBSourceRows = requiredBoundedCount(row.driver_b_source_rows, 'driver_b_source_rows', 30, 1);
  const distinctSourceKeys = requiredBoundedCount(row.distinct_source_keys, 'distinct_source_keys', 60, 1);
  const duplicateSourceRows = requiredBoundedCount(row.duplicate_source_rows, 'duplicate_source_rows');
  if (duplicateSourceRows !== 0 || distinctSourceKeys !== driverASourceRows + driverBSourceRows ||
      sharedEvents > Math.min(driverASourceRows, driverBSourceRows) || driverAAhead + driverBAhead + ties !== sharedEvents) {
    throw new AnswerFormatError(`${label} rows were invalid`);
  }
  return { driverAAhead, driverBAhead, ties, sharedEvents };
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

function requiredBoundedCount(value: unknown, field: string, maximum = 30, minimum = 0): number {
  const integer = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof integer !== 'number' || !Number.isSafeInteger(integer) || integer < minimum || integer > maximum) {
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
