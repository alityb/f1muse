/**
 * Auto-Sync Scheduler
 *
 * Schedule:
 *   - Primary trigger: Monday 00:00 UTC (races finish Sunday, Jolpica has
 *     data within ~1 hour, so midnight Monday is a safe first attempt).
 *   - Hourly retry: if Jolpica doesn't have new race data yet (race ran late,
 *     publishing lag), retries every hour until data appears.
 *   - Retry cap: 12 attempts max (~noon Monday) so non-race weekends don't
 *     loop forever.
 *
 * What auto-syncs:
 *   - Jolpica: race results, standings (TypeScript HTTP, fast)
 *   - Teammate gap + matchup matrix (TypeScript SQL, fast)
 *   - FastF1 ingestion is intentionally excluded until a reviewed pace-v2 manifest is supplied.
 *
 * Python requirements: `pip install -r requirements.txt` must have run.
 *   On Railway: Nixpacks installs Python + Node together via nixpacks.toml.
 *   Locally:    venv/bin/python is tried first, then python3.
 *
 * Set AUTO_SYNC=true to enable the weekly scheduler. Startup catch-up is a
 * separate opt-in through AUTO_SYNC_STARTUP_CATCH_UP=true.
 */

import { Pool } from 'pg';
import { runJolpicaSync } from './jolpica-sync';
import { runIngestion as runTeammateGapRace } from '../etl/teammate-gap/race';
import { runIngestion as runTeammateGapQual } from '../etl/teammate-gap/qualifying';
import { runMatchupSync } from '../etl/matchup-matrix';
import { DEFAULT_ETL_CONFIG } from '../config/teammate-gap';

const SEASON = 2026;
const MAX_RETRIES = 12;             // give up by ~noon Monday
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let syncInProgress = false;
let lastSyncAt: Date | null = null;
let lastNewRounds = 0;
let retryCount = 0;
let retryTimer: NodeJS.Timeout | null = null;
let primaryTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let schedulerEnabled = false;
let downstreamPending = false;
let activeSync: Promise<SyncResult> | null = null;

export interface AutoSyncOptions {
  startupCatchUp?: boolean;
}

export interface RunSyncOptions {
  forceDownstream?: boolean;
  rescheduleOnSuccess?: boolean;
}

export interface AutoSyncRuntimeConfig {
  enabled: boolean;
  startupCatchUp: boolean;
}

