import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
  OfficialTimingQuestionMatch
} from './official-timing-question';
import {
  computeOfficialTimingEvidenceHash,
  computeOfficialTimingQueryHash,
  OfficialTimingSemanticEvidence,
  OfficialTimingSemanticError,
  OfficialTimingSemanticQuery,
  verifyOfficialTimingEvidence
} from './official-timing-semantic-query';
import { readOfficialTimingCoverage, OfficialTimingCoverageDecision } from './official-timing-coverage';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_RESOLUTION_VERSION = 'semantic-resolution-v2' as const;

const CERTIFIED_SCOPE = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
const CERTIFIED_DRIVER_IDS = new Set(CERTIFIED_SCOPE.classified_laps_by_driver.map(driver => driver.driver_id));

export type OfficialTimingResolutionErrorCode =
  | 'catalog_unsupported'
  | 'driver_not_certified'
  | 'entity_ambiguous'
  | 'event_mismatch'
  | 'evidence_invalid'
  | 'identity_unresolved';

export class OfficialTimingResolutionError extends Error {
  constructor(readonly code: OfficialTimingResolutionErrorCode) {
    super(code);
    this.name = 'OfficialTimingResolutionError';
  }
}

export interface OfficialTimingDriverResolver {
  resolveUnambiguous(alias: string, season?: number): Promise<unknown>;
}

export interface OfficialTimingEventResolver {
  resolveRound(season: number, round: number): Promise<unknown>;
}

export interface OfficialTimingResolutionDependencies {
  readonly database: Pick<Pool, 'connect'>;
  readonly catalog: Parameters<typeof verifyOfficialTimingEvidence>[2];
  readonly driver_resolver: OfficialTimingDriverResolver;
  readonly event_resolver: OfficialTimingEventResolver;
  readonly coverage_reader?: typeof readOfficialTimingCoverage;
}

export interface OfficialTimingResolvedDriver {
  readonly branch: 'driver_a' | 'driver_b';
  readonly span: OfficialTimingSemanticQuery['entities'][number]['span'];
  readonly driver_id: string;
}

export interface OfficialTimingResolutionSuccess {
  readonly type: 'resolved';
  readonly version: typeof OFFICIAL_TIMING_RESOLUTION_VERSION;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly metric_id: OfficialTimingSemanticQuery['metric_id'];
  readonly season: 2022;
  readonly round: 14;
  readonly session_type: 'R';
  readonly event_name: '2022 Belgian Grand Prix';
  readonly drivers: readonly [OfficialTimingResolvedDriver, OfficialTimingResolvedDriver];
  readonly coverage: Extract<OfficialTimingCoverageDecision, { type: 'eligible' }>;
  readonly coverage_reader_version: 'official-timing-coverage-v1';
  readonly resolution_hash: string;
}

export interface OfficialTimingResolutionAbstention {
  readonly type: 'abstained';
  readonly version: typeof OFFICIAL_TIMING_RESOLUTION_VERSION;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly metric_id: OfficialTimingSemanticQuery['metric_id'];
  readonly coverage: Extract<OfficialTimingCoverageDecision, { type: 'abstain' }>;
  readonly resolution_hash: string;
}

export type OfficialTimingResolution = OfficialTimingResolutionSuccess | OfficialTimingResolutionAbstention;
export type UnsignedOfficialTimingResolution =
  | Omit<OfficialTimingResolutionSuccess, 'resolution_hash'>
  | Omit<OfficialTimingResolutionAbstention, 'resolution_hash'>;

const activeResolutions = new WeakSet<object>();

export async function collectOfficialTimingResolution(
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence,
  dependencies: OfficialTimingResolutionDependencies
): Promise<OfficialTimingResolution> {
  let verified: OfficialTimingSemanticEvidence;
  try {
    verified = verifyOfficialTimingEvidence(evidence, question, dependencies.catalog);
  } catch (error) {
    if (error instanceof OfficialTimingSemanticError && error.code === 'catalog_unsupported') {
      throw new OfficialTimingResolutionError('catalog_unsupported');
    }
    throw new OfficialTimingResolutionError('evidence_invalid');
  }
  const query = verified.candidates[0];
  const bindings = evidenceBindings(question, verified, query);
  const drivers = await resolveDrivers(query, dependencies.driver_resolver);
  await resolveEvent(dependencies.event_resolver);
  const coverage = await readCoverage(dependencies, query, drivers);
  const base = {
    version: OFFICIAL_TIMING_RESOLUTION_VERSION,
    ...bindings,
    metric_id: query.metric_id
  } as const;
  const unsigned: UnsignedOfficialTimingResolution = coverage.type === 'eligible'
    ? {
      ...base,
      type: 'resolved' as const,
      season: CERTIFIED_SCOPE.season,
      round: CERTIFIED_SCOPE.round,
      session_type: CERTIFIED_SCOPE.session_type,
      event_name: CERTIFIED_SCOPE.event_name,
      drivers,
      coverage,
      coverage_reader_version: 'official-timing-coverage-v1' as const
    }
    : { ...base, type: 'abstained' as const, coverage };
  const completed: OfficialTimingResolution = deepFreeze({ ...unsigned, resolution_hash: computeResolutionHash(unsigned) });
  activeResolutions.add(completed);
  return completed;
}

