import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BELGIUM_2022_ARTIFACTS,
  createBelgium2022PilotManifest,
  createBelgium2022PilotManifestFromText,
  parseBelgium2022DeletedLapTimesText,
  parseBelgium2022FinalClassificationText
} from '../../scripts/generate-phase8-belgium-2022-pilot';

const identities = [
  ['1', 'Max VERSTAPPEN', 2],
  ['3', 'Daniel RICCIARDO', 0],
  ['4', 'Lando NORRIS', 0],
  ['5', 'Sebastian VETTEL', 0],
  ['6', 'Nicholas LATIFI', 0],
  ['10', 'Pierre GASLY', 0],
  ['11', 'Sergio PEREZ', 0],
  ['14', 'Fernando ALONSO', 2],
  ['16', 'Charles LECLERC', 0],
  ['18', 'Lance STROLL', 0],
  ['20', 'Kevin MAGNUSSEN', 0],
  ['22', 'Yuki TSUNODA', 0],
  ['23', 'Alexander ALBON', 0],
  ['24', 'ZHOU Guanyu', 0],
  ['31', 'Esteban OCON', 0],
  ['44', 'Lewis HAMILTON', 0],
  ['47', 'Mick SCHUMACHER', 0],
  ['55', 'Carlos SAINZ', 0],
  ['63', 'George RUSSELL', 0],
  ['77', 'Valtteri BOTTAS', 0]
] as const;

function classificationText(): string {
  const expectedLaps = new Map([
    ['1', 44], ['3', 44], ['4', 44], ['5', 44], ['6', 43], ['10', 44], ['11', 44], ['14', 44], ['16', 44], ['18', 44],
    ['20', 43], ['22', 44], ['23', 44], ['24', 44], ['31', 44], ['44', 0], ['47', 43], ['55', 44], ['63', 44], ['77', 1]
  ]);
  return [
    'Race Final Classification after 44 Laps',
    ...identities.map(([number, name], index) => `${index + 1} ${number} ${name}  Entrant  ${expectedLaps.get(number)}  1:00.000`)
  ].join('\n');
}

function completeHistoryText(omittedKey?: string): string {
  const deletedTimes = new Map([
    ['6:7', '1:55.404'], ['10:8', '1:57.112'], ['23:9', '1:56.420'], ['47:32', '1:52.212'], ['5:39', '1:52.773']
  ]);
  const expectedLaps = new Map([
    ['1', 44], ['3', 44], ['4', 44], ['5', 44], ['6', 43], ['10', 44], ['11', 44], ['14', 44], ['16', 44], ['18', 44],
    ['20', 43], ['22', 44], ['23', 44], ['24', 44], ['31', 44], ['44', 0], ['47', 43], ['55', 44], ['63', 44], ['77', 1]
  ]);
  return identities.flatMap(([number]) => Array.from({ length: expectedLaps.get(number)! }, (_, index) => {
    const lap = index + 1;
    const key = `${number}:${lap}`;
    if (key === omittedKey) return [];
    return [`LAP ${lap} GAP TIME`, `${number} ${deletedTimes.get(key) ?? `1:50.${String(lap).padStart(3, '0')}`}`];
  })).flat().join('\n');
}

const deletedText = [
  'Title         Race deleted lap times',
  '1 (T4) 6 Nicholas Latifi  Williams Racing  15:18:25 1:55.404',
  '2 (T4) 10 Pierre Gasly  AlphaTauri  15:20:20 1:57.112',
  '3 (T4) 23 Alexander Albon  Williams Racing  15:22:09 1:56.420',
  '4 (T4) 47 Mick Schumacher  Haas F1 Team  16:07:20 1:52.212',
  '5 (T4) 5 Sebastian Vettel  Aston Martin  16:19:59 1:52.773'
].join('\n');

