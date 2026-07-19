# F1Muse Architecture — The Closed-Universe Statistical Engine

Status: Finalized design (target architecture)
Supersedes: template-enumeration architecture (24 intent kinds / 27 SQL templates)
Scope: statistical questions only. Not rules explanations, not stewarding, not news.

---

## 1. Thesis

Formula 1 is a **closed, tiny universe**: ~75 seasons, ~1,100 grands prix, ~800
drivers ever, ~165k normalized laps in our store. Enterprise NL-analytics
architectures (text-to-SQL, gated semantic layers) assume big data and an
unbounded schema. That assumption is false here, and every layer of this design
exploits its falseness:

1. The **question space** is combinatorial, but it decomposes into a small,
   closed set of statistical operators.
2. The **fact space** is small enough to materialize exhaustively.
3. The **language surface** is unbounded, but language is the only place an
   LLM is allowed to operate.

The product identity is unchanged and non-negotiable: **deterministic,
fail-closed, provenance-stamped answers.** The LLM never computes. It only
translates.

Model lineage: WolframAlpha (NL → symbolic program → deterministic evaluation),
not StatMuse (NL → intent enum → handler).

---

## 2. Design principles (binding)

P1. **Determinism.** Same question state + same data version = same answer,
    bit-for-bit. All nondeterminism is confined to one stage: language →
    program. From program onward, everything is pure.

P2. **Fail closed.** If data, coverage, or definitions cannot support an
    answer, refuse with a reason. Never render zeros as facts (see the 2018
    Russell-vs-Hamilton incident, Appendix A.4).

P3. **One authority per fact.** Every fact class has exactly one authoritative
    source (Section 5.3). Summing rows to reproduce an official total is
    forbidden when the official total exists (Appendix A.2).

P4. **No raw SQL from models, ever.** The LLM emits programs in a closed
    algebra. Programs are validated, compiled, and executed by our code only.

P5. **Definitions are code.** Every editorial term ("rookie", "midfield",
    "wet race", "classified") is a named, versioned function in the ontology.
    No vibes.

P6. **Answers explain themselves.** Every response carries an auto-derived
    English rendering of the exact program that produced it.

P7. **Coverage grows with usage.** Every validated program is stored, named,
    and reused. Traffic permanently expands capability.

---

## 3. System overview

```text
                       user question
                            │
          ┌─────────────────┼──────────────────────┐
          │       LAYER 4: TRANSLATION              │
          │  Tier 0  deterministic grammar (free)   │
          │  Tier 1  verified-program cache (free)  │
          │  Tier 2  LLM translator → program JSON  │
          │          (few-shot = verified programs) │
          └─────────────────┬──────────────────────┘
                            │  F1QL program (JSON AST)
          ┌─────────────────▼──────────────────────┐
          │       LAYER 2: THE F1 ALGEBRA           │
          │  validate: schema → types → entities    │
          │            → definitions → coverage     │
          │  compile:  program → SQL (read-only)    │
          │  explain:  program → English rendering  │
          └─────────────────┬──────────────────────┘
                            │
          ┌─────────────────▼──────────────────────┐
          │   LAYER 3: MATERIALIZED FACT SPACE      │
          │  fact lookups first, live compute       │
          │  fallback over canonical views          │
          └─────────────────┬──────────────────────┘
                            │
          ┌─────────────────▼──────────────────────┐
          │       LAYER 1: THE F1 ONTOLOGY          │
          │  canonical views + definitions registry │
          │  + identity resolution                  │
          └─────────────────┬──────────────────────┘
                            │
          ┌─────────────────▼──────────────────────┐
          │       LAYER 0: DATA FOUNDATION          │
          │  F1DB (1950+) · FastF1 (2018+)          │
          │  Jolpica (current season, live)         │
          └─────────────────────────────────────────┘
```

---

## 4. Layer 0 — Data foundation

### 4.1 Sources and authority boundaries

| Source | Coverage | Authoritative for |
|---|---|---|
| F1DB | 1950–present, static releases | historical race/qualifying classification, driver/constructor/circuit identity, season entrants, historical standings |
| FastF1 | 2018–present | lap times, stints, compounds, clean-air flags, qualifying session times (Q1/Q2/Q3) |
| Jolpica (Ergast successor) | current season, live | current-season calendar, race results, qualifying results, driver/constructor standings |

