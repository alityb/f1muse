# F1Muse Phase 10 Architecture

Status: Active architecture after F1QL public cutover and legacy retirement.

## Invariants

1. F1QL is the sole natural-language analytics architecture.
2. No model emits SQL. The answer interpreter can emit only a closed,
   reference-preserving answer intent.
3. The server derives, independently proves, and materializes the exact
   reviewed F1QL program.
4. All database execution is parameterized, read-only, statement-timeout
   bounded, row bounded, work bounded, and response-byte bounded.
5. `POST /program/translate` is permanently shadow-only and never executes a
   translated program.
6. Unsupported or ambiguous input clarifies or abstains; no nearest legacy
   calculation is substituted.
7. Every successful natural-language answer is an `AnswerEnvelope` containing
   the program, program hash, deterministic rendering, facts, rows, source,
   coverage, caveats, and version metadata.

## Request Topology

```text
public client                              internal caller
     |                                          |
POST /nl-query                        POST /program/answer
     | public principal                         | bearer-authenticated principal
     +----------------------+-------------------+
                            |
                  availability gates
          enabled + kill switch + valid question
                            |
              closed answer interpretation
                            |
         exact entity/event linking and semantic proof
                            |
             immutable reviewed F1QL template
                            |
        capability policy + work/row admission
                            |
        signed release + subject/template canary
                            |
       dedicated TLS read-only answer database
              + statement/request bounds
                            |
                deterministic formatter
                            |
                    AnswerEnvelope
```

The public route derives an opaque canary subject from the requester IP. The
internal route derives its subject from the authenticated internal principal.
Neither route can fall back to the primary or general replica pool when the
dedicated answer pool is absent.

## Operational Gates

The answer pipeline requires all gates to agree:

| Gate | Purpose |
|---|---|
| `F1QL_ANSWER_ENABLED` | Explicit route enablement |
| `F1QL_PUBLIC_ANSWER_ENABLED` | Separate public-route enablement; remains false during internal canaries |
| `F1QL_ANSWER_KILL_SWITCH` | Emergency stop, checked before and during execution |
| Signed release attestation | Binds commit, deployment, evidence, template set, allowed principal classes, versions, runtime bounds, audience, and expiry |
| Canary stage | Allows only stages `0,1,5,25,50,100` within the signed maximum |
| Subject and template cohorts | Deterministic HMAC selection; both must be admitted |
| Dedicated answer DB | `F1QL_ANSWER_DATABASE_URL` plus trusted CA; read-only least-privilege role |
| Runtime admission | Per-route rate, concurrency, queue wait, request timeout, and cancellation |
| Query bounds | Work units, rows, response bytes, statement timeout, and read-only transaction |
| Authorization envelope | Short-lived request/principal/proof/release binding, reverified immediately before execution |

Redis is retained for distributed production rate limiting and health. It is
not used as a natural-language intent cache or answer-result cache.

## F1QL Surfaces

### Public answer

`POST /nl-query` is the public deterministic contract. It accepts a question
and returns `AnswerEnvelope`; it does not expose a legacy response adapter.

### Internal answer

`POST /program/answer` uses the same pipeline and envelope but requires the
internal bearer token. The optional canary token represents a distinct internal
principal; it does not bypass release or canary checks.

### Raw and verified programs

- `POST /program` executes caller-supplied F1QL only when `F1QL_ENABLED=true`.
  It reparses, validates, admits cost, compiles parameterized SQL, and executes
  under read-only and timeout controls.
- `GET /program/verified` lists immutable curated programs.
- `POST /program/verified/:id` executes only a registry entry through
  `executeVerifiedF1QL`, which reruns the guarded F1QL pipeline.

### Permanent shadow translation

`POST /program/translate` is independently mounted only when
`F1QL_TRANSLATION_ENABLED=true`. It may call a translator, parse a candidate,
link identities, run validation gates, and emit observability. It has no
execution integration. The injected throwing-executor test requires zero
calls, including successful translation candidates.

## Fact Authorities

| Fact | Authority | Prohibited substitution |
|---|---|---|
| Final/current championship position and points | Recorded driver standings | Summed race points or inferred countback |
| Race winner, podium, rank, H2H, and wins | Official race classification | Lap pace or classification time-gap proxy |
| Pole, qualifying rank, H2H, and top-ten counts | Recorded qualifying position | Post-penalty grid position or inferred Q3 participation |
| Circuit for career wins | Canonical event metadata joined by season/round | Display-name or venue guessing |
| Public pace facts | None at Phase 10 launch | FastF1-derived pace products or sealed local timing research |

Final-season contracts are explicitly pinned through 2025. Current standings
are explicitly latest-recorded 2026 data and carry a season-in-progress caveat.
Routine current-season sync cannot promote 2026 into a final-season contract.

## Launch Boundary

The reviewed launch corpus contains 30 contracted parity cases. The retained
families are race and qualifying classification selections; final and latest
recorded standings; one-driver final-season and career standings summaries;
career race wins by circuit; race and qualifying position H2H; the pinned
official two-driver comparison; the pinned named-event race comparison; and
qualifying P1/top-ten counts and ranking.

The 24 historical query families were assigned one explicit disposition:

- Port: official season/career summaries, result selections, classification
  H2H, career wins by circuit, and qualifying P1 counts.
- Replace: broad profile, pace comparison/ranking, matchup, comprehensive,
  Q3, and qualifying-gap semantics with narrower official standings or
  classification facts.
- Retire: trend, synthetic performance vector, teammate-gap products, and
  fastest-driver pace ranking where no reviewed launch authority exists.

No legacy family survives as a hidden fallback.

## Retained Non-NL Surface

- `GET /share/:id` and `GET /share-feed` retrieve immutable stored material.
  Retrieval never executes a query. Share creation is not mounted.
- `GET /driver/:driver_id/profile` and `/trend` remain direct driver endpoints.
- Health, metrics, sync administration, and development-only debug routes keep
  their independent contracts.

There is no `/query`, public suggestions endpoint, public capabilities
endpoint, query-executing `POST /share`, or natural-language cache maintenance
surface.

## Historical Note

Earlier design documents proposed a broad compositional language, automatic
verified-question caches, materialized answer facts, and long-tail model
translation. Those proposals explain the migration history but are not the
Phase 10 public contract. Launch deliberately chose a closed reviewed language
and explicit retirement over reproducing weak legacy semantics.