describe('Phase 8 Belgian 2022 pilot evidence', () => {
  it('parses the exact reviewed identity and deleted-lap document shapes', () => {
    expect(parseBelgium2022FinalClassificationText(classificationText())).toHaveLength(20);
    expect(parseBelgium2022DeletedLapTimesText(deletedText)).toHaveLength(5);
  });

  it('fails closed on duplicate lap identity before assessing coverage', () => {
    const history = 'LAP 7 GAP TIME\n6 1:55.404\n6 1:55.404\n';
    expect(() => createBelgium2022PilotManifestFromText(history, classificationText(), deletedText)).toThrow('duplicate Race History Chart lap identity 6:7');
  });

  it('reports both coverage directions and refuses a missing official lap', () => {
    const manifest = createBelgium2022PilotManifestFromText(completeHistoryText('20:43'), classificationText(), deletedText);
    expect(manifest.coverage.final_classification_without_race_history).toEqual(['20:43']);
    expect(manifest.coverage.race_history_without_final_classification).toEqual([]);
    expect(manifest.promotion_status).toBe('refused');
  });

  it('refuses artifact bytes that do not match the reviewed provenance hashes', () => {
    const invalid = Buffer.from('%PDF-invalid');
    expect(() => createBelgium2022PilotManifest({
      race_history_chart: invalid,
      final_race_classification: invalid,
      deleted_race_lap_times: invalid
    })).toThrow('hash does not match the reviewed artifact');
  });

  it('retains an exact nonempty real-emitter fixture with complete official coverage', () => {
    const content = fs.readFileSync(path.resolve('data/phase8-belgium-2022-pilot.json'));
    expect(createHash('sha256').update(content).digest('hex')).toBe('491c7a7b01c9aa32742cfbf5b1b2cf3704e2ec7b48b84fbc08cdf2ea4df4caab');
    const fixture = JSON.parse(content.toString('utf8')) as {
      promotion_status: string;
      refusal_reasons: string[];
      parser_row_fingerprint: string;
      coverage: { final_classification_completed_lap_keys: number; race_history_lap_keys: number; final_classification_without_race_history: string[]; race_history_without_final_classification: string[] };
      completed_laps: { row_count: number; row_fingerprint: string; rows: Array<{ racing_number: string; official_name: string; lap_number: number; leader_gap_seconds: number | null; pit_marker: boolean; deleted_lap: boolean }> };
      pilot_window: { missing_lap_keys: string[]; rows: Array<{ racing_number: string; official_name: string; lap_number: number }> };
      deleted_laps: unknown[];
      artifacts: Record<string, { sha256: string; bytes: number }>;
    };
    expect(fixture.promotion_status).toBe('eligible_for_separate_review');
    expect(fixture.refusal_reasons).toEqual([]);
    expect(fixture.coverage.final_classification_without_race_history).toEqual([]);
    expect(fixture.coverage.race_history_without_final_classification).toEqual([]);
    expect(fixture.coverage.final_classification_completed_lap_keys).toBe(790);
    expect(fixture.coverage.race_history_lap_keys).toBe(790);
    expect(fixture.completed_laps.row_count).toBe(790);
    expect(fixture.completed_laps.rows).toHaveLength(790);
    expect(new Set(fixture.completed_laps.rows.map(row => `${row.racing_number}:${row.lap_number}`)).size).toBe(790);
    expect(fixture.completed_laps.rows.filter(row => row.deleted_lap)).toHaveLength(5);
    expect(fixture.completed_laps.rows.some(row => row.leader_gap_seconds !== null)).toBe(true);
    expect(fixture.completed_laps.row_fingerprint).toBe(createHash('sha256').update(JSON.stringify(fixture.completed_laps.rows)).digest('hex'));
    expect(fixture.pilot_window.missing_lap_keys).toEqual([]);
    expect(fixture.pilot_window.rows).toHaveLength(16);
    expect(new Set(fixture.pilot_window.rows.map((row) => `${row.racing_number}:${row.official_name}`))).toEqual(new Set(['1:Max VERSTAPPEN', '14:Fernando ALONSO']));
    expect(fixture.deleted_laps).toHaveLength(5);
    expect(fixture.parser_row_fingerprint).toBe('742bc6aee656ec04bb5f7248863a0dc09662e26655de1cc934e45f3a9636c27f');
    expect(Object.values(fixture.artifacts)).toHaveLength(3);
    expect(Object.fromEntries(Object.entries(fixture.artifacts).map(([name, artifact]) => [name, artifact.sha256]))).toEqual(Object.fromEntries(
      Object.entries(BELGIUM_2022_ARTIFACTS).map(([name, artifact]) => [name, artifact.sha256])
    ));
    expect(Object.fromEntries(Object.entries(fixture.artifacts).map(([name, artifact]) => [name, artifact.bytes]))).toEqual({
      race_history_chart: 1475524,
      final_race_classification: 525776,
      deleted_race_lap_times: 422958
    });
  });
});
