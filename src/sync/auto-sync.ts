/**
 * Auto-Sync Scheduler
 *
 * Runs the full data refresh pipeline on a timer inside the Node process —
 * the same pattern as cache maintenance.
 *
 * Schedule:
 *   - Jolpica results + standings: every 2 hours (lightweight, pure HTTP)
 *   - Teammate gap + matchup matrix: only when new race rounds are detected
 *
 * FastF1 lap/qualifying ETL still needs to be triggered separately (Python).
 * Use the Railway Cron or call POST /admin/sync?full=true to shell out to it.
 */

import { Pool } from 'pg';
import { runJolpicaSync } from './jolpica-sync';
import { runIngestion as runTeammateGapRace } from '../etl/teammate-gap/race';
import { runIngestion as runTeammateGapQual } from '../etl/teammate-gap/qualifying';
import { runMatchupSync } from '../etl/matchup-matrix';
import { DEFAULT_ETL_CONFIG } from '../config/teammate-gap';

const SEASON = 2026;
let syncInProgress = false;
let lastSyncAt: Date | null = null;
let lastNewRounds = 0;

export interface SyncResult {
  ok: boolean;
  newRounds: number;
  downstreamRan: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Run one full sync cycle.
 * Idempotent — safe to call at any frequency.
 */
export async function runSync(pool: Pool): Promise<SyncResult> {
  if (syncInProgress) {
    return { ok: false, newRounds: 0, downstreamRan: false, durationMs: 0, error: 'sync already in progress' };
  }

  syncInProgress = true;
  const start = Date.now();

  try {
    // 1. Jolpica: results + standings
    console.log('[auto-sync] Starting Jolpica sync...');
    const { newRounds } = await runJolpicaSync(pool, SEASON);
    lastNewRounds = newRounds;
    console.log(`[auto-sync] Jolpica done — ${newRounds} new round(s) detected`);

    // 2. Downstream ETL only when new race data arrived
    let downstreamRan = false;
    if (newRounds > 0) {
      console.log('[auto-sync] New data found — running teammate gap + matchup matrix...');

      await runTeammateGapRace(pool, DEFAULT_ETL_CONFIG);
      await runTeammateGapQual(pool, DEFAULT_ETL_CONFIG);
      await runMatchupSync(pool, SEASON);

      downstreamRan = true;
      console.log('[auto-sync] Downstream ETL complete');
    }

    lastSyncAt = new Date();
    return { ok: true, newRounds, downstreamRan, durationMs: Date.now() - start };

  } catch (err: any) {
    console.error('[auto-sync] Sync failed:', err?.message ?? err);
    return { ok: false, newRounds: 0, downstreamRan: false, durationMs: Date.now() - start, error: String(err?.message ?? err) };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Start the background sync interval.
 * Returns the interval handle so callers can clear it on shutdown.
 */
export function startAutoSyncInterval(
  pool: Pool,
  intervalMs = 2 * 60 * 60 * 1000   // 2 hours default
): NodeJS.Timeout {
  const hours = Math.round(intervalMs / 3_600_000 * 10) / 10;
  console.log(`✓ Auto-sync scheduled (every ${hours}h)`);

  // Run once at startup after a short delay (let the server fully boot first)
  setTimeout(() => runSync(pool).catch(console.error), 30_000);

  return setInterval(() => runSync(pool).catch(console.error), intervalMs);
}

export function getSyncStatus() {
  return {
    inProgress: syncInProgress,
    lastSyncAt: lastSyncAt?.toISOString() ?? null,
    lastNewRounds,
  };
}
