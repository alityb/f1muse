import { F1QLProgramCandidate, isNamedEventProgram } from './translation-schema';

export type FasterQuestionContract =
  | { type: 'none' }
  | { type: 'classification'; session: 'race' | 'qualifying'; season?: number; event_reference?: string }
  | { type: 'clarification'; reason: 'season_missing' | 'event_ambiguous' | 'entity_ambiguous' | 'metric_ambiguous'; question: string; options?: string[] }
  | { type: 'unsupported'; reason: 'capability_unsupported' }
  | { type: 'event_mean'; season: number; event_reference: string }
  | { type: 'window_median'; season: number; event_reference: string; lap_start: number; lap_end: number };

const FASTER = /\b(?:faster|quicker|better\s+race\s+pace|average\s+race\s+pace|mean\s+race\s+pace)\b/iu;
const MEDIAN = /\bmedian\b/iu;
const EVENT_MEAN = /\b(?:average|mean|better)\s+race\s+pace\b/iu;
const AVERAGE_LAP_TIME = /\b(?:average|mean)\s+lap\s+times?\b/iu;
const RACE_PACE = /\brace\s+pace\b/iu;
const GENERIC_PACE = /\bpace\b/iu;
const LAP_TIME = /\blap\s+times?\b/iu;
const AMBIGUOUS_COMPARATIVE = /\b(?:fastest|quickest|better)\b/iu;
const FASTEST_LAP = /\b(?:fastest|quickest|best)(?:\s+[\p{L}-]+){0,2}\s+lap\b/iu;
const FASTER_LAP = /\b(?:faster|quicker)(?:\s+[\p{L}-]+){0,2}\s+lap\b/iu;
const CARDINAL_LAP = /(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)/iu;
const ORDINAL_LAP = /(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))/iu;
const SINGLE_LAP_REFERENCE = new RegExp(`\\b(?:on\\s+)?lap(?:\\s+number)?\\s+(?:\\d{1,3}|${CARDINAL_LAP.source})\\b|\\b(?:the\\s+)?(?:final|opening|last|penultimate|[1-9]\\d?(?:st|nd|rd|th)|${ORDINAL_LAP.source})\\s+lap\\b`, 'iu');
const NON_RACE_SESSION = /\b(?:sprint|practice|fp[1-3]|q[1-3]|qualifying|quali|qualy)\b/iu;
const POSITIONAL = /\b(?:finished|finishing|finish|classified|classification|qualif(?:y|ied|ying)|placed|position|results?|ahead\s+in\s+the\s+results?)\b/iu;
const QUALIFYING_POSITIONAL = /\b(?:qualif(?:y|ied|ying)|quali|qualy|q[1-3]|grid)\b/iu;
const DRIVER_COMPARISON = /\b(?:vs\.?|versus|than|compare\b.+\b(?:with|and)|between\b.+\band)\b/iu;
const STANDINGS = /\b(?:standings|championship)\b/iu;
const EVENT = /\b(?:Australia(?:n)?|China|Chinese|Japan(?:ese)?|Bahrain|Saudi\s+Arabia(?:n)?|Miami|Emilia[- ]Romagna|Monaco|Spain|Spanish|Canada|Canadian|Austria|Austrian|Britain|British|Belgium|Belgian|Hungary|Hungarian|Netherlands|Dutch|Italy|Italian|Azerbaijan|Singapore|United\s+States|Mexico|S(?:a|ã)o\s+Paulo|Las\s+Vegas|Qatar|Abu\s+Dhabi|France|French|Germany|German|Europe(?:an)?|Portugal|Portuguese|Turkey|Turkish|Russia|Russian|Malaysia|Malaysian|India|Indian|Korea|Korean|South\s+Africa(?:n)?|Argentina|Argentine|Detroit|Pacific|San\s+Marino|Melbourne|Shanghai|Suzuka|Jeddah|Imola|Barcelona|Montreal|Spielberg|Silverstone|Spa(?:-Francorchamps)?|Budapest|Zandvoort|Monza|Baku|Austin|Interlagos|Lusail|Yas\s+Marina)(?:\s+(?:Grand\s+Prix|GP))?\b/iu;
const GENERIC_EVENT = /\b[A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,2}\s+(?:Grand\s+Prix|GP)\b/gu;