export function getAutoSyncRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AutoSyncRuntimeConfig {
  return {
    enabled: env.AUTO_SYNC === 'true',
    startupCatchUp: env.AUTO_SYNC === 'true' && env.AUTO_SYNC_STARTUP_CATCH_UP === 'true'
  };
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------
export interface SyncResult {
  ok: boolean;
  newRounds: number;
  newRoundNumbers: number[];
  downstreamRan: boolean;
  downstreamRecovered: boolean;
  durationMs: number;
  error?: string;
}

export function runSync(pool: Pool, options: RunSyncOptions = {}): Promise<SyncResult> {
  if (activeSync) {
    return Promise.resolve({
      ok: false,
      newRounds: 0,
      newRoundNumbers: [],
      downstreamRan: false,
      downstreamRecovered: false,
      durationMs: 0,
      error: 'already in progress'
    });
  }

  const operation = performSync(pool, options);
  activeSync = operation;
  operation.finally(() => {
    if (activeSync === operation) {
      activeSync = null;
    }
  }).catch(() => undefined);
  return operation;
}

async function performSync(pool: Pool, options: RunSyncOptions): Promise<SyncResult> {
  syncInProgress = true;
  const start = Date.now();
  const recoveringDownstream = downstreamPending;
  let newRounds = 0;
  let newRoundNumbers: number[] = [];
  let downstreamRan = false;

  try {
    console.log('[auto-sync] Jolpica sync starting...');
    const jolpica = await runJolpicaSync(pool, SEASON);
    newRounds = jolpica.newRounds;
    newRoundNumbers = jolpica.newRoundNumbers;
    lastNewRounds = newRounds;
    console.log(`[auto-sync] Jolpica done — ${newRounds} new round(s): [${newRoundNumbers.join(', ')}]`);

    if (newRounds > 0) {
      downstreamPending = true;
    }
    if (options.forceDownstream === true) {
      downstreamPending = true;
    }

    if (downstreamPending) {
      console.log('[auto-sync] FastF1 pace ingestion is disabled pending reviewed manifest approval.');

      console.log('[auto-sync] Running teammate gap + matchup matrix...');
      await runTeammateGapRace(pool, DEFAULT_ETL_CONFIG);
      await runTeammateGapQual(pool, DEFAULT_ETL_CONFIG);
      await runMatchupSync(pool, SEASON);

      downstreamRan = true;
      downstreamPending = false;
      retryCount = 0;
      console.log('[auto-sync] All downstream ETL complete');
      clearRetryTimer();
      if (options.rescheduleOnSuccess === true && schedulerEnabled && !primaryTimer) {
        scheduleNextMonday(pool);
      }
    }

    lastSyncAt = new Date();
    return {
      ok: true,
      newRounds,
      newRoundNumbers,
      downstreamRan,
      downstreamRecovered: recoveringDownstream && downstreamRan,
      durationMs: Date.now() - start
    };

  } catch (err: any) {
    console.error('[auto-sync] Sync failed:', err?.message ?? err);
    return {
      ok: false,
      newRounds,
      newRoundNumbers,
      downstreamRan,
      downstreamRecovered: false,
      durationMs: Date.now() - start,
      error: String(err?.message ?? err)
    };
  } finally {
    syncInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

/** Milliseconds until next Monday 00:00 UTC. */
function msUntilNextMondayMidnightUTC(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun 1=Mon … 6=Sat

  // Days to add: if it's already Monday (1), schedule for next Monday (+7)
  const daysToAdd = day === 1 ? 7 : (8 - day) % 7;

  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysToAdd);
  next.setUTCHours(0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function scheduleNextMonday(pool: Pool): void {
  if (!schedulerEnabled) {
    return;
  }
  const ms = msUntilNextMondayMidnightUTC();
  const h = Math.round(ms / 3_600_000 * 10) / 10;
  console.log(`[auto-sync] Next sync scheduled in ${h}h (Monday 00:00 UTC)`);

  if (primaryTimer) {
    clearTimeout(primaryTimer);
  }
  primaryTimer = setTimeout(() => {
    primaryTimer = null;
    runWeeklySyncCycle(pool).catch((err) => console.error('[auto-sync] Weekly cycle failed:', err));
  }, ms);
}

/**
 * One full weekly cycle: try now, retry hourly if no data yet.
 */
async function runWeeklySyncCycle(pool: Pool): Promise<void> {
  if (!schedulerEnabled) {
    return;
  }
  retryCount = 0;
  await attemptSyncWithRetry(pool);
}

async function attemptSyncWithRetry(pool: Pool): Promise<void> {
  if (!schedulerEnabled) {
    return;
  }
  const result = await runSync(pool);

  if (!schedulerEnabled) {
    return;
  }

  if (result.ok && (result.newRounds > 0 || result.downstreamRecovered)) {
    console.log(`[auto-sync] Sync work complete (${result.newRounds} new round(s)). Next sync: Monday 00:00 UTC`);
    scheduleNextMonday(pool);
    return;
  }

  scheduleRetryOrNextMonday(pool);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startAutoSync(pool: Pool, options: AutoSyncOptions = {}): void {
  if (schedulerEnabled || primaryTimer || retryTimer || startupTimer) {
    throw new Error('auto-sync already started');
  }

  schedulerEnabled = true;
  scheduleNextMonday(pool);

  if (options.startupCatchUp === true) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      runStartupCatchUp(pool).catch((err) => console.error('[auto-sync] Startup catch-up failed:', err));
    }, 30_000);
  }
}

export async function stopAutoSync(): Promise<void> {
  schedulerEnabled = false;
  if (primaryTimer) { clearTimeout(primaryTimer); primaryTimer = null; }
  clearRetryTimer();
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  retryCount = 0;
  await activeSync;
}

export function getSyncStatus() {
  const msUntilNext = msUntilNextMondayMidnightUTC();
  let nextSyncIn = `${Math.round(msUntilNext / 3_600_000 * 10) / 10}h (Monday 00:00 UTC)`;
  if (!schedulerEnabled) {
    nextSyncIn = 'disabled';
  } else if (syncInProgress || retryCount > 0) {
    nextSyncIn = `retry ${retryCount + 1}/${MAX_RETRIES} in ~1h`;
  }

  return {
    enabled: schedulerEnabled,
    inProgress:     syncInProgress,
    lastSyncAt:     lastSyncAt?.toISOString() ?? null,
    lastNewRounds,
    downstreamPending,
    retryCount,
    nextSyncIn,
  };
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function runStartupCatchUp(pool: Pool): Promise<void> {
  const result = await runSync(pool, { rescheduleOnSuccess: true });
  if (schedulerEnabled && !result.ok && downstreamPending) {
    scheduleRetryOrNextMonday(pool);
  }
}

function scheduleRetryOrNextMonday(pool: Pool): void {
  if (!schedulerEnabled || retryTimer) {
    return;
  }

  if (primaryTimer) {
    clearTimeout(primaryTimer);
    primaryTimer = null;
  }

  retryCount++;

  if (retryCount >= MAX_RETRIES) {
    console.log(`[auto-sync] Max retries (${MAX_RETRIES}) reached — no new race data found. Scheduling next Monday.`);
    retryCount = 0;
    scheduleNextMonday(pool);
    return;
  }

  console.log(`[auto-sync] No new data (attempt ${retryCount}/${MAX_RETRIES}). Retrying in 1h...`);
  const timer = setTimeout(() => {
    if (retryTimer === timer) {
      retryTimer = null;
    }
    attemptSyncWithRetry(pool).catch((err) => console.error('[auto-sync] Retry failed:', err));
  }, RETRY_INTERVAL_MS);
  retryTimer = timer;
}
