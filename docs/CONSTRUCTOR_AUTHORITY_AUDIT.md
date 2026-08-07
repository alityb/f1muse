# Retained Final-2025 Constructor Authority Candidate Audit

This Phase 11 Work Package 11 milestone audits whether retained
`season_constructor_standing` data is a candidate for a future exact final-2025
constructor championship-points authority. It observes recorded points only. It
does not reconstruct points, infer rank, expose a semantic concept, or execute an
answer query. Local success establishes only a retained candidate, never final
authority.

## Safety And Guards

The runner is disabled unless
`F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED=true` and an exact target is supplied.
`F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET=localhost` accepts only loopback
PostgreSQL. `F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET=production` rejects every
loopback, wildcard, or unspecified destination, including equivalent IPv4 zero
forms and URL-canonicalized IPv4-mapped unspecified IPv6 such as
`[::ffff:0:0]` and `[::ffff:0.0.0.0]`.

Production also requires an independently supplied approved-target digest in
`F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256`. The runner compares it
to the credential-independent URL-target digest in constant time and does not
derive the expected value from `DATABASE_URL`. A missing or mismatched guard or
digest fails before pool construction. Localhost remains local-only and does not
use the production expected-target variable.

The audit acquires one connection and performs all database observation in one
`REPEATABLE READ READ ONLY` transaction. It installs a transaction-local 5000 ms
statement timeout and always rolls back. Transaction-control timeouts and failed
rollback discard the connection. The audit contains only fixed catalog and data
`SELECT` statements. Local fixture setup is separate test-only DDL/DML against
the disposable wrapped PostgreSQL container and completes before the real audit
transaction starts.

Run the local emitter and wrapped suite with:

```sh
npm run emit:constructor-authority-audit:local
npm run test:constructor-authority-audit:local
```

The emitter seeds a nonempty 24-round disposable database, invokes the real audit
emitter, and writes canonical output to
`tests/fixtures/constructor-authority-audit.json`. The fixture must never be
edited by hand.

## Exact Scope

The fixed schema contract inspects only these relations and data columns:

| Relation | Required columns |
| --- | --- |
| `public.season_constructor_standing` | `year integer`, `constructor_id text`, `points numeric` |
| `public.constructor` | `id text` |
| `public.race` | `id integer`, `year integer`, `round integer` |
| `public.race_data` | `race_id integer`, `type text`, `constructor_id text` |

Relation existence is observed separately from columns so absence is distinct
from schema drift. The audit requires the exact critical key shapes
`constructor PRIMARY KEY (id)`, `race PRIMARY KEY (id)`,
`season_constructor_standing UNIQUE (year, constructor_id)`, and
`race_data PRIMARY KEY (race_id, type, driver_id)`. Here physical `year` is the
audited semantic season. All observed primary and unique keys on the four fixed
relations are fingerprinted. No other field is crawled or exposed.

Data scope is exactly `year = 2025`. Participation is distinct retained
constructor identity from `race_data` joined to `race`, restricted to trimmed
case-insensitive `race` and `race_result` classification rows. The audit requires
a nonempty standings source, unique raw `(season, constructor_id)` grain,
non-null safely normalizable identities, collision-free underscore-to-hyphen
normalization, non-null exact nonnegative decimal `numeric` points, matching
constructor identity rows, and exact normalized membership agreement with
retained 2025 race classification.

The 2025 race schedule must contain exactly one of each round `1..24`, and every
retained standings constructor must have retained race-classification
participation in all 24 rounds. The audit never computes points or standings
position. Membership differences are emitted only as counts and SHA-256 set
hashes.

Source, identity, and participation observations each retain at most the first
101 rows or identity groups. A present 101st item is preserved in the report
count and produces its typed bound failure before any slicing. Recorded points
are canonicalized only as exact decimal text by removing insignificant trailing
fractional zeroes. Normalized constructor identity plus canonical points form a
deterministically sorted fact set whose SHA-256 is reported. No numeric rounding
or arithmetic is performed.

## Report Contract

The strict canonical JSON v2 report includes the target hash, hashed database and
principal provenance, server version, read-only transaction contract, separate
relation presence, exact column and key-contract results, schema and key
fingerprints, bounded source/identity/participation counts, normalized identity
and points-fact hashes, 24-round coverage, integrity counts, membership-difference
counts and hashes, and one closed `passed` or `failed` status/reason.

The parser rejects unknown fields and recomputes reason, status, count arithmetic,
bound flags, empty-set hashes, and clean-set hash equalities for both passed and
failed reports. It also rejects impossible schema booleans and counts: observed
columns cannot exceed the present-relation contract, must cover matched critical
keys, and must equal the complete required column count when the column contract
matches; observed keys must cover matched keys, and a matching key contract must
contain exactly all required critical keys. The hash verifier uses constant-time
comparison over the canonical serialization. Reports never contain a database
URL, credential, SQL text, raw constructor identity, points value, or source row.

Signing is intentionally absent. Existing repository convention signs release
and principal production evidence, not pre-production data audits. If this audit
later enters a signed release attestation, signing must be added at that evidence
boundary rather than implied by this local fixture.

## Partial Boundary

Status is **PARTIAL pending production evidence**. This milestone adds no catalog
source, serving view, identity view, grant, capability profile, provider request,
production query, migration, deployment, or routing change. Local success proves
only emitter and validator behavior against disposable PostgreSQL; it makes no
claim about retained production data.

The exact next step is to commit a green audit-only change, obtain the approved
credential-independent production-target SHA-256 from independent deployment
inventory, and run the guarded read-only audit once against production with:

```sh
F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED=true \
F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET=production \
F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256=<approved-sha256> \
npm run --silent audit:constructor-authority:production
```

Retain the canonical artifact, hash, UTC execution time, target/deployment
provenance, expected-target provenance, operator, and commit. Only if that report
passes may the following milestone add least-privilege serving and constructor
identity views, followed by one narrow final-2025 constructor championship-points
profile. Any failed reason keeps constructor semantics and execution absent.
