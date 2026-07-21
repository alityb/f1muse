CREATE OR REPLACE VIEW f1ql.event_metadata AS
SELECT
  r.year AS season,
  r.round,
  COALESCE(REPLACE(r.grand_prix_id, '_', '-'), r.circuit_id) AS event_id,
  COALESCE(gp.full_name, gp.name, r.official_name) AS event_name,
  r.circuit_id,
  r.date
FROM race r
LEFT JOIN grand_prix gp ON gp.id = r.grand_prix_id;
