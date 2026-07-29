# F1Muse API Documentation

## Public Natural-Language Contract

`POST /nl-query` is the only public natural-language analytics route.

```http
POST /nl-query
Content-Type: application/json

{"question":"Who took pole at the 2025 Australian Grand Prix?"}
```

A successful response is an `AnswerEnvelope`:

```json
{
  "mode": "gated_execution",
  "program": {},
  "program_hash": "sha256...",
  "answer": { "headline": "...", "facts": [] },
  "rows": [],
  "rendering": "...",
  "metadata": {
    "source": "qualifying_classification",
    "definitions_version": "...",
    "compiler_version": "...",
    "fact_space_version": "...",
    "coverage": { "status": "sufficient", "rows_returned": 1 },
    "caveats": []
  }
}
```

The route is deterministic after question interpretation: exact-reference
proof, immutable program materialization, authorization, bounded read-only SQL,
and formatting all fail closed. Unsupported wording returns a typed
clarification or abstention, not a nearest legacy calculation.

`POST /program/answer` is the internal counterpart. It requires the internal
bearer token and uses a separate internal principal while retaining the same
release, canary, authorization, bound, and database gates.

## Answer Availability

Both answer routes require all of the following:

- `F1QL_ANSWER_ENABLED=true`.
- `F1QL_ANSWER_KILL_SWITCH` is not `true`; the switch is rechecked before and
  during execution.
- A valid signed release attestation matching the active code, definitions,
  compiler, fact-space, templates, runtime bounds, deployment, and evidence.
- A nonzero allowed canary stage and deterministic subject/template cohort.
- `F1QL_ANSWER_DATABASE_URL` and trusted CA for the dedicated read-only answer
  role.
- Rate, concurrency, queue, request deadline, statement timeout, work, row,
  and response-byte admission.

Public requests use an IP-derived opaque canary subject. Internal requests use
their authenticated principal identity. Neither route falls back to a general
database credential.

## Supported Launch Families

All 30 reviewed launch-parity cases are contracted. The supported semantic
families are:

| Family | Authority and exact boundary |
|---|---|
| Race results | Official race classification by one resolved event: all rows, winner, podium, top-N, exact position, one driver, or reviewed status |
| Qualifying results | Recorded qualifying classification by one resolved event: all rows, pole, top-N, exact position, one driver, or reviewed status |
| Final standings | Official final driver standings for 1950-2025; includes leader/full table and one exact reviewed three-driver rank form |
| Current standings | Latest recorded 2026 driver standings only; labeled season-in-progress |
| Driver season summary | One driver's recorded final championship position and points only |
| Driver career summary | Best recorded final position and count of recorded final-standings rows through 2025 only |
| Career wins | Official race P1 rows grouped by canonical circuit through 2025 |
| Race H2H | Lower finishing position ahead over shared events with two recorded numeric positions in one final season |
| Qualifying H2H | Lower qualifying position ahead over shared events with two recorded numeric positions in one final season |
| Official comparison | The pinned 2025 Norris/Piastri official standings plus race and qualifying position-H2H composition |
| Named-event comparison | The pinned Silverstone 2025 Verstappen/Norris official race finishing-position comparison |
| Qualifying counts | One-driver season/career P1 counts, one-driver season top-ten count, and season top-ten ranking |

Exact question forms and aliases remain versioned in the answer question,
intent, semantic-proof, and template registries. A semantically similar phrase
is not automatically accepted.

## Explicit Retirement Boundary

The Phase 10 public answer route does not answer or approximate:

- pace, time-gap, fastest-driver, tyre, stint, clean-air, or weather analytics;
- synthetic profiles, performance vectors, trends, or mixed-authority scores;
- legacy teammate-gap products or automatic teammate assumptions;
- sprint, post-penalty grid, constructor, or interim-standings requests;
- arbitrary ranges, arbitrary multi-driver composites, or unreviewed aliases;
- claims that convert qualifying position into grid position or position into
  time.

These families were retired where their old authority was weak, or left
unsupported pending a separately reviewed source contract. Historical pace
fixtures and F1QL operators do not imply public answer authorization.

## Program Routes

| Route | Contract |
|---|---|
| `POST /program` | Parses, validates, costs, compiles, and executes caller-supplied F1QL when `F1QL_ENABLED=true` |
| `GET /program/verified` | Lists the curated immutable verified-program registry |
| `POST /program/verified/:id` | Executes only a registry program and reruns the guarded F1QL pipeline |
| `POST /program/translate` | Shadow translation, linking, validation, and observability only; permanently non-executing |

`/program/translate` is independent from both answer routes. Enabling it does
not make translated programs executable. The test suite injects a throwing
executor and requires zero calls.

## Shares And Direct Endpoints

- `GET /share/:id` returns a stored immutable answer as JSON or HTML. It does
  not translate, execute, or recompute.
- `GET /share-feed` returns recent and trending immutable shares.
- Share creation is not exposed. There is no `POST /share`.
- `GET /driver/:driver_id/profile` and `GET /driver/:driver_id/trend` remain
  direct non-natural-language endpoints with their own response contracts.

## Removed Surface

The following are not mounted: `/query`, legacy natural-language routers,
legacy suggestions, legacy capabilities, query-executing share creation, and
natural-language query-result or intent-cache diagnostics. Redis remains for
distributed rate limiting and operational health; it is not a Phase 10 answer
or interpretation cache.

## Errors

Common fail-closed responses include `answer_disabled`, `kill_switch_active`,
`release_not_approved`, `canary_control`, `answer_database_not_configured`,
`rate_limit_exceeded`, `answer_busy`, `request_timeout`, `statement_timeout`,
`answer_bound_exceeded`, `clarification_required`, and
`capability_unsupported`. Error details never contain credentials or SQL.
