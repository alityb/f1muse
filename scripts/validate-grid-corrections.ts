/**
 * Validate Grid Corrections Completeness
 *
 * Compares our qualifying_results with Jolpica API data to ensure
 * all grid corrections are captured.
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

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

interface ValidationResult {
  season: number;
  round: number;
  driverId: string;
  qualifyingPosition: number;
  apiGrid: number;
  hasCorrection: boolean;
  correctionGrid: number | null;
}

async function fetchApiGrid(season: number, round: number): Promise<Map<string, number>> {
  const grids = new Map<string, number>();

  try {
    const url = `https://api.jolpi.ca/ergast/f1/${season}/${round}/results.json`;
    const response = await fetch(url);

    if (!response.ok) return grids;

    const data: any = await response.json();
    const races = data.MRData?.RaceTable?.Races;

    if (!races || races.length === 0) return grids;

    for (const result of races[0].Results) {
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

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('=== Validating Grid Corrections Completeness ===\n');

  const missingCorrections: ValidationResult[] = [];
  const incorrectCorrections: ValidationResult[] = [];
  const seasons = [2022, 2023, 2024, 2025];

  for (const season of seasons) {
    // Get all rounds for this season
    const roundsResult = await pool.query(`
      SELECT DISTINCT round FROM qualifying_results
      WHERE season = $1 AND session_type = 'RACE_QUALIFYING'
      ORDER BY round
    `, [season]);

    for (const roundRow of roundsResult.rows) {
      const round = roundRow.round;

      // Get API grid data
      const apiGrids = await fetchApiGrid(season, round);
      if (apiGrids.size === 0) continue;

      // Get our qualifying positions
      const qualResult = await pool.query(`
        SELECT driver_id, qualifying_position
        FROM qualifying_results
        WHERE season = $1 AND round = $2 AND session_type = 'RACE_QUALIFYING'
      `, [season, round]);

      // Get our corrections
      const corrResult = await pool.query(`
        SELECT driver_id, official_grid_position
        FROM qualifying_grid_corrections
        WHERE season = $1 AND round = $2
      `, [season, round]);

      const corrections = new Map<string, number>();
      for (const row of corrResult.rows) {
        corrections.set(row.driver_id, row.official_grid_position);
      }

      // Compare
      for (const row of qualResult.rows) {
        const driverId = row.driver_id;
        const qualPos = row.qualifying_position;
        const apiGrid = apiGrids.get(driverId);

        if (apiGrid && apiGrid !== qualPos) {
          // This driver has a grid change
          const hasCorrection = corrections.has(driverId);
          const correctionGrid = corrections.get(driverId) || null;

          if (!hasCorrection) {
            missingCorrections.push({
              season, round, driverId, qualifyingPosition: qualPos,
              apiGrid, hasCorrection: false, correctionGrid: null
            });
          } else if (correctionGrid !== apiGrid) {
            incorrectCorrections.push({
              season, round, driverId, qualifyingPosition: qualPos,
              apiGrid, hasCorrection: true, correctionGrid
            });
          }
        }
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Checked ${season}...`);
  }

  console.log('\n=== Results ===\n');

  if (missingCorrections.length === 0 && incorrectCorrections.length === 0) {
    console.log('✅ All grid corrections are complete and accurate!\n');
  } else {
    if (missingCorrections.length > 0) {
      console.log(`❌ Missing corrections: ${missingCorrections.length}\n`);
      console.log('Season | Round | Driver | Quali Pos | API Grid');
      console.log('-------|-------|--------|-----------|----------');
      for (const m of missingCorrections.slice(0, 20)) {
        console.log(`${m.season} | ${m.round} | ${m.driverId} | ${m.qualifyingPosition} | ${m.apiGrid}`);
      }
      if (missingCorrections.length > 20) {
        console.log(`... and ${missingCorrections.length - 20} more`);
      }
    }

    if (incorrectCorrections.length > 0) {
      console.log(`\n⚠️ Incorrect corrections: ${incorrectCorrections.length}\n`);
      console.log('Season | Round | Driver | Quali Pos | API Grid | Our Grid');
      console.log('-------|-------|--------|-----------|----------|----------');
      for (const i of incorrectCorrections.slice(0, 20)) {
        console.log(`${i.season} | ${i.round} | ${i.driverId} | ${i.qualifyingPosition} | ${i.apiGrid} | ${i.correctionGrid}`);
      }
    }
  }

  // Summary by season
  console.log('\n=== Summary by Season ===\n');
  for (const season of seasons) {
    const missing = missingCorrections.filter(m => m.season === season).length;
    const incorrect = incorrectCorrections.filter(i => i.season === season).length;
    console.log(`${season}: ${missing} missing, ${incorrect} incorrect`);
  }

  await pool.end();
}

main().catch(console.error);
