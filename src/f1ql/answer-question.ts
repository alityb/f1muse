import { createHash } from 'crypto';

export const ANSWER_QUESTION_CONTRACT_VERSION = 'answer-question-v18' as const;
export const ANSWER_QUESTION_MAX_CHARS = 1_000;
export const ANSWER_QUESTION_MAX_UTF8_BYTES = 3_000;

export type AnswerQuestionSourceCue = 'standings' | 'race_classification' | 'qualifying_classification' | 'race_date';
export type AnswerQuestionSessionCue = 'race' | 'qualifying' | 'sprint';
export type AnswerQuestionMetricCue = 'points' | 'official_leader' | 'latest_recorded' | 'official_season_summary' | 'official_career_summary' | 'date';
export type AnswerQuestionActionCue = 'all';
export type AnswerQuestionStatusCue = 'classified' | 'dnf' | 'dns' | 'dsq' | 'not_classified' | 'withdrawn';
export type AnswerQuestionResultCue = 'race_winner' | 'race_podium' | 'race_top_n' | 'race_exact_position' | 'qualifying_pole' | 'qualifying_top_n' | 'qualifying_exact_position';
export type AnswerQuestionUnsupportedCue = 'sprint' | 'grid' | 'constructor' | 'pace' | 'team' | 'interim' | 'multiseason' | 'capability';

export interface AnswerQuestionMention<T extends string | number> {
  readonly value: T;
  /** Inclusive offset in Unicode code points within normalized_question. */
  readonly start: number;
  /** Exclusive offset in Unicode code points within normalized_question. */
  readonly end: number;
  readonly text: string;
}

export interface AnswerQuestionResultMention extends AnswerQuestionMention<AnswerQuestionResultCue> {
  readonly position?: number;
}

export type AnswerQuestionOutcome =
  | { readonly type: 'inspection_required' }
  | { readonly type: 'clarification_required'; readonly reason: 'season_missing' | 'session_ambiguous' | 'metric_ambiguous' }
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
  readonly result_cues: readonly AnswerQuestionResultMention[];
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
  { value: 'standings', pattern: /\b(?:driver\s+)?standings\b|\b(?:driver\s+)?championship\b|\bdriver\s+champion\b|\bwho\s+was\s+(?:the\s+)?(?:final\s+)?(?:19[5-9]\d|20\d{2}|2100)\s+(?:driver\s+)?champion\b/giu },
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
  { value: 'official_leader', pattern: /\b(?:championship|standings)\s+(?:champion|leader)\b|\bdriver\s+champion\b|\bwho\b[^.?!]{0,80}\bchampion\b|\bwho\s+(?:led|won)\s+(?:the\s+)?(?:(?:19[5-9]\d|20\d{2}|2100)\s+)?(?:driver\s+)?(?:championship|standings)\b/giu },
  { value: 'latest_recorded', pattern: /\blatest\s+recorded\b/giu },
  { value: 'official_season_summary', pattern: /\bofficial\s+(?:19[5-9]\d|20\d{2}|2100)\s+(?:season|driver)\s+summary\b/giu },
  { value: 'official_career_summary', pattern: /\bofficial\s+career\s+summary\b/giu },
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

const ROUND_NUMBER = '(?:\\d{1,2}(?:st|nd|rd|th)?|twenty[- ](?:one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
const ROUND_REFERENCE_PATTERN = new RegExp(`\\b(?:round|rd\\.?|r)\\s*#?\\s*(${ROUND_NUMBER})\\b|\\b(?:the\\s+)?(${ROUND_NUMBER})\\s+round\\b`, 'giu');
const EVENT_NAME = '(?:Australian|Chinese|Japanese|Bahrain|Saudi\\s+Arabian|Miami|Emilia[- ]Romagna|Monaco|Spanish|Canadian|Austrian|British|Belgian|Hungarian|Dutch|Italian|Azerbaijan|Singapore|United\\s+States|Mexico\\s+City|S(?:a|ã)o\\s+Paulo|Las\\s+Vegas|Qatar|Abu\\s+Dhabi|French|German|European|Portuguese|Turkish|Russian|Malaysian|Indian|Korean|South\\s+African|Argentine|Detroit|Pacific|San\\s+Marino|Melbourne|Shanghai|Suzuka|Jeddah|Imola|Barcelona|Montreal|Spielberg|Silverstone|Spa(?:-Francorchamps)?|Budapest|Zandvoort|Monza|Baku|Austin|Mexico|Interlagos|Lusail|Yas\\s+Marina)';
const EVENT_PATTERN = new RegExp(`\\b${EVENT_NAME}(?:\\s+(?:grand\\s+prix|gp))?\\b`, 'giu');
const INTERIM_STANDINGS_PATTERN = new RegExp(
  `\\b(?:current|live|ongoing|so\\s+far|mid[-\\s]?season)\\b|\\bas[-\\s]+of\\b|\\b(?:after|before|through|up[-\\s]+to)\\s+(?:today|yesterday|now|currently|date)\\b|\\b(?:after|before|through|up[-\\s]+to|at)\\s+(?:(?:round\\s+${ROUND_NUMBER})|(?:(?:the\\s+)?${ROUND_NUMBER}\\s+rounds?)|(?:the\\s+)?${EVENT_NAME}(?:\\s+(?:grand\\s+prix|gp))?)\\b`,
  'giu'
);

