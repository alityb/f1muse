import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFiaRaceHistoryChartText, type FiaRaceHistoryRow } from './fetch-pace-v2-fia-r1-history-artifact';

const EVENT = '2022 Belgian Grand Prix';
const FIXTURE_PATH = path.resolve('data/phase8-belgium-2022-pilot.json');

export const BELGIUM_2022_ARTIFACTS = {
  race_history_chart: {
    url: 'https://www.fia.com/sites/default/files/2022_14_bel_f1_r0_timing_racehistorychart_v01.pdf',
    sha256: '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105'
  },
  final_race_classification: {
    url: 'https://www.fia.com/sites/default/files/doc_71_-_2022_belgian_grand_prix_-_final_race_classification.pdf',
    sha256: '85d9d3dc512d95b668377ca2b4167a7fe4218cd35bf30170764435e3f02b74df'
  },
  deleted_race_lap_times: {
    url: 'https://www.fia.com/sites/default/files/doc_68_-_2022_belgian_grand_prix_-_race_deleted_lap_times.pdf',
    sha256: '112bfb62c955ec88971bf215280a94b500ddcdad02dcd79ebe0a8c07c44c1e52'
  }
} as const;

const EXPECTED_IDENTITIES = [
  ['1', 'Max VERSTAPPEN', 44],
  ['3', 'Daniel RICCIARDO', 44],
  ['4', 'Lando NORRIS', 44],
  ['5', 'Sebastian VETTEL', 44],
  ['6', 'Nicholas LATIFI', 43],
  ['10', 'Pierre GASLY', 44],
  ['11', 'Sergio PEREZ', 44],
  ['14', 'Fernando ALONSO', 44],
  ['16', 'Charles LECLERC', 44],
  ['18', 'Lance STROLL', 44],
  ['20', 'Kevin MAGNUSSEN', 43],
  ['22', 'Yuki TSUNODA', 44],
  ['23', 'Alexander ALBON', 44],
  ['24', 'ZHOU Guanyu', 44],
  ['31', 'Esteban OCON', 44],
  ['44', 'Lewis HAMILTON', 0],
  ['47', 'Mick SCHUMACHER', 43],
  ['55', 'Carlos SAINZ', 44],
  ['63', 'George RUSSELL', 44],
  ['77', 'Valtteri BOTTAS', 1]
] as const;

type ArtifactName = keyof typeof BELGIUM_2022_ARTIFACTS;
type OfficialIdentity = {
  racing_number: string;
  official_name: string;
  classified_laps: number;
};

