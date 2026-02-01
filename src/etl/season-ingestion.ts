#!/usr/bin/env node

/**
 * LAPS NORMALIZED SEASON INGESTION - 2025
 *
 * Deterministic, fail-closed, append-only ingestion for the full season.
 *
 * Usage:
 *   npm run ingest:season 2025
 */

import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TARGET_SEASON = 2025;
const CLEAN_AIR_GAP_THRESHOLD = 2.0; // seconds
const MIN_DRIVERS_PER_RACE = 10;
const SQL_TEMPLATE = `INSERT INTO laps_normalized (
  season, round, track_id, driver_id, lap_number,
  stint_id, stint_lap_index, lap_time_seconds,
  is_valid_lap, is_pit_lap, is_out_lap, is_in_lap,
  clean_air_flag, compound, tyre_age_laps
) VALUES (...)`;

const FASTF1_CODE_OVERRIDES: Record<string, { driver_id?: string; first_name?: string; last_name?: string; full_name?: string }> = {
  ANT: { first_name: 'Kimi', last_name: 'Antonelli' },
  ALB: { first_name: 'Alexander', last_name: 'Albon' },
  BEA: { first_name: 'Oliver', last_name: 'Bearman' },
  BOR: { first_name: 'Gabriel', last_name: 'Bortoleto' },
  COL: { first_name: 'Franco', last_name: 'Colapinto' },
  DOO: { first_name: 'Jack', last_name: 'Doohan' },
  GAS: { first_name: 'Pierre', last_name: 'Gasly' },
  HAD: { first_name: 'Isack', last_name: 'Hadjar' },
  HAM: { first_name: 'Lewis', last_name: 'Hamilton' },
  HUL: { first_name: 'Nico', last_name: 'Hulkenberg' },
  HULK: { first_name: 'Nico', last_name: 'Hulkenberg' },
  LAW: { first_name: 'Liam', last_name: 'Lawson' },
  OCO: { first_name: 'Esteban', last_name: 'Ocon' },
  RUS: { first_name: 'George', last_name: 'Russell' },
  STR: { first_name: 'Lance', last_name: 'Stroll' },
  TSU: { first_name: 'Yuki', last_name: 'Tsunoda' }
};

const DIACRITICS_FROM = 'áàäâãéèëêíìïîóòöôõúùüûñçýÿ';
const DIACRITICS_TO = 'aaaaaeeeeiiiiooooouuuuncyy';

const REQUIRED_LAPS_COLUMNS = [
  'Driver',
  'LapNumber',
  'LapTime',
  'IsAccurate',
  'PitInTime',
  'PitOutTime',
  'Compound',
  'TyreLife',
  'Position'
];

interface RaceInfo {
  race_id: number;
  round: number;
  circuit_id: string;
  grand_prix_id: string;
  official_name: string;
  has_session_mapping: boolean;
}

interface FastF1LapRow {
  driver_code: string | null;
  lap_number: number | null;
  lap_time_seconds: number | null;
  lap_end_time_seconds: number | null;
  is_accurate: boolean | null;
  pit_in: boolean;
  pit_out: boolean;
  compound: string | null;
  tyre_life: number | null;
  position: number | null;
  gap_to_leader: number | null;
}

interface FastF1SessionPayload {
  season: number;
  round: number;
  session_name: string;
  event_name: string;
  session_uid: string;
  columns_present: Record<string, boolean>;
  laps: FastF1LapRow[];
}

interface NormalizedLapDraft {
  season: number;
  round: number;
  track_id: string;
  driver_id: string;
  lap_number: number;
  lap_time_seconds: number;
  lap_end_time_seconds?: number | null;
  is_valid_lap: boolean;
  is_pit_lap: boolean;
  is_out_lap: boolean;
  is_in_lap: boolean;
  compound: string | null;
  tyre_age_laps: number | null;
  stint_id?: number;
  stint_lap_index?: number;
  clean_air_flag?: boolean;
  position?: number | null;
  gap_to_leader?: number | null;
}

interface NormalizedLap extends NormalizedLapDraft {
  stint_id: number;
  stint_lap_index: number;
  clean_air_flag: boolean;
}

interface SeasonValidationResult {
  season_driver_ids: Set<string>;
  allowed_driver_ids: Set<string>;
  abbreviation_to_driver_id: Map<string, string>;
}

interface RaceOutcome {
  round: number;
  race_id: number;
  status: 'success' | 'skipped' | 'failed';
  laps_inserted: number;
  execution_hash: string;
  failure_reason?: string;
}

interface EtlMetrics {
  races_processed: number;
  races_skipped: number;
  races_failed: number;
  total_laps_inserted: number;
  execution_hash: string;
}

interface TableFingerprint {
  table_name: string;
  columns: Array<{ name: string; type: string }>;
  row_count: number;
  last_updated: string | null;
}

class HashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashMismatchError';
  }
}

