import { AnswerCapability } from './answer-policy';
import { ANSWER_FINAL_STANDINGS_SEASONS } from './answer-templates';
import { F1QLProgram } from './ast';
import { renderF1QL } from './render';
import { F1QL_DEFINITIONS_VERSION } from './validation';
import { F1QL_COMPILER_VERSION, F1QL_FACT_SPACE_VERSION, getF1QLProgramHash } from './verified-programs';
import { RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID } from './race-season-finishing-position-h2h';
import { QUALIFYING_SEASON_POSITION_H2H_METRIC_ID } from './qualifying-season-position-h2h';
import {
  finalStandingsRowsResponseContract,
  reviewedFinalStandingsPointsProgramScope,
  ResultCollectionEvidence
} from './final-standings-response-contract';
import { MAX_F1QL_RESPONSE_ROWS } from './limits';

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

export function buildAnswerEnvelope(
  program: F1QLProgram,
  capability: AnswerCapability,
  rows: Array<Record<string, unknown>>,
  collection: ResultCollectionEvidence = {
    row_limit: MAX_F1QL_RESPONSE_ROWS,
    has_more_rows: rows.length >= MAX_F1QL_RESPONSE_ROWS
  }
): AnswerEnvelope {
  const formatted = formatAnswerRows(program, capability, rows, collection);
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
  rows: Array<Record<string, unknown>>,
  collection: ResultCollectionEvidence = {
    row_limit: MAX_F1QL_RESPONSE_ROWS,
    has_more_rows: rows.length >= MAX_F1QL_RESPONSE_ROWS
  }
): { answer: FormattedAnswer; coverage: AnswerCoverageStatus; caveats: string[] } {
  const finalStandingsPointsScope = reviewedFinalStandingsPointsProgramScope(program);
  if (finalStandingsPointsScope) {
    try {
      finalStandingsRowsResponseContract(
        rows.length,
        collection,
        finalStandingsPointsScope.driver_ids.length > 0
          ? finalStandingsPointsScope.driver_ids.length
          : undefined
      );
    } catch {
      throw new AnswerFormatError('Final standings result collection evidence was invalid');
    }
  }
  if (program.root.op === 'official_driver_results_comparison') {
    if (capability.source !== 'official_driver_results_comparison' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Official driver results comparison capability did not match program');
    }
    return formatOfficialDriverResultsComparison(program.root, rows);
  }
  if (program.root.op === 'race_season_finishing_position_h2h') {
    if (capability.source !== 'race_classification' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Race H2H capability did not match program');
    }
    return formatRaceSeasonH2H(program.root, rows);
  }
  if (program.root.op === 'race_event_finishing_position_comparison') {
    if (capability.source !== 'race_classification' || capability.operation !== program.root.op || capability.round !== program.root.round) {
      throw new AnswerFormatError('Race event comparison capability did not match program');
    }
    return formatRaceEventComparison(program.root, rows);
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
  if (program.root.op === 'driver_season_qualifying_p1_count' || program.root.op === 'driver_career_qualifying_p1_count' ||
      program.root.op === 'driver_season_qualifying_top_ten_count' || program.root.op === 'season_qualifying_top_ten_ranking') {
    if (capability.source !== 'qualifying_classification' || capability.operation !== program.root.op) {
      throw new AnswerFormatError('Qualifying count capability did not match program');
    }
    return formatQualifyingCounts(program.root, rows);
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
    return formatStandings(program, rows, capability.source === 'current_driver_standings', collection);
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

function formatQualifyingCounts(
  root: Extract<F1QLProgram['root'], { op: 'driver_season_qualifying_p1_count' | 'driver_career_qualifying_p1_count' | 'driver_season_qualifying_top_ten_count' | 'season_qualifying_top_ten_ranking' }>,
  rows: Array<Record<string, unknown>>
) {
  const ranking = root.op === 'season_qualifying_top_ten_ranking';
  if (rows.length === 0 || (!ranking && rows.length !== 1) || (ranking && rows.length > 30)) {
    throw new AnswerFormatError('Qualifying count rows were invalid');
  }
  const countField = root.op === 'driver_season_qualifying_top_ten_count' || ranking ? 'qualifying_top_ten_count' : 'qualifying_p1_count';
  let maximumSourceRows = 30;
  if (root.op === 'driver_career_qualifying_p1_count') {
    maximumSourceRows = 2280;
  }
  if (ranking) {
    maximumSourceRows = 900;
  }
  const first = rows[0];
  const sentinelFields = [
    'qualifying_source_rows', 'distinct_qualifying_keys', 'missing_qualifying_key_rows',
    'duplicate_qualifying_rows', 'invalid_qualifying_position_rows', 'duplicate_qualifying_position_rows', 'source_presence_ok',
    'source_key_integrity_ok', 'position_integrity_ok', 'source_integrity_ok'
  ] as const;
  const sourceRows = requiredBoundedCount(first.qualifying_source_rows, 'qualifying_source_rows', maximumSourceRows, 1);
  if (first.metric_id !== root.metric || first.source_presence_ok !== true || first.source_key_integrity_ok !== true ||
      first.position_integrity_ok !== true || first.source_integrity_ok !== true ||
      requiredBoundedCount(first.distinct_qualifying_keys, 'distinct_qualifying_keys', maximumSourceRows, 1) !== sourceRows ||
       requiredBoundedCount(first.missing_qualifying_key_rows, 'missing_qualifying_key_rows', maximumSourceRows) !== 0 ||
       requiredBoundedCount(first.duplicate_qualifying_rows, 'duplicate_qualifying_rows', maximumSourceRows) !== 0 ||
       requiredBoundedCount(first.invalid_qualifying_position_rows, 'invalid_qualifying_position_rows', maximumSourceRows) !== 0 ||
       requiredBoundedCount(first.duplicate_qualifying_position_rows, 'duplicate_qualifying_position_rows', maximumSourceRows) !== 0) {
    throw new AnswerFormatError('Qualifying count rows were invalid');
  }
  const expectedDriver = ranking ? undefined : root.driver_id;
  const seen = new Set<string>();
  let previousCount = Number.POSITIVE_INFINITY;
  let previousDriver = '';
  const facts = rows.map(row => {
    if (row.metric_id !== root.metric || sentinelFields.some(field => row[field] !== first[field])) {
      throw new AnswerFormatError('Qualifying count rows were invalid');
    }
    const driverId = requiredString(row.driver_id, 'driver_id');
    const count = requiredBoundedCount(row[countField], countField, sourceRows);
    if ((expectedDriver !== undefined && driverId !== expectedDriver) || seen.has(driverId) ||
        (ranking && (count > previousCount || (count === previousCount && Buffer.compare(Buffer.from(previousDriver, 'utf8'), Buffer.from(driverId, 'utf8')) >= 0)))) {
      throw new AnswerFormatError('Qualifying count rows were invalid');
    }
    seen.add(driverId);
    previousCount = count;
    previousDriver = driverId;
    return { subject: driverId, values: { [countField]: String(count) } };
  });
  let headline: string;
  if (root.op === 'driver_season_qualifying_p1_count') {
    headline = `${root.driver_id} has ${facts[0].values[countField]} recorded official qualifying P1 classifications in ${root.season}.`;
  } else if (root.op === 'driver_career_qualifying_p1_count') {
    headline = `${root.driver_id} has ${facts[0].values[countField]} recorded official qualifying P1 classifications across 1950-2025.`;
  } else if (root.op === 'driver_season_qualifying_top_ten_count') {
    headline = `${root.driver_id} has ${facts[0].values[countField]} recorded numeric top-ten positions in ${root.season}.`;
  } else {
    headline = `Drivers ranked by recorded numeric top-ten positions in ${root.season}.`;
  }
  return {
    answer: { headline, facts },
    coverage: 'sufficient' as const,
    caveats: [
      'recorded_qualifying_positions_only',
      ...(root.op === 'driver_season_qualifying_p1_count' || root.op === 'driver_career_qualifying_p1_count'
        ? ['qualifying_p1_not_post_penalty_grid'] : []),
      ...(ranking ? ['ties_ordered_by_utf8_driver_id'] : [])
    ]
  };
}

function formatRaceEventComparison(
  root: Extract<F1QLProgram['root'], { op: 'race_event_finishing_position_comparison' }>,
  rows: Array<Record<string, unknown>>
) {
  if (rows.length !== 1) {
    throw new AnswerFormatError('Race event comparison rows were invalid');
  }
  const row = rows[0];
  if (row.metric_id !== root.metric || row.season !== root.season || row.driver_a_id !== root.driver_a_id || row.driver_b_id !== root.driver_b_id ||
      row.source_presence_ok !== true || row.source_unique_keys_ok !== true || row.source_integrity_ok !== true ||
      requiredPositiveInteger(row.driver_a_source_rows, 'driver_a_source_rows') !== 1 ||
      requiredPositiveInteger(row.driver_b_source_rows, 'driver_b_source_rows') !== 1 ||
      requiredPositiveInteger(row.distinct_source_keys, 'distinct_source_keys') !== 2 ||
      requiredBoundedCount(row.duplicate_source_rows, 'duplicate_source_rows') !== 0 ||
      requiredPositiveInteger(row.shared_events, 'shared_events') !== 1 ||
      requiredBoundedCount(row.ties, 'ties') !== 0) {
    throw new AnswerFormatError('Race event comparison rows were invalid');
  }
  const driverAAhead = requiredBoundedCount(row.driver_a_ahead, 'driver_a_ahead', 1);
  const driverBAhead = requiredBoundedCount(row.driver_b_ahead, 'driver_b_ahead', 1);
  if (driverAAhead + driverBAhead !== 1) {
    throw new AnswerFormatError('Race event comparison rows were invalid');
  }
  const ahead = driverAAhead === 1 ? root.driver_a_id : root.driver_b_id;
  const behind = driverAAhead === 1 ? root.driver_b_id : root.driver_a_id;
  return {
    answer: {
      headline: `${ahead} finished ahead of ${behind} in the official ${root.season} round ${root.round} race classification.`,
      facts: [{ subject: ahead, values: { finished_ahead_of: behind, season: String(root.season), round: String(root.round) } }]
    },
    coverage: 'sufficient' as const,
    caveats: ['official_race_finishing_positions_only', 'no_pace_or_time_gap_claim']
  };
}

function formatOfficialDriverResultsComparison(
  root: Extract<F1QLProgram['root'], { op: 'official_driver_results_comparison' }>,
  rows: Array<Record<string, unknown>>
) {
  if (rows.length !== 1) {
    throw new AnswerFormatError('Official driver results comparison rows were invalid');
  }
  const row = rows[0];
  if (row.metric_id !== root.metric || row.season !== root.season || row.driver_a_id !== root.driver_a_id || row.driver_b_id !== root.driver_b_id ||
      requiredPositiveInteger(row.driver_a_standing_rows, 'driver_a_standing_rows') !== 1 ||
      requiredPositiveInteger(row.driver_b_standing_rows, 'driver_b_standing_rows') !== 1) {
    throw new AnswerFormatError('Official driver results comparison rows were invalid');
  }
  const driverAPoints = requiredNonnegativeNumeric(row.driver_a_points, 'driver_a_points');
  const driverBPoints = requiredNonnegativeNumeric(row.driver_b_points, 'driver_b_points');
  const driverAPosition = requiredPositiveInteger(row.driver_a_championship_position, 'driver_a_championship_position');
  const driverBPosition = requiredPositiveInteger(row.driver_b_championship_position, 'driver_b_championship_position');
  if (driverAPosition === driverBPosition) {
    throw new AnswerFormatError('Official driver results comparison rows were invalid');
  }
  const race = validatePrefixedH2H(row, 'race', RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID);
  const qualifying = validatePrefixedH2H(row, 'qualifying', QUALIFYING_SEASON_POSITION_H2H_METRIC_ID);
  const facts: AnswerFact[] = [
    { subject: root.driver_a_id, values: { championship_position: String(driverAPosition), points: driverAPoints } },
    { subject: root.driver_b_id, values: { championship_position: String(driverBPosition), points: driverBPoints } },
    {
      subject: `${root.driver_a_id} vs ${root.driver_b_id}`,
      values: {
        race_driver_a_ahead: String(race.driverAAhead), race_driver_b_ahead: String(race.driverBAhead), race_ties: String(race.ties), race_shared_events: String(race.sharedEvents),
        qualifying_driver_a_ahead: String(qualifying.driverAAhead), qualifying_driver_b_ahead: String(qualifying.driverBAhead), qualifying_ties: String(qualifying.ties), qualifying_shared_events: String(qualifying.sharedEvents)
      }
    }
  ];
  return {
    answer: {
      headline: `Official final ${root.season} results comparison for ${root.driver_a_id} and ${root.driver_b_id}.`,
      facts
    },
    coverage: 'sufficient' as const,
    caveats: ['official_final_standings', 'shared_events_require_both_recorded_numeric_positions', 'no_pace_time_gap_weather_adjustment_achievement_total_or_synthetic_score']
  };
}

function validatePrefixedH2H(row: Record<string, unknown>, prefix: 'race' | 'qualifying', metric: string) {
  if (row[`${prefix}_metric_id`] !== metric || row[`${prefix}_source_integrity_ok`] !== true ||
      row[`${prefix}_source_presence_ok`] !== true || row[`${prefix}_source_unique_keys_ok`] !== true) {
    throw new AnswerFormatError('Official driver results comparison rows were invalid');
  }
  const driverAAhead = requiredBoundedCount(row[`${prefix}_driver_a_ahead`], `${prefix}_driver_a_ahead`);
  const driverBAhead = requiredBoundedCount(row[`${prefix}_driver_b_ahead`], `${prefix}_driver_b_ahead`);
  const ties = requiredBoundedCount(row[`${prefix}_ties`], `${prefix}_ties`);
  const sharedEvents = requiredBoundedCount(row[`${prefix}_shared_events`], `${prefix}_shared_events`, 30, 1);
  const driverASourceRows = requiredBoundedCount(row[`${prefix}_driver_a_source_rows`], `${prefix}_driver_a_source_rows`, 30, 1);
  const driverBSourceRows = requiredBoundedCount(row[`${prefix}_driver_b_source_rows`], `${prefix}_driver_b_source_rows`, 30, 1);
  const distinctSourceKeys = requiredBoundedCount(row[`${prefix}_distinct_source_keys`], `${prefix}_distinct_source_keys`, 60, 1);
  const duplicateSourceRows = requiredBoundedCount(row[`${prefix}_duplicate_source_rows`], `${prefix}_duplicate_source_rows`);
  if (duplicateSourceRows !== 0 || distinctSourceKeys !== driverASourceRows + driverBSourceRows ||
      sharedEvents > Math.min(driverASourceRows, driverBSourceRows) || driverAAhead + driverBAhead + ties !== sharedEvents) {
    throw new AnswerFormatError('Official driver results comparison rows were invalid');
  }
  return { driverAAhead, driverBAhead, ties, sharedEvents };
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

// eslint-disable-next-line complexity
function formatStandings(
  program: F1QLProgram,
  rows: Array<Record<string, unknown>>,
  current: boolean,
  collection: ResultCollectionEvidence
) {
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
  const finalStandingsPointsScope = reviewedFinalStandingsPointsProgramScope(program);
  const exactPoints = finalStandingsPointsScope !== null;
  const ordered = program.root.op === 'rank' ? rows : [...rows].sort((left, right) => {
    const leftId = requiredString(left.driver_id, 'driver_id');
    const rightId = requiredString(right.driver_id, 'driver_id');
    return exactPoints ? compareText(leftId, rightId) : leftId.localeCompare(rightId);
  });
  if (finalStandingsPointsScope && finalStandingsPointsScope.driver_ids.length > 0) {
    const returnedDriverIds = ordered.map(row => requiredString(row.driver_id, 'driver_id'));
    if (!sameStrings(returnedDriverIds, finalStandingsPointsScope.driver_ids)) {
      throw new AnswerFormatError('Filtered final standings drivers were invalid');
    }
  }
  const completeStandings = current || (program.root.op === 'rank' && program.root.limit === 30 &&
    program.root.input.op === 'aggregate' && program.root.input.input.op === 'filter' &&
    program.root.input.input.where.driver_id === undefined);
  if (completeStandings) {
    const positions = ordered.map(row => requiredPosition(row.championship_position, 'championship_position'));
    if (positions.some((position, index) => position !== index + 1)) {
      throw new AnswerFormatError('Complete standings positions were invalid');
    }
  }
  const facts = ordered.map(row => ({
    subject: requiredString(row.driver_id, 'driver_id'),
    values: Object.fromEntries(aliases.map(alias => [alias, displayNumeric(row[alias], alias)]))
  }));
  const responseContract = standingsResponseContract(program, current, rows.length, collection);
  return {
    answer: { headline: current ? `Latest recorded ${capabilitySeason(program)} driver standings.` : `Final ${capabilitySeason(program)} driver standings result.`, facts },
    coverage: responseContract.coverage,
    caveats: [...responseContract.caveats]
  };
}

function standingsResponseContract(
  program: F1QLProgram,
  current: boolean,
  rowCount: number,
  collection: ResultCollectionEvidence
) {
  const finalStandingsPointsScope = current ? null : reviewedFinalStandingsPointsProgramScope(program);
  if (finalStandingsPointsScope) {
    return finalStandingsRowsResponseContract(
      rowCount,
      collection,
      finalStandingsPointsScope.driver_ids.length > 0
        ? finalStandingsPointsScope.driver_ids.length
        : undefined
    );
  }
  return { coverage: 'sufficient' as const, caveats: current ? ['season_in_progress'] : [] as string[] };
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

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredNonnegativeNumeric(value: unknown, field: string): string {
  const displayed = displayNumeric(value, field);
  if (displayed === null || displayed.startsWith('-')) {
    throw new AnswerFormatError(`Invalid ${field} value`);
  }
  return displayed;
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
  return field === 'finishing_position' || field === 'points' || field === 'qualifying_position' || field === 'best_time_ms';
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