### 4.2 Sync contract

- Primary trigger: Monday 00:00 UTC after race weekends; hourly retry up to 12
  attempts; one startup catch-up ~30s after boot (covers redeploys).
- **Pagination invariant:** every Jolpica fetch MUST page (`limit`+`offset`)
  until `offset ≥ total`, merging race entries split across page boundaries.
  A round is "complete" only when local row count equals upstream row count
  (Appendix A.1).
- A round with fewer local rows than upstream is treated as *partial* and
  triggers full refresh + downstream recomputation, not skipped as "already
  loaded".
- Post-sync pipeline order (strict): results → standings → laps ETL →
  teammate gaps → matchup matrix → **fact-space rebuild → cache invalidation**.
- All sync entry points are idempotent (delete-and-reinsert per round within a
  transaction).

### 4.3 Ingestion invariants (fail the sync, not the answer)

- Every `RACE_RESULT` round has ≥ 18 rows (modern era) or the historical
  entrant count.
- `position_text` domain: number, `DNF`, `DNS`, `DSQ`, `NC`, `W`, `EX`, `Ret`.
  `W` (withdrawn) and `DNS` ⇒ `position_number = NULL`.
- `Lapped` status is a finish, not a retirement (Appendix A.3).
- Winner row: `race_time` set, `race_gap` NULL. Non-winner: `race_gap` set,
  `race_time` NULL.
- Standings rows exist for every entered driver each season, including
  0-point drivers (participation gates depend on this — A.4).

---

## 5. Layer 1 — The F1 Ontology

### 5.1 Canonical views (the only tables the compiler may read)

The compiler targets six views. Raw tables are never referenced by generated
SQL. Each view resolves, once and permanently, the identity and semantic traps
that produced past bugs.

| View | Grain | Key content |
|---|---|---|
| `f1.season_entries` | driver × season | constructor(s), rounds entered, is_rookie, entry type (full/partial/substitute) |
| `f1.standings` | driver-or-constructor × season × (round, final) | official points, position, wins; countback-ordered |
| `f1.race_classification` | driver × race | grid, finish position, position_text, status class (finished/lapped/retired/dsq/dns/withdrawn), points incl. sprint linkage, fastest-lap flag |
| `f1.qualifying_classification` | driver × race | Q1/Q2/Q3 times (ms), qualifying position, official grid (post-penalty), elimination round |
| `f1.lap_facts` | driver × lap | lap_time_ms, stint, compound, tyre age, validity flags, clean-air flag, session type |
| `f1.events` | race | season, round, circuit, GP name, date, format (sprint weekend or not), distance, laps |

**Identity normalization is solved inside the views, nowhere else:**

- One canonical driver ID form (hyphenated F1DB form, e.g.
  `lewis-hamilton`). Views translate legacy underscore forms
  (`lewis_hamilton`) at build time. Compiler code never contains
  `REPLACE(id,'-','_')` again (Appendix A.5).
- The two-ID track problem (`circuit_id` vs grand-prix-named `track_id`) is
  resolved by `f1.events` carrying both plus one canonical `event_id`;
  all joins are `season + round`.
- Multi-name circuits (Imola: San Marino GP / Emilia-Romagna GP; Nürburgring:
  German/European/Luxembourg GP) resolve through alias tables in the ontology,
  not through per-template SQL bridges.

### 5.2 The definitions registry (editorial terms as versioned code)

```jsonc
{
  "id": "midfield",
  "version": 2,
  "type": "constructor_set(season)",
  "rule": "constructors ranked 4..8 in final standings of that season",
  "since": "2026-07-01"
}
```

Shipped definitions (initial set): `rookie`, `midfield`, `top_team`,
`wet_race` (any classified stint on INTERMEDIATE/WET), `classified`
(position_number NOT NULL and status ∈ {finished, lapped}), `points_finish`,
`teammates(a,b,season)`, `street_circuit`, `season_half`, `sprint_weekend`,
`home_race`.

Rules:

- Definitions are versioned; **the active definition-set version is part of
  every cache key** and every provenance stamp.
- A question whose answer depends on a definition names the definition and
  version in the response.
- Changing a definition bumps the definition-set version → automatic cache
  invalidation (Section 10).

### 5.3 Fact authority table (P3 made concrete)

