import { createHash } from 'crypto';

export const ANSWER_QUESTION_CONTRACT_VERSION = 'answer-question-v4' as const;
export const ANSWER_QUESTION_MAX_CHARS = 1_000;
export const ANSWER_QUESTION_MAX_UTF8_BYTES = 3_000;

export type AnswerQuestionSourceCue = 'standings' | 'race_classification' | 'qualifying_classification' | 'race_date';
export type AnswerQuestionSessionCue = 'race' | 'qualifying' | 'sprint';
export type AnswerQuestionMetricCue = 'points' | 'official_leader' | 'date';
export type AnswerQuestionActionCue = 'all';
export type AnswerQuestionStatusCue = 'classified' | 'dnf' | 'dns' | 'dsq' | 'not_classified' | 'withdrawn';
export type AnswerQuestionUnsupportedCue = 'sprint' | 'grid' | 'constructor' | 'pace' | 'team' | 'interim' | 'multiseason';

export interface AnswerQuestionMention<T extends string | number> {
  readonly value: T;
  /** Inclusive offset in Unicode code points within normalized_question. */
  readonly start: number;
  /** Exclusive offset in Unicode code points within normalized_question. */
  readonly end: number;
  readonly text: string;
}

export type AnswerQuestionOutcome =
  | { readonly type: 'inspection_required' }
  | { readonly type: 'clarification_required'; readonly reason: 'season_missing' | 'session_ambiguous' }
  | { readonly type: 'rejected'; readonly reason: 'sprint_source_unsupported' | 'grid_source_unsupported' | 'constructor_source_unsupported' | 'pace_source_disabled' | 'team_filter_unsupported' | 'interim_standings_unsupported' | 'temporal_scope_unsupported' | 'capability_unsupported' };

export interface AnswerQuestionContract {
  readonly version: typeof ANSWER_QUESTION_CONTRACT_VERSION;
  readonly normalized_question: string;
  readonly char_count: number;
  readonly utf8_byte_count: number;
  readonly sha256: string;
  readonly years: readonly AnswerQuestionMention<number>[];
  readonly rounds: readonly AnswerQuestionMention<number>[];
  readonly event_cues: readonly AnswerQuestionMention<string>[];
  readonly source_cues: readonly AnswerQuestionMention<AnswerQuestionSourceCue>[];
  readonly session_cues: readonly AnswerQuestionMention<AnswerQuestionSessionCue>[];
  readonly metric_cues: readonly AnswerQuestionMention<AnswerQuestionMetricCue>[];
  readonly action_cues: readonly AnswerQuestionMention<AnswerQuestionActionCue>[];
  readonly status_cues: readonly AnswerQuestionMention<AnswerQuestionStatusCue>[];
  readonly unsupported_cues: readonly AnswerQuestionMention<AnswerQuestionUnsupportedCue>[];
  readonly outcome: AnswerQuestionOutcome;
}

export type AnswerQuestionErrorCode = 'question_not_string' | 'question_empty' | 'question_control_character' | 'question_too_many_chars' | 'question_too_many_bytes';

export class AnswerQuestionError extends Error {
  constructor(readonly code: AnswerQuestionErrorCode) {
    super(code);
    this.name = 'AnswerQuestionError';
  }
}

interface CuePattern<T extends string> {
  readonly value: T;
  readonly pattern: RegExp;
}

const SOURCE_PATTERNS: readonly CuePattern<AnswerQuestionSourceCue>[] = [
  { value: 'standings', pattern: /\b(?:driver\s+)?standings\b|\bchampionship\s+(?:points|leader|standing|standings)\b/giu },
  { value: 'race_classification', pattern: /\brace\s+(?:classification|result|results)\b|\bfinishing\s+(?:order|position)\b/giu },
  { value: 'qualifying_classification', pattern: /\bqualifying\s+(?:classification|result|results|order)\b/giu },
  { value: 'race_date', pattern: /\b(?:race|grand\s+prix)\s+date\b/giu }
];

