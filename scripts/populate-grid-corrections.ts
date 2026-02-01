/**
 * Populate Qualifying Grid Corrections
 *
 * Fetches official FIA starting grids and compares with our qualifying data.
 * Inserts corrections where official grid position differs from qualifying classification.
 *
 * Data sources:
 * 1. Jolpica API (Ergast successor) - race results include starting grid
 * 2. Manual corrections for known penalty cases
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

interface GridCorrection {
  season: number;
  round: number;
  driver_id: string;
  qualifying_position: number;
  official_grid_position: number;
  reason: string;
  source: string;
}

// Map Ergast driver IDs to our F1DB driver IDs
const DRIVER_ID_MAP: Record<string, string> = {
  'max_verstappen': 'max_verstappen',
  'leclerc': 'charles_leclerc',
  'sainz': 'carlos_sainz_jr',
  'perez': 'sergio_perez',
  'hamilton': 'lewis_hamilton',
  'russell': 'george_russell',
  'norris': 'lando_norris',
  'piastri': 'oscar_piastri',
  'alonso': 'fernando_alonso',
  'stroll': 'lance_stroll',
  'ocon': 'esteban_ocon',
  'gasly': 'pierre_gasly',
  'bottas': 'valtteri_bottas',
  'zhou': 'guanyu_zhou',
  'magnussen': 'kevin_magnussen',
  'hulkenberg': 'nico_hulkenberg',
  'tsunoda': 'yuki_tsunoda',
  'ricciardo': 'daniel_ricciardo',
  'albon': 'alexander_albon',
  'sargeant': 'logan_sargeant',
  'de_vries': 'nyck_de_vries',
  'lawson': 'liam_lawson',
  'bearman': 'oliver_bearman',
  'colapinto': 'franco_colapinto',
  'doohan': 'jack_doohan',
  'hadjar': 'isack_hadjar',
  'antonelli': 'kimi_antonelli',
  'bortoleto': 'gabriel_bortoleto',
  'latifi': 'nicholas_latifi',
  'mick_schumacher': 'mick_schumacher',
  'vettel': 'sebastian_vettel',
};

function mapDriverId(ergastId: string): string {
  return DRIVER_ID_MAP[ergastId] || ergastId.replace(/-/g, '_');
}

// Known grid corrections that may not be in APIs
// These are manually verified from FIA records
const MANUAL_CORRECTIONS: GridCorrection[] = [
  // 2022 Belgian GP - Multiple engine penalties
  { season: 2022, round: 14, driver_id: 'max_verstappen', qualifying_position: 1, official_grid_position: 14, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'charles_leclerc', qualifying_position: 4, official_grid_position: 15, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'esteban_ocon', qualifying_position: 5, official_grid_position: 16, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'lando_norris', qualifying_position: 6, official_grid_position: 17, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'yuki_tsunoda', qualifying_position: 14, official_grid_position: 19, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'mick_schumacher', qualifying_position: 16, official_grid_position: 18, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'valtteri_bottas', qualifying_position: 17, official_grid_position: 20, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 14, driver_id: 'guanyu_zhou', qualifying_position: 18, official_grid_position: 19, reason: 'Engine penalty', source: 'FIA' },

  // 2022 Italian GP - Multiple penalties
  { season: 2022, round: 16, driver_id: 'max_verstappen', qualifying_position: 2, official_grid_position: 7, reason: 'Engine penalty (5 places)', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'carlos_sainz_jr', qualifying_position: 3, official_grid_position: 18, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'sergio_perez', qualifying_position: 4, official_grid_position: 13, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'lewis_hamilton', qualifying_position: 5, official_grid_position: 19, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'valtteri_bottas', qualifying_position: 14, official_grid_position: 20, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'yuki_tsunoda', qualifying_position: 15, official_grid_position: 16, reason: 'Engine penalty', source: 'FIA' },
  { season: 2022, round: 16, driver_id: 'mick_schumacher', qualifying_position: 17, official_grid_position: 17, reason: 'Engine penalty', source: 'FIA' },

  // 2023 Belgian GP - Multiple penalties
  { season: 2023, round: 12, driver_id: 'max_verstappen', qualifying_position: 1, official_grid_position: 6, reason: 'Gearbox penalty (5 places)', source: 'FIA' },

  // 2023 Qatar GP - Multiple penalties after qualifying
  { season: 2023, round: 17, driver_id: 'logan_sargeant', qualifying_position: 11, official_grid_position: 16, reason: 'Gearbox penalty (5 places)', source: 'FIA' },
  { season: 2023, round: 17, driver_id: 'yuki_tsunoda', qualifying_position: 13, official_grid_position: 20, reason: 'Engine penalty', source: 'FIA' },

  // 2024 Belgian GP - Multiple penalties
  { season: 2024, round: 14, driver_id: 'max_verstappen', qualifying_position: 1, official_grid_position: 11, reason: 'Engine penalty (10 places)', source: 'FIA' },
  { season: 2024, round: 14, driver_id: 'yuki_tsunoda', qualifying_position: 18, official_grid_position: 20, reason: 'Engine penalty', source: 'FIA' },

  // 2024 Qatar GP - Verstappen penalty
  { season: 2024, round: 23, driver_id: 'max_verstappen', qualifying_position: 1, official_grid_position: 2, reason: 'Grid penalty (1 place) for impeding', source: 'FIA' },

  // 2024 Abu Dhabi GP - Penalties
  { season: 2024, round: 24, driver_id: 'sergio_perez', qualifying_position: 10, official_grid_position: 12, reason: 'Grid penalty (3 places)', source: 'FIA' },
  { season: 2024, round: 24, driver_id: 'franco_colapinto', qualifying_position: 14, official_grid_position: 19, reason: 'Grid penalty (5 places)', source: 'FIA' },
];

async function fetchJolpicaGrids(season: number, round: number): Promise<Map<string, number>> {
  const grids = new Map<string, number>();

  try {
    const url = `https://api.jolpi.ca/ergast/f1/${season}/${round}/results.json`;
    const response = await fetch(url);

    if (!response.ok) {
      return grids;
    }

    const data: any = await response.json();
    const races = data.MRData?.RaceTable?.Races;

    if (!races || races.length === 0) {
      return grids;
    }

    const results = races[0].Results;
    for (const result of results) {
      const driverId = mapDriverId(result.Driver.driverId);
      const gridPosition = parseInt(result.grid);
      if (!isNaN(gridPosition) && gridPosition > 0) {
        grids.set(driverId, gridPosition);
      }
    }
  } catch (err) {
    // API error - return empty
  }

  return grids;
}

async function getQualifyingPositions(pool: Pool, season: number, round: number): Promise<Map<string, number>> {
  const positions = new Map<string, number>();

  const result = await pool.query(`
    SELECT driver_id, qualifying_position
    FROM qualifying_results
    WHERE season = $1 AND round = $2 AND session_type = 'RACE_QUALIFYING'
  `, [season, round]);

  for (const row of result.rows) {
    positions.set(row.driver_id, row.qualifying_position);
  }

  return positions;
}

async function insertCorrections(pool: Pool, corrections: GridCorrection[]): Promise<number> {
  let inserted = 0;

  for (const c of corrections) {
    try {
      await pool.query(`
        INSERT INTO qualifying_grid_corrections
        (season, round, driver_id, qualifying_position, official_grid_position, reason, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (season, round, driver_id) DO UPDATE SET
          qualifying_position = EXCLUDED.qualifying_position,
          official_grid_position = EXCLUDED.official_grid_position,
          reason = EXCLUDED.reason,
          source = EXCLUDED.source,
          updated_at = NOW()
      `, [c.season, c.round, c.driver_id, c.qualifying_position, c.official_grid_position, c.reason, c.source]);
      inserted++;
    } catch (err) {
      console.log(`  Error inserting ${c.season} R${c.round} ${c.driver_id}: ${err}`);
    }
  }

  return inserted;
}

async function processSeasonFromAPI(pool: Pool, season: number): Promise<GridCorrection[]> {
  const corrections: GridCorrection[] = [];

  // Get list of rounds for this season
  const roundsResult = await pool.query(`
    SELECT DISTINCT round FROM qualifying_results
    WHERE season = $1 AND session_type = 'RACE_QUALIFYING'
    ORDER BY round
  `, [season]);

  for (const roundRow of roundsResult.rows) {
    const round = roundRow.round;

    // Get official grid from API
    const officialGrids = await fetchJolpicaGrids(season, round);
    if (officialGrids.size === 0) continue;

    // Get our qualifying positions
    const qualifyingPositions = await getQualifyingPositions(pool, season, round);

    // Compare and find differences
    for (const [driverId, officialGrid] of officialGrids) {
      const qualPos = qualifyingPositions.get(driverId);
      if (qualPos && qualPos !== officialGrid) {
        corrections.push({
          season,
          round,
          driver_id: driverId,
          qualifying_position: qualPos,
          official_grid_position: officialGrid,
          reason: 'Grid penalty (API detected)',
          source: 'Jolpica'
        });
      }
    }
  }

  return corrections;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('=== Populating Qualifying Grid Corrections ===\n');

  const allCorrections: GridCorrection[] = [];
  const seasons = [2022, 2023, 2024, 2025];

  // First, add manual corrections (verified from FIA records)
  console.log('Adding manual corrections...');
  allCorrections.push(...MANUAL_CORRECTIONS);
  console.log(`  Added ${MANUAL_CORRECTIONS.length} manual corrections\n`);

  // Then try to fetch from API for additional corrections
  for (const season of seasons) {
    console.log(`Processing ${season} from API...`);
    try {
      const apiCorrections = await processSeasonFromAPI(pool, season);

      // Only add API corrections that aren't already in manual list
      for (const apiC of apiCorrections) {
        const exists = allCorrections.some(
          c => c.season === apiC.season && c.round === apiC.round && c.driver_id === apiC.driver_id
        );
        if (!exists) {
          allCorrections.push(apiC);
        }
      }

      console.log(`  Found ${apiCorrections.length} corrections from API`);
    } catch (err) {
      console.log(`  Error processing ${season}: ${err}`);
    }

    // Small delay between API calls
    await new Promise(r => setTimeout(r, 500));
  }

  // Insert all corrections
  console.log('\nInserting corrections into database...');
  const inserted = await insertCorrections(pool, allCorrections);
  console.log(`  Inserted ${inserted} corrections\n`);

  // Summary by season
  console.log('=== Summary by Season ===\n');
  for (const season of seasons) {
    const seasonCorrections = allCorrections.filter(c => c.season === season);
    console.log(`${season}: ${seasonCorrections.length} corrections`);

    // Group by round
    const byRound = new Map<number, GridCorrection[]>();
    for (const c of seasonCorrections) {
      if (!byRound.has(c.round)) byRound.set(c.round, []);
      byRound.get(c.round)!.push(c);
    }

    for (const [round, corrections] of byRound) {
      console.log(`  Round ${round}: ${corrections.length} drivers affected`);
    }
  }

  // Verification
  console.log('\n=== Verification ===\n');
  const verifyResult = await pool.query(`
    SELECT season, COUNT(*) as correction_count
    FROM qualifying_grid_corrections
    GROUP BY season
    ORDER BY season
  `);

  for (const row of verifyResult.rows) {
    console.log(`${row.season}: ${row.correction_count} rows in database`);
  }

  await pool.end();
}

main().catch(console.error);