| Fact | Authority | Explicitly forbidden |
|---|---|---|
| Season/championship points | `f1.standings` | summing `race_classification.points` (misses sprints, corrections — A.2) |
| Race wins/podiums/finishes | `f1.race_classification` | deriving from lap data |
| Pole positions | `f1.qualifying_classification.qualifying_position = 1` | official grid (penalties move grid, not pole) |
| Grid position | official grid column (post-penalty) | qualifying position |
| Pace | `f1.lap_facts` valid laps | classification gaps |
| Season participation | `f1.season_entries` | inferring from presence of results |

---

## 6. Layer 2 — The F1 Algebra (F1QL)

### 6.1 What it is

A closed, typed, total, terminating, read-only DSL. Programs are JSON ASTs.
The operator set is deliberately small; expressiveness comes from composition.

### 6.2 Type system

```text
Scalar   : Int | Float | Ms | Points | Percent | Bool | Text | Date
Entity   : Driver | Constructor | Circuit | Event | Season | Round
Row sets : Entries | Standings | RaceResults | QualiResults | Laps | Events
Derived  : Series<T> (ordered), Grouped<K,T>, Pair<T> (comparison)
```

Every operator has a typed signature. Type errors are validation failures,
not runtime errors.

### 6.3 Operators (the complete set, v1)

| Operator | Signature (informal) | Notes |
|---|---|---|
| `source` | dataset → RowSet | one of the six canonical views |
| `filter` | RowSet × Predicate → RowSet | predicates reference ontology fields + definitions |
| `join_event` | RowSet × RowSet → RowSet | equi-join on season+round(+driver); the only join |
| `group` | RowSet × keys → Grouped | |
| `aggregate` | Grouped × fn → RowSet | fn ∈ {count, sum, mean, median, min, max, stddev, p50…p95} |
| `compare` | RowSet × (a,b) → Pair | aligns two entities on shared scope (shared laps / shared events) |
| `delta` | Pair × mode → Scalar/Series | mode ∈ {absolute, percent, signed}; sign convention fixed: negative = first entity faster/better |
| `rank` | RowSet × key × dir → Series | deterministic tie-break (6.6) |
| `sequence` | RowSet × Predicate → Series | ordered by (season, round); enables streaks |
| `longest_run` | Series → Scalar | streak length + span |
| `window` | RowSet × frame → RowSet | e.g. rounds 1..7, last N races, season halves |
| `ratio` | Scalar × Scalar → Percent | conversion-style stats ("poles converted to wins") |
| `record` | precomputed fact lookup | routes to Layer 3 (all-time records, streak tables) |
| `limit_sort` | RowSet × key × n → RowSet | output shaping only |

Hard exclusions (rejected at validation): recursion, user-defined functions,
arbitrary joins, write operations, cross-dataset math not expressible via
`join_event`, string manipulation.

### 6.4 Example — the canonical motivating query

"How much faster was Hamilton than Russell in rounds 1-7?"

```json
{
  "f1ql": 1,
  "program": {
    "op": "delta",
    "mode": "percent",
    "of": {
      "op": "compare",
      "a": { "driver": "lewis-hamilton" },
      "b": { "driver": "george-russell" },
      "on": "shared_valid_laps",
      "from": {
        "op": "filter",
        "pred": { "season": 2026, "round": { "between": [1, 7] },
                  "valid_lap": true, "session": "race" },
        "from": { "op": "source", "dataset": "lap_facts" }
      },
      "aggregate": "per_event_median_then_mean"
    }
  }
}
```

Auto-derived rendering (P6), shipped with the answer:

> Median race-lap pace per event, averaged across events, valid laps only,
> shared events only. Rounds 1–7, 2026. Negative = Hamilton faster.
> Definition set v3. Data through round 7 (2026-05-31).

### 6.5 Validation pipeline (strict order, fail closed at each stage)

1. **Schema** — Zod parse of the AST (structure, operator names, arity).
2. **Types** — signature check over the tree.
3. **Entities** — resolver check (driver/constructor/circuit/season exist);
   ambiguity resolved deterministically or rejected with candidates listed.
4. **Definitions** — referenced definitions exist in the active set.
5. **Participation gate** — every compared entity must exist in
   `f1.season_entries` for the program's scope (A.4).
6. **Coverage gate** — dataset supports the scope (no lap programs before
   2018; no current-season rounds beyond last synced round).