type DeletedLap = {
  racing_number: string;
  official_name: string;
  lap_time_seconds: number;
};

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function timeSeconds(value: string): number {
  const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) throw new Error(`FAIL_CLOSED: invalid printed lap time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseBelgium2022FinalClassificationText(content: string): OfficialIdentity[] {
  if (!content.includes('Race Final Classification after 44 Laps')) {
    throw new Error('FAIL_CLOSED: unexpected Belgian 2022 final classification document');
  }
  return EXPECTED_IDENTITIES.map(([racingNumber, officialName, classifiedLaps]) => {
    const row = new RegExp(`^\\s*(?:\\d+\\s+)?${racingNumber}\\s+${escapeRegExp(officialName)}(?: \\*)?\\s{2,}.*?\\s+${classifiedLaps}(?:\\s|$)`, 'gm');
    const matches = [...content.matchAll(row)];
    if (matches.length !== 1) {
      throw new Error(`FAIL_CLOSED: expected one final-classification identity row for racing number ${racingNumber}`);
    }
    return {
      racing_number: racingNumber,
      official_name: officialName,
      classified_laps: classifiedLaps
    };
  });
}

export function parseBelgium2022DeletedLapTimesText(content: string): DeletedLap[] {
  if (!content.includes('Title         Race deleted lap times')) {
    throw new Error('FAIL_CLOSED: unexpected Belgian 2022 deleted-lap document');
  }
  const rows = [...content.matchAll(/^\s*\d+\s+\(T4\)\s+(\d+)\s+(.+?)\s{2,}.+?\s+\d{2}:\d{2}:\d{2}\s+(\d+:\d{2}\.\d{3})\s*$/gm)].map((match) => ({
    racing_number: match[1],
    official_name: match[2].trim(),
    lap_time_seconds: timeSeconds(match[3])
  }));
  if (rows.length !== 5) throw new Error('FAIL_CLOSED: expected exactly five Belgian 2022 deleted race lap times');
  return rows;
}

function lapKey(racingNumber: string, lapNumber: number): string {
  return `${racingNumber}:${lapNumber}`;
}

function sortedLapKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((left, right) => {
    const [leftNumber, leftLap] = left.split(':').map(Number);
    const [rightNumber, rightLap] = right.split(':').map(Number);
    return leftNumber - rightNumber || leftLap - rightLap;
  });
}

function assertUniqueHistoryRows(rows: FiaRaceHistoryRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = lapKey(row.racing_number, row.lap_number);
    if (seen.has(key)) throw new Error(`FAIL_CLOSED: duplicate Race History Chart lap identity ${key}`);
    seen.add(key);
  }
}

export function createBelgium2022PilotManifestFromText(historyText: string, classificationText: string, deletedText: string) {
  const historyRows = parseFiaRaceHistoryChartText(historyText);
  if (!historyRows.length) throw new Error('FAIL_CLOSED: Race History Chart contains no timing rows');
  assertUniqueHistoryRows(historyRows);

  const identities = parseBelgium2022FinalClassificationText(classificationText);
  const identitiesByNumber = new Map(identities.map((identity) => [identity.racing_number, identity]));
  const classificationKeys = new Set(identities.flatMap((identity) => Array.from(
    { length: identity.classified_laps },
    (_, index) => lapKey(identity.racing_number, index + 1)
  )));
  const historyKeys = new Set(historyRows.map((row) => lapKey(row.racing_number, row.lap_number)));
  const historyWithoutClassification = sortedLapKeys([...historyKeys].filter((key) => !classificationKeys.has(key)));
  const classificationWithoutHistory = sortedLapKeys([...classificationKeys].filter((key) => !historyKeys.has(key)));

  const deletedLaps = parseBelgium2022DeletedLapTimesText(deletedText).map((deleted) => {
    const identity = identitiesByNumber.get(deleted.racing_number);
    if (!identity || identity.official_name.toLowerCase() !== deleted.official_name.toLowerCase()) {
      throw new Error(`FAIL_CLOSED: deleted-lap identity is not established for racing number ${deleted.racing_number}`);
    }
    const matches = historyRows.filter((row) => row.racing_number === deleted.racing_number && row.lap_time_seconds === deleted.lap_time_seconds);
    if (matches.length !== 1) {
      throw new Error(`FAIL_CLOSED: deleted lap does not map uniquely for racing number ${deleted.racing_number}`);
    }
    return {
      racing_number: deleted.racing_number,
      official_name: identity.official_name,
      lap_number: matches[0].lap_number,
      lap_time_seconds: deleted.lap_time_seconds
    };
  });
  const deletedKeys = new Set(deletedLaps.map((row) => lapKey(row.racing_number, row.lap_number)));
  const completedLapRows = [...historyRows]
    .sort((left, right) => Number(left.racing_number) - Number(right.racing_number) || left.lap_number - right.lap_number)
    .map((row) => {
      const identity = identitiesByNumber.get(row.racing_number);
      if (!identity) {
        throw new Error(`FAIL_CLOSED: Race History Chart identity is not classified for racing number ${row.racing_number}`);
      }
      return {
        racing_number: row.racing_number,
        official_name: identity.official_name,
        lap_number: row.lap_number,
        lap_time_seconds: row.lap_time_seconds,
        leader_gap_seconds: row.leader_gap_seconds,
        pit_marker: row.pit_marker,
        deleted_lap: deletedKeys.has(lapKey(row.racing_number, row.lap_number))
      };
    });
  const pilotNumbers = new Set(['1', '14']);
  const pilotRows = completedLapRows
    .filter((row) => pilotNumbers.has(row.racing_number) && row.lap_number >= 3 && row.lap_number <= 10)
    .map(({ leader_gap_seconds: _leaderGapSeconds, ...row }) => row);
  const requestedPilotKeys = new Set([...pilotNumbers].flatMap((number) => Array.from(
    { length: 8 },
    (_, index) => lapKey(number, index + 3)
  )));
  const missingPilotKeys = sortedLapKeys([...requestedPilotKeys].filter((key) => !historyKeys.has(key)));
  const refusalReasons = [
    ...(historyWithoutClassification.length ? ['race_history_contains_unclassified_lap_identity'] : []),
    ...(classificationWithoutHistory.length ? ['race_history_missing_classified_completed_laps'] : []),
    ...(missingPilotKeys.length ? ['pilot_window_incomplete'] : [])
  ];

  return {
    version: 2 as const,
    authority: 'FIA' as const,
    event: EVENT,
    season: 2022,
    round: 14,
    session: 'race' as const,
    assertion_scope: 'printed_race_history_lap_times_final_classification_identity_and_deleted_lap_decisions_only' as const,
    identities,
    deleted_laps: deletedLaps,
    coverage: {
      final_classification_completed_lap_keys: classificationKeys.size,
      race_history_lap_keys: historyKeys.size,
      final_classification_without_race_history: classificationWithoutHistory,
      race_history_without_final_classification: historyWithoutClassification
    },
    completed_laps: {
      row_count: completedLapRows.length,
      rows: completedLapRows,
      row_fingerprint: sha256(JSON.stringify(completedLapRows))
    },
    pilot_window: {
      lap_start: 3,
      lap_end: 10,
      official_identities: [
        { racing_number: '1', official_name: identitiesByNumber.get('1')!.official_name },
        { racing_number: '14', official_name: identitiesByNumber.get('14')!.official_name }
      ],
      missing_lap_keys: missingPilotKeys,
      rows: pilotRows
    },
    promotion_status: refusalReasons.length ? 'refused' as const : 'eligible_for_separate_review' as const,
    refusal_reasons: refusalReasons,
    canonical_raw_lap_window_operation: 'unsupported' as const,
    clean_air_or_pit_filtered_pace: 'unsupported' as const,
    parser_row_fingerprint: sha256(JSON.stringify(historyRows))
  };
}

function fetchArtifact(name: ArtifactName): Buffer {
  const artifact = BELGIUM_2022_ARTIFACTS[name];
  const content = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', artifact.url], {
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 35_000
  });
  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`FAIL_CLOSED: ${name} is not a PDF`);
  }
  if (sha256(content) !== artifact.sha256) throw new Error(`FAIL_CLOSED: ${name} hash does not match the reviewed artifact`);
  return content;
}

export function createBelgium2022PilotManifest(contents: Record<ArtifactName, Buffer>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-belgium-2022-'), { encoding: 'utf8' });
  fs.chmodSync(directory, 0o700);
  try {
    const texts = {} as Record<ArtifactName, string>;
    for (const name of Object.keys(BELGIUM_2022_ARTIFACTS) as ArtifactName[]) {
      const artifact = BELGIUM_2022_ARTIFACTS[name];
      if (sha256(contents[name]) !== artifact.sha256) throw new Error(`FAIL_CLOSED: ${name} hash does not match the reviewed artifact`);
      const artifactPath = path.join(directory, `${name}.pdf`);
      fs.writeFileSync(artifactPath, contents[name], { flag: 'wx', mode: 0o600 });
      texts[name] = execFileSync('pdftotext', ['-layout', artifactPath, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    }
    const manifest = createBelgium2022PilotManifestFromText(
      texts.race_history_chart,
      texts.final_race_classification,
      texts.deleted_race_lap_times
    );
    return {
      ...manifest,
      artifacts: Object.fromEntries((Object.keys(BELGIUM_2022_ARTIFACTS) as ArtifactName[]).map((name) => [name, {
        source_url: BELGIUM_2022_ARTIFACTS[name].url,
        sha256: BELGIUM_2022_ARTIFACTS[name].sha256,
        bytes: contents[name].length
      }]))
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main(): void {
  const contents = Object.fromEntries((Object.keys(BELGIUM_2022_ARTIFACTS) as ArtifactName[]).map((name) => [name, fetchArtifact(name)])) as Record<ArtifactName, Buffer>;
  const manifest = createBelgium2022PilotManifest(contents);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (process.argv.includes('--write-fixture')) {
    fs.writeFileSync(FIXTURE_PATH, serialized, { mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ status: 'written', fixture: path.relative(process.cwd(), FIXTURE_PATH), sha256: sha256(serialized), rows: manifest.completed_laps.rows.length, promotion_status: manifest.promotion_status })}\n`);
    return;
  }
  process.stdout.write(serialized);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'phase8_belgium_2022_pilot_failed' })}\n`);
    process.exitCode = 1;
  }
}
