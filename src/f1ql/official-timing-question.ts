import { createHash } from 'node:crypto';
import {
  ANSWER_QUESTION_MAX_CHARS,
  ANSWER_QUESTION_MAX_UTF8_BYTES,
  AnswerQuestionError
} from './answer-question';

export const OFFICIAL_TIMING_QUESTION_PARSER_VERSION = 'official-timing-question-parser-v1' as const;
export const OFFICIAL_TIMING_EVENT_NAME = '2022 Belgian Grand Prix' as const;
export const OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID = 'official_non_deleted_non_pit_event_mean_v1' as const;
export const OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID = 'official_non_deleted_non_pit_window_median_v1' as const;
export const OFFICIAL_TIMING_MAXIMUM_INCLUSIVE_WINDOW_LAPS = 50;
const DRIVER_TEXT_MAX_CODE_POINTS = 60;
const DRIVER_TEXT_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

export const OFFICIAL_TIMING_QUESTION_REFUSAL_REASONS = [
  'ambiguous_or_missing_event', 'ambiguous_or_missing_season', 'clean_air', 'classification',
  'causal_performance', 'constructor_or_team', 'contradictory_metric', 'control_or_instruction_text',
  'driver_cardinality_not_two', 'explicit_exclusion_override', 'fastest_or_single_lap', 'fuel',
  'generic_pace', 'grid', 'interim_or_latest', 'malformed_or_oversized_lap_range',
  'multiple_sessions', 'multiseason', 'negation', 'practice', 'qualifying', 'safety_car',
  'same_driver', 'sprint', 'strategy', 'traffic', 'tyre', 'unconsumed_filler', 'weather'
] as const;

export type OfficialTimingQuestionRefusalReason = (typeof OFFICIAL_TIMING_QUESTION_REFUSAL_REASONS)[number];

export interface OfficialTimingQuestionSpan {
  /** Inclusive offset in Unicode code points within normalized_question. */
  readonly start: number;
  /** Exclusive offset in Unicode code points within normalized_question. */
  readonly end: number;
  readonly text: string;
}

export interface OfficialTimingQuestionMatch {
  readonly type: 'matched';
  readonly parser_version: typeof OFFICIAL_TIMING_QUESTION_PARSER_VERSION;
  readonly metric_id: typeof OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID | typeof OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID;
  readonly pattern_id: string;
  readonly normalized_question: string;
  readonly question_sha256: string;
  readonly driver_a: OfficialTimingQuestionSpan;
  readonly driver_b: OfficialTimingQuestionSpan;
  readonly event_span: OfficialTimingQuestionSpan;
  readonly season_span: OfficialTimingQuestionSpan;
  readonly operation_span: OfficialTimingQuestionSpan;
  readonly lap_range: {
    readonly lap_start: number;
    readonly lap_end: number;
    readonly start_span: OfficialTimingQuestionSpan;
    readonly end_span: OfficialTimingQuestionSpan;
  } | null;
}

export interface OfficialTimingQuestionRefusal {
  readonly type: 'refused';
  readonly parser_version: typeof OFFICIAL_TIMING_QUESTION_PARSER_VERSION;
  readonly reason: OfficialTimingQuestionRefusalReason;
  readonly normalized_question: string;
  readonly question_sha256: string;
}

export type OfficialTimingQuestionParse = OfficialTimingQuestionMatch | OfficialTimingQuestionRefusal;

interface RefusalPattern {
  readonly reason: OfficialTimingQuestionRefusalReason;
  readonly pattern: RegExp;
}

