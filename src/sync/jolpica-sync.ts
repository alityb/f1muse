/**
 * Jolpica Sync — TypeScript port of ingest-from-jolpica.py
 *
 * Syncs race results and standings from api.jolpi.ca (Ergast successor).
 * Pure HTTP + SQL — no Python, no external tools, runs inside the Node process.
 *
 * Returns the number of new race rounds that had data inserted/updated,
 * so callers can decide whether to trigger downstream ETL.
 */

import { Pool } from 'pg';
import https from 'https';

const BASE_URL = 'https://api.jolpi.ca/ergast/f1';
const CURRENT_SEASON = 2026;
const PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// ID mappings (mirrors ingest-from-jolpica.py)
// ---------------------------------------------------------------------------
const JOLPICA_TO_F1DB_CONSTRUCTOR: Record<string, string> = {
  mercedes: 'mercedes', mclaren: 'mclaren', red_bull: 'red-bull',
  ferrari: 'ferrari', aston_martin: 'aston-martin', alpine: 'alpine',
  williams: 'williams', haas: 'haas', rb: 'racing-bulls',
  racing_bulls: 'racing-bulls', kick_sauber: 'audi', sauber: 'audi',
  audi: 'audi', cadillac: 'cadillac', alphatauri: 'racing-bulls',
};

const JOLPICA_TO_F1DB_DRIVER: Record<string, string> = {
  antonelli: 'kimi-antonelli', russell: 'george-russell',
  norris: 'lando-norris', piastri: 'oscar-piastri',
  leclerc: 'charles-leclerc', hamilton: 'lewis-hamilton',
  max_verstappen: 'max-verstappen', hadjar: 'isack-hadjar',
  albon: 'alexander-albon', sainz: 'carlos-sainz-jr',
  bortoleto: 'gabriel-bortoleto', hulkenberg: 'nico-hulkenberg',
  bearman: 'oliver-bearman', ocon: 'esteban-ocon', gasly: 'pierre-gasly',
  colapinto: 'franco-colapinto', alonso: 'fernando-alonso',
  stroll: 'lance-stroll', perez: 'sergio-perez', bottas: 'valtteri-bottas',
  lawson: 'liam-lawson', lindblad: 'arvid-lindblad',
  doohan: 'jack-doohan', tsunoda: 'yuki-tsunoda', zhou: 'guanyu-zhou',
  ricciardo: 'daniel-ricciardo', magnussen: 'kevin-magnussen',
};

const ENGINE_BY_CONSTRUCTOR: Record<string, string> = {
  mercedes: 'mercedes', mclaren: 'mercedes', williams: 'mercedes', alpine: 'mercedes',
  ferrari: 'ferrari', haas: 'ferrari', cadillac: 'ferrari',
  'red-bull': 'red-bull-ford', 'racing-bulls': 'red-bull-ford',
  'aston-martin': 'honda', audi: 'audi',
};

