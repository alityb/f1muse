-- ============================================================================
-- API QUERY CACHE TABLE
-- ============================================================================
-- Migration: create_api_query_cache.sql
-- Purpose: Stores cached API query results for deterministic, fast responses
--
-- Cache Policy:
--   - confidence = "valid"        → cache for 30 days
--   - confidence = "low_coverage" → cache for 3 days
--   - confidence = "insufficient" → DO NOT cache
--
-- Cache Key Design:
--   SHA256 hash of: { kind, parameters, methodology_version, schema_version }
--   Does NOT include timestamps, debug flags, or request IDs.
-- ============================================================================

-- Create the cache table
CREATE TABLE IF NOT EXISTS api_query_cache (
  cache_key TEXT PRIMARY KEY,
  query_kind TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  parameters JSONB NOT NULL,
  response JSONB NOT NULL,
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('valid', 'low_coverage', 'insufficient')),
  coverage_percent NUMERIC(5,2),
  shared_events INTEGER,
  methodology_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  expires_at TIMESTAMPTZ,
  hit_count INTEGER DEFAULT 0 NOT NULL,
  last_hit_at TIMESTAMPTZ
);

-- Index for finding expired entries during cleanup
CREATE INDEX IF NOT EXISTS idx_api_query_cache_expires_at
  ON api_query_cache(expires_at)
  WHERE expires_at IS NOT NULL;

-- Index for invalidating by query kind
CREATE INDEX IF NOT EXISTS idx_api_query_cache_query_kind
  ON api_query_cache(query_kind);

-- Index for methodology/schema version invalidation
CREATE INDEX IF NOT EXISTS idx_api_query_cache_versions
  ON api_query_cache(methodology_version, schema_version);

-- Comment on table
COMMENT ON TABLE api_query_cache IS 'Stores cached API query results with TTL based on confidence level';

-- Comments on columns
COMMENT ON COLUMN api_query_cache.cache_key IS 'SHA256 hash of normalized query parameters';
COMMENT ON COLUMN api_query_cache.query_kind IS 'QueryIntent kind (e.g., driver_head_to_head_count)';
COMMENT ON COLUMN api_query_cache.query_hash IS 'Hash of just the query parameters for debugging';
COMMENT ON COLUMN api_query_cache.parameters IS 'Original query parameters as JSON';
COMMENT ON COLUMN api_query_cache.response IS 'Full cached API response as JSON';
COMMENT ON COLUMN api_query_cache.confidence_level IS 'Confidence level: valid, low_coverage, or insufficient';
COMMENT ON COLUMN api_query_cache.coverage_percent IS 'Optional coverage percentage for analytics';
COMMENT ON COLUMN api_query_cache.shared_events IS 'Number of shared events (for head-to-head queries)';
COMMENT ON COLUMN api_query_cache.methodology_version IS 'Version of the calculation methodology';
COMMENT ON COLUMN api_query_cache.schema_version IS 'Version of the response schema';
COMMENT ON COLUMN api_query_cache.hit_count IS 'Number of times this cache entry was accessed';
COMMENT ON COLUMN api_query_cache.last_hit_at IS 'Timestamp of last cache hit';
