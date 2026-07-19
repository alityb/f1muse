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
 *   - FastF1 laps + qualifying (Python ETL, spawned per round)
 *
 * Python requirements: `pip install -r requirements.txt` must have run.
 *   On Railway: Nixpacks installs Python + Node together via nixpacks.toml.
 *   Locally:    venv/bin/python is tried first, then python3.
 *
 * Set AUTO_SYNC=false to disable entirely (e.g. staging env).
 */

import { Pool } from 'pg';
import { spawn } from 'child_process';
import { accessSync, constants } from 'fs';
import path from 'path';
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

// ---------------------------------------------------------------------------
// Python ETL runner
// ---------------------------------------------------------------------------
function resolvePython(): string {
  const railwayVenv = path.join(process.cwd(), '.venv', 'bin', 'python');
  try {
    accessSync(railwayVenv, constants.X_OK);
    return railwayVenv;
  } catch {
    // Fall through to local venv / system python.
  }

  const venv = path.join(process.cwd(), 'venv', 'bin', 'python');
  try {
    accessSync(venv, constants.X_OK);
    return venv;
  } catch {
    return 'python3';
  }
}

function spawnPython(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const python = resolvePython();
    const scriptPath = path.join(process.cwd(), script);
    console.log(`[auto-sync] Spawning: ${python} ${scriptPath} ${args.join(' ')}`);

    const proc = spawn(python, [scriptPath, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d: Buffer) => process.stdout.write(`[etl] ${d}`));
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[etl] ${d}`));

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`ETL timed out after 30 minutes: ${script}`));
    }, 30 * 60 * 1000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {resolve();}
      else {reject(new Error(`ETL exited ${code}: ${script}`));}
    });
  });
}

async function runFastF1ETL(roundNumbers: number[]): Promise<void> {
  for (const rnd of roundNumbers) {
    console.log(`[auto-sync] Running FastF1 laps ETL for round ${rnd}...`);
    try {
      await spawnPython('src/etl/ingest-laps-2026.py', ['--round', String(rnd)]);
      console.log(`[auto-sync] Laps ETL done for round ${rnd}`);
    } catch (e) {
      console.error(`[auto-sync] Laps ETL failed for round ${rnd}:`, e);
    }

    console.log(`[auto-sync] Running FastF1 qualifying ETL for round ${rnd}...`);
    try {
      await spawnPython('src/etl/ingest-qualifying.py', ['--season', String(SEASON), '--round', String(rnd)]);
      console.log(`[auto-sync] Qualifying ETL done for round ${rnd}`);
    } catch (e) {
      console.error(`[auto-sync] Qualifying ETL failed for round ${rnd}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------
export interface SyncResult {
  ok: boolean;
  newRounds: number;
  newRoundNumbers: number[];
  downstreamRan: boolean;
  durationMs: number;
  error?: string;
}

export async function runSync(pool: Pool): Promise<SyncResult> {
  if (syncInProgress) {
    return { ok: false, newRounds: 0, newRoundNumbers: [], downstreamRan: false, durationMs: 0, error: 'already in progress' };
  }

  syncInProgress = true;
  const start = Date.now();

  try {
    console.log('[auto-sync] Jolpica sync starting...');
    const { newRounds, newRoundNumbers } = await runJolpicaSync(pool, SEASON);
    lastNewRounds = newRounds;
    console.log(`[auto-sync] Jolpica done — ${newRounds} new round(s): [${newRoundNumbers.join(', ')}]`);

    let downstreamRan = false;

    if (newRounds > 0) {
      retryCount = 0; // found data — stop retrying

      console.log('[auto-sync] Running FastF1 Python ETL...');
      await runFastF1ETL(newRoundNumbers);

      console.log('[auto-sync] Running teammate gap + matchup matrix...');
      await runTeammateGapRace(pool, DEFAULT_ETL_CONFIG);
      await runTeammateGapQual(pool, DEFAULT_ETL_CONFIG);
      await runMatchupSync(pool, SEASON);

      downstreamRan = true;
      console.log('[auto-sync] All downstream ETL complete');
    }

    lastSyncAt = new Date();
    return { ok: true, newRounds, newRoundNumbers, downstreamRan, durationMs: Date.now() - start };

  } catch (err: any) {
    console.error('[auto-sync] Sync failed:', err?.message ?? err);
    return { ok: false, newRounds: 0, newRoundNumbers: [], downstreamRan: false, durationMs: Date.now() - start, error: String(err?.message ?? err) };
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
  const ms = msUntilNextMondayMidnightUTC();
  const h = Math.round(ms / 3_600_000 * 10) / 10;
  console.log(`[auto-sync] Next sync scheduled in ${h}h (Monday 00:00 UTC)`);

  primaryTimer = setTimeout(() => {
    runWeeklySyncCycle(pool);
  }, ms);
}

/**
 * One full weekly cycle: try now, retry hourly if no data yet.
 */
async function runWeeklySyncCycle(pool: Pool): Promise<void> {
  retryCount = 0;
  await attemptSyncWithRetry(pool);
}

async function attemptSyncWithRetry(pool: Pool): Promise<void> {
  const result = await runSync(pool);

  if (result.newRounds > 0) {
    // Data found — schedule next Monday and we're done
    console.log(`[auto-sync] Race data found (${result.newRounds} round(s)). Next sync: Monday 00:00 UTC`);
    scheduleNextMonday(pool);
    return;
  }

  retryCount++;

  if (retryCount >= MAX_RETRIES) {
    console.log(`[auto-sync] Max retries (${MAX_RETRIES}) reached — no new race data found. Scheduling next Monday.`);
    scheduleNextMonday(pool);
    return;
  }

  console.log(`[auto-sync] No new data (attempt ${retryCount}/${MAX_RETRIES}). Retrying in 1h...`);
  retryTimer = setTimeout(() => attemptSyncWithRetry(pool), RETRY_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startAutoSyncInterval(pool: Pool): NodeJS.Timeout {
  // Schedule first trigger at Monday 00:00 UTC
  scheduleNextMonday(pool);

  // Also do one lightweight catch-up shortly after startup. This keeps a
  // restarted deployment current if Jolpica already has new data before the
  // next scheduled Monday window.
  startupTimer = setTimeout(() => {
    runSync(pool).catch((err) => console.error('[auto-sync] Startup catch-up failed:', err));
  }, 30_000);

  // Return a dummy interval handle for the shutdown cleanup signature.
  // The real timers (primaryTimer / retryTimer) are module-level.
  return setInterval(() => {/* no-op sentinel */}, Number.MAX_SAFE_INTEGER);
}

export function stopAutoSync(): void {
  if (primaryTimer) { clearTimeout(primaryTimer); primaryTimer = null; }
  if (retryTimer)   { clearTimeout(retryTimer);   retryTimer   = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}

export function getSyncStatus() {
  const msUntilNext = msUntilNextMondayMidnightUTC();
  return {
    inProgress:     syncInProgress,
    lastSyncAt:     lastSyncAt?.toISOString() ?? null,
    lastNewRounds,
    retryCount,
    nextSyncIn:     syncInProgress || retryCount > 0
                      ? `retry ${retryCount + 1}/${MAX_RETRIES} in ~1h`
                      : `${Math.round(msUntilNext / 3_600_000 * 10) / 10}h (Monday 00:00 UTC)`,
  };
}