const FINISHED_STATUSES = new Set(['Finished', 'Lapped']);
type JolpicaFetcher = (path: string) => Promise<any>;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function fetchJolpicaPage(path: string, offset: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}?format=json&limit=${PAGE_LIMIT}&offset=${offset}`;
    const req = https.get(url, { headers: { 'User-Agent': 'f1muse/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).MRData ?? {}); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

export function mergeRacePage(target: any[], pageRaces: any[]): void {
  const byRace = new Map(target.map((race) => [`${race.season}:${race.round}`, race]));

  for (const race of pageRaces) {
    const key = `${race.season}:${race.round}`;
    const existing = byRace.get(key);
    if (!existing) {
      target.push(race);
      byRace.set(key, race);
      continue;
    }

    for (const field of ['Results', 'QualifyingResults', 'SprintResults', 'SprintQualifyingResults']) {
      if (Array.isArray(race[field])) {
        existing[field] = [...(existing[field] ?? []), ...race[field]];
      }
    }
  }
}

export function parseResultPosition(positionText: string | null | undefined): number | null {
  if (!positionText) {
    return null;
  }

  const parsed = parseInt(positionText, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function classifyRaceResultStatus(status: string | null | undefined): string | null {
  if (!status || FINISHED_STATUSES.has(status) || status.startsWith('+')) {
    return null;
  }
  return status;
}

async function fetchJolpica(path: string): Promise<any> {
  let offset = 0;
  let merged: any | null = null;
  const mergedRaces: any[] = [];
  let hasMore = true;

  while (hasMore) {
    const page = await fetchJolpicaPage(path, offset);
    const pageRaces = page.RaceTable?.Races;

    if (!Array.isArray(pageRaces)) {
      return page;
    }

    if (!merged) {
      merged = { ...page, RaceTable: { ...page.RaceTable, Races: mergedRaces } };
    }

    mergeRacePage(mergedRaces, pageRaces);

    const total = parseInt(page.total ?? '0', 10);
    const limit = parseInt(page.limit ?? String(PAGE_LIMIT), 10);
    offset += limit;

    hasMore = Boolean(total && offset < total);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------
function mapDriver(id: string): string {
  return JOLPICA_TO_F1DB_DRIVER[id] ?? id.replace(/_/g, '-');
}
function mapConstructor(id: string): string {
  return JOLPICA_TO_F1DB_CONSTRUCTOR[id] ?? id.replace(/_/g, '-');
}
function parseLapTimeMs(t: string | null | undefined): number | null {
  if (!t) {
    return null;
  }
  try {
    const parts = t.split(':');
    if (parts.length === 2) {
      return Math.round((parseInt(parts[0]) * 60 + parseFloat(parts[1])) * 1000);
    }
    return Math.round(parseFloat(t) * 1000);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync race results → race_data RACE_RESULT
// Returns the round numbers that were newly inserted (not previously loaded)
// ---------------------------------------------------------------------------
export async function syncResults(
  pool: Pool,
  season = CURRENT_SEASON,
  fetcher: JolpicaFetcher = fetchJolpica
): Promise<number[]> {
  const mrdata = await fetcher(`/${season}/results/`);
  const races: any[] = mrdata.RaceTable?.Races ?? [];
  if (!races.length) {
    return [];
  }

  const newRoundNumbers: number[] = [];
  const client = await pool.connect();

  try {
    for (const race of races) {
      const rnd = parseInt(race.round);

      const raceRow = await client.query(
        'SELECT id FROM race WHERE year = $1 AND round = $2',
        [season, rnd]
      );
      if (!raceRow.rows[0]) {
        continue;
      }
      const raceId = raceRow.rows[0].id;

      // Check if we already have this round's data
      const existing = await client.query(
        'SELECT COUNT(*) AS n FROM race_data WHERE race_id = $1 AND type = $2',
        [raceId, 'RACE_RESULT']
      );
      const existingCount = parseInt(existing.rows[0].n, 10);
      const alreadyLoaded = existingCount > 0;

      // Always refresh (full delete + re-insert) so corrections from Jolpica flow in
      await client.query('DELETE FROM race_data WHERE race_id = $1 AND type = $2', [raceId, 'RACE_RESULT']);

      const values: any[][] = [];
      for (const res of race.Results) {
        const posText: string = res.positionText ?? '';
        const posNum = parseResultPosition(posText);

        const constructorId = mapConstructor(res.Constructor.constructorId);
        const status: string = res.status ?? '';
        const reason = classifyRaceResultStatus(status);

        const timeData = res.Time ?? {};
        const timeStr: string | null = timeData.time ?? null;
        const timeMs = parseLapTimeMs(timeStr);

        const isWinner = posNum === 1;
        values.push([
          raceId, 'RACE_RESULT',
          parseInt(res.number ?? res.position ?? 99),   // display_order = car number
          posNum,
          posText.slice(0, 20),
          String(res.Driver.permanentNumber ?? ''),
          mapDriver(res.Driver.driverId),
          constructorId,
          ENGINE_BY_CONSTRUCTOR[constructorId] ?? 'unknown',
          'pirelli',
          isWinner ? timeStr : null,     // race_time  (winner only)
          isWinner ? timeMs  : null,     // race_time_millis
          isWinner ? null    : timeStr,  // race_gap   (everyone else)
          isWinner ? null    : timeMs,   // race_gap_millis
          parseFloat(res.points ?? '0') || 0,
          reason,
        ]);
      }

      if (values.length) {
        const placeholders = values.map((_, i) => {
          const base = i * 16;
          return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16})`;
        }).join(',');

        await client.query(`
          INSERT INTO race_data (
            race_id, type, position_display_order, position_number, position_text,
            driver_number, driver_id, constructor_id, engine_manufacturer_id,
            tyre_manufacturer_id, race_time, race_time_millis,
            race_gap, race_gap_millis, race_points, race_reason_retired
          ) VALUES ${placeholders}
          ON CONFLICT (race_id, type, position_display_order) DO UPDATE SET
            position_number       = EXCLUDED.position_number,
            position_text         = EXCLUDED.position_text,
            driver_id             = EXCLUDED.driver_id,
            constructor_id        = EXCLUDED.constructor_id,
            race_time             = EXCLUDED.race_time,
            race_time_millis      = EXCLUDED.race_time_millis,
            race_gap              = EXCLUDED.race_gap,
            race_gap_millis       = EXCLUDED.race_gap_millis,
            race_points           = EXCLUDED.race_points,
            race_reason_retired   = EXCLUDED.race_reason_retired
        `, values.flat());

        if (!alreadyLoaded || existingCount < values.length) {
          newRoundNumbers.push(rnd);
        }
        let state = 'refreshed';
        if (!alreadyLoaded) {
          state = 'new';
        } else if (existingCount < values.length) {
          state = `completed partial ${existingCount}/${values.length}`;
        }
        console.log(`  [jolpica] Round ${rnd}: ${values.length} results (${state})`);
      }
    }
  } finally {
    client.release();
  }

  return newRoundNumbers;
}

