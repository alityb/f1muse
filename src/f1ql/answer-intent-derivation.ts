import { AnswerIntent, LiteralMentionReference, parseAnswerIntent } from './answer-intent';
import { AnswerQuestionContract, AnswerQuestionMention } from './answer-question';

export const ANSWER_INTENT_DERIVATION_VERSION = 'answer-intent-derivation-v10' as const;

interface DriverInventoryMention {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface AnswerIntentInventoryResolver {
  inventoryMentions(question: string, season?: number): Promise<readonly DriverInventoryMention[]>;
}

const unsupported = { type: 'unsupported', reason: 'capability_unsupported' } as const;

export async function deriveAnswerIntent(
  contract: AnswerQuestionContract,
  resolver: AnswerIntentInventoryResolver
): Promise<AnswerIntent> {
  if (!Object.isFrozen(contract)) {
    return parseAnswerIntent(unsupported, contract);
  }
  const preserved = preservedOutcome(contract);
  if (preserved) {
    return parseAnswerIntent(preserved, contract);
  }
  if (containsGreekOrCyrillicLetter(contract.normalized_question)) {
    return parseAnswerIntent(unsupported, contract);
  }

  const metrics = new Set(contract.metric_cues.map(cue => cue.value));
  if (metrics.has('career_circuit_wins')) {
    const drivers = (await resolver.inventoryMentions(contract.normalized_question)).map(copyReference);
    return parseAnswerIntent(careerCircuitWinsIntent(contract, drivers, metrics), contract);
  }
  if (metrics.has('official_career_summary')) {
    const drivers = (await resolver.inventoryMentions(contract.normalized_question)).map(copyReference);
    return parseAnswerIntent(careerSummaryIntent(contract, drivers, metrics), contract);
  }
  const seasonMention = uniqueSeasonMention(contract);
  if (!seasonMention) {
    return parseAnswerIntent(unsupported, contract);
  }
  const seasonFields = { season: seasonMention.value, season_reference: copyReference(seasonMention) };
  const inventory = await resolver.inventoryMentions(contract.normalized_question, seasonMention.value);
  const drivers = inventory.filter(mention => !isSummaryStructureMention(contract, mention)).map(copyReference).sort(compareReferenceSpans);
  return parseAnswerIntent(selectIntent(contract, seasonFields, drivers), contract);
}

function careerCircuitWinsIntent(contract: AnswerQuestionContract, drivers: LiteralMentionReference[], metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>): unknown {
  const valid = contract.years.length === 0 && drivers.length === 1 && contract.source_cues.length === 0 && contract.session_cues.length === 0
    && only(metrics, 'career_circuit_wins') && contract.event_cues.length === 0 && contract.rounds.length === 0
    && contract.status_cues.length === 0 && contract.action_cues.length === 0 && contract.result_cues.length === 0
    && matchesCareerCircuitWinsQuestion(contract.normalized_question, drivers[0]);
  return valid ? { type: 'driver_career_wins_by_circuit', driver_reference: drivers[0] } : unsupported;
}

function careerSummaryIntent(
  contract: AnswerQuestionContract,
  drivers: LiteralMentionReference[],
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown {
  const valid = contract.years.length === 0 && drivers.length === 1 && contract.source_cues.length === 0 && contract.session_cues.length === 0
    && only(metrics, 'official_career_summary') && contract.event_cues.length === 0 && contract.rounds.length === 0
    && contract.status_cues.length === 0 && contract.action_cues.length === 0 && contract.result_cues.length === 0
    && matchesCareerSummaryQuestion(contract.normalized_question, drivers[0]);
  return valid ? { type: 'driver_career_official_summary', driver_reference: drivers[0] } : unsupported;
}

function preservedOutcome(contract: AnswerQuestionContract): unknown | undefined {
  if (contract.outcome.type === 'clarification_required') {
    return { type: 'clarification', reason: contract.outcome.reason };
  }
  if (contract.outcome.type === 'rejected') {
    return { type: 'unsupported', reason: contract.outcome.reason };
  }
  return undefined;
}

function uniqueSeasonMention(contract: AnswerQuestionContract): AnswerQuestionContract['years'][number] | undefined {
  const seasons = new Set(contract.years.map(mention => mention.value));
  return seasons.size === 1 ? contract.years[0] : undefined;
}

function selectIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[]
): unknown {
  const sources = new Set(contract.source_cues.map(cue => cue.value));
  const sessions = new Set(contract.session_cues.map(cue => cue.value));
  const metrics = new Set(contract.metric_cues.map(cue => cue.value));
  return seasonSummaryIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? raceH2HIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? qualifyingH2HIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? standingsIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? dateIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? resultPositionIntent(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? classificationSelection(contract, seasonFields, drivers, sources, sessions, metrics)
    ?? unsupported;
}

function qualifyingH2HIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (!metrics.has('qualifying_position_h2h')) {
    return undefined;
  }
  const valid = seasonFields.season <= 2025 && drivers.length === 2 && drivers[0].text !== drivers[1].text
    && sources.size === 0 && sessions.size === 0 && only(metrics, 'qualifying_position_h2h')
    && contract.event_cues.length === 0 && contract.rounds.length === 0 && contract.status_cues.length === 0
    && contract.action_cues.length === 0 && contract.result_cues.length === 0
    && matchesQualifyingH2HQuestion(contract.normalized_question, drivers);
  return valid ? { type: 'qualifying_season_position_h2h', ...seasonFields, driver_references: drivers } : unsupported;
}

function raceH2HIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (!metrics.has('race_finishing_position_h2h')) {
    return undefined;
  }
  const valid = seasonFields.season <= 2025 && drivers.length === 2 && drivers[0].text !== drivers[1].text
    && sources.size === 0 && sessions.size === 0 && only(metrics, 'race_finishing_position_h2h')
    && contract.event_cues.length === 0 && contract.rounds.length === 0 && contract.status_cues.length === 0
    && contract.action_cues.length === 0 && contract.result_cues.length === 0
    && matchesRaceH2HQuestion(contract.normalized_question, drivers);
  return valid ? { type: 'race_season_finishing_position_h2h', ...seasonFields, driver_references: drivers } : unsupported;
}

function seasonSummaryIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (!metrics.has('official_season_summary')) {
    return undefined;
  }
  const valid = seasonFields.season <= 2025 && drivers.length === 1 && sources.size === 0 && sessions.size === 0
    && only(metrics, 'official_season_summary') && contract.event_cues.length === 0 && contract.rounds.length === 0
    && contract.status_cues.length === 0 && contract.action_cues.length === 0 && contract.result_cues.length === 0
    && matchesSeasonSummaryQuestion(contract.normalized_question, drivers[0]);
  return valid ? { type: 'driver_season_official_summary', ...seasonFields, driver_reference: drivers[0] } : unsupported;
}

function resultPositionIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (contract.result_cues.length === 0) {
    return undefined;
  }
  if (contract.result_cues.length !== 1 || drivers.length !== 0 || contract.status_cues.length !== 0 ||
      contract.action_cues.length !== 0 || metrics.size !== 0) {
    return unsupported;
  }
  const cue = contract.result_cues[0];
  const session = cue.value.startsWith('race_') ? 'race' : 'qualifying';
  const expectedSource = session === 'race' ? 'race_classification' : 'qualifying_classification';
  if ((sources.size > 0 && !only(sources, expectedSource)) || (sessions.size > 0 && !only(sessions, session))) {
    return unsupported;
  }
  const event = uniqueEventReference(contract);
  if (!event) {
    return unsupported;
  }
  const selectionReference = copyReference(cue);
  return cue.position === undefined
    ? { type: cue.value, ...seasonFields, event_reference: event, selection_reference: selectionReference }
    : { type: cue.value, ...seasonFields, event_reference: event, position: cue.position, selection_reference: selectionReference };
}

function standingsIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (!isStandingsContext(contract, sources, sessions)) {
    return undefined;
  }
  if (only(metrics, 'latest_recorded')) {
    const unfiltered = seasonFields.season === 2026 && drivers.length === 0 && contract.status_cues.length === 0 && contract.action_cues.length === 0
      && /^(?:show the latest recorded 2026 driver standings|give the latest recorded driver standings for 2026)\.?$/iu.test(contract.normalized_question);
    return unfiltered ? { type: 'current_standings', ...seasonFields } : unsupported;
  }
  if (only(metrics, 'official_driver_ranking')) {
    const valid = seasonFields.season === 2025 && drivers.length === 3 && contract.status_cues.length === 0 && contract.action_cues.length === 0
      && contract.result_cues.length === 0 && matchesPinnedDriverRankingQuestion(contract.normalized_question);
    return valid ? { type: 'final_standings_driver_ranking', ...seasonFields, driver_references: drivers } : unsupported;
  }
  if (isPointsSelection(contract, drivers, metrics)) {
    return { type: 'final_standings_points', ...seasonFields, driver_references: drivers };
  }
  if (isLeaderSelection(contract, drivers, metrics)) {
    return { type: 'final_standings_leader', ...seasonFields };
  }
  return unsupported;
}

