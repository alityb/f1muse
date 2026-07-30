-- Keep answer identity and participation keys aligned with governed fact views.
CREATE OR REPLACE VIEW f1ql.answer_event_identity
WITH (security_barrier = true) AS
SELECT r.year AS season, r.round, identity_value.identity
FROM public.race AS r
LEFT JOIN public.grand_prix AS gp ON gp.id = r.grand_prix_id
CROSS JOIN LATERAL (
  VALUES (gp.id::text), (gp.name::text), (gp.full_name::text),
    (gp.short_name::text), (gp.abbreviation::text), (r.official_name::text)
) AS identity_value(identity)
WHERE identity_value.identity IS NOT NULL;

CREATE OR REPLACE VIEW f1ql.answer_driver_identity
WITH (security_barrier = true) AS
SELECT REPLACE(d.id::text, '_', '-') AS driver_id, identity_value.identity
FROM public.driver AS d
CROSS JOIN LATERAL (
  VALUES (d.id::text), (d.full_name::text), (d.first_name::text),
    (d.last_name::text), (d.abbreviation::text)
) AS identity_value(identity)
WHERE identity_value.identity IS NOT NULL
UNION ALL
SELECT REPLACE(d.id::text, '_', '-') AS driver_id, da.alias::text AS identity
FROM public.driver AS d
JOIN public.driver_aliases AS da ON da.driver_id = d.id
WHERE da.alias IS NOT NULL;

CREATE OR REPLACE VIEW f1ql.answer_season_participation
WITH (security_barrier = true) AS
SELECT sed.year AS season, REPLACE(sed.driver_id::text, '_', '-') AS driver_id,
  'entrant'::text AS participation_source
FROM public.season_entrant_driver AS sed
WHERE sed.test_driver = false
UNION ALL
SELECT dse.year AS season, REPLACE(dse.driver_id::text, '_', '-') AS driver_id,
  'legacy_fallback'::text AS participation_source
FROM public.driver_season_entries AS dse;

REVOKE ALL ON f1ql.answer_driver_identity FROM PUBLIC;
REVOKE ALL ON f1ql.answer_event_identity FROM PUBLIC;
REVOKE ALL ON f1ql.answer_season_participation FROM PUBLIC;

COMMENT ON VIEW f1ql.answer_driver_identity IS 'Minimal answer-only canonical driver and alias identity values with governed driver IDs.';
COMMENT ON VIEW f1ql.answer_event_identity IS 'Minimal answer-only event identity values; application code owns normalization and ambiguity.';
COMMENT ON VIEW f1ql.answer_season_participation IS 'Answer-only entrant participation with governed driver IDs and explicit legacy fallback provenance.';
