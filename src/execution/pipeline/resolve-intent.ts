import { Pool } from 'pg';
import { QueryIntent } from '../../types/query-intent';
import { QueryError } from '../../types/results';
import { DriverResolver } from '../../identity/driver-resolver';
import { TrackResolver } from '../../identity/track-resolver';
import { checkTeammates, resolveTeammatePairFromConstructor } from '../../identity/teammate-ownership';

export type ResolveResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: QueryError };

const TRACK_REQUIRED_KINDS = new Set<string>([
  'cross_team_track_scoped_driver_comparison',
  'track_fastest_drivers',
  'race_results_summary',
  'qualifying_results_summary'
]);

const TEAMMATE_GAP_KINDS = new Set<string>([
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',
  'qualifying_gap_teammates'
]);

export class IntentResolver {
  constructor(
    private pool: Pool,
    private driverResolver: DriverResolver,
    private trackResolver: TrackResolver
  ) {}

  async resolveIdentities(intent: QueryIntent): Promise<ResolveResult<QueryIntent>> {
    const resolved: any = { ...intent };
    const season = intent.season;

    const driverAResult = await this.resolveDriverField(resolved, 'driver_a', season);
    if (!driverAResult.ok) { return driverAResult; }

    const driverBResult = await this.resolveDriverField(
      resolved,
      'driver_b',
      season,
      resolved.driver_a_id
    );
    if (!driverBResult.ok) { return driverBResult; }

    const driverResult = await this.resolveDriverField(resolved, 'driver', season);
    if (!driverResult.ok) { return driverResult; }

    const driverIdsResult = await this.resolveDriverIds(resolved, season);
    if (!driverIdsResult.ok) { return driverIdsResult; }

    const trackResult = await this.resolveTrackFields(resolved);
    if (!trackResult.ok) { return trackResult; }

    return { ok: true, data: resolved };
  }

  async resolveTeammateGapDrivers(intent: QueryIntent): Promise<ResolveResult<QueryIntent>> {
    if (!TEAMMATE_GAP_KINDS.has(intent.kind)) {
      return { ok: true, data: intent };
    }

    const asAny = intent as any;
    if (asAny.driver_a_id && asAny.driver_b_id) {
      return { ok: true, data: intent };
    }

    const teamId = asAny.team_id || null;
    if (!teamId) {
      return {
        ok: false,
        error: {
          error: 'validation_failed',
          reason: 'teammate_gap_summary_season requires driver_a_id + driver_b_id or team_id'
        }
      };
    }

    const pairResult = await resolveTeammatePairFromConstructor(
      this.pool,
      intent.season,
      teamId
    );

    if (!pairResult.ok || !pairResult.driver_ids) {
      return {
        ok: false,
        error: {
          error: 'validation_failed',
          reason: `Cannot resolve teammate pair for constructor ${teamId} in season ${intent.season}: ${pairResult.reason}`
        }
      };
    }

    const [driverAId, driverBId] = pairResult.driver_ids;
    return {
      ok: true,
      data: { ...intent, driver_a_id: driverAId, driver_b_id: driverBId } as QueryIntent
    };
  }

  async validateTeammateConstraints(intent: QueryIntent): Promise<ResolveResult<void>> {
    if (!TEAMMATE_GAP_KINDS.has(intent.kind)) {
      return { ok: true, data: undefined };
    }

    const asAny = intent as any;
    if (!asAny.driver_a_id || !asAny.driver_b_id) {
      return {
        ok: false,
        error: {
          error: 'validation_failed',
          reason: 'Teammate comparison requires both driver IDs'
        }
      };
    }

    const teammateCheck = await checkTeammates(
      this.pool,
      asAny.driver_a_id,
      asAny.driver_b_id,
      intent.season
    );

    if (!teammateCheck.ok) {
      const normalizedReason = teammateCheck.reason === 'not_teammates'
        ? 'Drivers are not teammates in the specified season'
        : `Teammate validation failed: ${teammateCheck.reason}`;
      return {
        ok: false,
        error: {
          error: 'validation_failed',
          reason: normalizedReason,
          details: teammateCheck.details
        }
      };
    }

    return { ok: true, data: undefined };
  }

