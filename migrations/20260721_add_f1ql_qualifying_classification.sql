CREATE OR REPLACE VIEW f1ql.qualifying_classification AS
SELECT
  qr.season,
  qr.round,
  REPLACE(qr.driver_id, '_', '-') AS driver_id,
  qr.team_id,
  qr.qualifying_position,
  qr.best_time_ms,
  qr.best_session,
  qr.eliminated_in_round,
  CASE
    WHEN COALESCE(qr.is_dns, false) THEN 'dns'
    WHEN COALESCE(qr.is_dnf, false) THEN 'dnf'
    ELSE 'classified'
  END AS classification_status
FROM qualifying_results qr;