const FASTF1_SCRIPT = `
import json
import sys
import os
import fastf1
import math

season = int(sys.argv[1])
round_num = int(sys.argv[2])
session_type = sys.argv[3] if len(sys.argv) > 3 else 'R'

cache_dir = os.getenv('FASTF1_CACHE_DIR', 'cache/fastf1')
os.makedirs(cache_dir, exist_ok=True)
fastf1.Cache.enable_cache(cache_dir)

session = fastf1.get_session(season, round_num, session_type)
session.load()

laps = session.laps
columns = set(laps.columns)

required = ['Driver', 'LapNumber', 'LapTime', 'IsAccurate', 'PitInTime', 'PitOutTime', 'Compound', 'TyreLife', 'Position', 'Time', 'GapToLeader']
columns_present = {col: (col in columns) for col in required}

# Attempt to get a stable session uid
session_uid = None
try:
    if hasattr(session, 'session_info') and session.session_info is not None:
        info = session.session_info
        if hasattr(info, 'get'):
            session_uid = info.get('SessionUid')
        elif hasattr(info, 'iloc'):
            try:
                session_uid = info['SessionUid'].iloc[0]
            except Exception:
                session_uid = None
except Exception:
    session_uid = None

try:
    event_name = session.event['EventName'] if hasattr(session, 'event') else ''
except Exception:
    event_name = ''

if not session_uid:
    session_uid = f"{season}-{round_num}-{session.name}-{event_name}"


def to_seconds(value):
    if value is None:
        return None
    try:
        if str(value) == 'NaT':
            return None
    except Exception:
        pass
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
    except Exception:
        pass
    try:
        return value.total_seconds()
    except Exception:
        try:
            numeric = float(value)
            if math.isnan(numeric):
                return None
            return numeric
        except Exception:
            return None

def to_int(value):
    if value is None:
        return None
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
    except Exception:
        pass
    try:
        return int(value)
    except Exception:
        return None

rows = []
for _, row in laps.iterrows():
    rows.append({
        'driver_code': row['Driver'] if 'Driver' in row else None,
        'lap_number': to_int(row.get('LapNumber')),
        'lap_time_seconds': to_seconds(row.get('LapTime')),
        'lap_end_time_seconds': to_seconds(row.get('Time')),
        'is_accurate': bool(row.get('IsAccurate')) if row.get('IsAccurate') is not None else None,
        'pit_in': row.get('PitInTime') is not None,
        'pit_out': row.get('PitOutTime') is not None,
        'compound': row.get('Compound'),
        'tyre_life': to_int(row.get('TyreLife')),
        'position': to_int(row.get('Position')),
        'gap_to_leader': to_seconds(row.get('GapToLeader'))
    })

payload = {
    'season': season,
    'round': round_num,
    'session_name': session.name,
    'event_name': event_name,
    'session_uid': str(session_uid),
    'columns_present': columns_present,
    'laps': rows
}

print(json.dumps(payload))
`;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function resolvePythonPath(): string {
  if (process.env.FASTF1_PYTHON_PATH) {
    return process.env.FASTF1_PYTHON_PATH;
  }

  const venvPath = path.join(process.cwd(), 'venv', 'bin', 'python');
  if (fs.existsSync(venvPath)) {
    return venvPath;
  }

  return 'python3';
}

function ensureSeasonArgument(): number {
  const seasonArg = process.argv.slice(2)[0];
  if (!seasonArg) {
    throw new Error('FAIL_CLOSED: Season argument required. Usage: npm run ingest:season 2025');
  }

  const season = parseInt(seasonArg, 10);
  if (!Number.isInteger(season)) {
    throw new Error(`FAIL_CLOSED: Invalid season "${seasonArg}"`);
  }

  if (season !== TARGET_SEASON) {
    throw new Error(`FAIL_CLOSED: This ingestion script only supports season ${TARGET_SEASON}`);
  }

  return season;
}

async function fingerprintTable(pool: Pool, tableName: string): Promise<TableFingerprint> {
  const columnsResult = await pool.query(
    `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY column_name ASC
    `,
    [tableName]
  );

  const columns = columnsResult.rows.map(row => ({
    name: row.column_name as string,
    type: row.data_type as string
  }));

  const countResult = await pool.query(`SELECT COUNT(*) AS count FROM ${escapeIdentifier(tableName)}`);
  const row_count = parseInt(countResult.rows[0].count, 10);

  let last_updated: string | null = null;
  if (columns.some(column => column.name === 'updated_at')) {
    const updatedResult = await pool.query(`SELECT MAX(updated_at) AS max_updated FROM ${escapeIdentifier(tableName)}`);
    const maxUpdated = updatedResult.rows[0]?.max_updated;
    last_updated = maxUpdated ? new Date(maxUpdated).toISOString() : null;
  }

  return {
    table_name: tableName,
    columns,
    row_count,
    last_updated
  };
}

function escapeIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`FAIL_CLOSED: Invalid identifier "${identifier}"`);
  }
  return `"${identifier}"`;
}

function deriveAbbreviation(lastName?: string | null, name?: string | null): string | null {
  const source = (lastName || name || '').trim();
  if (!source) {
    return null;
  }

  const letters = source.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length < 3) {
    return null;
  }

  return letters.slice(0, 3);
}

function normalizeNameKey(value: string): string {
  const lowered = value.toLowerCase();
  let translated = '';

  for (const char of lowered) {
    const index = DIACRITICS_FROM.indexOf(char);
    translated += index >= 0 ? DIACRITICS_TO[index] : char;
  }

  return translated.replace(/[^a-z]/g, '');
}

function normalizeWords(value: string): string[] {
  const lowered = value.toLowerCase();
  let translated = '';

  for (const char of lowered) {
    const index = DIACRITICS_FROM.indexOf(char);
    translated += index >= 0 ? DIACRITICS_TO[index] : char;
  }

  const cleaned = translated.replace(/[^a-z]+/g, ' ').trim();
  if (!cleaned) {
    return [];
  }

  return cleaned.split(' ').filter(Boolean);
}

function slugifyDriverId(value: string): string | null {
  const words = normalizeWords(value);
  if (words.length === 0) {
    return null;
  }
  if (words.length === 1) {
    return words[0];
  }
  return `${words[0]}_${words[words.length - 1]}`;
}