  private async resolveDriverField(
    resolved: any,
    prefix: string,
    season: number,
    teammateId?: string
  ): Promise<ResolveResult<void>> {
    const surfaceKey = `${prefix}_surface`;
    const idKey = `${prefix}_id`;

    if (resolved[surfaceKey] === null && resolved[idKey] === null) {
      return { ok: true, data: undefined };
    }
    if (resolved[surfaceKey] === undefined && resolved[idKey] === undefined) {
      return { ok: true, data: undefined };
    }

    const value = resolved[surfaceKey] ?? resolved[idKey];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return {
        ok: false,
        error: { error: 'intent_resolution_failed', reason: `Missing ${idKey}` }
      };
    }

    const result = await this.driverResolver.resolve(value, { season, teammate_id: teammateId });
    if (!result.success || !result.f1db_driver_id) {
      return {
        ok: false,
        error: { error: 'intent_resolution_failed', reason: `Unknown driver: "${value}"` }
      };
    }

    resolved[idKey] = result.f1db_driver_id;
    return { ok: true, data: undefined };
  }

  private async resolveDriverIds(resolved: any, season: number): Promise<ResolveResult<void>> {
    if (!resolved.driver_ids || !Array.isArray(resolved.driver_ids)) {
      return { ok: true, data: undefined };
    }

    const resolvedIds: string[] = [];
    for (const driverId of resolved.driver_ids) {
      if (typeof driverId !== 'string' || driverId.trim().length === 0) {
        return {
          ok: false,
          error: { error: 'intent_resolution_failed', reason: 'Missing driver_ids entry' }
        };
      }

      const result = await this.driverResolver.resolve(driverId, { season });
      if (!result.success || !result.f1db_driver_id) {
        return {
          ok: false,
          error: { error: 'intent_resolution_failed', reason: `Unknown driver: "${driverId}"` }
        };
      }
      resolvedIds.push(result.f1db_driver_id);
    }

    resolved.driver_ids = resolvedIds;
    return { ok: true, data: undefined };
  }

  private async resolveTrackFields(resolved: any): Promise<ResolveResult<void>> {
    if (!TRACK_REQUIRED_KINDS.has(resolved.kind)) {
      delete resolved.track_surface;
      delete resolved.track_id;
      delete resolved.track_ids;
      return { ok: true, data: undefined };
    }

    const singleResult = await this.resolveSingleTrack(resolved);
    if (!singleResult.ok) { return singleResult; }

    const arrayResult = await this.resolveTrackIds(resolved);
    if (!arrayResult.ok) { return arrayResult; }

    return { ok: true, data: undefined };
  }

  private async resolveSingleTrack(resolved: any): Promise<ResolveResult<void>> {
    if (resolved.track_surface === null && resolved.track_id === null) {
      return { ok: true, data: undefined };
    }
    if (resolved.track_surface === undefined && resolved.track_id === undefined) {
      return { ok: true, data: undefined };
    }

    const value = resolved.track_surface ?? resolved.track_id;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return {
        ok: false,
        error: { error: 'intent_resolution_failed', reason: 'Missing track_id' }
      };
    }

    const result = await this.trackResolver.resolve(value);
    if (!result.success || !result.f1db_track_id) {
      return {
        ok: false,
        error: { error: 'intent_resolution_failed', reason: `Unknown track: "${value}"` }
      };
    }

    resolved.track_id = result.f1db_track_id;
    return { ok: true, data: undefined };
  }

  private async resolveTrackIds(resolved: any): Promise<ResolveResult<void>> {
    if (!resolved.track_ids || !Array.isArray(resolved.track_ids)) {
      return { ok: true, data: undefined };
    }

    const resolvedIds: string[] = [];
    for (const trackId of resolved.track_ids) {
      if (typeof trackId !== 'string' || trackId.trim().length === 0) {
        return {
          ok: false,
          error: { error: 'intent_resolution_failed', reason: 'Missing track_ids entry' }
        };
      }

      const result = await this.trackResolver.resolve(trackId);
      if (!result.success || !result.f1db_track_id) {
        return {
          ok: false,
          error: { error: 'intent_resolution_failed', reason: `Unknown track: "${trackId}"` }
        };
      }
      resolvedIds.push(result.f1db_track_id);
    }

    resolved.track_ids = resolvedIds;
    return { ok: true, data: undefined };
  }
}