function matchesPinnedDriverRankingQuestion(question: string): boolean {
  return /^(?:Rank Verstappen, Norris, and Piastri by final 2025 championship position|Rank Verstappen, Norris, and Piastri by championship position in the final 2025 standings)\.$/u.test(question);
}

function isStandingsContext(
  contract: AnswerQuestionContract,
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>
): boolean {
  return only(sources, 'standings') && sessions.size === 0
    && contract.event_cues.length === 0 && contract.rounds.length === 0;
}

function isPointsSelection(
  contract: AnswerQuestionContract,
  drivers: LiteralMentionReference[],
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): boolean {
  const actionCompatible = contract.action_cues.length === 0 || drivers.length === 0;
  return only(metrics, 'points') && drivers.length <= 4 && contract.status_cues.length === 0 && !/\brank\b/iu.test(contract.normalized_question)
    && contract.action_cues.length <= 1 && actionCompatible;
}

function isLeaderSelection(
  contract: AnswerQuestionContract,
  drivers: LiteralMentionReference[],
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): boolean {
  return only(metrics, 'official_leader') && drivers.length === 0
    && contract.status_cues.length === 0 && contract.action_cues.length === 0;
}

function dateIntent(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (!isDateSelection(sources, sessions, metrics)) {
    return undefined;
  }
  const event = uniqueEventReference(contract);
  const unfiltered = drivers.length === 0 && contract.status_cues.length === 0 && contract.action_cues.length === 0;
  return event && unfiltered ? { type: 'race_date', ...seasonFields, event_reference: event } : unsupported;
}

function classificationSelection(
  contract: AnswerQuestionContract,
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  drivers: LiteralMentionReference[],
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): unknown | undefined {
  if (metrics.size !== 0) {
    return undefined;
  }
  const session = classificationSession(sources, sessions);
  const event = uniqueEventReference(contract);
  return session && event ? classificationIntent(session, seasonFields, event, drivers, contract) : unsupported;
}

function classificationIntent(
  session: 'race' | 'qualifying',
  seasonFields: { season: number; season_reference: LiteralMentionReference },
  event: LiteralMentionReference,
  drivers: LiteralMentionReference[],
  contract: AnswerQuestionContract
): unknown {
  const statuses = contract.status_cues;
  const actions = contract.action_cues;
  const prefix = session === 'race' ? 'race_classification' : 'qualifying_classification';
  if (isStatusSelection(statuses.length, drivers.length, actions.length)) {
    const status = statuses[0];
    return isPermittedStatus(session, status.value) ? {
      type: `${prefix}_status`, ...seasonFields, event_reference: event,
      status: status.value, status_reference: copyReference(status)
    } : unsupported;
  }
  if (isAllSelection(statuses.length, drivers.length, actions.length)) {
    return { type: `${prefix}_all`, ...seasonFields, event_reference: event };
  }
  if (isDriverSelection(statuses.length, drivers.length, actions.length)) {
    return { type: `${prefix}_driver`, ...seasonFields, event_reference: event, driver_reference: drivers[0] };
  }
  return unsupported;
}

function isStatusSelection(statuses: number, drivers: number, actions: number): boolean {
  return statuses === 1 && drivers === 0 && actions === 0;
}

function isAllSelection(statuses: number, drivers: number, actions: number): boolean {
  return actions === 1 && statuses === 0 && drivers === 0;
}

function isDriverSelection(statuses: number, drivers: number, actions: number): boolean {
  return drivers === 1 && statuses === 0 && actions === 0;
}

function isPermittedStatus(session: 'race' | 'qualifying', status: AnswerQuestionContract['status_cues'][number]['value']): boolean {
  return session === 'race' || status === 'classified' || status === 'dnf' || status === 'dns';
}

function classificationSession(
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>
): 'race' | 'qualifying' | undefined {
  const race = (sources.size === 0 || only(sources, 'race_classification')) && only(sessions, 'race');
  const qualifying = (sources.size === 0 || only(sources, 'qualifying_classification')) && only(sessions, 'qualifying');
  if (race === qualifying) {
    return undefined;
  }
  return race ? 'race' : 'qualifying';
}

function isDateSelection(
  sources: ReadonlySet<AnswerQuestionContract['source_cues'][number]['value']>,
  sessions: ReadonlySet<AnswerQuestionContract['session_cues'][number]['value']>,
  metrics: ReadonlySet<AnswerQuestionContract['metric_cues'][number]['value']>
): boolean {
  const trustedDate = only(metrics, 'date') || only(sources, 'race_date');
  return trustedDate
    && (sources.size === 0 || only(sources, 'race_date'))
    && (metrics.size === 0 || only(metrics, 'date'))
    && (sessions.size === 0 || only(sessions, 'race'));
}

