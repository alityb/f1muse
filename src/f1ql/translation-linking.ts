import { Pool } from 'pg';
import { DriverResolutionResult, DriverResolver } from '../identity/driver-resolver';
import { EventResolution, EventResolver } from '../identity/event-resolver';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../identity/answer-identity-resolvers';
import { AggregateNode, F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';
import { F1QLProgramCandidate, isNamedEventProgram } from './translation-schema';

export class F1QLLinkingError extends Error {
  constructor(readonly code: 'event_ambiguous' | 'entity_ambiguous' | 'source_coverage_missing' | 'temporal_scope_unsupported', readonly options?: string[], readonly entityCandidates?: string[]) {
    super(code);
  }
}

export interface AnswerLinkObservation {
  program: F1QLProgram;
  entityCandidates: string[];
}

export async function linkF1QLCandidate(pool: Pick<Pool, 'query'>, candidate: F1QLProgramCandidate): Promise<F1QLProgram> {
  const program = await canonicalizeEvent(candidate, new EventResolver(pool));
  return parseF1QLProgram(await resolveDriverIds(program, new DriverResolver(pool)));
}

export async function linkAnswerF1QLCandidate(pool: Pick<Pool, 'query'>, candidate: F1QLProgramCandidate): Promise<F1QLProgram> {
  return (await linkAnswerF1QLCandidateObserved(pool, candidate)).program;
}

export async function linkAnswerF1QLCandidateObserved(pool: Pick<Pool, 'query'>, candidate: F1QLProgramCandidate): Promise<AnswerLinkObservation> {
  const entityCandidates = new Set<string>();
  const root = candidate.root;
  if ('season' in root && 'round' in root && typeof root.season === 'number' && typeof root.round === 'number') {
    entityCandidates.add(`event:${root.season}:${root.round}`);
  }
  try {
    const program = await canonicalizeEvent(candidate, new AnswerEventIdentityResolver(pool), resolution => {
      let events: Array<{ season: number; round: number }> = [];
      if (resolution.type === 'resolved') {
        events = [resolution];
      } else if (resolution.type === 'ambiguous') {
        events = resolution.candidates;
      }
      events.forEach(event => entityCandidates.add(`event:${event.season}:${event.round}`));
    });
    const linked = await resolveDriverIds(program, new AnswerDriverIdentityResolver(pool), resolution => {
      const drivers = resolution.candidates ?? (resolution.f1db_driver_id ? [resolution.f1db_driver_id] : []);
      drivers.forEach(driver => entityCandidates.add(`driver:${driver.replace(/_/g, '-')}`));
    });
    return { program: parseF1QLProgram(linked), entityCandidates: [...entityCandidates].sort() };
  } catch (error) {
    if (error instanceof F1QLLinkingError) {
      throw new F1QLLinkingError(error.code, error.options, [...entityCandidates].sort());
    }
    throw error;
  }
}

async function canonicalizeEvent(candidate: F1QLProgramCandidate, resolver: { resolve(season: number, name: string): Promise<EventResolution> }, observe?: (resolution: EventResolution) => void): Promise<F1QLProgram> {
  if (!isNamedEventProgram(candidate)) {
    return parseF1QLProgram(candidate);
  }
  const resolution = await resolver.resolve(candidate.root.season, candidate.root.event_name);
  observe?.(resolution);
  if (resolution.type === 'missing') {
    throw new F1QLLinkingError('source_coverage_missing');
  }
  if (resolution.type === 'ambiguous') {
    throw new F1QLLinkingError('event_ambiguous', resolution.candidates.map(event => `${event.season} round ${event.round}`));
  }
  const root = candidate.root;
  if (root.op === 'event_metadata') {
    return parseF1QLProgram({ version: 1, root: { op: root.op, season: root.season, round: resolution.round, session_scope: root.session_scope } });
  }
  return parseF1QLProgram({ version: 1, root: { op: root.op, season: root.season, round: resolution.round, limit: root.limit, filters: root.filters } });
}

async function resolveDriverIds(program: F1QLProgram, resolver: { resolveUnambiguous(alias: string, season?: number): Promise<DriverResolutionResult> }, observe?: (resolution: DriverResolutionResult) => void): Promise<F1QLProgram> {
  const { ids, season } = driverResolutionScope(program);
  const resolved = new Map<string, string>();
  for (const id of ids) {
    const result = await resolver.resolveUnambiguous(id, season);
    observe?.(result);
    if (result.error === 'ambiguous_driver') {
      throw new F1QLLinkingError('entity_ambiguous', result.candidates?.map(candidate => candidate.replace(/_/g, '-')));
    }
    if (!result.success || !result.f1db_driver_id) {
      throw new Error(`identity_unresolved: ${id}`);
    }
    resolved.set(id, result.f1db_driver_id.replace(/_/g, '-'));
  }
  return applyResolvedDriverIds(program, resolved);
}

function driverResolutionScope(program: F1QLProgram): { ids: string[]; season?: number } {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { ids: [root.driver_a_id, root.driver_b_id], season: root.scope.season };
  }
  if (root.op === 'pace_summary') {
    return { ids: [root.driver_id], season: root.scope.season };
  }
  if (root.op === 'event_classification' && root.filters?.driver_id) {
    return { ids: [root.filters.driver_id], season: root.season };
  }
  if (root.op === 'qualifying_classification' && root.filters?.driver_id) {
    return { ids: [root.filters.driver_id], season: root.season };
  }
  if (root.op === 'aggregate') {
    return standingsResolutionScope(root);
  }
  if (root.op === 'rank') {
    return standingsResolutionScope(root.input);
  }
  return { ids: [] };
}