async function resolveDriverIdByName(
  pool: Pool,
  lookup: { driver_id?: string; first_name?: string; last_name?: string; full_name?: string },
  code: string
): Promise<string> {
  if (lookup.driver_id) {
    if (!/^[a-z0-9_]+$/.test(lookup.driver_id)) {
      throw new Error(`FAIL_CLOSED: Override code ${code} has invalid driver_id ${lookup.driver_id}`);
    }
    return lookup.driver_id;
  }

  if (lookup.full_name) {
    const result = await pool.query(
      `SELECT id FROM driver WHERE LOWER(full_name) = LOWER($1)`,
      [lookup.full_name]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id as string;
    }
    if (result.rows.length > 1) {
      throw new Error(`FAIL_CLOSED: Multiple drivers matched full_name "${lookup.full_name}"`);
    }
  }

  if (lookup.first_name && lookup.last_name) {
    const result = await pool.query(
      `SELECT id FROM driver WHERE LOWER(first_name) = LOWER($1) AND LOWER(last_name) = LOWER($2)`,
      [lookup.first_name, lookup.last_name]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id as string;
    }
    if (result.rows.length > 1) {
      throw new Error(
        `FAIL_CLOSED: Multiple drivers matched ${lookup.first_name} ${lookup.last_name}`
      );
    }
  }

  if (lookup.last_name) {
    const result = await pool.query(
      `SELECT id FROM driver WHERE LOWER(last_name) = LOWER($1)`,
      [lookup.last_name]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id as string;
    }
    if (result.rows.length > 1) {
      throw new Error(`FAIL_CLOSED: Multiple drivers matched last_name "${lookup.last_name}"`);
    }
  }

  if (lookup.last_name) {
    const result = await pool.query(
      `SELECT id FROM driver WHERE LOWER(name) = LOWER($1)`,
      [lookup.last_name]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id as string;
    }
    if (result.rows.length > 1) {
      throw new Error(`FAIL_CLOSED: Multiple drivers matched name "${lookup.last_name}"`);
    }
  }

  const normalizedTarget = normalizeNameKey(
    lookup.full_name || `${lookup.first_name || ''} ${lookup.last_name || ''}`.trim() || lookup.last_name || ''
  );

  if (normalizedTarget) {
    const normalizedFullName = `regexp_replace(translate(lower(full_name), '${DIACRITICS_FROM}', '${DIACRITICS_TO}'), '[^a-z]', '', 'g')`;
    const result = await pool.query(
      `SELECT id FROM driver WHERE ${normalizedFullName} = $1`,
      [normalizedTarget]
    );
    if (result.rows.length === 1) {
      return result.rows[0].id as string;
    }
    if (result.rows.length > 1) {
      throw new Error(`FAIL_CLOSED: Multiple drivers matched normalized full_name for override code ${code}`);
    }

    const normalizedName = `regexp_replace(translate(lower(name), '${DIACRITICS_FROM}', '${DIACRITICS_TO}'), '[^a-z]', '', 'g')`;
    const nameResult = await pool.query(
      `SELECT id FROM driver WHERE ${normalizedName} = $1`,
      [normalizedTarget]
    );
    if (nameResult.rows.length === 1) {
      return nameResult.rows[0].id as string;
    }
    if (nameResult.rows.length > 1) {
      throw new Error(`FAIL_CLOSED: Multiple drivers matched normalized name for override code ${code}`);
    }
  }

  const fallbackName =
    lookup.full_name ||
    [lookup.first_name, lookup.last_name].filter(Boolean).join(' ').trim() ||
    lookup.last_name ||
    '';

  const fallbackId = fallbackName ? slugifyDriverId(fallbackName) : null;
  if (!fallbackId) {
    throw new Error(`FAIL_CLOSED: Unable to resolve driver id for override mapping ${code}`);
  }

  console.log(`WARN: Using derived driver_id "${fallbackId}" for override code ${code}`);
  return fallbackId;
}

async function computeTableSnapshotVersion(pool: Pool): Promise<string> {
  const tables = ['season', 'race', 'driver', 'season_entrant_driver'];
  const fingerprints: TableFingerprint[] = [];

  for (const table of tables) {
    fingerprints.push(await fingerprintTable(pool, table));
  }

  const snapshotPayload = JSON.stringify(
    fingerprints.map(fp => ({
      table_name: fp.table_name,
      row_count: fp.row_count,
      last_updated: fp.last_updated,
      columns: fp.columns
    }))
  );

  return sha256(snapshotPayload);
}

