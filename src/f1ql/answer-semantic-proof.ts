import { createHash } from 'crypto';
import { EventResolution } from '../identity/event-resolver';
import { AnswerDriverLiteralMention } from '../identity/answer-identity-resolvers';
import { AnswerIntent, LiteralMentionReference, parseAnswerIntent } from './answer-intent';
import { AnswerQuestionContract, parseRoundReference } from './answer-question';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION, AnswerTemplateId, AnswerTemplateVariables, computeAnswerTemplateRegistryHash, materializeAnswerTemplate, validateAnswerTemplateVariables } from './answer-templates';
import { F1QLProgram } from './ast';
import { F1QLLinkingError } from './translation-linking';
import { getF1QLProgramHash } from './verified-programs';

export const ANSWER_SEMANTIC_PROOF_VERSION = 'answer-semantic-proof-v6' as const;
export const ANSWER_AMBIGUITY_MAX_OPTIONS = 5;

export interface AnswerProofEventResolver {
  resolve(season: number, name: string): Promise<EventResolution>;
  resolveRound(season: number, round: number): Promise<EventResolution>;
}

export interface AnswerProofDriverResolver {
  inventoryMentions(question: string, season: number): Promise<readonly AnswerDriverLiteralMention[]>;
}

export interface AnswerProofMention {
  readonly kind: 'event' | 'driver';
  readonly mention_hash: string;
  readonly candidates: readonly string[];
  readonly selected_id: string;
}

export interface AnswerSemanticProof {
  readonly version: typeof ANSWER_SEMANTIC_PROOF_VERSION;
  readonly question_hash: string;
  readonly intent_hash: string;
  readonly mentions: readonly AnswerProofMention[];
  readonly template_id: AnswerTemplateId;
  readonly template_version: typeof ANSWER_TEMPLATE_REGISTRY_VERSION;
  readonly template_registry_hash: string;
  readonly template_variables: AnswerTemplateVariables;
  readonly program: F1QLProgram;
  readonly program_hash: string;
  readonly proof_hash: string;
}

declare const verifiedAnswerSemanticProofBrand: unique symbol;
export type VerifiedAnswerSemanticProof = AnswerSemanticProof & {
  readonly [verifiedAnswerSemanticProofBrand]: true;
};

interface ProofBindings {
  readonly normalizedQuestion: string;
  readonly serializedIntent: string;
  readonly mentionReferences: readonly string[];
}

const verifiedProofs = new WeakSet<object>();
const proofBindings = new WeakMap<object, ProofBindings>();

export class AnswerSemanticProofError extends Error {
  constructor(readonly reason: 'season_mismatch' | 'event_mismatch' | 'session_mismatch' | 'metric_mismatch' | 'status_mismatch' | 'entity_cardinality_mismatch' | 'template_mismatch') {
    super(reason);
    this.name = 'AnswerSemanticProofError';
  }
}

type ExecutableAnswerIntent = Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>;