const SESSION_PATTERNS: readonly CuePattern<AnswerQuestionSessionCue>[] = [
  { value: 'race', pattern: /\brace\b/giu },
  { value: 'qualifying', pattern: /\bqualifying\b|\bquali\b/giu },
  { value: 'sprint', pattern: /\bsprint\b/giu }
];

const METRIC_PATTERNS: readonly CuePattern<AnswerQuestionMetricCue>[] = [
  { value: 'points', pattern: /\bpoints?\b/giu },
  { value: 'official_leader', pattern: /\b(?:championship|standings)\s+leader\b|\bwho\s+(?:led|won)\s+(?:the\s+)?(?:(?:19[5-9]\d|20\d{2}|2100)\s+)?(?:driver\s+)?(?:championship|standings)\b/giu },
  { value: 'date', pattern: /\b(?:date|what\s+day|when\s+(?:was|is|did))\b/giu }
];

const ACTION_PATTERNS: readonly CuePattern<AnswerQuestionActionCue>[] = [
  { value: 'all', pattern: /\ball\b(?!\s+(?:DNFs?|DNSs?|DSQs?|classified|not[-\s]+classified|withdr(?:awn|ew)))|\b(?:full|complete)\s+(?:(?:race|qualifying)\s+)?(?:classification|result|results|order|drivers?)\b/giu }
];

const STATUS_PATTERNS: readonly CuePattern<AnswerQuestionStatusCue>[] = [
  { value: 'not_classified', pattern: /\bnot[-\s]+classified\b/giu },
  { value: 'classified', pattern: /\bclassified\b/giu },
  { value: 'dnf', pattern: /\bDNFs?\b|\bdid\s+not\s+finish\b/giu },
  { value: 'dns', pattern: /\bDNSs?\b|\bdid\s+not\s+start\b/giu },
  { value: 'dsq', pattern: /\bDSQs?\b|\bdisqualified\b/giu },
  { value: 'withdrawn', pattern: /\bwithdr(?:awn|ew)\b/giu }
];

const TEAM_NAME_PATTERN = /\b(?:scuderia\s+ferrari|ferrari|mclaren|mercedes(?:-amg)?|red\s+bull(?:\s+racing)?|visa\s+cash\s+app\s+rb|rb\s+f1\s+team|vcarb|racing\s+bulls|aston\s+martin|alpine|williams|haas|stake\s+f1\s+team\s+kick\s+sauber|kick\s+sauber|sauber|audi|cadillac|team\s+lotus|lotus|renault|benetton|brabham\s+racing\s+organisation|tyrrell|force\s+india|racing\s+point|alpha\s*tauri|toro\s+rosso|brawn(?:\s+gp)?|jordan\s+grand\s+prix|jordan|minardi|toyota|bmw\s+sauber|bmw|alfa\s+romeo|bar\s+honda|british\s+american\s+racing|honda(?:\s+racing\s+f1\s+team)?|jaguar|arrows|ligier|prost\s+grand\s+prix|march\s+engineering|cooper\s+car\s+company|brm|matra|maserati|vanwall|kurtis\s+kraft)\b/giu;

const ROUND_NUMBER = '(?:\\d{1,2}(?:st|nd|rd|th)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth)';
const EVENT_NAME = '(?:Australian|Chinese|Japanese|Bahrain|Saudi\\s+Arabian|Miami|Emilia[- ]Romagna|Monaco|Spanish|Canadian|Austrian|British|Belgian|Hungarian|Dutch|Italian|Azerbaijan|Singapore|United\\s+States|Mexico\\s+City|S(?:a|ã)o\\s+Paulo|Las\\s+Vegas|Qatar|Abu\\s+Dhabi|French|German|European|Portuguese|Turkish|Russian|Malaysian|Indian|Korean|South\\s+African|Argentine|Detroit|Pacific|San\\s+Marino|Melbourne|Shanghai|Suzuka|Jeddah|Imola|Barcelona|Montreal|Spielberg|Silverstone|Spa(?:-Francorchamps)?|Budapest|Zandvoort|Monza|Baku|Austin|Mexico|Interlagos|Lusail|Yas\\s+Marina)';
const EVENT_PATTERN = new RegExp(`\\b${EVENT_NAME}(?:\\s+(?:grand\\s+prix|gp))?\\b`, 'giu');
const INTERIM_STANDINGS_PATTERN = new RegExp(
  `\\b(?:current|live|ongoing|so\\s+far|mid[-\\s]?season)\\b|\\b(?:as[-\\s]+of|after|before|through|up[-\\s]+to|at)\\s+(?:(?:round\\s+${ROUND_NUMBER})|(?:(?:the\\s+)?${ROUND_NUMBER}\\s+rounds?)|(?:the\\s+)?${EVENT_NAME}(?:\\s+(?:grand\\s+prix|gp))?)\\b`,
  'giu'
);