7. **Budget** — complexity limits: ≤ 12 operator nodes, ≤ 2 `join_event`,
   ≤ 5 seasons of `lap_facts` scan per program, statement timeout 10s,
   result ≤ 5,000 rows pre-shaping.

### 6.6 Determinism fine print

- **Tie-breaking:** standings ties use FIA countback (wins, then P2s, …);
  rank ties elsewhere use stable order (entity id asc) and are labeled
  `"tie": true`. Never arbitrary.
- **Units:** times in integer ms internally; percent deltas as
  `(a − b) / b × 100`; signed conventions fixed and stated in renderings.
- **NULL semantics:** DNS/W rows never enter pace or H2H denominators; DNF
  rows count for starts and DNF stats but not classification comparisons
  unless `include_dnf: true` is explicit in the program.
- **Rounding:** presentation-layer only; programs return full precision.
- **Aggregation defaults:** cross-event pace always
  `per_event_median → mean across events` (equal event weight), never a flat
  lap pool (guards against lap-count imbalance).

### 6.7 Compilation

Pure function `compile(program, ontologyVersion) → {sql, params}`.
Parameterized SQL over canonical views only; executed on a read-only role;
compiler output is snapshot-tested (program fixtures → expected SQL).

---

## 7. Layer 3 — Materialized fact space

### 7.1 Rationale

The universe is small; precompute it. Most programs reduce to lookups, making
latency ~0, cost ~0, and hallucination structurally impossible for covered
facts.

### 7.2 Fact tables

| Table | Grain | Approx rows |
|---|---|---|
| `facts.driver_season` | driver × season × metric | ~200k |
| `facts.driver_event` | driver × event × metric | ~2M |
| `facts.head_to_head` | driver pair × season × basis (quali/race/pace) | ~500k |
| `facts.streaks` | entity × streak type | ~100k |
| `facts.records` | metric × scope (all-time/season/circuit) | ~50k |
| `facts.pace_profile` | driver × season × context (compound/clean-air/track-type) | ~300k |

Atomic fact row: `(subject, metric_id, scope, value, sample_size,
coverage_status, data_version, computed_at)`.

### 7.3 Refresh protocol

- Full rebuild after every successful sync (minutes at this scale — no
  incremental complexity).
- Build into `facts_next.*`, verify invariants (row counts, spot goldens),
  then transactional swap. Never mutate in place.
- Every fact row carries `data_version`; the API stamps it into provenance.

### 7.4 Query routing

`record` and simple aggregate programs route to fact lookups. Compositional
programs (arbitrary windows, novel filters) compile to live SQL over canonical
views. The router is transparent: provenance says which path answered.

---

## 8. Layer 4 — Translation and self-extension

### 8.1 Tiers

| Tier | Mechanism | Cost | Expected share |
|---|---|---|---|
| 0 | deterministic grammar → program | 0 | majority of head traffic |
| 1 | verified-program cache (normalized question → program) | 0 | growing over time |
| 2 | LLM translator → program JSON | ~cheap-model pennies | long tail only |

Tier 0 emits F1QL programs directly (it currently emits intents; migration in
Section 13). Tier 1 normalization: lowercase, strip stopwords, canonicalize
entities and year tokens.

### 8.2 LLM contract (Tier 2)

- Provider-agnostic client (Anthropic or any OpenAI-compatible endpoint via
  `LLM_PROVIDER/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`). Cheap models suffice
  because the task is translation into a schema-constrained JSON output.
- Structured output constrained by the F1QL JSON schema; temperature 0;
  max ~512 tokens; 10s timeout; bounded retries with backoff on 429/5xx.
- **Few-shot examples (optional, not load-bearing):** Tier 2 works with a
  small static example set in the prompt. Retrieving similar
  `question ↔ verified program` pairs from the library is an optional
  accuracy tune to add later, never a dependency. There is no RAG in the
  answer path; correctness comes from validation, not retrieval.
- The model sees the ontology field catalog and definition names — never the
  physical schema, never SQL.

### 8.3 Verified program library

- A program is "verified" when it passes validation, executes, and (a) is
  served without error or (b) is explicitly confirmed via golden tests.
- Stored with: normalized question, program AST, first-seen, hit count,
  data/definition versions at verification.