export async function proveAnswerIntent(
  contract: AnswerQuestionContract,
  input: unknown,
  eventResolver: AnswerProofEventResolver,
  driverResolver: AnswerProofDriverResolver
): Promise<VerifiedAnswerSemanticProof> {
  const parsed = parseAnswerIntent(input, contract);
  if (parsed.type === 'clarification' || parsed.type === 'unsupported') {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  const intent: ExecutableAnswerIntent = parsed;
  proveSeason(contract, intent);
  proveSourceSessionAndMetric(contract, intent);
  proveStatusAndCardinality(contract, intent);
  if (!('event_reference' in intent) && (contract.event_cues.length > 0 || contract.rounds.length > 0)) {
    throw new AnswerSemanticProofError('event_mismatch');
  }

  const mentions: AnswerProofMention[] = [];
  let round: number | undefined;
  if ('event_reference' in intent) {
    const explicitRound = roundFromReference(intent.event_reference);
    proveEventReference(contract, intent.event_reference, explicitRound);
    const event = explicitRound === undefined
      ? await eventResolver.resolve(intent.season, intent.event_reference.text)
      : await eventResolver.resolveRound(intent.season, explicitRound);
    const candidates = eventCandidates(event);
    if (event.type === 'missing') {
      throw new F1QLLinkingError('source_coverage_missing');
    }
    if (event.type === 'ambiguous') {
      throw new F1QLLinkingError('event_ambiguous', candidates.slice(0, ANSWER_AMBIGUITY_MAX_OPTIONS).map(candidate => candidate.replace('event:', '').replace(':', ' round ')));
    }
    round = event.round;
    if (contract.rounds.length > 0 && contract.rounds.some(cue => cue.value !== round)) {
      throw new AnswerSemanticProofError('event_mismatch');
    }
    mentions.push(proofMention('event', intent.event_reference, candidates, `event:${event.season}:${event.round}`));
  }

  let driverReferences: readonly LiteralMentionReference[] = [];
  if ('driver_reference' in intent) {
    driverReferences = [intent.driver_reference];
  } else if ('driver_references' in intent) {
    driverReferences = intent.driver_references;
  }
  const inventory = await driverResolver.inventoryMentions(contract.normalized_question, intent.season);
  proveDriverReferenceInventory(driverReferences, inventory);
  const driverIds: string[] = [];
  for (const mention of inventory) {
    const candidates = mention.candidates.map(canonicalDriverId).sort();
    const active = mention.active_candidates.map(canonicalDriverId).sort();
    if (active.length === 0) {
      throw new F1QLLinkingError('source_coverage_missing');
    }
    if (candidates.length > 1 || active.length > 1) {
      const options = candidates.slice(0, ANSWER_AMBIGUITY_MAX_OPTIONS);
      const entityCandidates = [...new Set([
        ...mentions.flatMap(proven => proven.candidates.map(candidate => proven.kind === 'driver' ? `driver:${candidate}` : candidate)),
        ...options.map(candidate => `driver:${candidate}`)
      ])].sort();
      throw new F1QLLinkingError('entity_ambiguous', options, entityCandidates);
    }
    const selected = active[0];
    driverIds.push(selected);
    mentions.push(proofMention('driver', mention, candidates, selected));
  }
  if (new Set(driverIds).size !== driverIds.length) {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }

  const variables: Record<string, unknown> = { season: intent.season };
  if (round !== undefined) {
    variables.round = round;
  }
  if ('driver_reference' in intent) {
    variables.driver_id = driverIds[0];
  }
  if ('driver_references' in intent && driverIds.length > 0) {
    variables.driver_ids = driverIds;
  }
  if ('status' in intent) {
    variables.status = intent.status;
  }
  if ('selection_reference' in intent) {
    variables.positions = positionsForIntent(intent);
  }
  const templateId = templateForIntent(intent);
  let templateVariables: AnswerTemplateVariables;
  let program: F1QLProgram;
  try {
    templateVariables = validateAnswerTemplateVariables(templateId, variables);
    program = materializeAnswerTemplate(templateId, templateVariables);
  } catch {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  const proofWithoutHash = {
    version: ANSWER_SEMANTIC_PROOF_VERSION,
    question_hash: contract.sha256,
    intent_hash: sha256(stableSerialize(intent)),
    mentions,
    template_id: templateId,
    template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
    template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
    template_variables: templateVariables,
    program,
    program_hash: getF1QLProgramHash(program)
  };
  const proof = deepFreeze({
    ...proofWithoutHash,
    proof_hash: sha256(stableSerialize(proofWithoutHash))
  }) as unknown as VerifiedAnswerSemanticProof;
  const mentionReferences = [
    ...('event_reference' in intent ? [intent.event_reference] : []),
    ...inventory
  ].map(reference => stableSerialize(referenceValue(reference)));
  proofBindings.set(proof, {
    normalizedQuestion: contract.normalized_question,
    serializedIntent: stableSerialize(intent),
    mentionReferences
  });
  verifiedProofs.add(proof);
  return verifyAnswerSemanticProof(proof);
}

export function verifyAnswerSemanticProof(input: unknown): VerifiedAnswerSemanticProof {
  if (typeof input !== 'object' || input === null || !verifiedProofs.has(input)) {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  const proof = input as VerifiedAnswerSemanticProof;
  const bindings = proofBindings.get(proof);
  if (!bindings || !isDeepFrozen(proof) || proof.version !== ANSWER_SEMANTIC_PROOF_VERSION ||
      proof.question_hash !== sha256(bindings.normalizedQuestion) ||
      proof.intent_hash !== sha256(bindings.serializedIntent) ||
      proof.template_version !== ANSWER_TEMPLATE_REGISTRY_VERSION ||
      proof.template_registry_hash !== ANSWER_TEMPLATE_REGISTRY_HASH ||
      proof.template_registry_hash !== computeAnswerTemplateRegistryHash() ||
      proof.mentions.length !== bindings.mentionReferences.length) {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  for (let index = 0; index < proof.mentions.length; index++) {
    const mention = proof.mentions[index];
    if (mention.mention_hash !== sha256(bindings.mentionReferences[index]) ||
        mention.candidates.length === 0 || !mention.candidates.includes(mention.selected_id) ||
        new Set(mention.candidates).size !== mention.candidates.length ||
        mention.candidates.some((candidate, candidateIndex) => candidateIndex > 0 && mention.candidates[candidateIndex - 1] >= candidate)) {
      throw new AnswerSemanticProofError('template_mismatch');
    }
  }
  try {
    const variables = validateAnswerTemplateVariables(proof.template_id, proof.template_variables);
    if (stableSerialize(variables) !== stableSerialize(proof.template_variables)) {
      throw new Error('Template variables changed');
    }
    const materializedHash = getF1QLProgramHash(materializeAnswerTemplate(proof.template_id, variables));
    const programHash = getF1QLProgramHash(proof.program);
    const proofWithoutHash = Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'proof_hash'));
    if (materializedHash !== proof.program_hash || programHash !== proof.program_hash ||
        sha256(stableSerialize(proofWithoutHash)) !== proof.proof_hash) {
      throw new Error('Proof hashes changed');
    }
  } catch {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  return proof;
}

function proveDriverReferenceInventory(references: readonly LiteralMentionReference[], inventory: readonly AnswerDriverLiteralMention[]): void {
  const model = [...references].sort(compareReferences).map(referenceKey);
  const independent = [...inventory].sort(compareReferences).map(referenceKey);
  if (model.length !== independent.length || model.some((reference, index) => reference !== independent[index])) {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }
}

function proveEventReference(contract: AnswerQuestionContract, reference: LiteralMentionReference, explicitRound: number | undefined): void {
  if (explicitRound !== undefined) {
    const exactRound = contract.rounds.some(cue => cue.start >= reference.start && cue.end <= reference.end && cue.value === explicitRound);
    if (!exactRound || contract.rounds.length !== 1 || contract.event_cues.length !== 0) {
      throw new AnswerSemanticProofError('entity_cardinality_mismatch');
    }
    return;
  }
  const exactEvent = contract.event_cues.some(cue => cue.start === reference.start && cue.end === reference.end);
  if (!exactEvent || contract.event_cues.length !== 1 || contract.rounds.length !== 0) {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }
}

function proveSeason(contract: AnswerQuestionContract, intent: ExecutableAnswerIntent): void {
  const seasons = new Set(contract.years.map(cue => cue.value));
  if (seasons.size !== 1 || !seasons.has(intent.season)) {
    throw new AnswerSemanticProofError('season_mismatch');
  }
}

function proveSourceSessionAndMetric(contract: AnswerQuestionContract, intent: ExecutableAnswerIntent): void {
  const source = sourceForIntent(intent);
  const explicitSources = new Set(contract.source_cues.map(cue => cue.value));
  if (explicitSources.size > 0 && [...explicitSources].some(cue => cue !== source)) {
    throw new AnswerSemanticProofError('session_mismatch');
  }
  if (source === 'standings' && !explicitSources.has('standings')) {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  const sessions = new Set(contract.session_cues.map(cue => cue.value));
  let expectedSession: 'race' | 'qualifying' | undefined;
  if (source === 'qualifying_classification') {
    expectedSession = 'qualifying';
  } else if (source !== 'standings') {
    expectedSession = 'race';
  }
  if (expectedSession && [...sessions].some(session => session !== expectedSession)) {
    throw new AnswerSemanticProofError('session_mismatch');
  }
  if (contract.status_cues.length > 0 && source !== 'standings') {
    const explicitClassification = explicitSources.has(source);
    if (!explicitClassification && (!expectedSession || !sessions.has(expectedSession))) {
      throw new AnswerSemanticProofError('session_mismatch');
    }
  }
  const metrics = new Set(contract.metric_cues.map(cue => cue.value));
  if (metrics.has('points') && intent.type !== 'final_standings_points') {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (metrics.has('official_leader') && intent.type !== 'final_standings_leader') {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (metrics.has('latest_recorded') && intent.type !== 'current_standings') {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (metrics.has('date') && intent.type !== 'race_date') {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (intent.type === 'final_standings_points' && !metrics.has('points')) {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (intent.type === 'final_standings_leader' && !metrics.has('official_leader')) {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (intent.type === 'current_standings' && !metrics.has('latest_recorded')) {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (intent.type === 'current_standings' && /\bfinal\b/iu.test(contract.normalized_question)) {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  if (intent.type === 'current_standings' && !/^(?:show the latest recorded 2026 driver standings|give the latest recorded driver standings for 2026)\.?$/iu.test(contract.normalized_question)) {
    throw new AnswerSemanticProofError('template_mismatch');
  }
  if (intent.type === 'race_date' && !metrics.has('date') && !explicitSources.has('race_date')) {
    throw new AnswerSemanticProofError('metric_mismatch');
  }
  const statusSelectsClassification = contract.status_cues.length > 0
    && (source === 'race_classification' || source === 'qualifying_classification');
  if (explicitSources.size === 0 && metrics.size === 0 && !statusSelectsClassification && !('selection_reference' in intent)) {
    throw new AnswerSemanticProofError('template_mismatch');
  }
}

function proveStatusAndCardinality(contract: AnswerQuestionContract, intent: ExecutableAnswerIntent): void {
  const statuses = new Set(contract.status_cues.map(cue => cue.value));
  if ('status' in intent) {
    if (statuses.size !== 1 || !statuses.has(intent.status)) {
      throw new AnswerSemanticProofError('status_mismatch');
    }
    const referenced = contract.status_cues.some(cue => cue.start === intent.status_reference.start && cue.end === intent.status_reference.end && cue.value === intent.status);
    if (!referenced) {
      throw new AnswerSemanticProofError('status_mismatch');
    }
  } else if (statuses.size > 0) {
    throw new AnswerSemanticProofError('status_mismatch');
  }
  const allRequested = contract.action_cues.some(cue => cue.value === 'all');
  const classificationIntent = intent.type.includes('_classification_');
  const allIntent = intent.type === 'race_classification_all' || intent.type === 'qualifying_classification_all';
  if (classificationIntent && allRequested !== allIntent) {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }
  if ('driver_references' in intent && intent.driver_references.length === 0 && intent.type !== 'final_standings_points') {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }
  if ('selection_reference' in intent) {
    const expectedCues = contract.result_cues.filter(cue => cue.start === intent.selection_reference.start && cue.end === intent.selection_reference.end && cue.value === intent.type);
    if (expectedCues.length !== 1 || contract.result_cues.length !== 1 ||
        ('position' in intent && expectedCues[0].position !== intent.position) ||
        contract.status_cues.length > 0 || contract.action_cues.length > 0) {
      throw new AnswerSemanticProofError('entity_cardinality_mismatch');
    }
  } else if (contract.result_cues.length > 0) {
    throw new AnswerSemanticProofError('entity_cardinality_mismatch');
  }
}

function sourceForIntent(intent: ExecutableAnswerIntent): 'standings' | 'race_classification' | 'qualifying_classification' | 'race_date' {
  if (intent.type.startsWith('final_standings') || intent.type === 'current_standings') {
    return 'standings';
  }
  if (intent.type.startsWith('race_classification')) {
    return 'race_classification';
  }
  if (intent.type.startsWith('qualifying_classification')) {
    return 'qualifying_classification';
  }
  if (intent.type === 'race_date') {
    return 'race_date';
  }
  if (intent.type.startsWith('race_')) {
    return 'race_classification';
  }
  if (intent.type.startsWith('qualifying_')) {
    return 'qualifying_classification';
  }
  return 'race_date';
}

function templateForIntent(intent: ExecutableAnswerIntent): AnswerTemplateId {
  if ('selection_reference' in intent) {
    return intent.type.startsWith('race_') ? 'race_classification_position' : 'qualifying_classification_position';
  }
  return intent.type;
}

function positionsForIntent(intent: Extract<ExecutableAnswerIntent, { selection_reference: LiteralMentionReference }>): number[] {
  if (intent.type === 'race_winner' || intent.type === 'qualifying_pole') {
    return [1];
  }
  if (intent.type === 'race_podium') {
    return [1, 2, 3];
  }
  if (intent.type === 'race_top_n' || intent.type === 'qualifying_top_n') {
    return Array.from({ length: intent.position }, (_, index) => index + 1);
  }
  return [intent.position];
}

function roundFromReference(reference: LiteralMentionReference): number | undefined {
  return parseRoundReference(reference.text);
}

function eventCandidates(resolution: EventResolution): string[] {
  if (resolution.type === 'missing') {
    return [];
  }
  const events = resolution.type === 'resolved' ? [resolution] : resolution.candidates;
  return events.map(event => `event:${event.season}:${event.round}`).sort();
}

function proofMention(kind: 'event' | 'driver', reference: LiteralMentionReference, candidates: string[], selectedId: string): AnswerProofMention {
  return { kind, mention_hash: sha256(stableSerialize(referenceValue(reference))), candidates, selected_id: selectedId };
}

function referenceValue(reference: LiteralMentionReference): Record<string, unknown> {
  return { end: reference.end, start: reference.start, text: reference.text };
}

function canonicalDriverId(value: string): string {
  return value.replace(/_/g, '-');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareReferences(left: LiteralMentionReference, right: LiteralMentionReference): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
}

function referenceKey(reference: LiteralMentionReference): string {
  return stableSerialize({ end: reference.end, start: reference.start, text: reference.text });
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

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value).every(child => !child || typeof child !== 'object' || isDeepFrozen(child));
}
