-- Reviewed least-privilege evidence only. Do not apply without explicit production authorization.
-- External DBA prerequisite: PUBLIC must not have TEMPORARY on the target database. This migration
-- intentionally does not alter database-wide PUBLIC grants; the principal audit fails closed while
-- effective TEMPORARY remains available through PUBLIC or any other membership.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1ql_answer') THEN
    CREATE ROLE f1ql_answer
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'f1ql_answer'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'existing f1ql_answer role attributes do not match the reviewed contract';
  END IF;
END
$migration$;

DO $migration$
BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM f1ql_answer', current_database());
END
$migration$;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON SCHEMA f1ql FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, f1ql FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, f1ql FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA f1ql FROM f1ql_answer;
REVOKE ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA f1ql FROM f1ql_answer;

GRANT USAGE ON SCHEMA f1ql TO f1ql_answer;
GRANT SELECT ON
  f1ql.driver_standings,
  f1ql.event_classification,
  f1ql.qualifying_classification,
  f1ql.event_metadata,
  f1ql.answer_driver_identity,
  f1ql.answer_event_identity,
  f1ql.answer_season_participation
TO f1ql_answer;

COMMENT ON ROLE f1ql_answer IS 'NOLOGIN group role for the exact F1QL answer read surface; membership is authorized separately.';
