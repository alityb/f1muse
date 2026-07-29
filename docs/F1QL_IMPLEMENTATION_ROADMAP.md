# F1QL Implementation Roadmap

Status: Historical roadmap, completed through the Phase 10 architecture.

This file records the delivered architecture boundary. It is not an active
instruction to preserve or restore the former template system.

## Delivered Foundation

- Typed F1QL surface and generic Core IR with schema, signature, participation,
  coverage, complexity, cost, and version validation.
- Parameterized SQL compiler, read-only timeout executor, deterministic
  renderer, and in-memory reference interpreter.
- Golden corpus, property, metamorphic, SQL/reference differential, source
  contract, lifecycle, performance, and production-evidence gates.
- Curated verified-program registry with semantic program hashes and
  version-bound execution.
- Permanent shadow translation endpoint with typed outcomes and a tested
  zero-execution invariant.

## Delivered Answer Architecture

- Closed question contract and typed answer interpretation.
- Deterministic entity/event linking with ambiguity preservation.
- Independent exact-reference semantic proof.
- Immutable reviewed F1QL answer templates.
- Capability-tuple policy and bounded work model.
- Short-lived execution authorization bound to request, principal, proof,
  release, versions, and template.
- Deterministic `AnswerEnvelope` formatting with facts, coverage, caveats,
  rendering, program hash, and provenance versions.
- Dedicated TLS-verified read-only answer database and statement timeout.
- Enable, emergency kill-switch, signed release, staged canary, rate,
  concurrency, queue, request, work, row, and response-byte gates.
- Separate public and internal principals for `POST /nl-query` and
  `POST /program/answer`.

## Phase 10 Completion Boundary

The reviewed parity manifest contains 30 contracted cases. It preserves the
launch families that can be supported by recorded standings, race
classification, qualifying classification, and canonical event metadata:

- race and qualifying result selections;
- final standings through 2025 and latest-recorded 2026 standings;
- standings-only driver season and career summaries;
- official final-position ranking;
- career race wins by circuit;
- race and qualifying position H2H;
- the pinned official two-driver results comparison;
- the pinned named-event race finishing-position comparison;
- season/career qualifying P1 and season top-ten counts/ranking.

The parity process did not recreate legacy output merely to claim feature
parity. It retired weak or synthetic semantics and narrowed replacements to a
single factual authority.

## Cutover And Retirement

Completed cutover behavior:

1. `POST /nl-query` enters the deterministic F1QL answer pipeline and returns
   `AnswerEnvelope`.
2. `POST /program/answer` remains internal and bearer authenticated.
3. `/program/translate` remains independently gated, shadow-only, and
   non-executing.
4. Raw `/program` and verified-program routes remain separately gated.
5. Legacy natural-language routing and `/query` are unmounted.
6. Query-executing `POST /share`, suggestions, and capabilities are unmounted.
7. Immutable share retrieval/feed and direct driver endpoints remain.
8. Natural-language query-result and interpretation caches are retired. Redis
   remains operational rate-limit infrastructure, not an answer cache.
9. Legacy query-kind, formatter, router, and SQL-template source is eligible for
   physical deletion only because the exhaustive disposition and launch corpus
   are complete.

## Exact Retirement Decisions

Ported families use official standings or classifications. Replaced families
use narrower official summaries, position H2H, exact result selection, or
qualifying top-ten facts. Retired families are trend summaries, synthetic
performance vectors, teammate-gap and dual-gap products, and fastest-driver
pace ranking.

The full 24-family mapping is in `docs/F1QL_CAPABILITY_MATRIX.md`.

## Permanent Release Rules

- Shadow translation never executes, regardless of translation success.
- Public answer capability changes require a reviewed question/intent/proof,
  immutable template, policy, work model, generated fixture, parity corpus
  update, and signed release rollover.
- A current-season sync cannot automatically promote that season to a final
  standings contract.
- No model-generated SQL, arbitrary identifiers, write operations, or general
  database credentials enter the answer path.
- Unsupported scope fails closed; no legacy fallback is permitted.
- Database tests run only through wrapped npm scripts.

## Historical Proposals Not Shipped As Launch Contracts

Earlier roadmap versions proposed broad arbitrary windows, long-tail automatic
program caching, exhaustive materialized answer facts, and public pace
composition. Those proposals were exploratory. Phase 10 launch instead uses a
closed reviewed language and explicit retirement boundary. Historical lap
pilots remain evidence assets but are not public answer capabilities.