// ---------------------------------------------------------------------------
// Sync standings → season_driver_standing + season_constructor_standing
// ---------------------------------------------------------------------------
export async function syncStandings(
  pool: Pool,
  season = CURRENT_SEASON,
  fetcher: JolpicaFetcher = fetchJolpica
): Promise<void> {
  const [driverMR, constructorMR] = await Promise.all([
    fetcher(`/${season}/driverstandings/`),
    fetcher(`/${season}/constructorstandings/`),
  ]);

  const driverList   = driverMR.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
  const constrList   = constructorMR.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings ?? [];

  const client = await pool.connect();
  try {
    if (driverList.length) {
      await client.query('DELETE FROM season_driver_standing WHERE year = $1', [season]);
      const rows = driverList.map((s: any) => {
        const pos = parseInt(s.position);
        return [season, pos, pos, String(pos), mapDriver(s.Driver.driverId), parseFloat(s.points ?? '0'), false];
      });
      for (const row of rows) {
        await client.query(`
          INSERT INTO season_driver_standing
            (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (year, position_display_order) DO UPDATE SET
            position_number = EXCLUDED.position_number,
            driver_id = EXCLUDED.driver_id,
            points = EXCLUDED.points
        `, row);
      }
    }

    if (constrList.length) {
      await client.query('DELETE FROM season_constructor_standing WHERE year = $1', [season]);
      for (const s of constrList) {
        const pos = parseInt(s.position);
        const cid = mapConstructor(s.Constructor.constructorId);
        await client.query(`
          INSERT INTO season_constructor_standing
            (year, position_display_order, position_number, position_text,
             constructor_id, engine_manufacturer_id, points, championship_won)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (year, position_display_order) DO UPDATE SET
            position_number = EXCLUDED.position_number,
            constructor_id = EXCLUDED.constructor_id,
            points = EXCLUDED.points
        `, [season, pos, pos, String(pos), cid, ENGINE_BY_CONSTRUCTOR[cid] ?? 'unknown',
            parseFloat(s.points ?? '0'), false]);
      }
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------
export async function runJolpicaSync(
  pool: Pool,
  season = CURRENT_SEASON
): Promise<{ newRounds: number; newRoundNumbers: number[] }> {
  const newRoundNumbers = await syncResults(pool, season);
  await syncStandings(pool, season);
  return { newRounds: newRoundNumbers.length, newRoundNumbers };
}
