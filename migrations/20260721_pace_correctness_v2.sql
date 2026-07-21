-- Forward-only pace correctness migration. Keep legacy laps_normalized intact:
-- its key cannot represent two sessions with the same driver/lap number.
CREATE TABLE IF NOT EXISTS laps_normalized_v2 (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  session_type TEXT NOT NULL,
  lap_number INTEGER NOT NULL,
  stint_id INTEGER NOT NULL DEFAULT 0,
  stint_lap_index INTEGER NOT NULL DEFAULT 0,
  lap_time_seconds NUMERIC(8,3),
  is_valid_lap BOOLEAN NOT NULL,
  is_pit_lap BOOLEAN NOT NULL,
  is_out_lap BOOLEAN NOT NULL DEFAULT false,
  is_in_lap BOOLEAN NOT NULL DEFAULT false,
  clean_air_flag BOOLEAN NOT NULL,
  compound TEXT,
  tyre_age_laps INTEGER,
  methodology_version TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season, round, track_id, driver_id, session_type, lap_number)
);

CREATE INDEX IF NOT EXISTS idx_laps_normalized_v2_pace
  ON laps_normalized_v2 (season, session_type, driver_id, round)
  WHERE is_valid_lap = true
    AND is_pit_lap = false
    AND is_out_lap = false
    AND is_in_lap = false;

COMMENT ON TABLE laps_normalized_v2 IS 'Versioned lap facts. Legacy laps_normalized is retained for rollback and is never silently backfilled.';
COMMENT ON COLUMN laps_normalized_v2.methodology_version IS 'Clean-air ingestion methodology. F1QL admits only its active documented version.';

CREATE OR REPLACE VIEW f1ql.lap_pace AS
SELECT
  l.season,
  l.round,
  l.track_id AS event_id,
  REPLACE(l.driver_id, '_', '-') AS driver_id,
  l.lap_time_seconds::numeric AS lap_time_seconds,
  l.is_valid_lap,
  l.is_pit_lap,
  l.is_in_lap,
  l.is_out_lap,
  l.clean_air_flag,
  l.compound,
  l.tyre_age_laps,
  l.session_type::varchar(5) AS session_type,
  l.methodology_version
FROM laps_normalized_v2 l;

CREATE OR REPLACE VIEW f1ql.event_classification AS
SELECT r.year AS season, r.round, REPLACE(rd.driver_id, '_', '-') AS driver_id,
  rd.constructor_id AS team_id, rd.position_number AS finishing_position, rd.race_points AS points,
  CASE
    -- Official explicit classification tokens override a stale or generic reason.
    WHEN UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('DSQ', 'DISQUALIFIED') THEN 'dsq'
    WHEN UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('DNS', 'DID NOT START') THEN 'dns'
    WHEN rd.position_number IS NOT NULL AND rd.race_reason_retired IS NULL THEN 'classified'
    WHEN UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('DNS', 'DID NOT START') THEN 'dns'
    WHEN UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('DSQ', 'DISQUALIFIED') THEN 'dsq'
    WHEN UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('NC', 'NOT CLASSIFIED') THEN 'not_classified'
    WHEN UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('WD', 'WITHDRAWN') THEN 'withdrawn'
    -- Do not infer a non-start from lap count or grid position: formation-lap DNFs remain DNF.
    ELSE 'dnf'
  END AS classification_status,
  COALESCE(NULLIF(BTRIM(rd.position_text), ''), rd.race_reason_retired)::varchar(100) AS status_reason
FROM race_data rd JOIN race r ON r.id = rd.race_id
WHERE LOWER(rd.type) IN ('race', 'race_result');
