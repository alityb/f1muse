import { createHash } from 'node:crypto';
import { createAnswerQuestionContract } from './answer-question';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from './semantic-catalog';
import {
  SemanticLiteralSpan,
  SemanticQuery,
  VerifiedSemanticQueryAdmission,
  verifySemanticQueryAdmission
} from './semantic-query';

export const SEMANTIC_RESOLUTION_EVIDENCE_VERSION = 'semantic-resolution-v1' as const;
export const SEMANTIC_RESOLVER_MAX_CANDIDATES = 100;

export type AnswerFactSourceId =
  | 'driver_standings'
  | 'event_classification'
  | 'event_metadata'
  | 'qualifying_classification';

export interface SemanticDriverMention {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly candidates: readonly string[];
  readonly active_candidates: readonly string[];
}

export interface SemanticDriverResolver {
  inventoryMentions(question: string, season: number): Promise<readonly SemanticDriverMention[]>;
}

export type SemanticEventResolution =
  | { readonly type: 'resolved'; readonly season: number; readonly round: number }
  | { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] }
  | { readonly type: 'missing' };

export interface SemanticEventResolver {
  resolve(season: number, name: string): Promise<SemanticEventResolution>;
  resolveRound(season: number, round: number): Promise<SemanticEventResolution>;
}

export type SemanticResolutionReason =
  | 'admission_invalid'
  | 'entity_ambiguous'
  | 'entity_cardinality_mismatch'
  | 'entity_inventory_mismatch'
  | 'event_ambiguous'
  | 'identity_unresolved'
  | 'source_coverage_missing'
  | 'source_graph_disconnected';

export class SemanticResolutionError extends Error {
  constructor(readonly reason: SemanticResolutionReason) {
    super(reason);
    this.name = 'SemanticResolutionError';
  }
}

export interface LinkedSemanticEntity {
  readonly entity_index: number;
  readonly type: 'driver' | 'event';
  readonly span: SemanticLiteralSpan;
  readonly candidate_ids: readonly string[];
  readonly selected_id: string;
  readonly resolution_relationship_ids: readonly string[];
}

const verifiedSemanticResolutionBrand: unique symbol = Symbol('verifiedSemanticResolution');

export interface VerifiedSemanticResolutionEvidence {
  readonly [verifiedSemanticResolutionBrand]: true;
  readonly version: typeof SEMANTIC_RESOLUTION_EVIDENCE_VERSION;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly season: number;
  readonly source_ids: readonly AnswerFactSourceId[];
  readonly entities: readonly LinkedSemanticEntity[];
  readonly resolved_round?: number;
  readonly resolver_reads: number;
  readonly resolver_candidates: number;
  readonly resolution_hash: string;
}

const activeResolutionEvidence = new WeakSet<object>();

