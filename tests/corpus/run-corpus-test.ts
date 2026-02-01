/**
 * Corpus Test Runner for /nl-query endpoint
 *
 * Executes queries from nl-query-corpus.json against the API
 * and records detailed results for analysis.
 */

import * as fs from 'fs';
import * as path from 'path';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500; // delay between batches (reduced since server handles throttling)
const RATE_LIMIT_BACKOFF_MS = 30000; // 30 seconds on 429
const RATE_LIMIT_EXTENDED_BACKOFF_MS = 120000; // 2 minutes if hitting rate limits repeatedly
const CONSECUTIVE_429_THRESHOLD = 5; // after this many consecutive 429s, use extended backoff
const START_FROM_ID = parseInt(process.env.START_FROM || '1', 10); // start from this query id

// note: set CORPUS_TEST_MODE=true on the server to enable llm throttling

interface CorpusQuery {
  id: number;
  category: string;
  question: string;
}

interface QueryResult {
  id: number;
  category: string;
  question: string;
  http_status: number;
  error_type: string | null;
  query_kind: string | null;
  request_id: string | null;
  latency_ms: number;
  cached: boolean | null;
  error_code: string | null;
  reason: string | null;
  timestamp: string;
}

async function executeQuery(query: CorpusQuery): Promise<QueryResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const response = await fetch(`${API_URL}/nl-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ question: query.question }),
    });

    const latency_ms = Date.now() - startTime;
    const data = await response.json();

    return {
      id: query.id,
      category: query.category,
      question: query.question,
      http_status: response.status,
      error_type: data.error_type ?? null,
      query_kind: data.query_kind ?? null,
      request_id: data.request_id ?? null,
      latency_ms,
      cached: data.cached ?? null,
      error_code: data.error_code ?? data.error ?? null,
      reason: data.reason ?? null,
      timestamp,
    };
  } catch (error: any) {
    const latency_ms = Date.now() - startTime;
    return {
      id: query.id,
      category: query.category,
      question: query.question,
      http_status: 0,
      error_type: 'network_error',
      query_kind: null,
      request_id: null,
      latency_ms,
      cached: null,
      error_code: 'connection_failed',
      reason: error.message,
      timestamp,
    };
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCorpusTest(): Promise<void> {
  // Load corpus
  const corpusPath = path.join(__dirname, 'nl-query-corpus.json');
  const allQueries: CorpusQuery[] = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
  const corpus = allQueries.filter(q => q.id >= START_FROM_ID);

  console.log(`Loaded ${allQueries.length} total queries, starting from ID ${START_FROM_ID}`);
  console.log(`Running ${corpus.length} queries`);
  console.log(`API URL: ${API_URL}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log('');

  const results: QueryResult[] = [];
  let rateLimitHits = 0;
  let consecutive429s = 0;

  // Process in batches
  for (let i = 0; i < corpus.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(corpus.length / BATCH_SIZE);
    const batch = corpus.slice(i, i + BATCH_SIZE);

    console.log(`\nBatch ${batchNum}/${totalBatches} (queries ${i + 1}-${Math.min(i + BATCH_SIZE, corpus.length)})`);

    for (const query of batch) {
      process.stdout.write(`  [${query.id}] ${query.category.padEnd(12)} `);

      const result = await executeQuery(query);
      results.push(result);

      // Handle rate limiting
      if (result.http_status === 429) {
        rateLimitHits++;
        consecutive429s++;

        // Use extended backoff if hitting rate limits repeatedly
        if (consecutive429s >= CONSECUTIVE_429_THRESHOLD) {
          console.log(`429 RATE LIMITED (${consecutive429s}x consecutive) - waiting ${RATE_LIMIT_EXTENDED_BACKOFF_MS / 1000}s`);
          await sleep(RATE_LIMIT_EXTENDED_BACKOFF_MS);
          consecutive429s = 0; // Reset after extended backoff
        } else {
          console.log(`429 RATE LIMITED (${consecutive429s}x) - waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
          await sleep(RATE_LIMIT_BACKOFF_MS);
        }
      } else {
        consecutive429s = 0; // Reset on successful request
        const statusIcon = result.http_status === 200 ? '✓' : '✗';
        const cached = result.cached ? ' (cached)' : '';
        console.log(`${statusIcon} ${result.http_status} ${result.latency_ms}ms${cached}`);
      }
    }

    // Delay between batches to respect rate limits
    if (i + BATCH_SIZE < corpus.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Save results
  const outputPath = path.join(__dirname, 'corpus-test-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputPath}`);

  // Generate summary
  generateSummary(results, rateLimitHits);
}

function generateSummary(results: QueryResult[], rateLimitHits: number): void {
  console.log('\n' + '='.repeat(60));
  console.log('CORPUS TEST SUMMARY');
  console.log('='.repeat(60));

  // Overall stats
  const total = results.length;
  const successful = results.filter(r => r.http_status === 200).length;
  const failed = results.filter(r => r.http_status !== 200).length;

  console.log(`\nOverall: ${successful}/${total} successful (${((successful/total)*100).toFixed(1)}%)`);
  console.log(`Rate limit hits: ${rateLimitHits}`);

  // Failure rate by category
  console.log('\n--- Failure Rate by Category ---');
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories.sort()) {
    const catResults = results.filter(r => r.category === cat);
    const catFailed = catResults.filter(r => r.http_status !== 200).length;
    const rate = ((catFailed / catResults.length) * 100).toFixed(1);
    console.log(`  ${cat.padEnd(12)}: ${catFailed}/${catResults.length} failed (${rate}%)`);
  }

  // Error type distribution
  console.log('\n--- Error Type Distribution ---');
  const errorTypes: Record<string, number> = {};
  for (const r of results) {
    if (r.error_type) {
      errorTypes[r.error_type] = (errorTypes[r.error_type] || 0) + 1;
    }
  }
  const sortedErrors = Object.entries(errorTypes).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedErrors) {
    console.log(`  ${type.padEnd(25)}: ${count}`);
  }

  // Unresolved intent percentage
  const unresolvedIntent = results.filter(
    r => r.error_type === 'intent_resolution_error' || r.query_kind === null
  ).length;
  const unresolvedPct = ((unresolvedIntent / total) * 100).toFixed(1);
  console.log(`\n--- Unresolved Intent ---`);
  console.log(`  ${unresolvedIntent}/${total} (${unresolvedPct}%)`);

  // Top 10 slowest queries
  console.log('\n--- Top 10 Slowest Queries ---');
  const sortedByLatency = [...results].sort((a, b) => b.latency_ms - a.latency_ms);
  for (let i = 0; i < Math.min(10, sortedByLatency.length); i++) {
    const r = sortedByLatency[i];
    const q = r.question.length > 50 ? r.question.slice(0, 47) + '...' : r.question;
    console.log(`  ${(i+1).toString().padStart(2)}. [${r.id}] ${r.latency_ms}ms - "${q}"`);
  }

  // HTTP status distribution
  console.log('\n--- HTTP Status Distribution ---');
  const statusCounts: Record<number, number> = {};
  for (const r of results) {
    statusCounts[r.http_status] = (statusCounts[r.http_status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  // Cache hit rate (if available)
  const cachedResults = results.filter(r => r.cached !== null);
  if (cachedResults.length > 0) {
    const cacheHits = cachedResults.filter(r => r.cached === true).length;
    const cachePct = ((cacheHits / cachedResults.length) * 100).toFixed(1);
    console.log(`\n--- Cache Statistics ---`);
    console.log(`  Cache hits: ${cacheHits}/${cachedResults.length} (${cachePct}%)`);
  }

  // Average latency
  const avgLatency = results.reduce((sum, r) => sum + r.latency_ms, 0) / results.length;
  const successAvgLatency = results.filter(r => r.http_status === 200)
    .reduce((sum, r, _, arr) => sum + r.latency_ms / arr.length, 0);
  console.log(`\n--- Latency Statistics ---`);
  console.log(`  Average (all): ${avgLatency.toFixed(0)}ms`);
  console.log(`  Average (successful): ${successAvgLatency.toFixed(0)}ms`);
  console.log(`  Min: ${Math.min(...results.map(r => r.latency_ms))}ms`);
  console.log(`  Max: ${Math.max(...results.map(r => r.latency_ms))}ms`);
}

// Run
runCorpusTest().catch(console.error);