const UNSUPPORTED_PATTERNS: readonly CuePattern<Exclude<AnswerQuestionUnsupportedCue, 'interim' | 'multiseason'>>[] = [
  { value: 'sprint', pattern: /\bsprint\b/giu },
  { value: 'grid', pattern: /\bstarting\s+grid\b|\bgrid\s+(?:position|positions|order)\b/giu },
  { value: 'constructor', pattern: /\bconstructor(?:s|'s)?\b/giu },
  { value: 'pace', pattern: /\bpace\b|\blap\s+time(?:s)?\b/giu },
  { value: 'team', pattern: /\bteam(?:s|'s)?\b/giu },
  { value: 'team', pattern: TEAM_NAME_PATTERN }
];

export function createAnswerQuestionContract(input: unknown): AnswerQuestionContract {
  if (typeof input !== 'string') {
    throw new AnswerQuestionError('question_not_string');
  }
  const nfkc = input.normalize('NFKC');
  if (containsControlCharacter(nfkc)) {
    throw new AnswerQuestionError('question_control_character');
  }
  const normalized = nfkc.trim();
  if (normalized.length === 0) {
    throw new AnswerQuestionError('question_empty');
  }
  const charCount = Array.from(normalized).length;
  if (charCount > ANSWER_QUESTION_MAX_CHARS) {
    throw new AnswerQuestionError('question_too_many_chars');
  }
  const byteCount = Buffer.byteLength(normalized, 'utf8');
  if (byteCount > ANSWER_QUESTION_MAX_UTF8_BYTES) {
    throw new AnswerQuestionError('question_too_many_bytes');
  }

  const years = extractNumbers(normalized, /\b(?:19[5-9]\d|20\d{2}|2100)\b/gu);
  const rounds = extractRounds(normalized);
  const eventCues = extractLiteralCues(normalized, EVENT_PATTERN);
  const sourceCues = extractCues(normalized, SOURCE_PATTERNS);
  const sessionCues = extractCues(normalized, SESSION_PATTERNS);
  const metricCues = extractCues(normalized, METRIC_PATTERNS);
  const actionCues = extractCues(normalized, ACTION_PATTERNS);
  const statusCues = removeContainedStatusCues(extractCues(normalized, STATUS_PATTERNS));
  const unsupportedCues: AnswerQuestionMention<AnswerQuestionUnsupportedCue>[] = extractCues(normalized, UNSUPPORTED_PATTERNS);
  const instructionalIntent = hasInstructionalIntentMention(normalized, sourceCues, sessionCues, metricCues, actionCues, statusCues);

  const standings = sourceCues.some(cue => cue.value === 'standings');
  const interimMatch = standings ? firstMatch(normalized, INTERIM_STANDINGS_PATTERN) : undefined;
  if (interimMatch) {
    unsupportedCues.push(toMention('interim', interimMatch));
  } else if (standings && (rounds.length > 0 || eventCues.length > 0)) {
    const qualifier = [...rounds, ...eventCues].sort((left, right) => left.start - right.start)[0];
    unsupportedCues.push({ value: 'interim', start: qualifier.start, end: qualifier.end, text: qualifier.text });
  }
  if (new Set(years.map(year => year.value)).size > 1) {
    const first = years[0];
    const end = years[years.length - 1].end;
    unsupportedCues.push({ value: 'multiseason', start: first.start, end, text: sliceCodePoints(normalized, first.start, end) });
  } else {
    const multiseasonMatch = firstMatch(normalized, /\b(?:multiple|several|all)\s+seasons\b|\b(?:last|past|previous)\s+\d+\s+seasons\b|\b\d{4}\s*(?:-|\u2013)\s*\d{2}\b/giu);
    if (multiseasonMatch) {
      unsupportedCues.push(toMention('multiseason', multiseasonMatch));
    }
  }

  const contract: AnswerQuestionContract = {
    version: ANSWER_QUESTION_CONTRACT_VERSION,
    normalized_question: normalized,
    char_count: charCount,
    utf8_byte_count: byteCount,
    sha256: createHash('sha256').update(normalized, 'utf8').digest('hex'),
    years,
    rounds,
    event_cues: eventCues,
    source_cues: sourceCues,
    session_cues: sessionCues,
    metric_cues: metricCues,
    action_cues: actionCues,
    status_cues: statusCues,
    unsupported_cues: sortMentions(unsupportedCues),
    outcome: determineOutcome(years, sourceCues, sessionCues, statusCues, unsupportedCues, instructionalIntent)
  };
  return deepFreeze(contract);
}

function removeContainedStatusCues(cues: AnswerQuestionMention<AnswerQuestionStatusCue>[]): AnswerQuestionMention<AnswerQuestionStatusCue>[] {
  return cues.filter(cue => !cues.some(other => other !== cue && other.start <= cue.start && other.end >= cue.end));
}

function determineOutcome(
  years: readonly AnswerQuestionMention<number>[],
  sources: readonly AnswerQuestionMention<AnswerQuestionSourceCue>[],
  sessions: readonly AnswerQuestionMention<AnswerQuestionSessionCue>[],
  statuses: readonly AnswerQuestionMention<AnswerQuestionStatusCue>[],
  unsupported: readonly AnswerQuestionMention<AnswerQuestionUnsupportedCue>[],
  instructionalIntent: boolean
): AnswerQuestionOutcome {
  const rejected: Partial<Record<AnswerQuestionUnsupportedCue, Extract<AnswerQuestionOutcome, { type: 'rejected' }>['reason']>> = {
    sprint: 'sprint_source_unsupported', grid: 'grid_source_unsupported', constructor: 'constructor_source_unsupported',
    pace: 'pace_source_disabled', team: 'team_filter_unsupported', interim: 'interim_standings_unsupported', multiseason: 'temporal_scope_unsupported'
  };
  for (const cue of sortMentions(unsupported)) {
    return { type: 'rejected', reason: rejected[cue.value] as Extract<AnswerQuestionOutcome, { type: 'rejected' }>['reason'] };
  }
  if (instructionalIntent) {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  const sessionSet = new Set(sessions.map(cue => cue.value).filter(value => value !== 'sprint'));
  if (sessionSet.has('race') && sessionSet.has('qualifying')) {
    return { type: 'clarification_required', reason: 'session_ambiguous' };
  }
  if (sources.length > 0 && years.length === 0) {
    return { type: 'clarification_required', reason: 'season_missing' };
  }
  const classificationSource = sources.some(cue => cue.value === 'race_classification' || cue.value === 'qualifying_classification');
  if (statuses.length > 0 && !classificationSource && !sessionSet.has('race') && !sessionSet.has('qualifying')) {
    return { type: 'clarification_required', reason: 'session_ambiguous' };
  }
  return { type: 'inspection_required' };
}

function hasInstructionalIntentMention(
  question: string,
  sources: readonly AnswerQuestionMention<AnswerQuestionSourceCue>[],
  sessions: readonly AnswerQuestionMention<AnswerQuestionSessionCue>[],
  metrics: readonly AnswerQuestionMention<AnswerQuestionMetricCue>[],
  actions: readonly AnswerQuestionMention<AnswerQuestionActionCue>[],
  statuses: readonly AnswerQuestionMention<AnswerQuestionStatusCue>[]
): boolean {
  if (sources.length + sessions.length + metrics.length + actions.length + statuses.length === 0) {
    return false;
  }
  if (/\b(?:do\s+not|don't|dont|never|no\s+need\s+to)\b/iu.test(question)) {
    return true;
  }
  if (/\b(?:ignore|disregard|override|forget)\b\s+(?:(?:all|any|the|these|those)\s+)?(?:(?:previous|prior|system|developer)\s+){0,3}(?:instructions?|prompts?|rules?)\b/iu.test(question)) {
    return true;
  }

  const promptLike = /\b(?:show|give|return|answer|tell|list|who|what|when|where)\b[\s\S]*\b(?:standings|championship|race|qualifying|results?|classification|points?|date|DNFs?|DNSs?|DSQs?)\b/iu;
  const quotedSegments = [
    ...question.matchAll(/"([^"\r\n]{1,300})"/gu),
    ...question.matchAll(/“([^”\r\n]{1,300})”/gu),
    ...question.matchAll(/'([^'\r\n]{1,300})'/gu),
    ...question.matchAll(/`([^`\r\n]{1,300})`/gu)
  ];
  if (quotedSegments.some(match => promptLike.test(match[1] ?? ''))) {
    return true;
  }
  return /\b(?:prompts?|instructions?|rules?|examples?|quoted?\s+text|user\s+(?:said|asked)|question\s+(?:said|asked))\b[\s:,-]{0,12}/iu.test(question) && promptLike.test(question);
}

function extractNumbers(question: string, pattern: RegExp): AnswerQuestionMention<number>[] {
  return [...question.matchAll(pattern)].map(match => {
    const start = codePointOffset(question, match.index);
    return { value: Number(match[0]), start, end: start + Array.from(match[0]).length, text: match[0] };
  });
}

function extractLiteralCues(question: string, pattern: RegExp): AnswerQuestionMention<string>[] {
  return [...question.matchAll(pattern)].map(match => toMention(match[0], match));
}

function extractRounds(question: string): AnswerQuestionMention<number>[] {
  const mentions: AnswerQuestionMention<number>[] = [];
  for (const match of question.matchAll(/\b(?:round|rd\.?|r)\s*#?\s*(\d{1,2})\b/giu)) {
    const numberText = match[1];
    if (numberText === undefined || match.index === undefined) {
      continue;
    }
    const relative = match[0].lastIndexOf(numberText);
    const start = codePointOffset(question, match.index + relative);
    mentions.push({ value: Number(numberText), start, end: start + Array.from(numberText).length, text: numberText });
  }
  return sortMentions(mentions);
}

function extractCues<T extends string>(question: string, patterns: readonly CuePattern<T>[]): AnswerQuestionMention<T>[] {
  const mentions = patterns.flatMap(({ value, pattern }) => [...question.matchAll(pattern)].map(match => toMention(value, match)));
  return sortMentions(mentions);
}

function firstMatch(question: string, pattern: RegExp): RegExpMatchArray | undefined {
  return question.matchAll(pattern).next().value;
}

function toMention<T extends string>(value: T, match: RegExpMatchArray): AnswerQuestionMention<T> {
  if (match.index === undefined) {
    throw new Error('Regex match did not include an index');
  }
  const start = codePointOffset(match.input ?? '', match.index);
  return { value, start, end: start + Array.from(match[0]).length, text: match[0] };
}

function sortMentions<T extends string | number>(mentions: readonly AnswerQuestionMention<T>[]): AnswerQuestionMention<T>[] {
  const sorted = [...mentions].sort((left, right) => left.start - right.start || right.end - left.end || compareText(String(left.value), String(right.value)));
  return sorted.filter((mention, index) => !sorted.slice(0, index).some(previous => previous.start === mention.start && previous.value === mention.value));
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
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

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function codePointOffset(value: string, utf16Offset: number): number {
  return Array.from(value.slice(0, utf16Offset)).length;
}

function sliceCodePoints(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join('');
}
