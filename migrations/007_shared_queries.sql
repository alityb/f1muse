-- shared_queries: stores resolved answers for permanent share links
-- no recomputation on access, deterministic and versioned

CREATE TABLE IF NOT EXISTS shared_queries (
  id VARCHAR(12) PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  query_kind VARCHAR(64) NOT NULL,
  params JSONB NOT NULL,
  season INTEGER NOT NULL,
  answer JSONB NOT NULL,
  headline VARCHAR(512) NOT NULL,
  summary VARCHAR(1024),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  view_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shared_queries_created_at ON shared_queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_queries_query_kind ON shared_queries(query_kind);
CREATE INDEX IF NOT EXISTS idx_shared_queries_season ON shared_queries(season);

COMMENT ON TABLE shared_queries IS 'Permanent shareable query results - statmuse-style links';
COMMENT ON COLUMN shared_queries.id IS 'Short alphanumeric share id for urls';
COMMENT ON COLUMN shared_queries.version IS 'Schema version for forward compatibility';
COMMENT ON COLUMN shared_queries.params IS 'Resolved query parameters (no raw nl text)';
COMMENT ON COLUMN shared_queries.answer IS 'Full resolved answer payload';
COMMENT ON COLUMN shared_queries.headline IS 'Human-readable headline for og:title';
COMMENT ON COLUMN shared_queries.summary IS 'Short summary for og:description';