export async function collectSemanticResolutionEvidence(input: {
  readonly question: unknown;
  readonly admission: unknown;
  readonly driver_resolver: SemanticDriverResolver;
  readonly event_resolver: SemanticEventResolver;
}): Promise<VerifiedSemanticResolutionEvidence> {
  let admission: VerifiedSemanticQueryAdmission;
  try {
    admission = verifySemanticQueryAdmission(input.admission, input.question);
  } catch {
    throw new SemanticResolutionError('admission_invalid');
  }
  const question = createAnswerQuestionContract(input.question);
  const query = admission.query;
  const season = requiredSeason(query);
  const sourceIds = semanticSourceIds(query);
  let resolverReads = 1;
  let resolverCandidates = 0;
  const rawMentions = await input.driver_resolver.inventoryMentions(question.normalized_question, season);
  if (!Array.isArray(rawMentions) || rawMentions.length > 8) {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  const mentions = rawMentions.map(parseDriverMention).sort(compareMentions);
  const expectedDrivers = query.entities.flatMap((entity, index) => entity.type === 'driver' ? [{ entity, index }] : [])
    .sort((left, right) => compareSpans(left.entity.span, right.entity.span));
  if (mentions.length !== expectedDrivers.length ||
      mentions.some((mention, index) => !sameMention(mention, expectedDrivers[index].entity.span))) {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  const linked: LinkedSemanticEntity[] = expectedDrivers.map(({ entity, index }, mentionIndex) => {
    const mention = mentions[mentionIndex];
    resolverCandidates += mention.candidates.length;
    if (mention.candidates.length === 0) {throw new SemanticResolutionError('identity_unresolved');}
    if (mention.active_candidates.length === 0) {throw new SemanticResolutionError('source_coverage_missing');}
    if (mention.active_candidates.length !== 1) {throw new SemanticResolutionError('entity_ambiguous');}
    return {
      entity_index: index,
      type: 'driver' as const,
      span: entity.span,
      candidate_ids: mention.candidates,
      selected_id: mention.active_candidates[0],
      resolution_relationship_ids: driverResolutionRelationships(sourceIds)
    };
  });
  if (new Set(linked.map(entity => entity.selected_id)).size !== linked.length) {
    throw new SemanticResolutionError('entity_cardinality_mismatch');
  }

  const eventScope = query.scopes.find(scope => scope.kind === 'event');
  const roundScope = query.scopes.find(scope => scope.kind === 'round');
  let resolvedRound: number | undefined;
  if (eventScope || roundScope) {
    resolverReads += 1;
    const rawResolution = eventScope
      ? await input.event_resolver.resolve(season, query.entities[eventScope.entity_index].span.text)
      : await input.event_resolver.resolveRound(season, roundScope!.value);
    const resolution = parseEventResolution(rawResolution);
    if (resolution.type === 'missing') {throw new SemanticResolutionError('source_coverage_missing');}
    if (resolution.type === 'ambiguous') {throw new SemanticResolutionError('event_ambiguous');}
    resolverCandidates += 1;
    if (resolution.season !== season || (roundScope && resolution.round !== roundScope.value)) {
      throw new SemanticResolutionError('source_coverage_missing');
    }
    resolvedRound = resolution.round;
    if (eventScope) {
      const entity = query.entities[eventScope.entity_index];
      linked.push({
        entity_index: eventScope.entity_index,
        type: 'event',
        span: entity.span,
        candidate_ids: [`event:${season}:${resolvedRound}`],
        selected_id: `event:${season}:${resolvedRound}`,
        resolution_relationship_ids: eventResolutionRelationships(sourceIds)
      });
    }
  }
  linked.sort((left, right) => left.entity_index - right.entity_index);
  const draft = {
    version: SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
    question_sha256: question.sha256,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    semantic_evidence_hash: admission.semantic_evidence_hash,
    candidate_set_hash: admission.candidate_set_hash,
    semantic_query_hash: admission.query_hash,
    season,
    source_ids: sourceIds,
    entities: linked,
    ...(resolvedRound === undefined ? {} : { resolved_round: resolvedRound }),
    resolver_reads: resolverReads,
    resolver_candidates: resolverCandidates
  };
  const evidence: VerifiedSemanticResolutionEvidence = deepFreeze({
    [verifiedSemanticResolutionBrand]: true as const,
    ...draft,
    resolution_hash: sha256(stableSerialize(draft))
  });
  activeResolutionEvidence.add(evidence);
  return evidence;
}

export function verifySemanticResolutionEvidence(
  input: unknown,
  questionInput: unknown,
  admissionInput: unknown
): VerifiedSemanticResolutionEvidence {
  if (!input || typeof input !== 'object' || !activeResolutionEvidence.has(input)) {
    throw new Error('semantic resolution evidence provenance is invalid');
  }
  const evidence = input as VerifiedSemanticResolutionEvidence;
  const admission = verifySemanticQueryAdmission(admissionInput, questionInput);
  const question = createAnswerQuestionContract(questionInput);
  const { resolution_hash: resolutionHash, ...brandedDraft } = evidence;
  const draft = brandedDraft;
  if (evidence[verifiedSemanticResolutionBrand] !== true || evidence.version !== SEMANTIC_RESOLUTION_EVIDENCE_VERSION ||
      evidence.question_sha256 !== question.sha256 || evidence.catalog_hash !== SEMANTIC_CATALOG_HASH ||
      evidence.semantic_evidence_hash !== admission.semantic_evidence_hash ||
      evidence.candidate_set_hash !== admission.candidate_set_hash || evidence.semantic_query_hash !== admission.query_hash ||
      stableSerialize(evidence.source_ids) !== stableSerialize(semanticSourceIds(admission.query)) ||
      evidence.season !== requiredSeason(admission.query) || resolutionHash !== sha256(stableSerialize(draft))) {
    throw new Error('semantic resolution evidence binding is invalid');
  }
  return evidence;
}

function parseDriverMention(input: unknown): SemanticDriverMention {
  if (!isPlainObject(input) || !hasExactKeys(input, ['active_candidates', 'candidates', 'end', 'start', 'text']) ||
      typeof input.text !== 'string' || !Number.isInteger(input.start) || !Number.isInteger(input.end) ||
      !Array.isArray(input.candidates) || !Array.isArray(input.active_candidates)) {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  const candidates = parseCandidateIds(input.candidates);
  const active = parseCandidateIds(input.active_candidates);
  if (active.some(candidate => !candidates.includes(candidate))) {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  return deepFreeze({ text: input.text, start: input.start as number, end: input.end as number, candidates, active_candidates: active });
}

function parseCandidateIds(input: readonly unknown[]): string[] {
  if (input.length > SEMANTIC_RESOLVER_MAX_CANDIDATES ||
      input.some(candidate => typeof candidate !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(candidate))) {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  const candidates = sortedUnique(input as string[]);
  if (candidates.length !== input.length) {throw new SemanticResolutionError('entity_inventory_mismatch');}
  return candidates;
}

function parseEventResolution(input: unknown): SemanticEventResolution {
  if (!isPlainObject(input) || typeof input.type !== 'string') {
    throw new SemanticResolutionError('entity_inventory_mismatch');
  }
  if (input.type === 'missing' && hasExactKeys(input, ['type'])) {return { type: 'missing' };}
  if (input.type === 'resolved' && hasExactKeys(input, ['round', 'season', 'type']) &&
      isSeason(input.season) && isRound(input.round)) {
    return { type: 'resolved', season: input.season, round: input.round };
  }
  if (input.type === 'ambiguous' && hasExactKeys(input, ['candidates', 'type']) && Array.isArray(input.candidates) &&
      input.candidates.length > 0 && input.candidates.length <= SEMANTIC_RESOLVER_MAX_CANDIDATES) {
    const candidates = input.candidates.map(candidate => {
      if (!isPlainObject(candidate) || !hasExactKeys(candidate, ['round', 'season']) ||
          !isSeason(candidate.season) || !isRound(candidate.round)) {
        throw new SemanticResolutionError('entity_inventory_mismatch');
      }
      return { season: candidate.season, round: candidate.round };
    }).sort((left, right) => left.season - right.season || left.round - right.round);
    if (new Set(candidates.map(candidate => `${candidate.season}:${candidate.round}`)).size !== candidates.length) {
      throw new SemanticResolutionError('entity_inventory_mismatch');
    }
    return { type: 'ambiguous', candidates };
  }
  throw new SemanticResolutionError('entity_inventory_mismatch');
}

function driverResolutionRelationships(sourceIds: readonly AnswerFactSourceId[]): string[] {
  const targetIds = new Set<string>([...sourceIds, 'answer_season_participation']);
  return SEMANTIC_CATALOG.relationships.filter(relationship => relationship.join_stage === 'resolution' &&
    relationship.governance !== 'experimental' && relationship.from_source === 'answer_driver_identity' &&
    targetIds.has(relationship.to_source)).map(relationship => relationship.id).sort(compareText);
}

function eventResolutionRelationships(sourceIds: readonly AnswerFactSourceId[]): string[] {
  const targetIds = new Set<string>(sourceIds);
  return SEMANTIC_CATALOG.relationships.filter(relationship => relationship.join_stage === 'resolution' &&
    relationship.governance !== 'experimental' && relationship.from_source === 'answer_event_identity' &&
    targetIds.has(relationship.to_source)).map(relationship => relationship.id).sort(compareText);
}

function semanticSourceIds(query: SemanticQuery): AnswerFactSourceId[] {
  const ids = sortedUnique([
    ...query.outputs.map(output => output.concept.source_id),
    ...query.group_by.map(group => group.concept.source_id),
    ...query.filters.map(filter => filter.concept.source_id)
  ]) as AnswerFactSourceId[];
  if (ids.length === 0) {throw new SemanticResolutionError('source_graph_disconnected');}
  return ids;
}

function requiredSeason(query: SemanticQuery): number {
  const scope = query.scopes.find(item => item.kind === 'season');
  if (!scope || scope.kind !== 'season') {throw new SemanticResolutionError('admission_invalid');}
  return scope.value;
}

function sameMention(mention: SemanticDriverMention, span: SemanticLiteralSpan): boolean {
  return mention.text === span.text && mention.start === span.start && mention.end === span.end;
}

function compareMentions(left: SemanticDriverMention, right: SemanticDriverMention): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
}

function compareSpans(left: SemanticLiteralSpan, right: SemanticLiteralSpan): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return stableSerialize(Object.keys(value).sort(compareText)) === stableSerialize([...keys].sort(compareText));
}

function isSeason(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1950 && (value as number) <= 2100;
}

function isRound(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 30;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  if (left > right) {return 1;}
  return 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
