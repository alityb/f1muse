# F1QL Implementation Roadmap

Status: Proposed execution plan
Companion: `docs/architecture.md`
Objective: Evolve F1Muse from enumerated query templates into a deterministic,
compositional statistical engine for F1 questions.

This is a strangler migration. Existing templates remain the production path
until a replacement has proved it is correct. There is no big-bang rewrite.

---

## 1. Success Definition

F1QL is successful only when all of the following are true:

1. A statistical question is represented as a validated F1QL program, not a
   new application-specific query kind.
2. The server, not an LLM, deterministically compiles that program to
   parameterized SQL over canonical views.
3. Every answer includes its calculation rendering, data authority, version,
   assumptions, and coverage.
4. The system refuses unsupported, ambiguous, out-of-scope, or
   under-covered questions rather than manufacturing zeros or estimates.
5. A query shape such as "Hamilton vs Russell in rounds 1-7" requires no new
   intent kind or SQL template. It is one composition of existing operators.
6. Existing accepted answers remain stable unless a data correction or a
   deliberately versioned definition changes them.

### Explicit non-goals

- No arbitrary model-generated SQL.
- No RAG over raw F1 records.
- No subjective driver ratings, predictions, rules explanations, stewarding,
  news, or counterfactual simulations.
- No new third-party semantic-layer service (Cube, dbt MetricFlow, etc.).

---

## 2. Governing Rules

These are release blockers, not preferences.

| Rule | Implementation consequence |
|---|---|
| One authority per fact | Standings points read from official standings, never summed result rows where an official value exists |
| One canonical identity | Compiler reads canonical view IDs only; no per-query hyphen/underscore replacement |
| No zero-filled data | Participation and coverage gates run before formatting |
| Program before SQL | Models, API callers, and caches exchange F1QL ASTs; only the compiler creates SQL |
| Deterministic definitions | Terms like `rookie`, `wet_race`, and `midfield` are named, versioned rules |
| Versioned answers | Cache keys include data, ontology, and definition versions |
| Prove before claiming | Complexity and rewrite claims remain implementation notes until backed by executable tests or a reviewed proof |

---

## 3. Delivery Order

```text
0. Baseline and formal audit
          │
1. Data contracts and canonical views
          │
2. Golden corpus and generative test harness
          │
3. F1QL v1 specification and reference interpreter
          │
4. Compiler and shadow execution
          │
5. Pilot: generic filtered comparisons
          │
6. Materialized facts and program library
          │
7. Translator migration and template retirement
```

Do not start a phase until the prior phase exit gate is met.

---

## 4. Phase 0 — Baseline and Formal Audit

### Goal

Freeze the current behavior, identify known incorrect behavior, and correct
any architecture claims that cannot be defended.

### Steps

1. Inventory every public endpoint, intent kind, template, data source,
   cache layer, and background job.
2. Publish a data capability matrix:
   - classification/standings: 1950-present where F1DB has coverage;
   - lap pace/stints/compound questions: 2018-present;
   - live current-season data: bounded by latest successful Jolpica/FastF1
     sync.
3. Capture a baseline response fixture for every current template.
4. Log all known historical incidents as regression cases:
   - Jolpica pagination after 100 results;
   - sprint points omitted from summed race results;
   - zero-filled driver comparisons for absent seasonal entrants;
   - `Lapped` treated as retirement;
   - `W`/DNS incorrectly given a finish position;
   - stale caches after methodology changes;
   - import-triggered ETL execution at API startup.
5. Formally audit `architecture.md` claims before implementing them:
   - median, percentile, ranking, and aggregation mean F1QL is not simply
     "non-recursive first-order algebra in AC0";
   - replace unproved asymptotic claims with enforceable operational bounds
     until the exact language fragment is specified;
   - document which normalization rewrites are proven sound, not merely
     desirable.

### Deliverables

- `docs/F1QL_CAPABILITY_MATRIX.md`
- `tests/golden/known-incidents.json` as a typed provisional incident registry
- a corrected formal-claims section in `docs/architecture.md`

### Exit gate

- Every existing behavior is classified as: correct, deliberately deprecated,
  or known bug with a provisional incident case.
- No unproved theorem remains presented as a production guarantee.

---

## 5. Phase 1 — Data Contracts and Canonical Views

### Goal

Eliminate per-template data semantics. Every calculation reads one canonical
semantic layer.

### Steps

1. Define migrations/views for the six canonical datasets:
   - `f1.events`
   - `f1.season_entries`
   - `f1.standings`
   - `f1.race_classification`
   - `f1.qualifying_classification`
   - `f1.lap_facts`
2. Move all identity normalization into those views:
   - one canonical hyphenated driver ID;
   - one canonical event key (`season`, `round`);
   - canonical circuit aliases;
   - canonical constructor aliases.
3. Encode fact authority in view contracts:
   - points: standings;
   - wins/podiums/finishes: race classification;
   - pole: qualifying classification, not official grid;
   - pace: valid lap facts;
   - participation: season entries.