export function inspectFasterQuestion(question: string): FasterQuestionContract {
  const hasMedian = MEDIAN.test(question);
  const hasMean = EVENT_MEAN.test(question) || AVERAGE_LAP_TIME.test(question);
  const hasFaster = FASTER.test(question);
  const hasRacePace = RACE_PACE.test(question);
  const hasGenericPace = GENERIC_PACE.test(question);
  const hasLapTime = LAP_TIME.test(question);
  const bounds = extractLapBounds(question);
  const genericPaceComparison = hasGenericPace && DRIVER_COMPARISON.test(question) && EVENT.test(question);
  const years = [...question.matchAll(/\b(?:19[5-9]\d|20\d{2}|2100)\b/gu)].map(match => Number(match[0]));
  const events = distinctMatches(question, EVENT, GENERIC_EVENT);
  if (FASTEST_LAP.test(question)) {
    return { type: 'unsupported', reason: 'capability_unsupported' };
  }
  const hasPaceSemantics = hasMedian || hasMean || hasFaster || hasRacePace || genericPaceComparison || hasLapTime || bounds !== undefined;
  if (hasPaceSemantics && STANDINGS.test(question)) {
    return metricClarification();
  }
  if (hasPaceSemantics && (NON_RACE_SESSION.test(question) || SINGLE_LAP_REFERENCE.test(question) || (FASTER_LAP.test(question) && !AVERAGE_LAP_TIME.test(question)))) {
    return { type: 'unsupported', reason: 'capability_unsupported' };
  }
  if (!hasPaceSemantics) {
    if (STANDINGS.test(question)) {
      return { type: 'none' };
    }
    if (POSITIONAL.test(question) || (QUALIFYING_POSITIONAL.test(question) && /\bahead\b/iu.test(question))) {
      return {
        type: 'classification',
        session: QUALIFYING_POSITIONAL.test(question) ? 'qualifying' : 'race',
        ...(new Set(years).size === 1 ? { season: years[0] } : {}),
        ...(events.length === 1 ? { event_reference: events[0] } : {})
      };
    }
    return AMBIGUOUS_COMPARATIVE.test(question) || (EVENT.test(question) && DRIVER_COMPARISON.test(question)) ? metricClarification() : { type: 'none' };
  }
  if (POSITIONAL.test(question) && (hasMedian || hasMean || hasFaster)) {
    return metricClarification();
  }
  if ((hasMedian && hasMean) || (bounds !== undefined && !hasMedian) || (hasMedian && bounds === undefined)) {
    return metricClarification();
  }
  if (hasLapTime && !hasFaster && !hasMean && !hasMedian) {
    return metricClarification();
  }
  if (genericPaceComparison && !hasRacePace && !hasFaster && !hasMean && !hasMedian) {
    return metricClarification();
  }
  if (new Set(years).size !== 1) {
    return { type: 'clarification', reason: 'season_missing', question: 'Which season did you mean?' };
  }
  if (events.length !== 1) {
    return { type: 'clarification', reason: 'event_ambiguous', question: 'Which race event did you mean?' };
  }
  const withoutBounds = question.replace(/\bbetween\s+laps?\s+\d{1,3}\s+and\s+\d{1,3}\b/giu, '');
  const alternatives = withoutBounds.match(/\b(?:or|and|vs\.?|versus|than|with)\b/giu) ?? [];
  const threeNameList = /\b[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}\s*,\s*[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}\s*,?\s*(?:or|and)\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}\b/iu.test(question);
  if (alternatives.length !== 1 || threeNameList) {
    return { type: 'clarification', reason: 'entity_ambiguous', question: 'Which two drivers did you mean?' };
  }
  const shared = { season: years[0], event_reference: events[0] };
  return hasMedian && bounds
    ? { type: 'window_median', ...shared, lap_start: bounds[0], lap_end: bounds[1] }
    : { type: 'event_mean', ...shared };
}

export function fasterCandidateMatchesQuestion(contract: FasterQuestionContract, _question: string, candidate: F1QLProgramCandidate): boolean {
  if (contract.type === 'none') {
    return candidate.root.op !== 'official_event_mean_compare' && candidate.root.op !== 'official_lap_window_median_compare';
  }
  if (contract.type === 'classification') {
    const sessionMatches = contract.session === 'race'
      ? candidate.root.op === 'event_classification'
      : candidate.root.op === 'qualifying_classification';
    if (!sessionMatches) {
      return false;
    }
    if (contract.season !== undefined || contract.event_reference !== undefined) {
      if (!isNamedEventProgram(candidate) ||
          (contract.season !== undefined && candidate.root.season !== contract.season) ||
          (contract.event_reference !== undefined && normalizeEventReference(candidate.root.event_name) !== normalizeEventReference(contract.event_reference))) {
        return false;
      }
    }
    const root = candidate.root;
    return (root.op !== 'event_classification' && root.op !== 'qualifying_classification') ||
      root.filters?.driver_id === undefined || literalTokenReference(_question, root.filters.driver_id);
  }
  if (contract.type !== 'event_mean' && contract.type !== 'window_median') {
    return true;
  }
  if (!isNamedEventProgram(candidate) || candidate.root.season !== contract.season ||
      normalizeEventReference(candidate.root.event_name) !== normalizeEventReference(contract.event_reference)) {
    return false;
  }
  const root = candidate.root;
  if (root.op !== 'official_event_mean_compare' && root.op !== 'official_lap_window_median_compare') {
    return false;
  }
  if (!literalComparisonPair(_question, root.driver_a_id, root.driver_b_id)) {
    return false;
  }
  if (contract.type === 'event_mean') {
    return root.op === 'official_event_mean_compare';
  }
  return root.op === 'official_lap_window_median_compare' && root.lap_start === contract.lap_start && root.lap_end === contract.lap_end;
}