- Powers Tier 1, few-shot retrieval, and the shareable/forkable public "stat"
  pages (extends the existing `/share` mechanism).
- Library entries are re-validated automatically when ontology or definition
  versions bump; incompatible entries are quarantined, not silently served.

### 8.4 Ambiguity policy (StatMuse-style, but honest)

Never ask clarifying questions. Resolve deterministically by precedence
(explicit year > current season; full name > surname match; race session >
sprint unless stated), and **surface every assumption** in the rendering:
"Interpreted as: 2026 season, race sessions only."

---

## 9. Trust layer

### 9.1 Fail-closed catalog (complete)

| Condition | Response |
|---|---|
| entity unresolvable | `intent_resolution_failed` + candidate list |
| entity not entered in scope (A.4) | `not_in_scope`: "Russell did not enter the 2018 championship" |
| dataset lacks scope (pre-2018 laps) | `coverage_unavailable` + available range |
| shared sample below floor | `insufficient_data` + observed/required counts |
| definition missing | `unknown_definition` + nearest known |
| budget exceeded | `program_too_complex` |
| validation failure of any kind | structured error; **never a guessed answer** |

Coverage floors: pace comparisons — valid ≥ 8 shared events, low-coverage
4–7 (served with warning), insufficient < 4 (refused). H2H — ≥ 4 shared
events. Insufficient results are never cached.

### 9.2 Provenance stamp (on every answer)

```json
{
  "program_hash": "…",
  "rendering": "…",
  "sources": ["f1.lap_facts"],
  "authority": "official_standings | classification | laps",
  "data_version": "2026.07.14-r7",
  "definition_set": 3,
  "ontology_version": 2,
  "path": "fact_lookup | live_compute",
  "coverage": { "status": "valid", "sample": 9, "unit": "events" },
  "assumptions": ["season=2026 (default)"]
}
```

### 9.3 Golden evaluation suite (the regression backbone)

- ~100 question → exact-answer pairs spanning: official totals (Hamilton
  2018 = 408, Russell 2025 = 319), participation gates, sprint-inclusive
  points, multi-name circuits, streaks, round windows, tie cases,
  hyphen/underscore identities, current-season freshness (answer must match
  Jolpica within one sync cycle).
- Runs: on every deploy, nightly against production, after every sync.
- Any failure pages loudly and blocks fact-space swap if triggered during
  refresh. Every historical incident becomes a permanent golden case.

### 9.4 Property-based and metamorphic layer (answers the oracle problem)

Goldens only test answers we already know. Two generative layers test the
rest:

- **Property-based** (QuickCheck-style): generate random *well-typed* F1QL
  programs; assert machine-checkable invariants — validation accepts, SQL
  compiles and executes within budget, rendering is derivable, and
  `compile(p) ≡ compile(normalize(p))`.
- **Metamorphic relations** (hold without knowing expected answers):
  widening scope never shrinks sample size (`S′ ⊇ S ⇒ sample(P,S′) ≥
  sample(P,S)`); filter order is irrelevant; `delta(a,b) = −delta(b,a)`;
  fact-lookup path and live-compute path agree on overlapping programs.
- **Differential testing**: every program runs through both the SQL compiler
  and the reference interpreter (Section 16); disagreement fails the build.

---

## 10. Caching and versioning

Single invalidation law: **cache keys embed the version triple.**

```text
key = hash(normalize(program_ast)) : data_version : definition_set : ontology_version
```

