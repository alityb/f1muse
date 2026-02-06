/**
 * Data Completeness Audit for Normalized Pace Data
 *
 * Verifies that 2024 and 2025 seasons have:
 *   1. Session median exists (≥20 valid laps per race)
 *   2. Normalized pace data exists for classified drivers (≥5 valid laps)
 *
 * IMPORTANT: This uses season+round joins (NOT track_id) because:
 *   - laps_normalized.track_id uses grand_prix names (e.g., "bahrain_grand_prix")
 *   - race.circuit_id uses circuit IDs (e.g., "bahrain")
 *   - Season + round is the reliable unique identifier
 *
 * Usage: npx ts-node scripts/audit-data-completeness.ts
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

interface AuditRow {
  season: number;
  round: number;
  track_name: string;
  session_laps: number;
  session_median: string;
  classified_drivers: number;
  drivers_with_data: number;
  missing_normalized: number;
  status: 'COMPLETE' | 'MOSTLY_COMPLETE' | 'PARTIAL' | 'MISSING_MEDIAN';
}

const AUDIT_QUERY = `
WITH race_sessions AS (
    SELECT
        r.year AS season,
        r.round,
        r.circuit_id AS track_id,
        c.name AS track_name
    FROM race r
    JOIN circuit c ON r.circuit_id = c.id
    WHERE r.year IN (2024, 2025)
    ORDER BY r.year, r.round
),

session_laps AS (
    SELECT
        season,
        round,
        COUNT(*) AS valid_lap_count,
        COUNT(DISTINCT driver_id) AS unique_drivers
    FROM laps_normalized
    WHERE season IN (2024, 2025)
      AND is_valid_lap = true
      AND lap_time_seconds IS NOT NULL
    GROUP BY season, round
),

classified_drivers AS (
    SELECT
        r.year AS season,
        r.round,
        COUNT(DISTINCT rd.driver_id) AS classified_count
    FROM race r
    JOIN race_data rd ON rd.race_id = r.id
    WHERE r.year IN (2024, 2025)
      AND rd.type = 'RACE_RESULT'
      AND rd.position_number IS NOT NULL
      AND rd.position_number <= 20
    GROUP BY r.year, r.round
),

driver_lap_counts AS (
    SELECT
        season,
        round,
        driver_id,
        COUNT(*) AS lap_count
    FROM laps_normalized
    WHERE season IN (2024, 2025)
      AND is_valid_lap = true
      AND lap_time_seconds IS NOT NULL
    GROUP BY season, round, driver_id
),

drivers_meeting_threshold AS (
    SELECT
        season,
        round,
        COUNT(DISTINCT driver_id) AS drivers_with_sufficient_data
    FROM driver_lap_counts
    WHERE lap_count >= 5
    GROUP BY season, round
)

SELECT
    rs.season,
    rs.round,
    rs.track_name,
    COALESCE(sl.valid_lap_count, 0)::int AS session_laps,
    CASE WHEN COALESCE(sl.valid_lap_count, 0) >= 20 THEN 'YES' ELSE 'NO' END AS session_median,
    COALESCE(cd.classified_count, 0)::int AS classified_drivers,
    COALESCE(dmt.drivers_with_sufficient_data, 0)::int AS drivers_with_data,
    GREATEST(0, COALESCE(cd.classified_count, 0) - COALESCE(dmt.drivers_with_sufficient_data, 0))::int AS missing_normalized,
    CASE
        WHEN COALESCE(sl.valid_lap_count, 0) < 20 THEN 'MISSING_MEDIAN'
        WHEN COALESCE(dmt.drivers_with_sufficient_data, 0) >= COALESCE(cd.classified_count, 0) THEN 'COMPLETE'
        WHEN COALESCE(dmt.drivers_with_sufficient_data, 0) >= COALESCE(cd.classified_count, 0) * 0.8 THEN 'MOSTLY_COMPLETE'
        ELSE 'PARTIAL'
    END AS status
FROM race_sessions rs
LEFT JOIN session_laps sl ON sl.season = rs.season AND sl.round = rs.round
LEFT JOIN classified_drivers cd ON cd.season = rs.season AND cd.round = rs.round
LEFT JOIN drivers_meeting_threshold dmt ON dmt.season = rs.season AND dmt.round = rs.round
ORDER BY rs.season, rs.round
`;

function padEnd(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function padStart(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str;
}

function formatTable(rows: AuditRow[]): void {
  const header = [
    padEnd('Season', 6),
    padStart('Round', 5),
    padEnd('Track', 25),
    padStart('Laps', 6),
    padStart('Median', 6),
    padStart('Classfd', 7),
    padStart('W/Data', 6),
    padStart('Missing', 7),
    padEnd('Status', 16),
  ].join(' | ');

  const separator = header.replace(/[^|]/g, '-');

  console.log(header);
  console.log(separator);

  for (const row of rows) {
    const line = [
      padEnd(String(row.season), 6),
      padStart(String(row.round), 5),
      padEnd(row.track_name.slice(0, 25), 25),
      padStart(String(row.session_laps), 6),
      padStart(row.session_median, 6),
      padStart(String(row.classified_drivers), 7),
      padStart(String(row.drivers_with_data), 6),
      padStart(String(row.missing_normalized), 7),
      padEnd(row.status, 16),
    ].join(' | ');
    console.log(line);
  }
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? undefined : { rejectUnauthorized: false }
  });

  console.log('=== Data Completeness Audit (2024 + 2025) ===\n');

  try {
    const result = await pool.query<AuditRow>(AUDIT_QUERY);
    const rows = result.rows;

    if (rows.length === 0) {
      console.log('ERROR: No race data found for 2024/2025 seasons.');
      process.exit(1);
    }

    // Group by season
    const seasons = [...new Set(rows.map(r => r.season))];

    for (const season of seasons) {
      const seasonRows = rows.filter(r => r.season === season);
      console.log(`\n--- ${season} Season (${seasonRows.length} races) ---\n`);
      formatTable(seasonRows);

      // Summary stats
      const complete = seasonRows.filter(r => r.status === 'COMPLETE').length;
      const mostlyComplete = seasonRows.filter(r => r.status === 'MOSTLY_COMPLETE').length;
      const partial = seasonRows.filter(r => r.status === 'PARTIAL').length;
      const missingMedian = seasonRows.filter(r => r.status === 'MISSING_MEDIAN').length;

      console.log(`\nSummary: ${complete} COMPLETE, ${mostlyComplete} MOSTLY_COMPLETE, ${partial} PARTIAL, ${missingMedian} MISSING_MEDIAN`);
    }

    // Overall summary
    console.log('\n=== OVERALL SUMMARY ===\n');
    const complete = rows.filter(r => r.status === 'COMPLETE').length;
    const mostlyComplete = rows.filter(r => r.status === 'MOSTLY_COMPLETE').length;
    const partial = rows.filter(r => r.status === 'PARTIAL').length;
    const missingMedian = rows.filter(r => r.status === 'MISSING_MEDIAN').length;
    const total = rows.length;

    console.log(`Total races:     ${total}`);
    console.log(`COMPLETE:        ${complete} (${((complete / total) * 100).toFixed(1)}%)`);
    console.log(`MOSTLY_COMPLETE: ${mostlyComplete} (${((mostlyComplete / total) * 100).toFixed(1)}%)`);
    console.log(`PARTIAL:         ${partial} (${((partial / total) * 100).toFixed(1)}%)`);
    console.log(`MISSING_MEDIAN:  ${missingMedian} (${((missingMedian / total) * 100).toFixed(1)}%)`);

    // Final verdict
    console.log('\n=== VERDICT ===\n');
    if (complete === total) {
      console.log('✅ ALL RACES COMPLETE - Data is production-ready');
      process.exit(0);
    } else if (complete + mostlyComplete === total) {
      console.log('⚠️  MOSTLY COMPLETE - Some races have minor gaps (80%+ driver coverage)');
      process.exit(0);
    } else if (missingMedian > 0) {
      console.log('❌ FAILED - Some races are missing session median data. Check lap ingestion.');
      process.exit(1);
    } else if (partial > 0) {
      console.log('❌ FAILED - Some races have incomplete driver coverage (<80%). Check ingestion.');
      process.exit(1);
    }

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
