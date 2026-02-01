-- ============================================================================
-- P0 MIGRATION VERIFICATION SCRIPT
-- ============================================================================
-- Run this after applying 20260125_p0_performance_indexes.sql
-- ============================================================================

\echo ''
\echo '============================================================================'
\echo 'P0 MIGRATION VERIFICATION'
\echo '============================================================================'
\echo ''

-- ============================================================================
-- 1. Check laps_normalized indexes
-- ============================================================================
\echo '1. Checking laps_normalized indexes...'
\echo ''

SELECT
  indexname,
  CASE
    WHEN indexname = 'idx_laps_multi_driver_queries' THEN '✓ P0-1: Multi-driver index'
    WHEN indexname = 'idx_laps_session_compound' THEN '✓ P0-1b: Session-compound index'
    WHEN indexname LIKE 'idx_laps%' THEN '✓ Existing index'
    ELSE '  ' || indexname
  END as status
FROM pg_indexes
WHERE tablename = 'laps_normalized'
ORDER BY indexname;

\echo ''
\echo '   Expected: idx_laps_multi_driver_queries, idx_laps_session_compound'
\echo ''

-- ============================================================================
-- 2. Check pace_metric_summary_driver_season indexes
-- ============================================================================
\echo '2. Checking pace_metric_summary_driver_season indexes...'
\echo ''

SELECT
  indexname,
  CASE
    WHEN indexname = 'idx_pace_metrics_full_lookup' THEN '✓ P0-2: Covering index for driver comparisons'
    ELSE '  ' || indexname
  END as status
FROM pg_indexes
WHERE tablename = 'pace_metric_summary_driver_season'
ORDER BY indexname;

\echo ''
\echo '   Expected: idx_pace_metrics_full_lookup'
\echo ''

-- ============================================================================
-- 3. Verify cache table and indexes
-- ============================================================================
\echo '3. Checking api_query_cache table...'
\echo ''

SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'api_query_cache')
    THEN '✓ P0-3: Cache table exists'
    ELSE '✗ Cache table missing'
  END as cache_table_status;

\echo ''

SELECT
  COUNT(*) as cache_entries,
  COALESCE(SUM(hit_count), 0) as total_hits,
  ROUND(AVG(hit_count), 2) as avg_hits_per_entry
FROM api_query_cache;

\echo ''

SELECT
  indexname,
  CASE
    WHEN indexname LIKE '%cache%' THEN '✓ Cache index'
    ELSE '  ' || indexname
  END as status
FROM pg_indexes
WHERE tablename = 'api_query_cache'
ORDER BY indexname;

\echo ''
\echo '   Expected: 3 indexes on api_query_cache'
\echo ''

-- ============================================================================
-- 4. Check new columns on laps_normalized
-- ============================================================================
\echo '4. Checking new columns on laps_normalized...'
\echo ''

SELECT
  column_name,
  data_type,
  CASE
    WHEN column_name = 'session_type' THEN '✓ P0-1: Session type column'
    WHEN column_name = 'race_name' THEN '✓ P0-1: Race name column'
    ELSE '  Other column'
  END as status
FROM information_schema.columns
WHERE table_name = 'laps_normalized'
  AND column_name IN ('session_type', 'race_name')
ORDER BY column_name;

\echo ''
\echo '   Expected: session_type, race_name'
\echo ''

-- ============================================================================
-- 5. Index size analysis
-- ============================================================================
\echo '5. Index size analysis...'
\echo ''

SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) as index_size
FROM pg_indexes
WHERE tablename IN ('laps_normalized', 'pace_metric_summary_driver_season', 'api_query_cache')
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;

\echo ''

-- ============================================================================
-- 6. Query plan test - Multi-driver query
-- ============================================================================
\echo '6. Testing index usage with EXPLAIN...'
\echo ''
\echo '   Multi-driver query (should use idx_laps_multi_driver_queries):'
\echo ''

EXPLAIN (COSTS OFF, TIMING OFF)
SELECT driver_id, AVG(lap_time_seconds) as avg_pace, COUNT(*) as laps
FROM laps_normalized
WHERE season = 2025
  AND session_type = 'R'
  AND is_valid_lap = true
  AND is_pit_lap = false
GROUP BY driver_id;

\echo ''

-- ============================================================================
-- 7. Query plan test - Driver comparison
-- ============================================================================
\echo '   Driver comparison query (should use idx_pace_metrics_full_lookup):'
\echo ''

EXPLAIN (COSTS OFF, TIMING OFF)
SELECT *
FROM pace_metric_summary_driver_season
WHERE season = 2025
  AND driver_id = 'verstappen'
  AND metric_name = 'avg_true_pace'
  AND normalization = 'none'
  AND clean_air_only = false
  AND compound_context = 'all'
  AND session_scope = 'race';

\echo ''

-- ============================================================================
-- Summary
-- ============================================================================
\echo '============================================================================'
\echo 'VERIFICATION COMPLETE'
\echo '============================================================================'
\echo ''
\echo 'If all checks pass:'
\echo '  ✓ P0-1: Multi-driver query optimization is active'
\echo '  ✓ P0-2: Driver comparison optimization is active'
\echo '  ✓ P0-3: Query caching is enabled'
\echo ''
\echo 'Next steps:'
\echo '  1. Run ANALYZE on affected tables'
\echo '  2. Monitor query performance in application logs'
\echo '  3. Check cache hit rate after warm-up period'
\echo ''
\echo 'Run ANALYZE:'
\echo '  ANALYZE laps_normalized;'
\echo '  ANALYZE pace_metric_summary_driver_season;'
\echo ''
