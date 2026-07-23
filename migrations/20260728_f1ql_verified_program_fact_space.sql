-- Phase 6 registry contract. Apply only through the approved production migration channel.
CREATE SCHEMA IF NOT EXISTS f1ql;

CREATE TABLE IF NOT EXISTS f1ql.verified_program (
  program_id TEXT PRIMARY KEY CHECK (program_id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  program_json JSONB NOT NULL,
  program_hash TEXT NOT NULL CHECK (program_hash ~ '^[a-f0-9]{64}$'),
  definitions_version TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  fact_space_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_hash, definitions_version, compiler_version, fact_space_version)
);

CREATE TABLE IF NOT EXISTS f1ql.fact_space_revision (
  fact_space_version TEXT PRIMARY KEY,
  source_contract JSONB NOT NULL,
  source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE f1ql.verified_program IS 'Reviewed F1QL programs. Runtime validation and read-only execution remain mandatory.';
COMMENT ON TABLE f1ql.fact_space_revision IS 'Reviewed F1QL source-view contract revisions. Application code does not write this relation.';