function uniqueEventReference(contract: AnswerQuestionContract): LiteralMentionReference | undefined {
  if (contract.event_cues.length === 1 && contract.rounds.length === 0) {
    return copyReference(contract.event_cues[0]);
  }
  if (contract.rounds.length === 1 && contract.event_cues.length === 0) {
    return copyReference(contract.rounds[0]);
  }
  return undefined;
}

function only<T>(values: ReadonlySet<T>, expected: T): boolean {
  return values.size === 1 && values.has(expected);
}

function copyReference(mention: Pick<AnswerQuestionMention<string | number>, 'text' | 'start' | 'end'>): LiteralMentionReference {
  return { text: mention.text, start: mention.start, end: mention.end };
}

function compareReferenceSpans(left: LiteralMentionReference, right: LiteralMentionReference): number {
  return left.start - right.start || left.end - right.end;
}

function isSummaryStructureMention(contract: AnswerQuestionContract, mention: DriverInventoryMention): boolean {
  return mention.text.toLocaleLowerCase('en-US') === 'driver' && contract.metric_cues.some(cue =>
    cue.value === 'official_season_summary' && mention.start >= cue.start && mention.end <= cue.end);
}

function matchesSeasonSummaryQuestion(question: string, driver: LiteralMentionReference): boolean {
  const points = Array.from(question);
  const masked = [...points.slice(0, driver.start), '<driver>', ...points.slice(driver.end)].join('');
  return /^(?:show <driver> official (?:19[5-9]\d|20\d{2}|2100) (?:season|driver) summary|give the official (?:19[5-9]\d|20\d{2}|2100) (?:season|driver) summary for <driver>)\.?$/iu.test(masked);
}

function matchesCareerSummaryQuestion(question: string, driver: LiteralMentionReference): boolean {
  const points = Array.from(question);
  const masked = [...points.slice(0, driver.start), '<driver>', ...points.slice(driver.end)].join('');
  return /^(?:show <driver> official career summary|give the official career summary for <driver>)\.?$/iu.test(masked);
}

function matchesCareerCircuitWinsQuestion(question: string, driver: LiteralMentionReference): boolean {
  const points = Array.from(question);
  const masked = [...points.slice(0, driver.start), '<driver>', ...points.slice(driver.end)].join('');
  return /^(?:at which circuits has <driver> won races|which circuits has <driver> won races at)\?$/iu.test(masked);
}

function matchesRaceH2HQuestion(question: string, drivers: readonly LiteralMentionReference[]): boolean {
  const points = Array.from(question);
  const masked = [...points];
  for (const [index, driver] of [...drivers].map((driver, index) => [index, driver] as const).sort((left, right) => right[1].start - left[1].start)) {
    masked.splice(driver.start, driver.end - driver.start, `<driver_${index === 0 ? 'a' : 'b'}>`);
  }
  return /^(?:who finished ahead more often in (?:19[5-9]\d|20\d{2}|2100), <driver_a> or <driver_b>|in (?:19[5-9]\d|20\d{2}|2100), who finished ahead more often, <driver_a> or <driver_b>)\?$/iu.test(masked.join(''));
}

function matchesQualifyingH2HQuestion(question: string, drivers: readonly LiteralMentionReference[]): boolean {
  const points = Array.from(question);
  const masked = [...points];
  for (const [index, driver] of [...drivers].map((driver, index) => [index, driver] as const).sort((left, right) => right[1].start - left[1].start)) {
    masked.splice(driver.start, driver.end - driver.start, `<driver_${index === 0 ? 'a' : 'b'}>`);
  }
  return /^(?:who outqualified whom more often in (?:19[5-9]\d|20\d{2}|2100), <driver_a> or <driver_b>|in (?:19[5-9]\d|20\d{2}|2100), who outqualified whom more often, <driver_a> or <driver_b>|who qualified ahead more often in (?:19[5-9]\d|20\d{2}|2100), <driver_a> or <driver_b>|in (?:19[5-9]\d|20\d{2}|2100), who qualified ahead more often, <driver_a> or <driver_b>)\?$/iu.test(masked.join(''));
}

function containsGreekOrCyrillicLetter(value: string): boolean {
  return Array.from(value).some(character => /\p{L}/u.test(character)
    && /[\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}]/u.test(character));
}