const BOUNDED_NUMBER_TOKEN = '(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const CARDINAL_NUMBER_TOKEN = '(?:\\d{1,3}|twenty[- ](?:one|two|three|four|five|six|seven|eight|nine)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)';
const GENERIC_RESULT_ENTITY_NOUN = '(?:drivers?|results?|entries|entry|positions?|finishers?|cars?|rows?)';
const GENERIC_CARDINALITY_PATTERN = new RegExp(
  `\\b${CARDINAL_NUMBER_TOKEN}\\s+(?:(?:race|qualifying|standings|championship)\\s+)?${GENERIC_RESULT_ENTITY_NOUN}\\b`
    + `|\\b${GENERIC_RESULT_ENTITY_NOUN}\\s+(?:(?:for|of)\\s+)?${CARDINAL_NUMBER_TOKEN}\\b`,
  'giu'
);
const EXPLICIT_RANK_TOKEN = '(?:\\d{1,3}(?:st|nd|rd|th)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteenth|seventeenth|eighteenth|nineteenth|twenty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|last)';
const RANK_CARDINALITY_ADJECTIVE = '(?:top|bottom|first|last|highest|lowest|best|worst|leading|trailing)';
const UNSUPPORTED_ORDER_CARDINALITY_PATTERN = new RegExp(
  `\\b(?:${RANK_CARDINALITY_ADJECTIVE}[-\\s]+${BOUNDED_NUMBER_TOKEN}|${BOUNDED_NUMBER_TOKEN}[-\\s]+${RANK_CARDINALITY_ADJECTIVE})\\b`
    + `|\\b(?:place|position|rank(?:ed)?)\\s*(?:number\\s*)?#?\\s*${EXPLICIT_RANK_TOKEN}\\b`
    + `|\\b${EXPLICIT_RANK_TOKEN}[-\\s]+(?:place|position|rank(?:ed)?)\\b`
    + `|\\b(?:finished|finish|came|placed|qualified|was)\\s+(?:in\\s+)?${EXPLICIT_RANK_TOKEN}\\b`
    + `|\\b${EXPLICIT_RANK_TOKEN}\\s+in\\s+(?:(?:the|final)\\s+)?(?:standings|classification)\\b`
    + `|\\brunner[-\\s]?up\\b`
    + `|\\b(?:highest|lowest|best|worst)\\b[^.?!]{0,60}\\b(?:standings|points?|results?)\\b`
    + `|\\b(?:standings|points?|results?)\\b[^.?!]{0,60}\\b(?:highest|lowest|best|worst)\\b`
    + `|\\b(?:standings|classification)\\b[^.?!]{0,40}\\bP\\s*\\d{1,2}\\b|\\bP\\s*\\d{1,2}\\b[^.?!]{0,40}\\b(?:standings|classification)\\b`
    + `|\\bpodium(?:\\s+(?:finishers?|places?|positions?|results?))?\\b`,
  'giu'
);
// Exclusions are never inverted safely; even harmless "without" phrasing fails closed before model inspection.
const EXCLUSION_MARKER_PATTERN = /\b(?:exclude|excluding|excluded|except(?:\s+for)?|other\s+than|apart\s+from|save\s+for|with\s+the\s+exception\s+of|all\s+but|without|do\s+not\s+include|don['’]t\s+include)\b/giu;

const UNSUPPORTED_PATTERNS: readonly CuePattern<Exclude<AnswerQuestionUnsupportedCue, 'interim' | 'multiseason'>>[] = [
  { value: 'sprint', pattern: /\bsprint\b/giu },
  { value: 'grid', pattern: /\bstarting\s+grid\b|\bgrid\s+(?:position|positions|order)\b/giu },
  { value: 'constructor', pattern: /\bconstructor(?:s|'s)?\b/giu },
  { value: 'pace', pattern: /\bpace\b|\blap\s+time(?:s)?\b|\b(?:faster|fastest|quicker|quickest|speed)\b/giu },
  { value: 'team', pattern: /\bteam(?:s|'s)?\b/giu },
  { value: 'team', pattern: TEAM_NAME_PATTERN },
  { value: 'capability', pattern: /\bnon[-\s]*(?:DNFs?|DNSs?)\b/giu },
  { value: 'capability', pattern: EXCLUSION_MARKER_PATTERN },
  { value: 'capability', pattern: /\balso\s+add\b|\bsubstitute\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}(?=[.,;?!]|$)|(?:^|[;.!?]\s+)omit\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}(?=[.,;?!]|$)|\bbut\s+use\s+[^.?!]{1,100}(?=[.?!]|$)|\bbut\s+return\s+(?:classified|not[-\s]+classified|DNFs?|DNSs?|DSQs?|withdrawn)\s+drivers?\b/giu }
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
  const resultCues = extractResultCues(normalized);
  const unsupportedCues: AnswerQuestionMention<AnswerQuestionUnsupportedCue>[] = [
    ...extractCues(normalized, UNSUPPORTED_PATTERNS)
  ];
  const orderMatch = firstMatch(maskMentionSpans(normalized, resultCues), UNSUPPORTED_ORDER_CARDINALITY_PATTERN);
  if (orderMatch) {
    unsupportedCues.push(toMention('capability', orderMatch));
  }
  const remainingResultRank = resultCues.length === 0 ? undefined : firstMatch(
    maskMatches(maskMentionSpans(maskRoundReferences(normalized), resultCues), /\bformula\s+(?:1|one)\b/giu),
    new RegExp(`\\b${EXPLICIT_RANK_TOKEN}\\b`, 'giu')
  );
  if (remainingResultRank) {
    unsupportedCues.push(toMention('capability', remainingResultRank));
  }
  const bareNotMatch = firstMatch(maskSupportedNotPhrases(normalized), /\bnot\b/giu);
  if (bareNotMatch) {
    unsupportedCues.push(toMention('capability', bareNotMatch));
  }
  const cardinalityMatch = firstMatch(maskMentionSpans(maskRoundReferences(normalized), resultCues), GENERIC_CARDINALITY_PATTERN);
  if (cardinalityMatch) {
    unsupportedCues.push(toMention('capability', cardinalityMatch));
  }
  const instructionalIntent = hasInstructionalIntentMention(normalized, sourceCues, sessionCues, metricCues, actionCues, statusCues, resultCues);

  const standings = sourceCues.some(cue => cue.value === 'standings');
  const interimMatch = standings ? firstMatch(normalized, INTERIM_STANDINGS_PATTERN) : undefined;
  if (interimMatch) {
    unsupportedCues.push(toMention('interim', interimMatch));
  } else if (standings && (rounds.length > 0 || eventCues.length > 0)) {
    const qualifier = [...rounds, ...eventCues].sort((left, right) => left.start - right.start)[0];
    unsupportedCues.push({ value: 'interim', start: qualifier.start, end: qualifier.end, text: qualifier.text });
  }
  const latestRecorded = metricCues.some(cue => cue.value === 'latest_recorded');
  const finalLatestMatch = standings && latestRecorded ? firstMatch(normalized, /\bfinal\b/giu) : undefined;
  if (finalLatestMatch) {
    unsupportedCues.push(toMention('capability', finalLatestMatch));
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
    result_cues: resultCues,
    unsupported_cues: sortMentions(unsupportedCues),
    outcome: determineOutcome(normalized, years, sourceCues, sessionCues, metricCues, actionCues, statusCues, resultCues, unsupportedCues, instructionalIntent)
  };
  return deepFreeze(contract);
}

function removeContainedStatusCues(cues: AnswerQuestionMention<AnswerQuestionStatusCue>[]): AnswerQuestionMention<AnswerQuestionStatusCue>[] {
  return cues.filter(cue => !cues.some(other => other !== cue && other.start <= cue.start && other.end >= cue.end));
}

function determineOutcome(
  question: string,
  years: readonly AnswerQuestionMention<number>[],
  sources: readonly AnswerQuestionMention<AnswerQuestionSourceCue>[],
  sessions: readonly AnswerQuestionMention<AnswerQuestionSessionCue>[],
  metrics: readonly AnswerQuestionMention<AnswerQuestionMetricCue>[],
  actions: readonly AnswerQuestionMention<AnswerQuestionActionCue>[],
  statuses: readonly AnswerQuestionMention<AnswerQuestionStatusCue>[],
  results: readonly AnswerQuestionResultMention[],
  unsupported: readonly AnswerQuestionMention<AnswerQuestionUnsupportedCue>[],
  instructionalIntent: boolean
): AnswerQuestionOutcome {
  const rejected: Partial<Record<AnswerQuestionUnsupportedCue, Extract<AnswerQuestionOutcome, { type: 'rejected' }>['reason']>> = {
    sprint: 'sprint_source_unsupported', grid: 'grid_source_unsupported', constructor: 'constructor_source_unsupported',
    pace: 'pace_source_disabled', team: 'team_filter_unsupported', interim: 'interim_standings_unsupported', multiseason: 'temporal_scope_unsupported',
    capability: 'capability_unsupported'
  };
  for (const cue of sortMentions(unsupported)) {
    return { type: 'rejected', reason: rejected[cue.value] as Extract<AnswerQuestionOutcome, { type: 'rejected' }>['reason'] };
  }
  if (instructionalIntent) {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  const sessionSet = new Set(sessions.map(cue => cue.value).filter(value => value !== 'sprint'));
  for (const result of results) {
    sessionSet.add(result.value.startsWith('race_') ? 'race' : 'qualifying');
  }
  if (sessionSet.has('race') && sessionSet.has('qualifying')) {
    return { type: 'clarification_required', reason: 'session_ambiguous' };
  }
  if ((sources.length > 0 || results.length > 0) && years.length === 0) {
    return { type: 'clarification_required', reason: 'season_missing' };
  }
  const classificationSource = sources.some(cue => cue.value === 'race_classification' || cue.value === 'qualifying_classification');
  if (statuses.length > 0 && !classificationSource && !sessionSet.has('race') && !sessionSet.has('qualifying')) {
    return { type: 'clarification_required', reason: 'session_ambiguous' };
  }
  if (/\bwho\s+was\s+better\b/iu.test(question) && sources.length + sessions.length + metrics.length + actions.length + statuses.length === 0) {
    return { type: 'clarification_required', reason: 'metric_ambiguous' };
  }
  return { type: 'inspection_required' };
}

function hasInstructionalIntentMention(
  question: string,
  sources: readonly AnswerQuestionMention<AnswerQuestionSourceCue>[],
  sessions: readonly AnswerQuestionMention<AnswerQuestionSessionCue>[],
  metrics: readonly AnswerQuestionMention<AnswerQuestionMetricCue>[],
  actions: readonly AnswerQuestionMention<AnswerQuestionActionCue>[],
  statuses: readonly AnswerQuestionMention<AnswerQuestionStatusCue>[],
  results: readonly AnswerQuestionResultMention[]
): boolean {
  if (sources.length + sessions.length + metrics.length + actions.length + statuses.length + results.length === 0) {
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

function extractResultCues(question: string): AnswerQuestionResultMention[] {
  const patterns: readonly { value: AnswerQuestionResultCue; pattern: RegExp; numbered?: boolean }[] = [
    { value: 'race_winner', pattern: /\bwho\s+won\b(?=[^.?!]{0,120}\b(?:grand\s+prix|gp|race)\b)/giu },
    { value: 'race_podium', pattern: /\bpodium(?:\s+(?:finishers?|places?|positions?|results?))?\b/giu },
    { value: 'race_top_n', pattern: new RegExp(`\\btop[-\\s]+(${CARDINAL_NUMBER_TOKEN})[-\\s]+finishers?\\b`, 'giu'), numbered: true },
    { value: 'race_exact_position', pattern: new RegExp(`\\bfinished\\s+(?:in\\s+)?(${EXPLICIT_RANK_TOKEN})\\b(?![-\\s]+(?:place|position|rank))`, 'giu'), numbered: true },
    { value: 'qualifying_pole', pattern: /\b(?:who\s+)?(?:took|take|takes|got|gets|secured|secures|claimed|claims|won)\s+pole\b|\bpole\s+sitter\b/giu },
    { value: 'qualifying_top_n', pattern: new RegExp(`\\btop[-\\s]+(${CARDINAL_NUMBER_TOKEN})[-\\s]+qualifiers?\\b`, 'giu'), numbered: true },
    { value: 'qualifying_exact_position', pattern: new RegExp(`\\bqualified\\s+(?:in\\s+)?(${EXPLICIT_RANK_TOKEN})\\b(?![-\\s]+(?:place|position|rank))`, 'giu'), numbered: true }
  ];
  const mentions = patterns.flatMap(({ value, pattern, numbered }) => [...question.matchAll(pattern)].flatMap(match => {
    const position = numbered ? parsePositionReference(match[1] ?? '') : undefined;
    if (numbered && position === undefined) {
      return [];
    }
    return [{ ...toMention(value, match), ...(position === undefined ? {} : { position }) }];
  }));
  return sortMentions(mentions) as AnswerQuestionResultMention[];
}

function parsePositionReference(reference: string): number | undefined {
  const normalized = reference.toLocaleLowerCase('en-US').replace(/-/gu, ' ').replace(/\s+/gu, ' ').trim();
  const digit = normalized.match(/^(\d{1,3})(?:st|nd|rd|th)?$/u);
  const value = digit ? Number(digit[1]) : ROUND_WORD_VALUES[normalized];
  return value !== undefined && value >= 1 && value <= 30 ? value : undefined;
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
  for (const match of question.matchAll(ROUND_REFERENCE_PATTERN)) {
    const numberText = match[1] ?? match[2];
    if (numberText === undefined || match.index === undefined) {
      continue;
    }
    const round = parseRoundReference(numberText);
    if (round === undefined) {
      continue;
    }
    const relative = match[0].lastIndexOf(numberText);
    const start = codePointOffset(question, match.index + relative);
    mentions.push({ value: round, start, end: start + Array.from(numberText).length, text: numberText });
  }
  return sortMentions(mentions);
}

export function parseRoundReference(reference: string): number | undefined {
  let token = reference.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  token = token.replace(/^the\s+/u, '');
  const prefixed = token.match(/^(?:round|rd\.?|r)\s*#?\s*(.+)$/u);
  if (prefixed) {
    token = prefixed[1];
  } else {
    const suffixed = token.match(/^(.+?)\s+round$/u);
    if (suffixed) {
      token = suffixed[1];
    }
  }
  const digit = token.match(/^(\d{1,2})(?:st|nd|rd|th)?$/u);
  if (digit) {
    const round = Number(digit[1]);
    return round >= 1 && round <= 30 ? round : undefined;
  }
  return ROUND_WORD_VALUES[token.replace(/-/gu, ' ').replace(/\s+/gu, ' ')];
}

const ROUND_WORD_VALUES: Readonly<Record<string, number>> = Object.freeze({
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10,
  eleven: 11, eleventh: 11, twelve: 12, twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
  fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18,
  nineteen: 19, nineteenth: 19, twenty: 20, twentieth: 20, 'twenty one': 21, 'twenty first': 21,
  'twenty two': 22, 'twenty second': 22, 'twenty three': 23, 'twenty third': 23, 'twenty four': 24, 'twenty fourth': 24,
  'twenty five': 25, 'twenty fifth': 25, 'twenty six': 26, 'twenty sixth': 26, 'twenty seven': 27, 'twenty seventh': 27,
  'twenty eight': 28, 'twenty eighth': 28, 'twenty nine': 29, 'twenty ninth': 29, thirty: 30, thirtieth: 30
});

function maskSupportedNotPhrases(question: string): string {
  return maskMatches(question, /\b(?:not[-\s]+classified|did\s+not\s+finish|did\s+not\s+start)\b/giu);
}

function maskRoundReferences(question: string): string {
  return maskMatches(question, ROUND_REFERENCE_PATTERN);
}

function maskMatches(value: string, pattern: RegExp): string {
  const characters = Array.from(value);
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }
    const start = codePointOffset(value, match.index);
    characters.fill(' ', start, start + Array.from(match[0]).length);
  }
  return characters.join('');
}

function maskMentionSpans(value: string, mentions: readonly Pick<AnswerQuestionMention<string | number>, 'start' | 'end'>[]): string {
  const characters = Array.from(value);
  for (const mention of mentions) {
    characters.fill(' ', mention.start, mention.end);
  }
  return characters.join('');
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
