import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const { runJolpicaSync, runTeammateGapRace, runTeammateGapQual, runMatchupSync } = vi.hoisted(() => ({
  runJolpicaSync: vi.fn(),
  runTeammateGapRace: vi.fn(),
  runTeammateGapQual: vi.fn(),
  runMatchupSync: vi.fn()
}));

vi.mock('../../src/sync/jolpica-sync', () => ({ runJolpicaSync }));
vi.mock('../../src/etl/teammate-gap/race', () => ({ runIngestion: runTeammateGapRace }));
vi.mock('../../src/etl/teammate-gap/qualifying', () => ({ runIngestion: runTeammateGapQual }));
vi.mock('../../src/etl/matchup-matrix', () => ({ runMatchupSync }));

import { getAutoSyncRuntimeConfig, getSyncStatus, runSync, startAutoSync, stopAutoSync } from '../../src/sync/auto-sync';

const pool = {} as Pool;
const WEDNESDAY_UTC = new Date('2026-07-29T12:00:00.000Z');
const UNTIL_MONDAY_MS = 4 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;

describe('auto-sync scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(WEDNESDAY_UTC);
    runJolpicaSync.mockReset().mockResolvedValue({ newRounds: 0, newRoundNumbers: [] });
    runTeammateGapRace.mockReset().mockResolvedValue(undefined);
    runTeammateGapQual.mockReset().mockResolvedValue(undefined);
    runMatchupSync.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopAutoSync();
    vi.useRealTimers();
  });

  it('requires exact independent environment opt-ins', () => {
    expect(getAutoSyncRuntimeConfig({})).toEqual({ enabled: false, startupCatchUp: false });
    expect(getAutoSyncRuntimeConfig({ AUTO_SYNC: 'false', AUTO_SYNC_STARTUP_CATCH_UP: 'true' })).toEqual({ enabled: false, startupCatchUp: false });
    expect(getAutoSyncRuntimeConfig({ AUTO_SYNC: 'TRUE', AUTO_SYNC_STARTUP_CATCH_UP: 'true' })).toEqual({ enabled: false, startupCatchUp: false });
    expect(getAutoSyncRuntimeConfig({ AUTO_SYNC: 'true' })).toEqual({ enabled: true, startupCatchUp: false });
    expect(getAutoSyncRuntimeConfig({ AUTO_SYNC: 'true', AUTO_SYNC_STARTUP_CATCH_UP: 'true' })).toEqual({ enabled: true, startupCatchUp: true });
  });

  it('schedules only the next Monday by default and does not run at startup', async () => {
    startAutoSync(pool);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runJolpicaSync).not.toHaveBeenCalled();
  });

  it('runs startup catch-up only when explicitly requested', async () => {
    startAutoSync(pool, { startupCatchUp: true });

    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps one retry chain when Monday fires during startup catch-up', async () => {
    vi.setSystemTime(new Date('2026-08-02T23:59:20.000Z'));
    let finishJolpica: ((result: { newRounds: number; newRoundNumbers: number[] }) => void) | undefined;
    runJolpicaSync.mockImplementationOnce(() => new Promise(resolve => {
      finishJolpica = resolve;
    }));
    runTeammateGapRace.mockRejectedValueOnce(new Error('temporary downstream failure'));
    startAutoSync(pool, { startupCatchUp: true });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    finishJolpica?.({ newRounds: 1, newRoundNumbers: [12] });
    await vi.advanceTimersByTimeAsync(0);

    expect(getSyncStatus().retryCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(2);
    expect(getSyncStatus().downstreamPending).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('re-arms Monday after successful startup catch-up overlaps the weekly trigger', async () => {
    vi.setSystemTime(new Date('2026-08-02T23:59:20.000Z'));
    let finishJolpica: ((result: { newRounds: number; newRoundNumbers: number[] }) => void) | undefined;
    runJolpicaSync.mockImplementationOnce(() => new Promise(resolve => {
      finishJolpica = resolve;
    }));
    startAutoSync(pool, { startupCatchUp: true });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    finishJolpica?.({ newRounds: 1, newRoundNumbers: [12] });
    await vi.advanceTimersByTimeAsync(0);

    expect(getSyncStatus()).toMatchObject({ retryCount: 0, downstreamPending: false });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(1);
  });

  it('starts the weekly cycle on Monday and schedules an hourly retry', async () => {
    startAutoSync(pool);

    await vi.advanceTimersByTimeAsync(UNTIL_MONDAY_MS - 1);
    expect(runJolpicaSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runJolpicaSync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(2);
  });

  it('runs downstream jobs only when a new round is found', async () => {
    runJolpicaSync.mockResolvedValueOnce({ newRounds: 1, newRoundNumbers: [12] });
    startAutoSync(pool, { startupCatchUp: true });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runTeammateGapRace).toHaveBeenCalledTimes(1);
    expect(runTeammateGapQual).toHaveBeenCalledTimes(1);
    expect(runMatchupSync).toHaveBeenCalledTimes(1);
  });

  it('retries pending downstream work without losing a persisted new round', async () => {
    runJolpicaSync
      .mockResolvedValueOnce({ newRounds: 1, newRoundNumbers: [12] })
      .mockResolvedValueOnce({ newRounds: 0, newRoundNumbers: [] });
    runTeammateGapRace.mockRejectedValueOnce(new Error('temporary downstream failure'));
    startAutoSync(pool);

    await vi.advanceTimersByTimeAsync(UNTIL_MONDAY_MS);
    expect(getSyncStatus().downstreamPending).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(2);
    expect(runTeammateGapRace).toHaveBeenCalledTimes(2);
    expect(runTeammateGapQual).toHaveBeenCalledTimes(1);
    expect(runMatchupSync).toHaveBeenCalledTimes(1);
    expect(getSyncStatus().downstreamPending).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels a pending retry after explicit downstream repair', async () => {
    startAutoSync(pool);
    await vi.advanceTimersByTimeAsync(UNTIL_MONDAY_MS);
    expect(vi.getTimerCount()).toBe(1);

    await runSync(pool, { forceDownstream: true, rescheduleOnSuccess: true });
    expect(runJolpicaSync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(2);
  });

  it('resets retry status after reaching the cap', async () => {
    startAutoSync(pool);
    await vi.advanceTimersByTimeAsync(UNTIL_MONDAY_MS + 11 * 60 * 60 * 1000);

    expect(runJolpicaSync).toHaveBeenCalledTimes(12);
    expect(getSyncStatus()).toMatchObject({ retryCount: 0 });
    expect(getSyncStatus().nextSyncIn).toContain('Monday 00:00 UTC');
  });

  it('reports disabled scheduling after stop', async () => {
    startAutoSync(pool);
    expect(getSyncStatus().enabled).toBe(true);

    await stopAutoSync();
    expect(getSyncStatus()).toMatchObject({ enabled: false, nextSyncIn: 'disabled' });
  });

  it('waits for active startup work and does not re-arm after stop', async () => {
    let finishJolpica: ((result: { newRounds: number; newRoundNumbers: number[] }) => void) | undefined;
    runJolpicaSync.mockImplementationOnce(() => new Promise(resolve => {
      finishJolpica = resolve;
    }));
    startAutoSync(pool, { startupCatchUp: true });
    await vi.advanceTimersByTimeAsync(30_000);

    let stopped = false;
    const stopping = stopAutoSync().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishJolpica?.({ newRounds: 0, newRoundNumbers: [] });
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(runJolpicaSync).toHaveBeenCalledTimes(1);
  });

  it('refuses duplicate starts and clears every owned timer on stop', async () => {
    startAutoSync(pool, { startupCatchUp: true });

    expect(() => startAutoSync(pool)).toThrow('auto-sync already started');
    await stopAutoSync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
