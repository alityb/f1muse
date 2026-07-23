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
  if (rows.length === 0) {
    return {
      answer: { headline: 'No matching source rows were available.', facts: [] },
      coverage: 'empty',
      caveats: ['empty_result_is_not_zero']
    };
  }
  if (capability.source === 'final_driver_standings') {
    return formatStandings(program, rows);
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

function formatStandings(program: F1QLProgram, rows: Array<Record<string, unknown>>) {
  if (program.root.op !== 'aggregate' && program.root.op !== 'rank') {
    throw new AnswerFormatError('Standings capability did not match program');
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const aliases = aggregate.measures.map(measure => measure.as);
  const ordered = program.root.op === 'rank' ? rows : [...rows].sort((left, right) => requiredString(left.driver_id, 'driver_id').localeCompare(requiredString(right.driver_id, 'driver_id')));
  const facts = ordered.map(row => ({
    subject: requiredString(row.driver_id, 'driver_id'),
    values: Object.fromEntries(aliases.map(alias => [alias, displayNumeric(row[alias], alias)]))
  }));
  return {
    answer: { headline: `Final ${capabilitySeason(program)} driver standings result.`, facts },
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
  const facts = rows.map(row => ({
    subject: requiredString(row.driver_id, 'driver_id'),
    values: Object.fromEntries(keys.map(key => [key, isNumericClassificationField(key) ? displayNumeric(row[key], key) : displayText(row[key], key)]))
  }));
  const possiblyTruncated = root.filters?.driver_id === undefined && rows.length === root.limit;
  return {
    answer: { headline: `${kind === 'race' ? 'Race' : 'Qualifying'} classification for ${root.season} round ${root.round}.`, facts },
    coverage: possiblyTruncated ? 'possibly_truncated' as const : 'sufficient' as const,
    caveats: possiblyTruncated ? [`classification_limited_to_${root.limit}_rows`] : []
  };
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
