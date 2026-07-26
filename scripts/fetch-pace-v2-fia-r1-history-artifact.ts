import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const FIA_R1_RACE_HISTORY_CHART_URL = 'https://www.fia.com/sites/default/files/2026_01_aus_f1_r0_timing_racehistorychart_v01.pdf';

export type FiaRaceHistoryRow = {
  lap_number: number;
  racing_number: string;
  lap_time_seconds: number;
  leader_gap_seconds: number | null;
  pit_marker: boolean;
};

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function timeSeconds(value: string): number | null {
  const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function validateFiaR1RaceHistoryChartUrl(sourceUrl: string): void {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.fia.com' || url.href !== FIA_R1_RACE_HISTORY_CHART_URL) {
    throw new Error('FAIL_CLOSED: only the reviewed FIA 2026 Australian Race History Chart URL may be fetched');
  }
}

// FIA's chart marks a pit lap as PIT and lapped cars as N LAP(S). Neither marker
// establishes the application eligibility flags or a numeric car-ahead gap.
export function parseFiaRaceHistoryChartText(content: string): FiaRaceHistoryRow[] {
  const rows: FiaRaceHistoryRow[] = [];
  let columns: Array<{ lapNumber: number; start: number; end: number }> = [];
  for (const line of content.split(/\r?\n/)) {
    const headers = [...line.matchAll(/LAP\s+(\d+)\s+GAP\s+TIME/g)];
    if (headers.length) {
      columns = headers.map((header, index) => ({
        lapNumber: Number(header[1]),
        start: header.index ?? 0,
        end: index + 1 < headers.length ? headers[index + 1].index ?? line.length : Number.POSITIVE_INFINITY
      }));
      continue;
    }
    for (const column of columns) {
      const fields = line.slice(column.start, column.end).trim().split(/\s+/);
      if (fields.length < 2 || fields.length > 4 || !/^\d+$/.test(fields[0])) continue;
      const lapTimeSeconds = timeSeconds(fields.at(-1)!);
      if (lapTimeSeconds === null) continue;
      const middle = fields.slice(1, -1).join(' ');
      const numericGap = /^\d+(?:\.\d+)?$/.test(middle) ? Number(middle) : null;
      const lapsBehind = /^(\d+) LAPS?$/.exec(middle);
      if (middle && middle !== 'PIT' && numericGap === null && !lapsBehind) continue;
      const completedLapNumber = column.lapNumber - (lapsBehind ? Number(lapsBehind[1]) : 0);
      if (completedLapNumber < 1) continue;
      rows.push({
        lap_number: completedLapNumber,
        racing_number: fields[0],
        lap_time_seconds: lapTimeSeconds,
        leader_gap_seconds: numericGap,
        pit_marker: middle === 'PIT'
      });
    }
  }
  return rows;
}

export function fetchFiaR1RaceHistoryChart(sourceUrl = FIA_R1_RACE_HISTORY_CHART_URL): Buffer {
  validateFiaR1RaceHistoryChartUrl(sourceUrl);
  const content = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', sourceUrl], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('FAIL_CLOSED: FIA artifact is not a PDF');
  return content;
}

export function writeFiaR1RaceHistoryChartArtifact(
  content: Buffer,
  retrievedAt: string,
  temporaryDirectory = os.tmpdir(),
  pdfToText: (artifactPath: string) => string = (artifactPath) => execFileSync('pdftotext', ['-layout', artifactPath, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
) {
  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('FAIL_CLOSED: FIA artifact is not a PDF');
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'pace-v2-r1-fia-history-'), { encoding: 'utf8' });
  const output = path.join(directory, 'RaceHistoryChart.pdf');
  fs.writeFileSync(output, content, { flag: 'wx', mode: 0o600 });
  const text = pdfToText(output);
  const rows = parseFiaRaceHistoryChartText(text);
  if (!rows.length) throw new Error('FAIL_CLOSED: FIA Race History Chart contains no parseable printed timing rows');
  return {
    version: 1 as const,
    authority: 'FIA' as const,
    event: '2026 Australian Grand Prix' as const,
    source_url: FIA_R1_RACE_HISTORY_CHART_URL,
    retrieved_at: retrievedAt,
    output,
    artifact_sha256: sha256(content),
    bytes: content.length,
    assertion_scope: 'printed_completed_lap_times_leader_relative_gaps_and_pit_markers_only' as const,
    parsed_rows: rows.length,
    observed_racing_numbers: [...new Set(rows.map((row) => row.racing_number))].sort((left, right) => Number(left) - Number(right)),
    pit_marked_rows: rows.filter((row) => row.pit_marker).length,
    row_fingerprint: sha256(JSON.stringify(rows)),
    f1ql_filtered_pace_comparison: 'unsupported_without_authoritative_per_lap_validity_in_out_and_clean_air_methodology' as const
  };
}

function main(): void {
  const content = fetchFiaR1RaceHistoryChart();
  process.stdout.write(`${JSON.stringify(writeFiaR1RaceHistoryChartArtifact(content, new Date().toISOString()))}\n`);
}

if (require.main === module) main();