`normalize` rewrites programs to canonical normal form before hashing
(filter fusion, sorted commutative predicates, filter pushdown). The rewrite
system is terminating and confluent (Newman's lemma), so normal forms are
unique: semantically equivalent-modulo-rules programs share one cache entry
and one library slot. Only proven-sound rewrites are applied — false cache
hits are impossible, false misses merely cost a recompute (full equivalence
is NP-complete; Chandra–Merlin 1977).

- Data sync bumps `data_version` → current-season entries die naturally.
- Definition change bumps `definition_set` → affected programs recompile.
- Operator/compiler semantic change bumps `ontology_version`
  (successor of `METHODOLOGY_VERSION`).
- Layers: verified-program cache (translation), result cache
  (Redis, optional; Postgres `api_query_cache` baseline), fact space
  (persistent, versioned — not a cache, a derived store).
- TTLs become secondary hygiene, not the correctness mechanism. The
  stale-413 class of bug (Appendix A.6) is eliminated by construction.
- `DELETE /admin/cache` (admin-authed) remains as the manual override:
  clears Redis (`f1muse:query:*`, `intent:*`) and truncates
  `api_query_cache`.

---

## 11. API surface

| Endpoint | Change |
|---|---|
| `POST /nl-query` | unchanged contract; internally: translate → validate → route → answer + provenance |
| `POST /program` | new: execute a raw F1QL program (validated identically; this is the public API story) |
| `GET /definitions` | new: active definition set, versioned |
| `GET /stat/:id` | verified-program pages (share/fork), extends `/share` |
| `POST /query` | legacy intent execution; frozen during migration, removed at Phase 4 |
| `/admin/sync`, `/admin/sync/status`, `/admin/cache`, NL diagnostics | unchanged; all require `Authorization: Bearer ADMIN_API_KEY` |

---

## 12. Security

- Compiler executes under a dedicated Postgres role: `SELECT` on `f1.*` and
  `facts.*` only. No raw-table grants, no writes, statement timeout enforced
  at role level.
- LLM output is untrusted input; it never reaches the database — only the
  validator.
- Program budget limits double as DoS protection; per-IP rate limits remain
  (100/15min API, 20/15min NL).
- Admin surface: constant-time bearer comparison; 503 if `ADMIN_API_KEY`
  unset in production.
- Supabase Data API stays disabled (`public`, `graphql_public` unexposed);
  the only DB path is `DATABASE_URL`.
- Secrets live in Railway env + password manager only. `.env` is untracked.

---

## 13. Migration from the current system

Strangler pattern. The template system keeps serving until each phase's exit
criterion is met. No big-bang cutover.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Golden suite running against current prod | 100 goldens green nightly |
| 1 | Canonical views + identity/participation/authority fixes inside them | all templates re-pointed at views; goldens green |
| 2 | F1QL schema + validator + compiler; Tier 0 emits programs; shadow-execute both paths, diff results | ≥ 99% agreement over 30 days of traffic; disagreements adjudicated into goldens |
| 3 | Fact space + router + verified-program library; Tier 2 LLM emits programs | long-tail questions (round windows, streaks, records) served in prod |
| 4 | Delete templates, intent enum, per-kind formatters | zero template executions for 30 days |

Existing assets carry forward: deterministic parser (becomes a program
emitter), metric registry (absorbed into ontology definitions/metrics),
query-validator (becomes validation stages 1–2), intent cache (becomes the
verified-program cache), coverage/confidence machinery (becomes the coverage
gate), driver/track resolvers (feed the ontology), share routes (become the
stat library), sync/auto-sync (unchanged), admin auth (unchanged).

---

## 14. Failure modes and mitigations (eyes open)

| Risk | Severity | Mitigation |
|---|---|---|
| Grammar mis-design (operators can't express real questions, or LLM composes garbage) | High — this is the product risk | Start from a 200-question corpus mined from real traffic + Reddit/r/F1technical; require ≥ 95% expressibility on paper before building the compiler; version the algebra (`f1ql: 1`) for additive evolution |
| Valid program, wrong intent ("wins from pole" vs "pole-to-win ratio") | High | self-explaining renderings; assumptions surfaced; verified library pins known phrasings; goldens for confusable pairs |
| Definition disputes (midfield, wet) | Medium, permanent | published versioned definitions; renderings cite them; changes are versioned events, never silent |
| Fact space drifts from live compute | Medium | goldens run against both paths; swap blocked on divergence |
| Cheap-LLM translation quality | Medium | schema-constrained output + few-shot examples (static first, library-retrieved later if needed); Tier 0/1 shield the head |
| Scope creep toward subjectivity ("driver ratings") | Brand-fatal | Non-goal (Section 15). Refuse or answer the nearest deterministic reformulation, explicitly labeled |

---

## 15. Non-goals

- Subjective ratings ("how good is Alonso really") — nearest deterministic
  reformulation only, explicitly labeled.
- Causal/rules/stewarding questions ("why was Pérez penalized").
- Live telemetry, lap-by-lap streaming.
- Counterfactual simulation ("Hamilton in the Red Bull") — incompatible with
  the determinism brand.
- Betting/predictions.
- Answering when data is absent. Refusal is a feature.

---

## 16. Formal foundations (PL-theoretic proof obligations)

F1QL is a language; it inherits language theory. The following are design
targets, not implemented guarantees. Each becomes a release requirement only
after its executable test suite or reviewed proof exists.
See `docs/F1QL_REFERENCES.md` for citation status and primary references.

1. **Bounded execution.** F1QL will include median, percentile, ranking, and
   aggregation, so it must not be described as a plain first-order/AC0
   language. Until the final fragment has a formal complexity result, safety
   comes from bounded AST size, approved views, query-plan cost checks, result
   limits, and statement timeouts.
2. **Type soundness (progress + preservation).** The target is that a program
   passing schema/type validation compiles, and evaluation cannot raise a
   runtime type error (Milner 1978; Wright-Felleisen 1994). Partial operators
   must be totalized: `ratio` returns `Option<Percent>` (zero denominator is
   `null` with a reason), never an exception.
3. **Canonical normal forms.** Normalization is introduced only with a
   documented rewrite set, property tests for each rewrite, and critical-pair
   tests before cache keys use its output. Newman's lemma applies only after
   termination and local confluence have actually been established.
4. **One AST, three interpreters.** The target is a SQL compiler, English
   renderer, and naive in-memory reference interpreter over the same tree.
   Differential tests on generated programs (McKeeman 1998) then make
   compiler/rendering disagreement observable.
5. **Metamorphic test oracles.** Operator laws such as filter commutativity,
   delta antisymmetry, and fact/live agreement are executable checks. Scope
   monotonicity may only be asserted for explicitly monotone sample metrics,
   not for every aggregate.
6. **Computed provenance.** The provenance stamp will derive mechanically
   from the normalized AST (sources = leaves, definitions = referenced nodes,
   path = router decision). Full provenance semirings (Green, Karvounarakis &
   Tannen 2007) remain a theory reference, not a v1 dependency.
7. **Tier 0 grammar.** The deterministic parser will be specified as a
   parser-combinator/PEG grammar (Hutton-Meijer 1996), replacing accumulated
   regexes only after grammar tests cover its accepted language.

Rejected on scale grounds: incremental view maintenance / differential
dataflow (McSherry et al. 2013) for the fact space — at ~3M facts a full
rebuild is cheaper than any incremental correctness argument.

---

## Appendix A — Correctness rules derived from production incidents

Permanent regression cases. Every rule below is enforced structurally and
covered by goldens.

- **A.1 Pagination completeness.** Jolpica `/results/` paginates at 100 rows;
  round 5+ of a season splits across pages. Fetch-all-pages with race-entry
  merging is mandatory; "already loaded" is decided by row-count equality,
  not row existence. (Stale standings incident, 2026 rounds 5–6.)
- **A.2 Points authority.** Championship points come from
  `season_driver_standing` only. Summing race rows misses sprint points and
  post-race corrections. (Russell 2025: 289 shown vs 319 official.)
- **A.3 Status semantics.** `Lapped` is a finish. `W`/`DNS` ⇒ NULL position,
  excluded from H2H denominators. Retirement reasons never include "Lapped".
- **A.4 Participation gate.** Any per-season program over a driver requires a
  `season_entries` row for that season; otherwise `not_in_scope`. Zero-filled
  comparisons are forbidden. (Russell-vs-Hamilton 2018 zero-fill incident.)
- **A.5 Identity normalization.** Hyphen/underscore driver-ID duality is
  resolved once, inside canonical views. Generated SQL never string-replaces
  IDs. Multi-name circuits resolve via ontology aliases (San Marino/Imola,
  German/European GP at Nürburgring).
- **A.6 Version-keyed caches.** Every cached artifact embeds
  `data_version : definition_set : ontology_version`. TTLs are hygiene, not
  correctness. (Stale 413-points cache incident.)
- **A.7 Python/ETL isolation.** ETL entrypoints guard `main()` behind
  `require.main === module` (Node) / `__main__` (Python); importing a module
  must never execute a job. (Railway healthcheck-failure incident: API import
  ran matchup ingestion at boot.)
- **A.8 Deployment.** Nixpacks installs Python deps into `.venv` (PEP 668);
  the app resolves `.venv/bin/python` first. Railway healthcheck path is
  `/health`; the server must bind the port before any long-running startup
  work.