export function verifyOfficialTimingResolution(
  input: unknown,
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence
): OfficialTimingResolution {
  if (!input || typeof input !== 'object' || !activeResolutions.has(input)) {
    throw new OfficialTimingResolutionError('evidence_invalid');
  }
  const resolution = input as OfficialTimingResolution;
  const query = evidence.candidates[0];
  const expectedBindings = evidenceBindings(question, evidence, query);
  for (const [key, value] of Object.entries(expectedBindings)) {
    if ((resolution as unknown as Record<string, unknown>)[key] !== value) {
      throw new OfficialTimingResolutionError('evidence_invalid');
    }
  }
  const { resolution_hash: hashValue, ...unsigned } = resolution;
  if (hashValue !== computeResolutionHash(unsigned as UnsignedOfficialTimingResolution)) {
    throw new OfficialTimingResolutionError('evidence_invalid');
  }
  return resolution;
}

function evidenceBindings(
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence,
  query: OfficialTimingSemanticQuery
) {
  return {
    question_sha256: question.question_sha256,
    catalog_hash: evidence.catalog_hash,
    semantic_evidence_hash: computeOfficialTimingEvidenceHash(evidence),
    candidate_set_hash: evidence.candidate_set_hash,
    semantic_query_hash: computeOfficialTimingQueryHash(query)
  };
}

async function resolveDrivers(
  query: OfficialTimingSemanticQuery,
  resolver: OfficialTimingDriverResolver
): Promise<readonly [OfficialTimingResolvedDriver, OfficialTimingResolvedDriver]> {
  const resolved: OfficialTimingResolvedDriver[] = [];
  for (const entity of query.entities) {
    const result = await resolver.resolveUnambiguous(entity.span.text, CERTIFIED_SCOPE.season);
    const parsed = parseDriverResolution(result);
    if (!CERTIFIED_DRIVER_IDS.has(parsed)) {
      throw new OfficialTimingResolutionError('driver_not_certified');
    }
    resolved.push({ branch: entity.branch, span: entity.span, driver_id: parsed });
  }
  if (resolved[0].driver_id === resolved[1].driver_id) {
    throw new OfficialTimingResolutionError('identity_unresolved');
  }
  return [resolved[0], resolved[1]];
}

function parseDriverResolution(result: unknown): string {
  if (!result || typeof result !== 'object') {
    throw new OfficialTimingResolutionError('identity_unresolved');
  }
  const record = result as Record<string, unknown>;
  if (record.success === false && record.error === 'ambiguous_driver') {
    throw new OfficialTimingResolutionError('entity_ambiguous');
  }
  if (record.success !== true || typeof record.f1db_driver_id !== 'string' || record.f1db_driver_id.length === 0) {
    throw new OfficialTimingResolutionError('identity_unresolved');
  }
  return record.f1db_driver_id;
}

async function resolveEvent(resolver: OfficialTimingEventResolver): Promise<void> {
  const result = await resolver.resolveRound(CERTIFIED_SCOPE.season, CERTIFIED_SCOPE.round);
  if (!result || typeof result !== 'object') {
    throw new OfficialTimingResolutionError('event_mismatch');
  }
  const record = result as Record<string, unknown>;
  if (record.type !== 'resolved' || record.season !== CERTIFIED_SCOPE.season || record.round !== CERTIFIED_SCOPE.round) {
    throw new OfficialTimingResolutionError('event_mismatch');
  }
}

async function readCoverage(
  dependencies: OfficialTimingResolutionDependencies,
  query: OfficialTimingSemanticQuery,
  drivers: readonly [OfficialTimingResolvedDriver, OfficialTimingResolvedDriver]
): Promise<OfficialTimingCoverageDecision> {
  const reader = dependencies.coverage_reader ?? readOfficialTimingCoverage;
  if (query.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID) {
    return reader(dependencies.database, {
      metric: OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
      season: CERTIFIED_SCOPE.season,
      round: CERTIFIED_SCOPE.round,
      session_type: CERTIFIED_SCOPE.session_type,
      driver_ids: [drivers[0].driver_id, drivers[1].driver_id]
    });
  }
  const window = query.filters.find(filter => filter.kind === 'literal_range');
  if (window?.kind !== 'literal_range') {
    throw new OfficialTimingResolutionError('evidence_invalid');
  }
  return reader(dependencies.database, {
    metric: OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
    season: CERTIFIED_SCOPE.season,
    round: CERTIFIED_SCOPE.round,
    session_type: CERTIFIED_SCOPE.session_type,
    driver_ids: [drivers[0].driver_id, drivers[1].driver_id],
    lap_start: window.min,
    lap_end: window.max
  });
}

export function computeResolutionHash(resolution: UnsignedOfficialTimingResolution): string {
  return createHash('sha256').update(stableSerialize(resolution)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing resolution value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