4. Define a small status taxonomy in SQL:
   `finished`, `lapped`, `retired`, `dsq`, `dns`, `withdrawn`, `unknown`.
5. Add data invariant checks before a view version becomes active.
6. Version every view contract (`ontology_version`).

### Deliverables

- database migrations for `f1.*` views
- `docs/F1_DATA_CONTRACTS.md`
- contract tests that compare canonical-view results to authoritative source
  fixtures

### Exit gate

- Existing templates can be mechanically changed to read canonical views
  without answer changes except documented bug corrections.
- No generated SQL will need ID string replacement or raw-table joins.

---

## 6. Phase 2 — Golden Corpus and Generative Test Harness

### Goal

Make correctness measurable before expanding capability.

### Steps

1. Build a human-reviewed golden corpus of at least 100 exact questions:
   - official standings/points across sprint and non-sprint seasons;
   - historical aliases (Imola/San Marino, Nürburgring/German GP);
   - driver participation negative cases;
   - qualifying vs official-grid distinctions;
   - tie/countback cases;
   - current-season freshness cases;
   - missing-data refusals.
2. Run goldens:
   - on pull requests;
   - before and after every data sync;
   - nightly against production.
3. Add property-based generators for valid future F1QL programs.
4. Add metamorphic tests that do not need fixed answers:
   - filter order does not change results;
   - `delta(a,b) = -delta(b,a)` where both are defined;
   - expanding a scope cannot reduce the unfiltered input sample count;
   - fact lookup agrees with live computation on overlapping facts;
   - `compile(p)` and `compile(normalize(p))` are equivalent.

### Deliverables

- golden runner and CI gate
- production scheduled evaluation job
- failure report with query, expected/actual answer, program/data versions
- local template-contract runner with adversarial synthetic fixtures

### Exit gate

- Every release-blocking golden has an independent source reference, a local
  fixture/snapshot, and an executable runner. Provisional incident cases do
  not block releases until promoted.
- All known incidents are permanent regressions.
- A data sync cannot silently publish an answer that breaks a golden.

---

## 7. Phase 3 — Define F1QL v1

### Goal

Specify the language before implementing a compiler.

### Steps

1. Write `docs/F1QL_SPEC.md` with:
   - grammar/JSON AST schema;
   - type signatures;
   - operator semantics;
   - null, tie, unit, rounding, ordering, and denominator rules;
   - normalization rules and their proofs/tests;
   - stable error codes.
2. Start with the smallest useful operator set:
   `source`, `filter`, `group`, `aggregate`, `compare`, `delta`, `rank`,
   `window`, `ratio`, `limit_sort`.
3. Defer `sequence`, `longest_run`, and `record` until the first set is
   proven. The language should grow from observed questions, not imagination.
4. Make partial operations explicit:
   - ratio with zero denominator returns `null` with a reason;
   - median with no samples returns `null`;
   - comparing non-participants returns `not_in_scope`.
5. Implement the AST using Zod discriminated unions and TypeScript types.
6. Implement a reference interpreter over in-memory fixture rows. It must be
   simple and obviously correct, not fast.

### Deliverables

- `docs/F1QL_SPEC.md`
- Zod schema + TypeScript AST types
- reference interpreter
- parser/normalizer tests

### Exit gate

- 90%+ of a curated 200-question statistical corpus is expressible as F1QL
  on paper.
- Every F1QL v1 operator has reference semantics and at least one negative
  test.

---

## 8. Phase 4 — Validator, Compiler, and Shadow Execution

### Goal

Compile F1QL to safe SQL and prove it agrees with existing production logic.

### Steps

1. Implement validation in strict stages:
   schema → types → entity resolution → definition resolution → participation
   → coverage → complexity budget.
2. Implement a compiler targeting `f1.*` views only.
3. Compiler rules:
   - parameterized values only;
   - no dynamic identifiers from user/model input;
   - read-only DB role;
   - statement timeout and result cap;
   - deterministic SQL formatting for snapshot tests.
4. Implement a renderer from the same AST to English methodology text.
5. For supported legacy intents, execute both paths in shadow mode:
   template result versus F1QL result; record structural diffs but serve the
   existing template answer.
6. Differential-test SQL output against the reference interpreter over
   generated small fixtures.

### Deliverables

- compiler and renderer
- SQL snapshot suite
- shadow comparison telemetry/dashboard
- mismatch triage workflow

### Exit gate

- At least 99% agreement for migrated question classes over a substantial
  real-traffic sample.
- Every disagreement is either a known legacy bug, a data correction, or a
  compiler bug with a regression test.

---

## 9. Phase 5 — Pilot the Real Unlock: Generic Scoped Comparisons

### Goal

Prove that one compositional program replaces many templates.

### Pilot scope

Driver/constructor pace, classification, and standings comparisons with
composable filters:

- season or season range;
- arbitrary round windows;
- circuits/circuit classes;
- race/qualifying/sprint sessions;
- valid laps, clean air, compounds, tyre ages;
- weather definition;
- starts, finishes, positions, points, wins, podiums;
- rank and top-N.

