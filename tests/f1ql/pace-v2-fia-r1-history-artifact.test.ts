import { mkdtempSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FIA_R1_RACE_HISTORY_CHART_URL, parseFiaRaceHistoryChartText, validateFiaR1RaceHistoryChartUrl, writeFiaR1RaceHistoryChartArtifact } from '../../scripts/fetch-pace-v2-fia-r1-history-artifact';

describe('FIA Australian race history chart artifact', () => {
  it('parses only the explicit completed-lap fields and preserves PIT as a marker', () => {
    const rows = parseFiaRaceHistoryChartText([
      'LAP 11 GAP TIME',
      '16 1:23.798',
      '1 PIT 1:43.391',
      '63 1.012 1:23.967'
    ].join('\n'));
    expect(rows).toEqual([
      { lap_number: 11, racing_number: '16', lap_time_seconds: 83.798, leader_gap_seconds: null, pit_marker: false },
      { lap_number: 11, racing_number: '1', lap_time_seconds: 103.391, leader_gap_seconds: null, pit_marker: true },
      { lap_number: 11, racing_number: '63', lap_time_seconds: 83.967, leader_gap_seconds: 1.012, pit_marker: false }
    ]);
  });

  it('fails closed for an unreviewed FIA endpoint', () => {
    expect(() => validateFiaR1RaceHistoryChartUrl('https://www.fia.com/other.pdf')).toThrow('only the reviewed FIA');
  });

  it('writes only a mode-0600 raw PDF and refuses a chart with no timing rows', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pace-v2-fia-history-test-'));
    try {
      const report = writeFiaR1RaceHistoryChartArtifact(Buffer.from('%PDF-test'), '2026-07-23T00:00:00.000Z', directory, () => 'LAP 2 GAP TIME\n63 1:24.000\n');
      expect(report.source_url).toBe(FIA_R1_RACE_HISTORY_CHART_URL);
      expect(report.parsed_rows).toBe(1);
      expect(report.f1ql_filtered_pace_comparison).toContain('unsupported');
      expect(statSync(report.output).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
