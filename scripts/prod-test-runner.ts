#!/usr/bin/env npx ts-node
/**
 * Production Readiness Test Suite
 *
 * Tests all 19 supported query kinds through the full stack:
 * - Backend API (localhost:3000)
 * - Frontend dev server (localhost:5173)
 *
 * Runs persistently for 40-50 minutes with retry logic and exponential backoff.
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_URL = 'http://localhost:3000';
const FRONTEND_URL = 'http://localhost:5173';
const RESULTS_FILE = path.join(__dirname, '..', 'prod_test_results.json');
const TARGET_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const MIN_DURATION_MS = 40 * 60 * 1000; // 40 minutes
const QUERY_DELAY_MS = 500; // 500ms between queries
const MAX_RETRIES = 5;
const MAX_PASSES = 100; // Allow up to 100 passes (safety limit only)

interface TestQuery {
  query: string;
  expectedKind: string;
  description: string;
}

interface TestResult {
  timestamp: string;
  passNumber: number;
  queryIndex: number;
  query: string;
  expectedKind: string;
  description: string;
  backendResponse: {
    status: number;
    query_kind: string | null;
    normalization: string | null;
    coverage_status: string | null;
    season: number | null;
    headline: string | null;
    raw: unknown;
    error: string | null;
  };
  frontendAvailable: boolean;
  pass: boolean;
  kindMatch: boolean;
  retries: number;
  latencyMs: number;
  notes: string;
}

interface Summary {
  type: 'summary';
  totalQueries: number;
  totalTests: number;
  totalPass: number;
  totalFail: number;
  passesCompleted: number;
  durationSeconds: number;
  verdict: 'PROD SANITY PASS' | 'PROD SANITY FAIL';
  failedQueries: string[];
}

// All 19 supported query kinds with representative test queries
const ALL_SUPPORTED_QUERIES: TestQuery[] = [
  // Driver Summaries (5)
  {
    query: "lewis hamilton career summary",
    expectedKind: "driver_career_summary",
    description: "Career stats from F1DB"
  },
  {
    query: "max verstappen 2024 season stats",
    expectedKind: "driver_season_summary",
    description: "Single season statistics"
  },
  {
    query: "charles leclerc driver profile",
    expectedKind: "driver_profile_summary",
    description: "Comprehensive driver profile (mixed sources)"
  },
  {
    query: "hamilton performance trend over seasons",
    expectedKind: "driver_trend_summary",
    description: "Multi-season trend analysis"
  },
  {
    query: "verstappen performance profile 2024",
    expectedKind: "driver_performance_vector",
    description: "Cross-metric performance vector"
  },

  // Cross-team Comparisons (3)
  {
    query: "verstappen vs norris 2024",
    expectedKind: "season_driver_vs_driver",
    description: "Cross-team season pace comparison"
  },
  {
    query: "verstappen vs leclerc at monaco 2024",
    expectedKind: "cross_team_track_scoped_driver_comparison",
    description: "Track-scoped cross-team comparison"
  },
  {
    query: "compare verstappen norris leclerc race pace 2024",
    expectedKind: "driver_multi_comparison",
    description: "Multi-driver comparison on single metric"
  },

  // Teammate Comparisons (2)
  {
    query: "leclerc vs sainz teammate gap 2024",
    expectedKind: "teammate_gap_summary_season",
    description: "Season-long teammate pace gap"
  },
  {
    query: "norris vs piastri qualifying vs race 2024",
    expectedKind: "teammate_gap_dual_comparison",
    description: "Qualifying vs race pace dual comparison"
  },

  // Head-to-Head (2)
  {
    query: "verstappen vs hamilton head to head finishes 2024",
    expectedKind: "driver_head_to_head_count",
    description: "Position-based head-to-head count"
  },
  {
    query: "verstappen hamilton matchup 2024",
    expectedKind: "driver_matchup_lookup",
    description: "Fast h2h from precomputed matrix"
  },

  // Qualifying Stats (5)
  {
    query: "verstappen pole count 2024",
    expectedKind: "driver_pole_count",
    description: "Pole position statistics"
  },
  {
    query: "leclerc q3 appearances 2024",
    expectedKind: "driver_q3_count",
    description: "Q3 appearance count"
  },
  {
    query: "q3 appearances ranking 2024",
    expectedKind: "season_q3_rankings",
    description: "Season Q3 rankings"
  },
  {
    query: "norris vs piastri qualifying gap 2024",
    expectedKind: "qualifying_gap_teammates",
    description: "Teammate qualifying gap"
  },
  {
    query: "verstappen vs norris qualifying comparison 2024",
    expectedKind: "qualifying_gap_drivers",
    description: "Cross-team qualifying gap"
  },

  // Rankings (1)
  {
    query: "fastest drivers at monaco 2024",
    expectedKind: "track_fastest_drivers",
    description: "Track-specific driver rankings"
  },

  // Race Results (1)
  {
    query: "monaco 2024 race results",
    expectedKind: "race_results_summary",
    description: "Official race results from F1DB"
  },
];

// Additional variant queries to extend test coverage
const VARIANT_QUERIES: TestQuery[] = [
  // 2025 season queries
  {
    query: "verstappen vs norris 2025",
    expectedKind: "season_driver_vs_driver",
    description: "2025 season cross-team comparison"
  },
  {
    query: "hamilton vs russell teammate gap 2025",
    expectedKind: "teammate_gap_summary_season",
    description: "2025 teammate gap"
  },
  {
    query: "verstappen 2025 season stats",
    expectedKind: "driver_season_summary",
    description: "2025 season summary"
  },
  {
    query: "fastest drivers at silverstone 2024",
    expectedKind: "track_fastest_drivers",
    description: "Silverstone track rankings"
  },
  {
    query: "norris pole positions 2024",
    expectedKind: "driver_pole_count",
    description: "Norris poles"
  },
  {
    query: "piastri career summary",
    expectedKind: "driver_career_summary",
    description: "Piastri career stats"
  },
  {
    query: "perez vs verstappen teammate gap 2024",
    expectedKind: "teammate_gap_summary_season",
    description: "Red Bull teammate gap"
  },
  {
    query: "alonso q3 count 2024",
    expectedKind: "driver_q3_count",
    description: "Alonso Q3 appearances"
  },
  {
    query: "hamilton vs alonso head to head 2024",
    expectedKind: "driver_head_to_head_count",
    description: "Ham vs Alo h2h"
  },
  {
    query: "spa 2024 race results",
    expectedKind: "race_results_summary",
    description: "Spa race results"
  },
  // More 2025 variants
  {
    query: "leclerc vs hamilton 2025",
    expectedKind: "season_driver_vs_driver",
    description: "Ferrari vs Merc 2025"
  },
  {
    query: "verstappen pole count 2025",
    expectedKind: "driver_pole_count",
    description: "2025 poles"
  },
  {
    query: "q3 rankings 2025",
    expectedKind: "season_q3_rankings",
    description: "2025 Q3 rankings"
  },
];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = MAX_RETRIES
): Promise<{ response: Response | null; retries: number; error: string | null }> {
  let retries = 0;
  let lastError: string | null = null;

  while (retries < maxRetries) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return { response, retries, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      retries++;

      if (retries < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, retries), 30000);
        console.log(`  Retry ${retries}/${maxRetries} after ${backoffMs}ms: ${lastError}`);
        await sleep(backoffMs);
      }
    }
  }

  return { response: null, retries, error: lastError };
}

async function testQuery(
  query: TestQuery,
  passNumber: number,
  queryIndex: number
): Promise<TestResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  console.log(`[Pass ${passNumber}][${queryIndex + 1}/${ALL_SUPPORTED_QUERIES.length + VARIANT_QUERIES.length}] Testing: "${query.query}"`);
  console.log(`  Expected kind: ${query.expectedKind}`);

  // Test backend
  const { response: backendRes, retries, error: backendError } = await fetchWithRetry(
    `${BACKEND_URL}/nl-query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: query.query })
    }
  );

  let backendData: any = null;
  let backendStatus = 0;

  if (backendRes) {
    backendStatus = backendRes.status;
    try {
      backendData = await backendRes.json();
    } catch (e) {
      backendData = { error: 'Failed to parse JSON' };
    }

    // Handle rate limiting
    if (backendStatus === 429) {
      console.log('  ⚠ Rate limited (429) - waiting 60s before next query...');
      await sleep(60000); // Wait 60 seconds before continuing
    }
  }

  // Extract backend fields
  const queryKind = backendData?.query_kind || backendData?.result?.result?.type || null;
  const payload = backendData?.result?.result?.payload || {};
  const normalization = payload.normalization || null;
  const coverageStatus = payload.coverage_status || null;
  const season = payload.season || null;

  // Extract headline stat based on query kind
  let headline: string | null = null;
  if (queryKind === 'season_driver_vs_driver') {
    headline = payload.difference !== undefined ? `${Math.abs(payload.difference).toFixed(2)}%` : null;
  } else if (queryKind === 'driver_career_summary') {
    headline = payload.career_wins !== undefined ? `${payload.career_wins} wins` : null;
  } else if (queryKind === 'teammate_gap_summary_season') {
    headline = payload.gap_pct !== undefined ? `${payload.gap_pct.toFixed(3)}%` : null;
  } else if (queryKind === 'driver_pole_count') {
    headline = payload.pole_count !== undefined ? `${payload.pole_count} poles` : null;
  } else if (queryKind === 'driver_q3_count') {
    headline = payload.q3_appearances !== undefined ? `${payload.q3_appearances} Q3s` : null;
  } else if (queryKind === 'driver_season_summary') {
    headline = payload.wins !== undefined ? `${payload.wins} wins` : null;
  } else if (queryKind === 'season_q3_rankings') {
    const topDriver = payload.entries?.[0]?.driver_id;
    headline = topDriver ? `#1: ${topDriver}` : null;
  } else if (queryKind === 'track_fastest_drivers') {
    const topDriver = payload.entries?.[0]?.driver_id;
    headline = topDriver ? `#1: ${topDriver}` : null;
  } else if (queryKind === 'race_results_summary') {
    headline = payload.winner ? `Winner: ${payload.winner}` : null;
  } else if (queryKind === 'driver_head_to_head_count' || queryKind === 'driver_matchup_lookup') {
    const a = payload.driver_a_wins;
    const b = payload.driver_b_wins;
    headline = a !== undefined && b !== undefined ? `${a}-${b}` : null;
  }

  // Check frontend availability
  let frontendAvailable = false;
  try {
    const frontendRes = await fetch(FRONTEND_URL, { method: 'GET' });
    frontendAvailable = frontendRes.status === 200;
  } catch {
    frontendAvailable = false;
  }

  const kindMatch = queryKind === query.expectedKind;
  const pass = backendStatus === 200 && kindMatch && !backendError;
  const latencyMs = Date.now() - startTime;

  let notes = '';
  if (!kindMatch && queryKind) {
    notes = `Kind mismatch: got ${queryKind}, expected ${query.expectedKind}`;
  }
  if (backendError) {
    notes = `Backend error: ${backendError}`;
  }
  if (backendData?.error) {
    notes = `API error: ${JSON.stringify(backendData.error)}`;
  }

  console.log(`  Result: ${pass ? 'PASS' : 'FAIL'} | Kind: ${queryKind} | Latency: ${latencyMs}ms${notes ? ' | ' + notes : ''}`);

  return {
    timestamp,
    passNumber,
    queryIndex,
    query: query.query,
    expectedKind: query.expectedKind,
    description: query.description,
    backendResponse: {
      status: backendStatus,
      query_kind: queryKind,
      normalization,
      coverage_status: coverageStatus,
      season,
      headline,
      raw: backendData,
      error: backendError
    },
    frontendAvailable,
    pass,
    kindMatch,
    retries,
    latencyMs,
    notes
  };
}

async function runTestSuite(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PRODUCTION READINESS TEST SUITE');
  console.log('='.repeat(60));
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Target duration: ${TARGET_DURATION_MS / 60000} minutes`);
  console.log(`Total query kinds: ${ALL_SUPPORTED_QUERIES.length}`);
  console.log(`Total queries per pass: ${ALL_SUPPORTED_QUERIES.length + VARIANT_QUERIES.length}`);
  console.log('');

  const startTime = Date.now();
  const results: TestResult[] = [];
  let passNumber = 0;
  let totalPass = 0;
  let totalFail = 0;
  const failedQueries: Set<string> = new Set();

  // Initialize results file
  fs.writeFileSync(RESULTS_FILE, '[\n');

  // Combine all queries
  const allQueries = [...ALL_SUPPORTED_QUERIES, ...VARIANT_QUERIES];

  // Run until target duration or 2 full passes with zero errors
  while (true) {
    passNumber++;
    const elapsedMs = Date.now() - startTime;

    console.log('');
    console.log('='.repeat(60));
    console.log(`PASS ${passNumber} | Elapsed: ${(elapsedMs / 60000).toFixed(1)} minutes`);
    console.log('='.repeat(60));

    let passFailures = 0;

    for (let i = 0; i < allQueries.length; i++) {
      const query = allQueries[i];
      const result = await testQuery(query, passNumber, i);
      results.push(result);

      if (result.pass) {
        totalPass++;
      } else {
        totalFail++;
        passFailures++;
        failedQueries.add(result.query);
      }

      // Append to file
      const separator = results.length > 1 ? ',\n' : '';
      fs.appendFileSync(RESULTS_FILE, separator + JSON.stringify(result, null, 2));

      // Delay between queries
      await sleep(QUERY_DELAY_MS);

      // Check if we should stop
      const currentElapsed = Date.now() - startTime;
      if (currentElapsed >= TARGET_DURATION_MS) {
        console.log(`\nTarget duration reached (${(currentElapsed / 60000).toFixed(1)} minutes)`);
        break;
      }
    }

    console.log('');
    console.log(`Pass ${passNumber} complete: ${allQueries.length - passFailures}/${allQueries.length} passed`);

    // Check exit conditions
    const currentElapsed = Date.now() - startTime;

    // Exit if target duration reached
    if (currentElapsed >= TARGET_DURATION_MS) {
      console.log('Target duration reached - stopping');
      break;
    }

    // Exit if 2+ passes with zero errors and min duration met
    if (passNumber >= 2 && totalFail === 0 && currentElapsed >= MIN_DURATION_MS) {
      console.log('Two passes with zero errors and min duration met - stopping');
      break;
    }

    // Exit after MAX_PASSES regardless (safety limit)
    if (passNumber >= MAX_PASSES) {
      console.log('Maximum passes reached - stopping');
      break;
    }
  }

  // Write summary
  const endTime = Date.now();
  const durationSeconds = (endTime - startTime) / 1000;

  const summary: Summary = {
    type: 'summary',
    totalQueries: ALL_SUPPORTED_QUERIES.length + VARIANT_QUERIES.length,
    totalTests: results.length,
    totalPass,
    totalFail,
    passesCompleted: passNumber,
    durationSeconds,
    verdict: totalFail === 0 ? 'PROD SANITY PASS' : 'PROD SANITY FAIL',
    failedQueries: Array.from(failedQueries)
  };

  fs.appendFileSync(RESULTS_FILE, ',\n' + JSON.stringify(summary, null, 2) + '\n]');

  console.log('');
  console.log('='.repeat(60));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Duration: ${durationSeconds.toFixed(1)} seconds (${(durationSeconds / 60).toFixed(1)} minutes)`);
  console.log(`Passes completed: ${passNumber}`);
  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${totalPass}`);
  console.log(`Failed: ${totalFail}`);
  console.log(`Pass rate: ${((totalPass / results.length) * 100).toFixed(1)}%`);
  console.log('');
  console.log(`VERDICT: ${summary.verdict}`);

  if (failedQueries.size > 0) {
    console.log('');
    console.log('Failed queries:');
    failedQueries.forEach(q => console.log(`  - ${q}`));
  }

  console.log('');
  console.log(`Results written to: ${RESULTS_FILE}`);
}

// Run the test suite
runTestSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