function standingsResolutionScope(aggregate: AggregateNode): { ids: string[]; season?: number } {
  if (aggregate.input.op !== 'filter' || !aggregate.input.where.driver_id) {
    return { ids: [] };
  }
  if (typeof aggregate.input.where.season !== 'number') {
    throw new F1QLLinkingError('temporal_scope_unsupported');
  }
  const driverId = aggregate.input.where.driver_id;
  return { ids: Array.isArray(driverId) ? driverId : [driverId], season: aggregate.input.where.season };
}

function applyResolvedDriverIds(program: F1QLProgram, resolved: Map<string, string>): F1QLProgram {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { ...program, root: { ...root, driver_a_id: resolved.get(root.driver_a_id)!, driver_b_id: resolved.get(root.driver_b_id)! } };
  }
  if (root.op === 'pace_summary') {
    return { ...program, root: { ...root, driver_id: resolved.get(root.driver_id)! } };
  }
  if (root.op === 'event_classification' && root.filters?.driver_id) {
    return { ...program, root: { ...root, filters: { ...root.filters, driver_id: resolved.get(root.filters.driver_id) } } };
  }
  if (root.op === 'qualifying_classification' && root.filters?.driver_id) {
    return { ...program, root: { ...root, filters: { ...root.filters, driver_id: resolved.get(root.filters.driver_id) } } };
  }
  if (root.op === 'aggregate') {
    return { ...program, root: applyResolvedStandingsDrivers(root, resolved) };
  }
  if (root.op === 'rank') {
    return { ...program, root: { ...root, input: applyResolvedStandingsDrivers(root.input, resolved) } };
  }
  return program;
}

function applyResolvedStandingsDrivers(aggregate: AggregateNode, resolved: Map<string, string>): AggregateNode {
  if (aggregate.input.op !== 'filter' || !aggregate.input.where.driver_id) {
    return aggregate;
  }
  const original = aggregate.input.where.driver_id;
  const driver_id = Array.isArray(original) ? original.map(id => resolved.get(id)!) : resolved.get(original)!;
  return { ...aggregate, input: { ...aggregate.input, where: { ...aggregate.input.where, driver_id } } };
}