// Deterministic refusal precedence: control text and explicit semantic overrides first,
// topical prohibitions next, scope identity last, grammar match only after every refusal check.
const REFUSAL_PATTERNS: readonly RefusalPattern[] = [
  { reason: 'control_or_instruction_text', pattern: /\b(?:ignore|disregard|override|forget)\b|\b(?:previous|prior|system|developer)\s+instructions?\b|\b(?:prompts?|rules?)\b|\bdo\s+not\b|\bnever\s+(?:answer|tell|use)\b/iu },
  { reason: 'explicit_exclusion_override', pattern: /\b(?:exclude|excluding|excluded|except(?:\s+for)?|other\s+than|apart\s+from|save\s+for|all\s+but|without|don['’]t\s+include)\b/iu },
  { reason: 'negation', pattern: /\b(?:not|never|no)\b/iu },
  { reason: 'multiple_sessions', pattern: /\brace\b[\s\S]*\b(?:qualifying|practice|sprint)\b|\b(?:qualifying|practice|sprint)\b[\s\S]*\brace\b/iu },
  { reason: 'practice', pattern: /\bpractice\b|\bfp[123]\b/iu },
  { reason: 'qualifying', pattern: /\bqualifying\b|\bquali\b/iu },
  { reason: 'sprint', pattern: /\bsprint\b/iu },
  { reason: 'multiseason', pattern: /\b(?:19[5-9]\d|20\d{2}|2100)\b[\s\S]*\b(?:19[5-9]\d|20\d{2}|2100)\b|\b(?:multiple|several|all)\s+seasons\b|\bseasons\b/iu },
  { reason: 'interim_or_latest', pattern: /\b(?:latest|current(?:ly)?|recent(?:ly)?|so\s+far|live|ongoing)\b/iu },
  { reason: 'classification', pattern: /\bclassification\b|\bfinishing\s+(?:order|position)\b|\bresults?\b/iu },
  { reason: 'grid', pattern: /\bgrid\b/iu },
  { reason: 'fastest_or_single_lap', pattern: /\bfastest\b|\bquickest\b|\bsingle\s+lap\b|\bbest\s+lap\b|\blap\s+record\b|\bone\s+lap\b/iu },
  { reason: 'generic_pace', pattern: /\bpace\b/iu },
  { reason: 'clean_air', pattern: /\bclean[-\s]air\b/iu },
  { reason: 'causal_performance', pattern: /\b(?:because|why|caus(?:e|ed|ing)|due\s+to|thanks\s+to)\b/iu },
  { reason: 'constructor_or_team', pattern: /\bconstructors?\b|\bteams?\b|\b(?:ferrari|mclaren|mercedes|red\s+bull|williams|alpine|aston\s+martin|haas|sauber|racing\s+bulls|alphatauri|alpha\s*tauri)\b/iu },
  { reason: 'fuel', pattern: /\bfuel\b/iu },
  { reason: 'safety_car', pattern: /\bsafety\s+car\b|\bvsc\b|\bred\s+flag\b|\byellow\s+flag\b/iu },
  { reason: 'strategy', pattern: /\bstrateg(?:y|ies|ic)\b|\bundercut\b|\bovercut\b|\bpit\s+stop/iu },
  { reason: 'traffic', pattern: /\btraffic\b|\bslipstream\b|\bdirty\s+air\b|\bdrs\b/iu },
  { reason: 'tyre', pattern: /\btyres?\b|\btires?\b|\bcompounds?\b|\bsofts?\b|\bmediums?\b|\bhards?\b|\bintermediates?\b|\bwets\b/iu },
  { reason: 'weather', pattern: /\bweather\b|\brain(?:y|ing|ed)?\b|\bwet\b|\bdry\b|\btemperature\b|\bwind(?:y)?\b|\bhumid/iu }
];

const BELGIAN_EVENT_PATTERN = /\b2022\s+belgian\s+grand\s+prix\b/iu;
const ANY_GRAND_PRIX_PATTERN = /\bgrand\s+prix\b|\bgp\b/iu;
const ANY_YEAR_PATTERN = /\b(?:19[5-9]\d|20\d{2}|2100)\b/u;
const MEAN_PATTERN = /\b(?:mean|average)\b/iu;
const MEDIAN_PATTERN = /\bmedian\b/iu;
const LAP_WINDOW_SHAPE_PATTERN = /\bover\s+laps?\b/iu;

const DRIVER_GROUP = '([\\p{L}\\p{M}][\\p{L}\\p{M} .\'’-]{0,80}?)';
const LAP_GROUP = '(\\d{1,3})';
const EVENT_GROUP = '(2022\\s+belgian\\s+grand\\s+prix)';

interface GrammarPattern {
  readonly pattern_id: string;
  readonly metric_id: OfficialTimingQuestionMatch['metric_id'];
  readonly regex: RegExp;
  readonly lap_range: boolean;
  readonly operation_text: string;
}

const GRAMMAR: readonly GrammarPattern[] = [
  {
    pattern_id: 'event_mean_who_faster',
    metric_id: OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
    regex: new RegExp(
      `^(who\\s+was\\s+faster)\\s+between\\s+${DRIVER_GROUP}\\s+and\\s+${DRIVER_GROUP}\\s+at\\s+the\\s+${EVENT_GROUP}\\s*[?.]?$`,
      'diu'
    ),
    lap_range: false,
    operation_text: 'who was faster'
  },
  {
    pattern_id: 'event_mean_compare_mean',
    metric_id: OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
    regex: new RegExp(
      `^(compare)\\s+${DRIVER_GROUP}\\s+and\\s+${DRIVER_GROUP}\\s+by\\s+official\\s+mean\\s+race\\s+lap\\s+time\\s+at\\s+the\\s+${EVENT_GROUP}\\s*[?.]?$`,
      'diu'
    ),
    lap_range: false,
    operation_text: 'compare'
  },
  {
    pattern_id: 'event_mean_compare_average',
    metric_id: OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
    regex: new RegExp(
      `^(compare)\\s+${DRIVER_GROUP}\\s+and\\s+${DRIVER_GROUP}\\s+by\\s+official\\s+average\\s+race\\s+lap\\s+time\\s+at\\s+the\\s+${EVENT_GROUP}\\s*[?.]?$`,
      'diu'
    ),
    lap_range: false,
    operation_text: 'compare'
  },
  {
    pattern_id: 'window_median_compare',
    metric_id: OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
    regex: new RegExp(
      `^(compare)\\s+the\\s+official\\s+median\\s+race\\s+lap\\s+time\\s+of\\s+${DRIVER_GROUP}\\s+and\\s+${DRIVER_GROUP}\\s+over\\s+laps\\s+${LAP_GROUP}\\s+to\\s+${LAP_GROUP}\\s+at\\s+the\\s+${EVENT_GROUP}\\s*[?.]?$`,
      'diu'
    ),
    lap_range: true,
    operation_text: 'compare'
  },
  {
    pattern_id: 'window_median_who_faster',
    metric_id: OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
    regex: new RegExp(
      `^(who\\s+was\\s+faster\\s+by\\s+official\\s+median\\s+race\\s+lap\\s+time)\\s+between\\s+${DRIVER_GROUP}\\s+and\\s+${DRIVER_GROUP}\\s+over\\s+laps\\s+${LAP_GROUP}\\s+to\\s+${LAP_GROUP}\\s+at\\s+the\\s+${EVENT_GROUP}\\s*[?.]?$`,
      'diu'
    ),
    lap_range: true,
    operation_text: 'who was faster by official median race lap time'
  }
];

export function parseOfficialTimingQuestion(input: unknown): OfficialTimingQuestionParse {
  const normalized = normalizeQuestion(input);
  const questionHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const refuse = (reason: OfficialTimingQuestionRefusalReason): OfficialTimingQuestionRefusal =>
    deepFreeze({
      type: 'refused',
      parser_version: OFFICIAL_TIMING_QUESTION_PARSER_VERSION,
      reason,
      normalized_question: normalized,
      question_sha256: questionHash
    });

  const topical = firstTopicalRefusal(normalized);
  if (topical) {
    return refuse(topical);
  }
  const scope = scopeRefusal(normalized);
  if (scope) {
    return refuse(scope);
  }
  for (const pattern of GRAMMAR) {
    const match = pattern.regex.exec(normalized);
    if (match) {
      const built = buildMatch(normalized, questionHash, pattern, match);
      return built.type === 'matched' ? built : refuse(built.reason);
    }
  }
  if (/\bbetween\b/iu.test(normalized) && !/\band\b/iu.test(normalized)) {
    return refuse('driver_cardinality_not_two');
  }
  return refuse('unconsumed_filler');
}

function firstTopicalRefusal(normalized: string): OfficialTimingQuestionRefusalReason | undefined {
  for (const { reason, pattern } of REFUSAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return reason;
    }
  }
  return undefined;
}

function scopeRefusal(normalized: string): OfficialTimingQuestionRefusalReason | undefined {
  if (MEAN_PATTERN.test(normalized) && MEDIAN_PATTERN.test(normalized)) {
    return 'contradictory_metric';
  }
  if (MEDIAN_PATTERN.test(normalized) && LAP_WINDOW_SHAPE_PATTERN.test(normalized) &&
      !GRAMMAR.some(pattern => pattern.lap_range && pattern.regex.test(normalized))) {
    return 'malformed_or_oversized_lap_range';
  }
  if (!ANY_YEAR_PATTERN.test(normalized) || !/\b2022\b/u.test(normalized)) {
    return 'ambiguous_or_missing_season';
  }
  if (!BELGIAN_EVENT_PATTERN.test(normalized) ||
      ANY_GRAND_PRIX_PATTERN.test(normalized.replace(BELGIAN_EVENT_PATTERN, ' '))) {
    return 'ambiguous_or_missing_event';
  }
  return undefined;
}

function normalizeQuestion(input: unknown): string {
  if (typeof input !== 'string') {
    throw new AnswerQuestionError('question_not_string');
  }
  const nfkc = input.normalize('NFKC');
  if (Array.from(nfkc).some(character => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    throw new AnswerQuestionError('question_control_character');
  }
  const normalized = nfkc.trim();
  if (normalized.length === 0) {
    throw new AnswerQuestionError('question_empty');
  }
  if (Array.from(normalized).length > ANSWER_QUESTION_MAX_CHARS) {
    throw new AnswerQuestionError('question_too_many_chars');
  }
  if (Buffer.byteLength(normalized, 'utf8') > ANSWER_QUESTION_MAX_UTF8_BYTES) {
    throw new AnswerQuestionError('question_too_many_bytes');
  }
  return normalized;
}

interface GrammarGroups {
  readonly operation: number;
  readonly driver_a: number;
  readonly driver_b: number;
  readonly lap_start?: number;
  readonly lap_end?: number;
  readonly event: number;
}

type SpanReader = (group: number) => OfficialTimingQuestionSpan;

function buildMatch(
  normalized: string,
  questionHash: string,
  pattern: GrammarPattern,
  match: RegExpExecArray
): OfficialTimingQuestionMatch | { readonly type: 'refusal'; readonly reason: OfficialTimingQuestionRefusalReason } {
  const indices = (match as unknown as { indices?: Array<[number, number] | undefined> }).indices;
  if (!indices) {
    throw new Error('FAIL_CLOSED: official timing grammar requires regex match indices');
  }
  const groups: GrammarGroups = pattern.lap_range
    ? { operation: 1, driver_a: 2, driver_b: 3, lap_start: 4, lap_end: 5, event: 6 }
    : { operation: 1, driver_a: 2, driver_b: 3, event: 4 };
  const span: SpanReader = group => {
    const range = indices[group];
    if (!range) {
      throw new Error('FAIL_CLOSED: official timing grammar capture group missing');
    }
    const start = codePointOffset(normalized, range[0]);
    const end = codePointOffset(normalized, range[1]);
    return { start, end, text: sliceCodePoints(normalized, start, end) };
  };
  const driverA = span(groups.driver_a);
  const driverB = span(groups.driver_b);
  if (!isValidDriverSpan(driverA) || !isValidDriverSpan(driverB)) {
    return { type: 'refusal', reason: 'driver_cardinality_not_two' };
  }
  if (driverA.text.toLocaleLowerCase('en-US') === driverB.text.toLocaleLowerCase('en-US')) {
    return { type: 'refusal', reason: 'same_driver' };
  }
  const lapRange = pattern.lap_range ? buildLapRange(groups, match, span) : null;
  if (lapRange !== null && 'reason' in lapRange) {
    return { type: 'refusal', reason: lapRange.reason };
  }
  const eventSpan = span(groups.event);
  const seasonStart = codePointOffset(normalized, normalized.indexOf('2022', (indices[groups.event]?.[0] ?? 0)));
  return deepFreeze({
    type: 'matched',
    parser_version: OFFICIAL_TIMING_QUESTION_PARSER_VERSION,
    metric_id: pattern.metric_id,
    pattern_id: pattern.pattern_id,
    normalized_question: normalized,
    question_sha256: questionHash,
    driver_a: driverA,
    driver_b: driverB,
    event_span: eventSpan,
    season_span: { start: seasonStart, end: seasonStart + 4, text: '2022' },
    operation_span: span(groups.operation),
    lap_range: lapRange
  });
}

function isValidDriverSpan(span: OfficialTimingQuestionSpan): boolean {
  return span.text.length > 0 && Array.from(span.text).length <= DRIVER_TEXT_MAX_CODE_POINTS &&
    DRIVER_TEXT_PATTERN.test(span.text) && !/\band\b/iu.test(span.text);
}

function buildLapRange(
  groups: GrammarGroups,
  match: RegExpExecArray,
  span: SpanReader
): OfficialTimingQuestionMatch['lap_range'] | { readonly reason: 'malformed_or_oversized_lap_range' } {
  if (groups.lap_start === undefined || groups.lap_end === undefined) {
    throw new Error('FAIL_CLOSED: official timing lap grammar lacks lap groups');
  }
  const lapStart = Number(match[groups.lap_start]);
  const lapEnd = Number(match[groups.lap_end]);
  if (!Number.isSafeInteger(lapStart) || !Number.isSafeInteger(lapEnd) || lapStart < 1 ||
      lapEnd < lapStart || lapEnd - lapStart + 1 > OFFICIAL_TIMING_MAXIMUM_INCLUSIVE_WINDOW_LAPS) {
    return { reason: 'malformed_or_oversized_lap_range' };
  }
  return {
    lap_start: lapStart,
    lap_end: lapEnd,
    start_span: span(groups.lap_start),
    end_span: span(groups.lap_end)
  };
}

function codePointOffset(value: string, utf16Offset: number): number {
  return Array.from(value.slice(0, utf16Offset)).length;
}

function sliceCodePoints(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join('');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