async function validateLapsSchema(pool: Pool): Promise<void> {
  const requiredColumns = [
    'season',
    'round',
    'track_id',
    'driver_id',
    'lap_number',
    'stint_id',
    'stint_lap_index',
    'lap_time_seconds',
    'is_valid_lap',
    'is_pit_lap',
    'is_out_lap',
    'is_in_lap',
    'clean_air_flag',
    'compound',
    'tyre_age_laps'
  ];

  const result = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'laps_normalized'
    `
  );

  if (result.rows.length === 0) {
    throw new Error('FAIL_CLOSED: laps_normalized table not found');
  }

  const existing = new Set<string>(result.rows.map(row => row.column_name));
  const missing = requiredColumns.filter(column => !existing.has(column));

  if (missing.length > 0) {
    throw new Error(
      `FAIL_CLOSED: laps_normalized missing required columns: ${missing.join(', ')}`
    );
  }
}

async function loadSeasonRaces(pool: Pool, season: number): Promise<RaceInfo[]> {
  const result = await pool.query(
    `
    SELECT
      id AS race_id,
      round,
      circuit_id,
      grand_prix_id,
      official_name,
      free_practice_1_date,
      free_practice_2_date,
      free_practice_3_date,
      free_practice_4_date,
      qualifying_date,
      sprint_qualifying_date,
      sprint_race_date,
      warming_up_date,
      pre_qualifying_date,
      qualifying_1_date,
      qualifying_2_date
    FROM race
    WHERE year = $1
    ORDER BY round ASC
    `,
    [season]
  );

  if (result.rows.length === 0) {
    throw new Error(`FAIL_CLOSED: No races found for season ${season}`);
  }

  const rounds = new Set<number>();
  const races: RaceInfo[] = result.rows.map(row => {
    const sessionFields = [
      row.free_practice_1_date,
      row.free_practice_2_date,
      row.free_practice_3_date,
      row.free_practice_4_date,
      row.qualifying_date,
      row.sprint_qualifying_date,
      row.sprint_race_date,
      row.warming_up_date,
      row.pre_qualifying_date,
      row.qualifying_1_date,
      row.qualifying_2_date
    ];

    const hasSession = sessionFields.some(value => value !== null);

    return {
      race_id: Number(row.race_id),
      round: Number(row.round),
      circuit_id: row.circuit_id,
      grand_prix_id: row.grand_prix_id,
      official_name: row.official_name,
      has_session_mapping: hasSession
    };
  });

  for (const race of races) {
    if (rounds.has(race.round)) {
      throw new Error(`FAIL_CLOSED: Duplicate round ${race.round} detected in race table`);
    }
    rounds.add(race.round);

    if (!race.has_session_mapping) {
      throw new Error(`FAIL_CLOSED: Race round ${race.round} missing session mapping`);
    }
  }

  return races;
}

async function validateSeasonEntrants(pool: Pool, season: number): Promise<SeasonValidationResult> {
  const seasonResult = await pool.query(
    `SELECT year FROM season WHERE year = $1`,
    [season]
  );

  if (seasonResult.rows.length === 0) {
    throw new Error(`FAIL_CLOSED: Season ${season} not found in season table`);
  }

  const entrantsResult = await pool.query(
    `
    SELECT driver_id
    FROM season_entrant_driver
    WHERE year = $1
      AND test_driver IS NOT TRUE
    `,
    [season]
  );

  if (entrantsResult.rows.length === 0) {
    throw new Error(`FAIL_CLOSED: No season entrants found for ${season}`);
  }

  const missingDrivers = await pool.query(
    `
    SELECT sed.driver_id
    FROM season_entrant_driver sed
    LEFT JOIN driver d ON d.id = sed.driver_id
    WHERE sed.year = $1
      AND sed.test_driver IS NOT TRUE
      AND d.id IS NULL
    `,
    [season]
  );

  if (missingDrivers.rows.length > 0) {
    const ids = missingDrivers.rows.map(row => row.driver_id).join(', ');
    throw new Error(`FAIL_CLOSED: Season entrants include non-canonical driver IDs: ${ids}`);
  }

  const driverRows = await pool.query(
    `
    SELECT d.id, d.abbreviation, d.last_name, d.name
    FROM season_entrant_driver sed
    JOIN driver d ON d.id = sed.driver_id
    WHERE sed.year = $1
      AND sed.test_driver IS NOT TRUE
    `,
    [season]
  );

  const abbreviationToDriverId = new Map<string, string>();
  for (const row of driverRows.rows) {
    const driverId = row.id as string;
    const abbreviationRaw = row.abbreviation ? String(row.abbreviation).trim().toUpperCase() : '';

    const fallback = deriveAbbreviation(row.last_name, row.name);

    if (abbreviationRaw) {
      const existing = abbreviationToDriverId.get(abbreviationRaw);
      if (existing && existing !== driverId) {
        throw new Error(
          `FAIL_CLOSED: Duplicate driver abbreviation ${abbreviationRaw} within season entrants maps to ${existing} and ${driverId}`
        );
      }
      abbreviationToDriverId.set(abbreviationRaw, driverId);
    }

    if (fallback) {
      const existingFallback = abbreviationToDriverId.get(fallback);
      if (existingFallback && existingFallback !== driverId) {
        throw new Error(
          `FAIL_CLOSED: Derived abbreviation ${fallback} within season entrants maps to ${existingFallback} and ${driverId}`
        );
      }
      abbreviationToDriverId.set(fallback, driverId);
    }

    if (!abbreviationRaw && !fallback) {
      throw new Error(`FAIL_CLOSED: Missing abbreviation for driver ${driverId} and cannot derive fallback`);
    }
  }

  const seasonDriverIds = new Set<string>(
    entrantsResult.rows.map(row => row.driver_id as string)
  );

  for (const [code, lookup] of Object.entries(FASTF1_CODE_OVERRIDES)) {
    const driverId = await resolveDriverIdByName(pool, lookup, code);

    const existing = abbreviationToDriverId.get(code);
    if (existing && existing !== driverId) {
      throw new Error(
        `FAIL_CLOSED: Override code ${code} conflicts with existing mapping (${existing} vs ${driverId})`
      );
    }
    abbreviationToDriverId.set(code, driverId);
  }

  const allowedDriverIds = new Set<string>([
    ...seasonDriverIds,
    ...abbreviationToDriverId.values()
  ]);

  return {
    season_driver_ids: seasonDriverIds,
    allowed_driver_ids: allowedDriverIds,
    abbreviation_to_driver_id: abbreviationToDriverId
  };
}

function fetchFastF1Session(season: number, round: number): FastF1SessionPayload {
  const pythonPath = resolvePythonPath();
  const result = spawnSync(
    pythonPath,
    ['-c', FASTF1_SCRIPT, String(season), String(round), 'R'],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      }
    }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    const stdout = result.stdout?.trim() || '';
    throw new Error(`FAIL_CLOSED: FastF1 session load failed (round ${round}). ${stderr || stdout}`);
  }

  const output = result.stdout?.trim();
  if (!output) {
    throw new Error(`FAIL_CLOSED: FastF1 session returned empty output (round ${round})`);
  }

  try {
    return JSON.parse(output) as FastF1SessionPayload;
  } catch (err) {
    throw new Error(`FAIL_CLOSED: FastF1 session JSON parse failed (round ${round}): ${err}`);
  }
}

function validateFastF1Columns(session: FastF1SessionPayload): void {
  for (const column of REQUIRED_LAPS_COLUMNS) {
    if (!session.columns_present[column]) {
      throw new Error(`FAIL_CLOSED: Missing telemetry column "${column}" in FastF1 data`);
    }
  }

  const hasGap = session.columns_present.GapToLeader;
  const hasTime = session.columns_present.Time;
  if (!hasGap && !hasTime) {
    throw new Error('FAIL_CLOSED: Missing telemetry column "GapToLeader" and "Time" in FastF1 data');
  }
}

function normalizeLaps(
  session: FastF1SessionPayload,
  race: RaceInfo,
  abbreviationToDriverId: Map<string, string>,
  allowedDriverIds: Set<string>
): NormalizedLapDraft[] {
  validateFastF1Columns(session);

  if (!session.laps || session.laps.length === 0) {
    throw new Error('FAIL_CLOSED: No lap data returned by FastF1');
  }

  const hasTiming = session.laps.some(lap => lap.lap_time_seconds !== null);
  if (!hasTiming) {
    throw new Error('FAIL_CLOSED: Session timing missing');
  }

  const hasGapToLeader = session.laps.some(
    lap => lap.gap_to_leader !== null && Number.isFinite(lap.gap_to_leader)
  );
  const hasLapEndTime = session.laps.some(
    lap => lap.lap_end_time_seconds !== null && Number.isFinite(lap.lap_end_time_seconds)
  );
  const hasPosition = session.laps.some(
    lap => lap.position !== null && Number.isFinite(lap.position)
  );

  if (!hasGapToLeader && !hasLapEndTime) {
    throw new Error('FAIL_CLOSED: Telemetry mapping missing (gap/time)');
  }

  if (!hasPosition && !hasLapEndTime) {
    throw new Error('FAIL_CLOSED: Telemetry mapping missing (position/time)');
  }

  const unknownDrivers = new Set<string>();
  const rawLaps: NormalizedLapDraft[] = [];

  for (const lap of session.laps) {
    if (lap.lap_number === null || lap.lap_number <= 0) {
      continue;
    }

    const driverCode = lap.driver_code ? lap.driver_code.trim().toUpperCase() : '';
    const driverId = driverCode ? abbreviationToDriverId.get(driverCode) : undefined;

    if (!driverId) {
      if (driverCode) {
        unknownDrivers.add(driverCode);
      }
      continue;
    }

    if (!allowedDriverIds.has(driverId)) {
      unknownDrivers.add(driverCode);
      continue;
    }

    const isValidLap = lap.is_accurate !== false;
    if (!isValidLap || lap.lap_time_seconds === null || !Number.isFinite(lap.lap_time_seconds)) {
      continue;
    }

    const isPitLap = lap.pit_in || lap.pit_out;
    const isOutLap = lap.pit_out;
    const isInLap = lap.pit_in;

    rawLaps.push({
      season: TARGET_SEASON,
      round: race.round,
      track_id: race.circuit_id,
      driver_id: driverId,
      lap_number: lap.lap_number,
      lap_time_seconds: Number(lap.lap_time_seconds.toFixed(3)),
      lap_end_time_seconds: lap.lap_end_time_seconds ?? null,
      is_valid_lap: true,
      is_pit_lap: isPitLap,
      is_out_lap: isOutLap,
      is_in_lap: isInLap,
      compound: lap.compound || null,
      tyre_age_laps: lap.tyre_life ?? null,
      position: lap.position ?? null,
      gap_to_leader: lap.gap_to_leader ?? null
    });
  }

  if (unknownDrivers.size > 0) {
    throw new Error(`FAIL_CLOSED: Unknown driver codes in FastF1 data: ${Array.from(unknownDrivers).join(', ')}`);
  }

  const uniqueDrivers = new Set(rawLaps.map(lap => lap.driver_id));
  if (uniqueDrivers.size < MIN_DRIVERS_PER_RACE) {
    throw new Error(`FAIL_CLOSED: Only ${uniqueDrivers.size} drivers with valid laps`);
  }

  validateLapOrdering(rawLaps);

  return rawLaps;
}

function validateLapOrdering(laps: NormalizedLapDraft[]): void {
  const lapsByDriver = new Map<string, NormalizedLapDraft[]>();

  for (const lap of laps) {
    if (!lapsByDriver.has(lap.driver_id)) {
      lapsByDriver.set(lap.driver_id, []);
    }
    lapsByDriver.get(lap.driver_id)!.push(lap);
  }

  for (const [driverId, driverLaps] of lapsByDriver.entries()) {
    driverLaps.sort((a, b) => a.lap_number - b.lap_number);
    let previousLap = 0;
    const seen = new Set<number>();

    for (const lap of driverLaps) {
      if (seen.has(lap.lap_number)) {
        throw new Error(`FAIL_CLOSED: Duplicate lap number ${lap.lap_number} for driver ${driverId}`);
      }
      if (lap.lap_number <= previousLap) {
        throw new Error(`FAIL_CLOSED: Non-increasing lap order for driver ${driverId}`);
      }
      seen.add(lap.lap_number);
      previousLap = lap.lap_number;
    }
  }
}

function computeStints(laps: NormalizedLapDraft[]): NormalizedLapDraft[] {
  const lapsByDriver = new Map<string, NormalizedLapDraft[]>();

  for (const lap of laps) {
    if (!lapsByDriver.has(lap.driver_id)) {
      lapsByDriver.set(lap.driver_id, []);
    }
    lapsByDriver.get(lap.driver_id)!.push(lap);
  }

  for (const driverLaps of lapsByDriver.values()) {
    driverLaps.sort((a, b) => a.lap_number - b.lap_number);

    let stintId = 1;
    let stintLapIndex = 1;
    let previousCompound: string | null = null;

    for (const lap of driverLaps) {
      const compoundChanged =
        previousCompound !== null && lap.compound !== null && lap.compound !== previousCompound;
      const isFirstLap = previousCompound === null;
      const newStint = !isFirstLap && (compoundChanged || lap.is_out_lap);

      if (newStint) {
        stintId += 1;
        stintLapIndex = 1;
      }

      lap.stint_id = stintId;
      lap.stint_lap_index = stintLapIndex;

      stintLapIndex += 1;
      if (lap.compound) {
        previousCompound = lap.compound;
      }
    }
  }

  return laps;
}

function computeCleanAir(laps: NormalizedLapDraft[]): NormalizedLapDraft[] {
  const lapsByNumber = new Map<number, NormalizedLapDraft[]>();

  for (const lap of laps) {
    if (!lapsByNumber.has(lap.lap_number)) {
      lapsByNumber.set(lap.lap_number, []);
    }
    lapsByNumber.get(lap.lap_number)!.push(lap);
  }

  for (const lapGroup of lapsByNumber.values()) {
    const hasPosition = lapGroup.some(lap => lap.position !== null);

    lapGroup.sort((a, b) => {
      const posA = a.position ?? Number.MAX_SAFE_INTEGER;
      const posB = b.position ?? Number.MAX_SAFE_INTEGER;

      if (hasPosition && posA !== Number.MAX_SAFE_INTEGER && posB !== Number.MAX_SAFE_INTEGER) {
        return posA - posB;
      }

      const timeA = a.lap_end_time_seconds ?? Number.MAX_SAFE_INTEGER;
      const timeB = b.lap_end_time_seconds ?? Number.MAX_SAFE_INTEGER;
      return timeA - timeB;
    });

    for (const lap of lapGroup) {
      const position = lap.position;
      const isLeader = position === 1 || (!hasPosition && lap === lapGroup[0]);

      if (isLeader) {
        lap.clean_air_flag = true;
        continue;
      }

      const ahead = hasPosition
        ? lapGroup.find(candidate => candidate.position === (position ?? -1) - 1)
        : lapGroup[lapGroup.indexOf(lap) - 1];

      if (!ahead) {
        lap.clean_air_flag = false;
        continue;
      }

      if (lap.gap_to_leader !== null && lap.gap_to_leader !== undefined &&
          ahead.gap_to_leader !== null && ahead.gap_to_leader !== undefined) {
        const gapToAhead = lap.gap_to_leader - ahead.gap_to_leader;
        lap.clean_air_flag = gapToAhead >= CLEAN_AIR_GAP_THRESHOLD;
        continue;
      }

      if (lap.lap_end_time_seconds !== null && lap.lap_end_time_seconds !== undefined &&
          ahead.lap_end_time_seconds !== null && ahead.lap_end_time_seconds !== undefined) {
        const gapToAhead = lap.lap_end_time_seconds - ahead.lap_end_time_seconds;
        lap.clean_air_flag = gapToAhead >= CLEAN_AIR_GAP_THRESHOLD;
        continue;
      }

      lap.clean_air_flag = false;
    }
  }

  return laps;
}

function finalizeLaps(laps: NormalizedLapDraft[]): NormalizedLap[] {
  return laps.map(lap => {
    if (lap.stint_id === undefined || lap.stint_id === null ||
        lap.stint_lap_index === undefined || lap.stint_lap_index === null ||
        lap.clean_air_flag === undefined || lap.clean_air_flag === null) {
      throw new Error('FAIL_CLOSED: Missing stint or clean air data during normalization');
    }

    const finalLap: NormalizedLap = {
      season: lap.season,
      round: lap.round,
      track_id: lap.track_id,
      driver_id: lap.driver_id,
      lap_number: lap.lap_number,
      lap_time_seconds: lap.lap_time_seconds,
      lap_end_time_seconds: lap.lap_end_time_seconds,
      is_valid_lap: lap.is_valid_lap,
      is_pit_lap: lap.is_pit_lap,
      is_out_lap: lap.is_out_lap,
      is_in_lap: lap.is_in_lap,
      compound: lap.compound,
      tyre_age_laps: lap.tyre_age_laps,
      position: lap.position,
      gap_to_leader: lap.gap_to_leader,
      stint_id: lap.stint_id,
      stint_lap_index: lap.stint_lap_index,
      clean_air_flag: lap.clean_air_flag
    };
    return finalLap;
  });
}

function computeRaceExecutionHash(
  season: number,
  raceId: number,
  sessionUid: string,
  tableSnapshotVersion: string
): string {
  const payload = `${SQL_TEMPLATE}|${season}|${raceId}|${sessionUid}|${tableSnapshotVersion}`;
  return sha256(payload);
}

function normalizeHashValue(value: unknown, decimals?: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (decimals !== null) {
      return value.toFixed(decimals);
    }
    return `${Math.trunc(value)}`;
  }
  return String(value);
}

function computeLapRowsHash(laps: NormalizedLap[]): string {
  const sorted = [...laps].sort((a, b) => {
    if (a.driver_id === b.driver_id) {
      return a.lap_number - b.lap_number;
    }
    return a.driver_id.localeCompare(b.driver_id);
  });

  const lines = sorted.map(lap => {
    return [
      lap.season,
      lap.round,
      lap.track_id,
      lap.driver_id,
      lap.lap_number,
      normalizeHashValue(lap.stint_id),
      normalizeHashValue(lap.stint_lap_index),
      normalizeHashValue(lap.lap_time_seconds, 3),
      normalizeHashValue(lap.is_valid_lap),
      normalizeHashValue(lap.is_pit_lap),
      normalizeHashValue(lap.is_out_lap),
      normalizeHashValue(lap.is_in_lap),
      normalizeHashValue(lap.clean_air_flag),
      normalizeHashValue(lap.compound),
      normalizeHashValue(lap.tyre_age_laps)
    ].join('|');
  });

  return sha256(lines.join('\n'));
}

async function loadExistingLapHash(
  client: PoolClient,
  season: number,
  round: number,
  trackId: string
): Promise<{ hash: string; count: number } | null> {
  const trackRows = await client.query(
    `
    SELECT DISTINCT track_id
    FROM laps_normalized
    WHERE season = $1
      AND round = $2
    `,
    [season, round]
  );

  if (trackRows.rows.length === 0) {
    return null;
  }

  const existingTrackIds = trackRows.rows.map(row => row.track_id);
  if (existingTrackIds.some(id => id !== trackId)) {
    throw new Error(
      `FAIL_CLOSED: Existing laps_normalized rows for round ${round} have mismatched track_id`
    );
  }

  const rows = await client.query(
    `
    SELECT
      season,
      round,
      track_id,
      driver_id,
      lap_number,
      stint_id,
      stint_lap_index,
      lap_time_seconds,
      is_valid_lap,
      is_pit_lap,
      is_out_lap,
      is_in_lap,
      clean_air_flag,
      compound,
      tyre_age_laps
    FROM laps_normalized
    WHERE season = $1
      AND round = $2
      AND track_id = $3
    ORDER BY driver_id, lap_number
    `,
    [season, round, trackId]
  );

  const normalized = rows.rows.map(row => ({
    season: Number(row.season),
    round: Number(row.round),
    track_id: row.track_id as string,
    driver_id: row.driver_id as string,
    lap_number: Number(row.lap_number),
    stint_id: Number(row.stint_id),
    stint_lap_index: Number(row.stint_lap_index),
    lap_time_seconds: Number(row.lap_time_seconds),
    is_valid_lap: Boolean(row.is_valid_lap),
    is_pit_lap: Boolean(row.is_pit_lap),
    is_out_lap: Boolean(row.is_out_lap),
    is_in_lap: Boolean(row.is_in_lap),
    clean_air_flag: Boolean(row.clean_air_flag),
    compound: row.compound as string | null,
    tyre_age_laps: row.tyre_age_laps !== null ? Number(row.tyre_age_laps) : null
  })) as NormalizedLap[];

  return {
    hash: computeLapRowsHash(normalized),
    count: normalized.length
  };
}

async function insertRoundLaps(
  client: PoolClient,
  race: RaceInfo,
  laps: NormalizedLap[],
  executionHash: string
): Promise<{ status: 'success' | 'skipped'; lapsInserted: number }> {
  const existing = await loadExistingLapHash(client, TARGET_SEASON, race.round, race.circuit_id);
  const newHash = computeLapRowsHash(laps);

  if (existing) {
    if (existing.hash === newHash) {
      return { status: 'skipped', lapsInserted: 0 };
    }
    throw new HashMismatchError(
      `FAIL_CLOSED: Hash mismatch for round ${race.round}. Existing count ${existing.count}, new count ${laps.length}`
    );
  }

  const columnList = [
    'season',
    'round',
    'track_id',
    'driver_id',
    'lap_number',
    'stint_id',
    'stint_lap_index',
    'lap_time_seconds',
    'is_valid_lap',
    'is_pit_lap',
    'is_out_lap',
    'is_in_lap',
    'clean_air_flag',
    'compound',
    'tyre_age_laps'
  ];

  const valuesPerRow = columnList.length;
  const batchSize = 500;

  for (let i = 0; i < laps.length; i += batchSize) {
    const batch = laps.slice(i, i + batchSize);
    const values: any[] = [];
    const placeholders: string[] = [];

    batch.forEach((lap, idx) => {
      const baseIndex = idx * valuesPerRow;
      placeholders.push(
        `(${columnList.map((_, colIdx) => `$${baseIndex + colIdx + 1}`).join(', ')})`
      );

      values.push(
        lap.season,
        lap.round,
        lap.track_id,
        lap.driver_id,
        lap.lap_number,
        lap.stint_id,
        lap.stint_lap_index,
        lap.lap_time_seconds,
        lap.is_valid_lap,
        lap.is_pit_lap,
        lap.is_out_lap,
        lap.is_in_lap,
        lap.clean_air_flag,
        lap.compound,
        lap.tyre_age_laps
      );
    });

    const sql = `INSERT INTO laps_normalized (${columnList.join(', ')}) VALUES ${placeholders.join(', ')}`;
    await client.query(sql, values);
  }

  console.log(`  OK Inserted ${laps.length} laps (hash ${executionHash})`);
  return { status: 'success', lapsInserted: laps.length };
}

async function recordEtlRun(
  pool: Pool,
  season: number,
  metrics: EtlMetrics,
  startedAt: Date,
  finishedAt: Date
): Promise<void> {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS etl_runs_laps_normalized (
      run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      season integer NOT NULL,
      status text NOT NULL,
      races_processed integer NOT NULL,
      races_skipped integer NOT NULL,
      races_failed integer NOT NULL,
      total_laps_inserted integer NOT NULL,
      execution_hash text NOT NULL,
      started_at timestamp with time zone NOT NULL,
      finished_at timestamp with time zone NOT NULL,
      CONSTRAINT etl_runs_laps_normalized_pkey PRIMARY KEY (run_id)
    )
    `
  );

  await pool.query(
    `
    INSERT INTO etl_runs_laps_normalized (
      season,
      status,
      races_processed,
      races_skipped,
      races_failed,
      total_laps_inserted,
      execution_hash,
      started_at,
      finished_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      season,
      metrics.races_failed === 0 ? 'success' : 'partial_failure',
      metrics.races_processed,
      metrics.races_skipped,
      metrics.races_failed,
      metrics.total_laps_inserted,
      metrics.execution_hash,
      startedAt.toISOString(),
      finishedAt.toISOString()
    ]
  );
}

async function processRace(
  pool: Pool,
  race: RaceInfo,
  allowedDriverIds: Set<string>,
  abbreviationToDriverId: Map<string, string>,
  tableSnapshotVersion: string
): Promise<RaceOutcome> {
  console.log(`\n-> Processing round ${race.round}: ${race.official_name}`);

  try {
    const session = fetchFastF1Session(TARGET_SEASON, race.round);
    const executionHash = computeRaceExecutionHash(
      TARGET_SEASON,
      race.race_id,
      session.session_uid,
      tableSnapshotVersion
    );

    console.log(`  * FastF1 session: ${session.event_name} (${session.session_name})`);
    console.log(`  * Execution hash: ${executionHash}`);

    const normalized = normalizeLaps(session, race, abbreviationToDriverId, allowedDriverIds);

    const withStints = computeStints(normalized);
    const withCleanAir = computeCleanAir(withStints);
    const finalLaps = finalizeLaps(withCleanAir);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertResult = await insertRoundLaps(client, race, finalLaps, executionHash);
      await client.query('COMMIT');

      return {
        round: race.round,
        race_id: race.race_id,
        status: insertResult.status,
        laps_inserted: insertResult.lapsInserted,
        execution_hash: executionHash
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof HashMismatchError) {
      throw err;
    }
    return {
      round: race.round,
      race_id: race.race_id,
      status: 'failed',
      laps_inserted: 0,
      execution_hash: 'n/a',
      failure_reason: String(err)
    };
  }
}

async function main(): Promise<void> {
  const season = ensureSeasonArgument();

  console.log('\n=== LAPS NORMALIZED SEASON INGESTION (2025) ===\n');
  console.log(`Season: ${season}`);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('FAIL_CLOSED: DATABASE_URL not set');
  }

  const pool = new Pool({ connectionString: dbUrl });
  const startedAt = new Date();

  try {
    const races = await loadSeasonRaces(pool, season);
    await validateLapsSchema(pool);
    const validation = await validateSeasonEntrants(pool, season);
    const tableSnapshotVersion = await computeTableSnapshotVersion(pool);

    console.log(`OK Preflight validation passed (${races.length} races)`);
    console.log(`OK Table snapshot version: ${tableSnapshotVersion}`);

    const metrics: EtlMetrics = {
      races_processed: 0,
      races_skipped: 0,
      races_failed: 0,
      total_laps_inserted: 0,
      execution_hash: ''
    };

    const raceHashes: string[] = [];
    const failures: Array<{ round: number; reason: string }> = [];

    let aborted = false;

    for (const race of races) {
      let outcome: RaceOutcome | null = null;

      try {
        outcome = await processRace(
          pool,
          race,
          validation.allowed_driver_ids,
          validation.abbreviation_to_driver_id,
          tableSnapshotVersion
        );
      } catch (err) {
        if (err instanceof HashMismatchError) {
          aborted = true;
          metrics.races_failed += 1;
          failures.push({ round: race.round, reason: String(err) });
          console.log(`  -> Round ${race.round} status: failed`);
          console.log(`  -> Failure reason: ${err}`);
          break;
        }
        throw err;
      }

      if (!outcome) {
        continue;
      }

      if (outcome.status === 'success') {
        metrics.races_processed += 1;
        metrics.total_laps_inserted += outcome.laps_inserted;
      } else if (outcome.status === 'skipped') {
        metrics.races_skipped += 1;
      } else {
        metrics.races_failed += 1;
        failures.push({
          round: outcome.round,
          reason: outcome.failure_reason || 'unknown error'
        });
      }

      if (outcome.execution_hash !== 'n/a') {
        raceHashes.push(outcome.execution_hash);
      }

      console.log(`  -> Round ${outcome.round} status: ${outcome.status}`);
      if (outcome.failure_reason) {
        console.log(`  -> Failure reason: ${outcome.failure_reason}`);
      }
    }

    if (aborted) {
      console.log('\nFAIL_CLOSED: Aborting remaining races due to hash mismatch.');
    }

    metrics.execution_hash = sha256(`season:${season}|` + raceHashes.sort().join('|'));

    const finishedAt = new Date();
    await recordEtlRun(pool, season, metrics, startedAt, finishedAt);

    console.log('\n=== INGESTION SUMMARY ===\n');
    console.log(`Execution hash: ${metrics.execution_hash}`);
    console.log(`Races processed: ${metrics.races_processed}`);
    console.log(`Races skipped:   ${metrics.races_skipped}`);
    console.log(`Races failed:    ${metrics.races_failed}`);
    console.log(`Total laps inserted: ${metrics.total_laps_inserted}`);

    if (failures.length > 0) {
      console.log('\nFailures:');
      for (const failure of failures) {
        console.log(`- Round ${failure.round}: ${failure.reason}`);
      }
    }

    if (metrics.races_failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(`\nFAIL_CLOSED: ${err}`);
  process.exitCode = 1;
});