export function legacyFasterQuestionRefusal(question: string): { code: string; reason: string; suggestion: string } | undefined {
  const contract = inspectFasterQuestion(question);
  if (contract.type === 'none' || contract.type === 'classification') {
    return undefined;
  }
  if (contract.type === 'clarification') {
    return { code: 'semantic_clarification_required', reason: contract.question, suggestion: 'Specify one event, one season, exactly two drivers, and the intended statistic.' };
  }
  if (contract.type === 'event_mean' || contract.type === 'window_median') {
    return { code: 'semantic_route_required', reason: 'Official race-pace semantics are not executed by the legacy natural-language route.', suggestion: 'Use the F1QL translation workflow for this explicitly defined metric.' };
  }
  return { code: 'semantic_capability_unsupported', reason: 'The requested statistic is not supported.', suggestion: 'Ask for average race pace, a finishing result, or an explicit median lap window.' };
}

function extractLapBounds(question: string): [number, number] | undefined {
  const match = /\blaps?\s+(\d{1,3})\s*(?:-|–|to|through)\s*(\d{1,3})\b|\bbetween\s+laps?\s+(\d{1,3})\s+and\s+(\d{1,3})\b/iu.exec(question);
  if (!match) {
    return undefined;
  }
  return [Number(match[1] ?? match[3]), Number(match[2] ?? match[4])];
}

function normalizeWords(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeEventReference(value: string): string {
  const normalized = normalizeWords(value).replace(/\b(?:grand prix|gp)\b/gu, '').replace(/\s+/gu, ' ').trim();
  return EVENT_ALIASES[normalized] ?? normalized;
}

const EVENT_ALIASES: Readonly<Record<string, string>> = {
  australian: 'australia', chinese: 'china', japanese: 'japan', 'saudi arabian': 'saudi arabia', spanish: 'spain',
  canadian: 'canada', austrian: 'austria', british: 'britain', belgian: 'belgium', hungarian: 'hungary',
  dutch: 'netherlands', italian: 'italy', mexican: 'mexico', french: 'france', german: 'germany', european: 'europe',
  portuguese: 'portugal', turkish: 'turkey', russian: 'russia', malaysian: 'malaysia', indian: 'india', korean: 'korea',
  'south african': 'south africa', argentine: 'argentina'
};

function literalTokenReference(question: string, reference: string): boolean {
  const normalizedQuestion = ` ${normalizeWords(question)} `;
  const referenceTokens = normalizeWords(reference).split(' ').filter(token => token.length >= 3);
  if (referenceTokens.every(token => normalizedQuestion.includes(` ${token} `))) {
    return true;
  }
  return referenceTokens.some(token => normalizedQuestion.includes(` ${token} `) && !hasAdjacentNameToken(question, token));
}

function literalComparisonPair(question: string, driverA: string, driverB: string): boolean {
  const normalizedQuestion = normalizeWords(question);
  const a = escapeRegExp(normalizeWords(driverA));
  const b = escapeRegExp(normalizeWords(driverB));
  if (!a || !b) {
    return false;
  }
  const direct = (left: string, right: string) => new RegExp(`\\b${left}\\b\\s+(?:or|and|vs|versus|with)\\s+\\b${right}\\b`, 'u').test(normalizedQuestion);
  const comparative = (left: string, right: string) => new RegExp(`\\b${left}\\b(?:\\s+[a-z0-9]+){0,8}\\s+than\\s+\\b${right}\\b`, 'u').test(normalizedQuestion);
  return direct(a, b) || direct(b, a) || comparative(a, b) || comparative(b, a);
}

function hasAdjacentNameToken(question: string, token: string): boolean {
  const words = [...question.matchAll(/[\p{L}'-]+/gu)].map(match => match[0]);
  return words.some((word, index) => normalizeWords(word) === token &&
    [words[index - 1], words[index + 1]].some(adjacent => adjacent !== undefined &&
      !DRIVER_MENTION_CONTEXT.has(normalizeWords(adjacent))));
}

const DRIVER_MENTION_CONTEXT = new Set([
  'a', 'at', 'did', 'do', 'does', 'finish', 'finished', 'finishing', 'in', 'place', 'placed', 'position',
  'qualify', 'qualified', 'qualifying', 'result', 'results', 'the', 'was', 'what', 'where', 'who'
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function distinctMatches(question: string, ...patterns: RegExp[]): string[] {
  const matches = patterns.flatMap(pattern => [...question.matchAll(new RegExp(pattern.source, pattern.flags.includes('i') ? 'giu' : 'gu'))].map(match => match[0]));
  return [...new Map(matches.map(match => [normalizeWords(match), match])).values()];
}

function metricClarification(): Extract<FasterQuestionContract, { type: 'clarification' }> {
  return {
    type: 'clarification',
    reason: 'metric_ambiguous',
    question: 'Do you mean all-event average race pace, fastest lap, finishing result, or a median over an explicit lap window?',
    options: ['Average race pace', 'Fastest lap', 'Finishing result', 'Median lap window']
  };
}