### Required examples

- "How much faster was Hamilton than Russell in rounds 1-7?"
- "Who had the highest median clean-air pace on street circuits in 2024?"
- "Which drivers converted the most poles into wins from 2018-2025?"
- "Rank Ferrari drivers by positions gained in wet races."
- "Compare Norris and Piastri on medium tyres after lap 15."

### Exit gate

- No new query kind or SQL template is required for any pilot question.
- Every answer has a readable program rendering and source/coverage stamp.
- Unsupported phrasing receives a precise refusal, never a generic fallback.

---

## 10. Phase 6 — Materialized Facts

### Goal

Make common facts instant and make every source calculation reproducible.

### Steps

1. Define atomic fact schema:
   `(subject, metric_id, scope, value, denominator, sample_size,
   coverage_status, data_version, computed_at)`.
2. Materialize high-frequency facts first:
   driver-season summaries, official standings, driver-event classification,
   qualifying/race H2H, pace by driver/season/context, records, streaks.
3. Rebuild in a next-generation schema after sync; validate against goldens;
   atomically swap active facts.
4. Router chooses fact lookup when the program maps exactly to a materialized
   fact; otherwise uses live compilation.
5. Test fact/live equivalence continuously.

### Exit gate

- High-frequency questions resolve from facts without a correctness drift.
- A failed fact build cannot replace the prior active fact generation.

---

## 11. Phase 7 — Translation and Program Library

### Goal

Make the language natural without making computation non-deterministic.

### Steps

1. Rewrite `deterministic-intent.ts` as a grammar/program emitter for common
   question forms. Prefer parser combinators/PEG structure over accumulated
   regexes.
2. Introduce a verified-program cache keyed by normalized question and
   version triple.
3. Update the LLM integration to output only F1QL JSON constrained by the
   Zod schema.
4. Keep static few-shot examples first. Do **not** add RAG as a dependency.
5. Store successfully validated and executed programs in a program library:
   question, normalized question, AST, rendering, hit count, versions.
6. Optionally add retrieval of similar verified programs only when static
   examples demonstrably fail. Retrieval may improve translation but is never
   required for correctness or execution.

### Exit gate

- Deterministic grammar + program cache handle the majority of requests
  without an LLM call.
- Tier 2 output is never executed until it passes the same validator as all
  other programs.

---

## 12. Phase 8 — Retire Legacy Templates

### Goal

Remove the query-kind ceiling only after the replacement is trusted.

### Steps

1. Migrate template classes one at a time to F1QL equivalents.
2. Keep a legacy execution feature flag for each class until no mismatches
   occur over the agreed observation window.
3. Remove the template, its intent type, and its bespoke formatter only after
   the final golden and shadow gate passes.
4. Preserve old public API contracts through a compatibility adapter until a
   versioned API sunset.

### Exit gate

- No production request executes a legacy template.
- Every existing public answer has an F1QL program/provenance equivalent.

---

## 13. Operational Rules

### Versioning

All answer/cache/program keys include:

```text
hash(normalized_program) : data_version : definition_set : ontology_version
```

Any change in source data, definition semantics, or compiler/ontology
semantics invalidates results by construction. TTL is cleanup, never
correctness.

### Security

- Compiler role: `SELECT` on canonical views/facts only.
- Supabase Data API: disabled or no `public`/`graphql_public` exposure.
- Admin endpoints: `Authorization: Bearer ADMIN_API_KEY`.
- LLM: receives ontology catalog, never schema/SQL/connection strings.
- No model output is interpolated into SQL.

### Observability

Log: program hash, normalized AST, compiler version, SQL template fingerprint,
fact/live route, data version, definition set, coverage decision, execution
duration, cache state. Never log secrets or raw connection strings.

### Rollback

- Fact generation: atomic swap means rollback is pointer reversal.
- Compiler/ontology: retain previous version and route by feature flag.
- Data sync: do not activate a generation that fails invariants or goldens.

---

## 14. Decision Gates

Stop or redesign if any of these fail:

| Gate | Question |
|---|---|
| Expressibility | Can F1QL represent ≥90% of the real statistical corpus without escape hatches? |
| Explainability | Can a non-engineer verify the English rendering against the question? |
| Agreement | Does compiler output agree with legacy/reference paths at the required threshold? |
| Authority | Is every displayed fact traceable to exactly one declared source? |
| Refusal quality | Does an unsupported question get a precise limitation, not a wrong answer? |
| Operational simplicity | Is a full fact rebuild and atomic swap simpler than incremental maintenance? |

If the language needs arbitrary SQL or user-defined functions to pass the
expressibility gate, do not add them. Reassess the product scope instead.

---

## 15. First Concrete Work Item

Start with Phase 0 and Phase 2 together:

1. Build the capability matrix.
2. Turn every known production incident into a golden test.
3. Add 100 reviewed goldens before adding one new natural-language query
   feature.
4. Correct the formal claims in `architecture.md` as part of the audit.

This produces an immediate reliability improvement and establishes the test
oracle required for every later phase.
