CREATE OR REPLACE VIEW f1ql.event_classification AS
SELECT r.year AS season, r.round, REPLACE(rd.driver_id, '_', '-') AS driver_id,
  rd.constructor_id AS team_id, rd.position_number AS finishing_position, rd.race_points AS points,
  CASE
    WHEN rd.position_number IS NOT NULL AND rd.race_reason_retired IS NULL THEN 'classified'
    WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('DNS', 'DID NOT START') THEN 'dns'
    WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('DSQ', 'DISQUALIFIED') THEN 'dsq'
    WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('NC', 'NOT CLASSIFIED') THEN 'not_classified'
    WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('WD', 'WITHDRAWN') THEN 'withdrawn'
    ELSE 'dnf'
  END AS classification_status,
  rd.race_reason_retired AS status_reason
FROM race_data rd JOIN race r ON r.id = rd.race_id
WHERE LOWER(rd.type) IN ('race', 'race_result');
