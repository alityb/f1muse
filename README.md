# F1Muse

F1Muse is a deterministic Formula 1 analytics API. The public natural-language
surface accepts only reviewed launch questions, derives a typed F1QL program,
validates and authorizes it, executes bounded parameterized SQL through a
dedicated read-only database role, and returns an `AnswerEnvelope` with facts,
coverage, caveats, rendering, program hash, and source/version metadata.

## Quickstart

Prerequisites: Node.js 20+, PostgreSQL 14+, Docker Desktop for wrapped database
tests, and Redis for production rate limiting.

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://localhost:3000` by default.

```bash
curl -X POST http://localhost:3000/nl-query \
  -H 'Content-Type: application/json' \
  -d '{"question":"Who won the 2025 Australian Grand Prix?"}'
```

`POST /nl-query` is unavailable unless every answer gate, including the
independent `F1QL_PUBLIC_ANSWER_ENABLED` rollout gate, is satisfied. See
`.env.example` and `docs/operations.md`.

Release attestations also sign `allowed_principal_classes`. Internal-canary
releases use `F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES=internal_canary`; public
rollout requires a separately built attestation that explicitly includes
`public` before the public runtime gate is enabled.

## Active Architecture

`POST /nl-query` is the public natural-language route. It returns the F1QL
`AnswerEnvelope` contract and follows this fail-closed pipeline:

1. Normalize and classify the question into the closed launch language.
2. Derive and independently prove exact season, event, driver, scope, and
   operation references.
3. Materialize an immutable reviewed F1QL program.
4. Apply capability authorization and bounded-work admission.
5. Verify enable, kill-switch, signed release, canary, rate, concurrency,
   queue, request, statement, row, work, and response-byte gates.
6. Execute parameterized SQL only through `F1QL_ANSWER_DATABASE_URL`, which
   must identify the dedicated TLS-verified read-only answer role.
7. Format deterministic facts, coverage, caveats, rendering, and provenance.

`POST /program/answer` is the bearer-authenticated internal route over the same
answer pipeline. It is not the public application contract.

`POST /program/translate` is permanently shadow-only. It may translate, link,
validate, and report outcomes, but it never executes a translated program. Its
throwing-executor invariant is a release gate.

## API Surface

| Endpoint | Purpose |
|---|---|
| `POST /nl-query` | Public deterministic F1QL `AnswerEnvelope` |
| `POST /program/answer` | Internal bearer-authenticated answer route |
| `POST /program/translate` | Shadow translation only; never executes |
| `POST /program` | Execute a caller-supplied validated F1QL program when `F1QL_ENABLED=true` |
| `GET /program/verified` | List curated verified programs |
| `POST /program/verified/:id` | Execute a curated verified program through the guarded F1QL executor |
| `GET /share/:id` | Retrieve an immutable stored share; no recomputation |
| `GET /share-feed` | Retrieve the immutable-share discovery feed |
| `GET /driver/:driver_id/profile` | Direct driver profile endpoint |
| `GET /driver/:driver_id/trend` | Direct driver trend endpoint |
| `GET /health`, `GET /health/db` | Health checks |

There is no `/query` route, query-executing `POST /share`, public suggestions
route, or public capabilities route. Natural-language query-result and intent
caches are not part of the Phase 10 answer architecture. Redis is retained for
distributed production rate limiting and health, not answer or intent caching.

## Launch Capability

The launch boundary is intentionally closed:

- Race classification: full classification, winner, podium, top-N, exact
  finishing position, one driver, or reviewed status selection.
- Qualifying classification: full classification, pole, top-N, exact position,
  one driver, or reviewed status selection.
- Official final standings through 2025, exact three-driver final-position
  ranking, and explicitly latest-recorded 2026 standings.
- One-driver final-season official summary and standings-only career summary.
- Career race wins grouped by canonical circuit through 2025.
- Season race and qualifying position H2H over recorded shared numeric events.
- One pinned two-driver official-results comparison and one pinned named-event
  race finishing-position comparison.
- Season and career qualifying P1 counts, season top-ten qualifying count, and
  season top-ten qualifying ranking.

The API abstains or clarifies outside reviewed wording and scope. It does not
silently broaden a request.

## Retired Boundary

Phase 10 does not reproduce weak legacy semantics. Retired or unsupported
natural-language claims include pace rankings and gaps, weather-conditioned
comparisons, clean-air or tyre/stint analytics, position-to-time proxies,
synthetic performance vectors, trend claims, teammate-gap composites,
automatic teammate inference, sprint/grid/constructor analytics, interim
standings, arbitrary date/range filters, and unsupported cross-source
composites. Historical lap/pace work remains testable F1QL research but is not
authorized for public answers.

## Testing

Never invoke bare `vitest` for database-backed suites. Use the wrapped scripts:

```bash
npm run typecheck
npm run lint
npm run test:f1ql
npm run test:api:inprocess
npm run test:golden:db
npm run test:schema:db
npm run validate:full
```

## Data Sources

- F1DB: historical identities, classifications, qualifying, and final
  standings.
- Jolpica: current-season calendar, results, qualifying, and latest recorded
  standings.
- FastF1 and retained official timing artifacts: lap research and ingestion;
  not a public Phase 10 answer authority.

F1Muse is independent and is not affiliated with Formula 1, the FIA, teams, or
drivers.
