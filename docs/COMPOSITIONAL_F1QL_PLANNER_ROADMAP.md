# Compositional F1QL Planner Roadmap

Status: proposed Phase 11 plan

## Decision

F1Muse should move from exact question-to-template admission to a bounded
compositional planner over a generalized internal F1QL surface and Core
compiler.

The target is:

> Answer any unambiguous factual question that can be uniquely grounded by the
> reviewed language catalog and expressed over the governed F1QL fact space and
> closed relational operator set.

This does not mean executing arbitrary SQL or exposing every physical database
column. Broad coverage comes from composing a small algebra over reviewed
semantic concepts, not from allowing a model to invent sources, joins,
formulas, or SQL.

## Current Delivery Decision

Phase 11 delivery proceeds by capability family and certified source, not by
adding one exact-question exception for each evaluation case. Exact questions
remain useful as regression and differential oracles, but a production
milestone must promote a reusable closed set of concepts, operators, scopes,
and interactions.

The product target is:

> Answer any unambiguous query expressible over certified retained data through
> the concept's declared operators; clarify when multiple reviewed readings
> survive, and abstain when language, semantics, authority, or coverage is
> insufficient.

"Present in the database" is not sufficient. A source becomes answer-eligible
only after the catalog binds its authority, grain, keys, dimensions, measures,
units, null behavior, valid filters and aggregations, coverage, integrity,
relationships, work bounds, and least-privilege serving view. This prevents an
arbitrary physical column from silently becoming a factual product contract.

Delivery order is fixed:

1. Close reusable single-source, safe-join, and aggregate-locality capabilities
   over driver standings, race classification, qualifying classification, and
   event metadata.
2. Migrate the permanent answer corpus by semantic family. Do not implement the
   remaining cases as independent exact-language rules.
3. Onboard eligible retained career, constructor, and circuit facts through the
   same certification checklist.
4. Promote sealed official historical lap timing as a distinct raw-timing
   authority with lap-window coverage semantics.
5. Promote derived pace separately, preserving its methodology, narrower
   coverage, and non-official authority.
6. Expand production one signed source/operator/topology cohort at a time.

The initial current-source closure must support every catalog-valid combination
of select, entity/value filter, group, aggregate, rank, comparison, sort, limit,
event, season, and final/current scope that fits the promoted topology and work
budgets. Invalid aggregations, unsafe grains, unsupported temporal readings,
and incomplete source coverage remain deterministic refusals.

The model may propose semantic-query candidates. It must never author
executable F1QL, Core, SQL, physical table names, join predicates, source
integrity rules, or permissions. A deterministic semantic enumerator retains
all interpretations supported by reviewed language evidence. A deterministic
planner materializes the sole surviving interpretation as an internal planned
F1QL program. That program must pass strict parsing, validation, cost,
participation, lowering, Core validation, and compilation before an independent
verifier can authorize the existing read-only execution pipeline.

## Why The Compiler Is Not Yet Delivering This

The repository already has a strong execution foundation:

- `src/f1ql/core.ts` defines source, filter, join, aggregate, compare, sort,
  limit, comparison-summary, and composition nodes. These are generic-looking
  primitives, but several accepted topologies are still pinned to named metric
  families.
- `src/f1ql/validation.ts`, `src/f1ql/compiler.ts`, and
  `src/f1ql/interpreter.ts` independently validate, compile, and interpret
  supported Core shapes. Joined aggregates, conditional aggregates,
  comparison summaries, and composition need a separate generalization
  milestone before a planner can use them freely.
- `src/f1ql/executor.ts` provides parameterized, row-capped, read-only,
  statement-timeout-bounded execution.
- Property, metamorphic, SQL/reference differential, release, least-privilege,
  and canary tests already exist.

The current restriction is above the compiler:

- `src/f1ql/answer-semantic-proof.ts` maps an intent to an exact template and
  proves that rematerializing that template produces the same program hash.
- `src/f1ql/answer-policy.ts` authorizes exact macro or aggregate shapes.
- `src/f1ql/answer-release-attestation.ts` signs template IDs rather than
  semantic capabilities and a catalog identity.
- `tests/fixtures/f1ql-answer-evaluation-manifest.ts` evaluates a closed set of
  template programs.

The repository has compositional foundations, but both natural-language
admission and parts of Core validation/compilation remain family-specific.
Phase 11 generalizes the smallest required algebra and then changes admission
and proof without bypassing the executor safety stages.

## Research Findings

### Constrained syntax is necessary but insufficient

PICARD shows that incremental parsing can reject invalid tokens during model
decoding and reduce unusable SQL. Its strongest guards check syntax, schema
names, aliases, and scope, but the paper explicitly leaves richer type checks
for future work. On Spider, PICARD improved validity and accuracy, but it did
not prove that a valid query represented the user's intended metric, source,
scope, or grain. F1Muse therefore needs constrained structured output plus an
independent semantic proof; grammar validity alone is not an execution grant.

### Raw-schema text-to-SQL does not generalize to enterprise conditions

Spider 2.0 contains schemas averaging hundreds of columns, long queries,
external documentation, multiple dialects, and project context. Its reported
systems fell from strong Spider 1.0/BIRD results to low success on realistic
workflows. Error analysis identifies wrong tables, columns, joins, filters,
calculations, dialects, and multi-step plans. F1Muse has a smaller domain, but
the same lesson applies: the model should not choose physical plumbing.

### Values, definitions, and efficiency are part of correctness

BIRD adds large and noisy database values, external knowledge, and query
efficiency. It reports major errors in schema linking, database-content
understanding, and knowledge interpretation, and introduces Valid Efficiency
Score in addition to execution accuracy. F1Muse must version definitions,
units, null semantics, value dictionaries, coverage, and work estimates in the
semantic catalog. Same-result execution on one fixture is not enough.

### Ambiguity must be represented, not guessed away

AMBROSIA evaluates scope ambiguity, attachment ambiguity, and vagueness that
remain unresolved even when the schema and values are visible. Models often
return only one interpretation and show strong interpretation bias. A Phase 11
planner must retain multiple defensible semantic plans, clarify when more than
one survives, and execute only when exactly one plan is proven.

### A semantic query IR is the right model boundary

Recent semantic-layer-mediated systems separate business concepts from
physical columns and compile a compact semantic query into SQL through a
deterministic engine. Industry semantic layers similarly keep measures,
dimensions, grain, joins, and fanout rules in reviewed, version-controlled
metadata. These results motivate mediation, but they do not establish F1Muse's
whole-plan proof or authorization design. That design is a project-specific
engineering conclusion. F1Muse should not copy systems that let an agent
compose or execute raw SQL after semantic exploration, because that would
break the existing safety invariant.

### Trusted answers and exploratory SQL are different products

Block reports separating governed deterministic metrics from flexible
exploratory SQL after a combined interface was neither trusted enough for
business users nor flexible enough for analysts. F1Muse's answer routes should
remain the trusted path. If exploratory SQL is ever desired, it must be a
separate non-public product with separate authorization and human review, not a
fallback from a failed answer plan.

## Target Architecture

```text
Natural-language question
          |
          v
Question contract and literal spans
          |
          v
Catalog retrieval and candidate semantic query
          |
          v
Deterministic semantic evidence and candidate enumeration
          |
          v
Deterministic entity/value linker and semantic planner
          |
          v
Independent whole-plan verifier
          |
          v
Internal planned-F1QL parsing, validation, cost, participation
          |
          v
Core lowering, Core validation, capability authorization, release binding
          |
          v
Shared parameterized compiler and read-only timeout-bounded executor
          |
          v
Schema-driven deterministic formatter
```

The permanent `/program/translate` shadow route remains non-executing and does
not become an alternate planner-to-executor path.

## 1. Versioned Semantic Catalog

Add one immutable, machine-readable catalog that is the only planner-visible
fact space. It should describe semantic meaning, not merely mirror columns.

Each source entry must declare:

| Contract | Required information |
|---|---|
| Identity | Stable semantic ID, governed F1QL view, owner, governance state |
| Grain | Unique row key and whether the source has one row per event, driver-event, driver-season, or lap |
| Scope | Supported seasons, sessions, temporal rules, current/final distinction |
| Dimensions | Semantic type, physical field, units, null meaning, allowed filters and groupings |
| Measures | Authority, expression class, allowed aggregation, additivity, units, null meaning |
| Relationships | Typed keys, cardinality, direction, optionality, and allowed filter propagation |
| Integrity | Required uniqueness, source presence, position bounds, and completeness sentinels |
| Coverage | Observed inventory, certified coverage, freshness, and explicit unsupported boundaries |
| Language | Reviewed names, synonyms, abbreviations, ambiguity groups, and forbidden conflations |
| Governance | `experimental`, `verified`, or `certified`; only signed release-eligible states execute |

Initial catalog scope should include only the existing answer principal's
governed views:

- Final and current driver standings.
- Race classification.
- Qualifying classification.
- Event metadata.
- Driver and event identity/participation views.

Pace, official historical laps, sprint, constructors, weather, grid, and
unverified source relations remain absent until separately promoted.

Catalog requirements:

- The catalog is deeply frozen and deterministically serialized.
- The catalog hash changes on every semantic change.
- CI validates unique IDs, field existence, graph connectivity, acyclic
  derived measures, valid cardinalities, and explicit null/coverage contracts.
- Production evidence binds the catalog hash to fingerprints of the deployed
  views and dedicated principal grants.
- Descriptions explain reusable semantics and must not encode benchmark
  answers or question-specific hints.

## 2. Semantic Query Contract

Introduce a small `SemanticQuery` IR above planned F1QL. A provider may propose
only a bounded set of these candidates.

```ts
interface SemanticQuery {
  version: 1;
  outputs: SemanticOutputRef[];
  scopes: SemanticScope[];
  entities: LiteralEntityRef[];
  filters: SemanticFilter[];
  group_by: SemanticDimensionRef[];
  comparison?: SemanticComparison;
  order_by: SemanticOrder[];
  limit?: number;
}

interface SemanticQueryCandidateSet {
  version: 1;
  candidates: readonly SemanticQuery[]; // bounded to 1..5
}
```

The exact schema should stay declarative:

- `outputs` names catalog dimensions or measures.
- `scopes` binds season, event, round, session, and final/current semantics.
- `entities` contains literal question spans, never canonical IDs supplied by
  the model.
- `filters` uses typed catalog operators and literal values or linked entities.
- `group_by` names semantic dimensions.
- `comparison` declares the requested relation, such as lower, higher, delta,
  count, rank, or shared-event comparison.
- `order_by` and `limit` capture explicit ranking/cardinality language.

It must not contain:

- SQL, table names, schemas, column names, aliases, or expressions.
- Join paths or join predicates.
- Arbitrary formulas or caller-provided functions.
- Integrity checks or claims of source completeness.
- Runtime limits, principal classes, or authorization decisions.
- Canonical driver/event IDs not produced by deterministic linking.

The model proposes possible readings of what the user asked for. It cannot
decide that an alternative reading does not exist. A separate deterministic
semantic evidence pass scans the question with the reviewed catalog lexicon,
scope grammar, comparison grammar, and entity inventory, then enumerates every
bounded plan compatible with that evidence.

Execution admission requires exactly one independently enumerated normalized
semantic query and an equivalent provider candidate. More than one surviving
query produces clarification. No surviving query, an omitted concept, or
language outside the reviewed lexicon produces abstention. Provider output can
improve ranking and recall, but it cannot suppress ambiguity or create semantic
evidence.

## 3. Internal Planned F1QL And Core Generalization

Do not lower a semantic plan directly to Core or add an executor that accepts
planner-produced Core. The answer executor currently obtains important safety
properties from surface parsing, validation, cost admission, participation,
lowering, row ordering, Core validation, compilation, cancellation, and the
read-only transaction. Phase 11 must preserve that sequence.

Add a strict internal `PlannedF1QLProgram` surface for generic relational
plans. It is produced only by deterministic code from a verified semantic plan
and is not accepted by caller-supplied `POST /program`. Refactor shared
execution stages so both existing surface programs and planned answer programs
pass equivalent checks before reaching Core. No branded proof object may call
the compiler or database with Core directly.

Generalize the smallest required algebra before provider planning depends on
it:

- Define the legal generic operator DAG, not just individual node names.
- Add typed projection/result shape if current roots cannot represent it.
- Replace source-specific filter interfaces with closed typed predicates where
  needed.
- Add deterministic multi-key sorting.
- Carry catalog-bound measure IDs without free-form expressions.
- Carry typed join edges, cardinality, grain, and integrity requirements.
- Propagate work, participation, integrity, and output-order requirements
  through every topology.
- Implement every promoted topology in validation, lowering, compiler, and
  reference interpreter before it is planner-visible.

## 4. Deterministic Semantic Planner

The semantic planner consumes the sole independently admitted `SemanticQuery`,
linked entities, and the catalog. It produces a deeply frozen `AnswerPlan` and
materializes a strict internal `PlannedF1QLProgram`.

Planner passes should run in a fixed order:

1. Resolve every semantic reference to one catalog concept.
2. Resolve literal entity and value spans without accepting model-authored IDs.
3. Infer the minimal source set from requested concepts.
4. Select exactly one typed join path; equal valid paths are clarification, not
   an arbitrary shortest-path choice.
5. Check source grain and requested output grain.
6. Detect fanout, chasm, and aggregation-order hazards.
7. Keep measures at aggregate locality before joining when required.
8. Place row filters before aggregation and measure filters after aggregation.
9. Inject source-integrity checks from the catalog.
10. Infer deterministic ordering and reject requests whose tie behavior is not
    defined.
11. Estimate source work, rows, bytes, join count, and plan depth.
12. Materialize only the closed internal planned-F1QL operator set.

Planned F1QL and Core should remain small. Extend generic nodes only where
required for broad composition; do not add a new macro root for each question
family.

Window functions, recursive queries, arbitrary set operations, caller-defined
formulas, and unrestricted subqueries are out of scope for the first release.

## 5. Independent Whole-Plan Proof

The current proof verifies template rematerialization. Replace that requirement
for compositional plans with an independent proof that starts from deterministic
semantic evidence and the complete independently enumerated candidate set, not
from the provider's chosen query. Re-running the planner on the provider query
would prove only implementation consistency and is not semantic proof.

The proof must bind:

- Question, candidate, catalog, and linker hashes.
- Every literal span and all retained resolution candidates.
- Selected semantic concepts and reviewed lexical evidence.
- Scope, session, metric, status, comparison, order, and cardinality cues.
- Source set, typed join path, grain transitions, and aggregate locality.
- Injected integrity predicates and coverage decision.
- Work estimate and runtime ceilings.
- Independent candidate-set, admitted semantic query, answer plan, planned
  F1QL program, and lowered Core hashes.
- Planner, verifier, catalog, definitions, compiler, and fact-space versions.

The verifier must independently reject:

- Unanchored model concepts.
- Missing or extra entities, scopes, filters, outputs, or comparisons.
- Multiple defensible interpretations, including interpretations omitted by
  the provider.
- Wrong-but-valid source, season, event, session, metric, aggregation, join,
  order, or limit substitutions.
- Grain-changing joins and unsafe measure fanout.
- Unsupported coverage or stale current-data requests.
- Any program that cannot be reproduced from the proven semantic plan.

Provider confidence is not proof. The verifier must reproduce the sole semantic
interpretation from deterministic evidence, parse and validate the internal
planned F1QL surface, independently lower it, and reproduce the Core hash. For
language outside the reviewed lexicon, the system clarifies or abstains until
that language is evaluated and promoted.

## 6. Capability Authorization

Replace template-only authorization with signed semantic capability profiles.
Templates remain valid regression cases and can use the same profiles.

A capability profile should define and allowlist:

- Catalog sources, dimensions, measures, and relationship families.
- Planned-F1QL/Core operators and typed filter/comparison operators.
- Legal operator-DAG topologies and source/concept co-occurrence constraints.
- Measure/dimension/filter compatibility and required aggregation order.
- Maximum sources, joins, depth, outputs, groups, entities, seasons, and rows.
- Historical/current scope and required coverage state.
- Principal classes and canary stages.
- Runtime work, concurrency, rate, timeout, row, and byte ceilings.

Default deny remains mandatory. Policy evaluates the entire normalized plan,
not a Cartesian product of individually allowed components. A valid plan that
uses an unsigned concept, topology, interaction, or operator must stop before
result-query database acquisition. Property tests must generate pairwise and
higher-order combinations to prove that individually allowed pieces cannot form
an unreviewed plan.

Release attestation must bind at least:

- Semantic catalog hash.
- Deployed view-definition fingerprint.
- Planner and whole-plan proof versions.
- Allowed capability-profile IDs.
- Answer routing mode and the exact template IDs migrated to compositional
  admission.
- Existing code, evidence, principal, runtime, release, and canary bindings.

## 7. Generic Deterministic Formatting

Formatting must derive from the proven output schema and catalog metadata, not
from arbitrary model prose.

The formatter should:

- Render dimensions and measures using catalog labels and units.
- Preserve official positions, decimals, nulls, and source ordering.
- State the exact scope and comparison semantics.
- Include source authority, coverage, freshness, and caveats.
- Detect empty, partial, duplicate, tied, malformed, or over-limit output.
- Refuse to summarize a result shape not exactly predicted by the proof.

Existing per-family formatters remain regression oracles during migration.

## 8. Evaluation Strategy

Evaluation must measure semantic planning, not only SQL validity or one-fixture
execution.

### Corpus

Build a reviewed compositional corpus that crosses:

- Every certified source, dimension, measure, filter, comparison, and scope.
- Every legal pair of operators and selected higher-order combinations.
- Single-source and multi-source plans.
- Aggregate-before-join and join-before-aggregate traps.
- Null, duplicate, missing-row, tie, sparse-season, and incomplete-session cases.
- Named event, round, driver, team, status, and value resolution.
- Historical, current, final, and freshness wording.
- Paraphrase, punctuation, typo, abbreviation, and word-order variants.
- Hidden entity, season, event, wording, and composition holdouts.
- Scope, attachment, lexical, metric, temporal, and output-shape ambiguity.
- Prompt injection and wrong-but-valid substitutions.

Existing 110 answer cases stay as a permanent regression suite. Existing
templates become expected semantic plans rather than the only accepted path.

### Metrics

Track independently:

| Metric | Purpose |
|---|---|
| Action accuracy | Answer, clarify, or abstain correctly |
| Concept recall/precision | Select all and only intended semantic concepts |
| Entity/scope accuracy | Resolve every literal entity and temporal scope |
| Exact semantic-plan accuracy | Match a reviewed normalized semantic plan |
| Test-suite denotation accuracy | Match results across multiple discriminating database instances |
| Ambiguity recall | Retain all defensible interpretations before clarification |
| Mutation rejection | Reject wrong source, join, grain, filter, aggregate, order, and limit variants |
| Valid efficiency | Correct plans also stay within relative work/latency bounds |
| Reliability | Repeated provider observations produce the same proven plan |

Execution accuracy on one database instance can accept semantically wrong
queries by coincidence. Every promoted plan family therefore needs multiple
data populations designed to distinguish common wrong plans.

### Release thresholds

The first production release requires:

- Zero unsafe executions in adversarial and ambiguity suites.
- Zero accepted source, metric, scope, join, grain, or authorization mutations.
- 100% preservation of the existing answer regression corpus.
- 100% SQL/reference agreement for every promoted planned-F1QL/Core topology.
- Passing per-capability factual, coverage, principal, and performance evidence.
- A frozen hidden holdout evaluated only by the release workflow.
- Recall may be conservative; unsupported recall does not justify lowering
  semantic precision.

## 9. Observability And Rollout

Add bounded planner observability without logging questions, SQL parameters, or
unbounded entity labels.

Track:

- Candidate, linker, planner, proof, authorization, compiler, database, and
  formatter outcomes and latency.
- Capability profile, operator set, source set, and complexity band.
- Estimated versus actual work, rows, bytes, and duration.
- Clarification/abstention reason and ambiguity class.
- Catalog, planner, proof, compiler, and release versions.

Rollout order:

1. Offline fixture-only evaluation.
2. Non-executing shadow planning with no answer-result query. Fixed,
   server-owned, bounded read-only identity/event resolution and catalog/view
   fingerprint queries are permitted and separately logged; translated or
   planned result programs never execute.
3. Dual planning against existing template questions; compare semantic and
   program hashes without executing the new path.
4. Read-only production metadata/fingerprint evidence.
5. Internal canary for one simple capability profile.
6. Immediate restoration to disabled stage zero.
7. Separate public attestation for the same profile.
8. Prove and canary the initial safe-join and aggregate-locality profiles.
9. Expand one source/operator/topology capability cohort at a time.

No percentage rollout may mix unreviewed source or operator cohorts. Rollback
remains the existing kill switch and stage-zero restoration.

## Implementation Work Packages

### Work Package 0: Deployment Safety Prerequisite

Fix `src/sync/auto-sync.ts` before another deployment.

- Remove the `Number.MAX_SAFE_INTEGER` interval that Node truncates to 1 ms.
- Make startup catch-up an explicit, separately configured writer behavior.
- Make production auto-sync opt-in rather than enabled by omission.
- Add fake-timer tests proving startup, Monday scheduling, retry, and shutdown.
- Verify a deployment does not trigger an unintended write-capable sync.

Definition of done: no timer overflow, no implicit startup writer, and retained
production evidence for one safe deployment.

### Work Package 1: Catalog Foundation

Add `semantic-catalog.ts`, catalog validation, stable hashing, and a generated
catalog snapshot for the five existing governed source families. Convert the
relevant prose contracts into machine-enforced grain, type, null, authority,
coverage, and relationship fields.

Definition of done: every exposed concept and join is reviewed, hash-bound,
mutation-tested, and checked against disposable PostgreSQL views.

### Work Package 2: Internal F1QL And Core Generalization

Define `PlannedF1QLProgram`, its internal-only parser, the legal operator-DAG
grammar, generic projection and predicates, typed joins, grain/integrity
propagation, deterministic multi-key ordering, and generic catalog-bound
measures. Generalize validation, lowering, cost, participation, compiler, and
reference interpreter together. Refactor the executor only to share these
existing safety stages; do not add a Core-direct execution path.

Definition of done: every promoted topology parses, validates, receives a
bounded cost and participation decision, lowers, passes Core validation,
compiles, and matches the reference interpreter. Caller-supplied `/program`
cannot submit the internal surface, and Core cannot enter answer execution
without a verified planned-F1QL parent.

### Work Package 3: Semantic Evidence And Candidate Queries

Add reviewed catalog lexicon entries, deterministic scope/comparison grammar,
strict `SemanticQueryCandidateSet` parsing, and a bounded independent semantic
enumerator. The provider supplies literal spans and candidate semantic refs;
the enumerator independently retains all interpretations licensed by the
question and catalog.

Definition of done: all supported questions yield the complete normalized
candidate set; ambiguous scope, attachment, metric, entity, temporal, and
output-shape cases yield multiple candidates and clarification; unknown
language yields abstention. Provider omission cannot turn an ambiguous case
into an executable singleton.

### Work Package 4: Deterministic Semantic Planner

Add deterministic linking, source/graph selection, grain analysis, fanout and
chasm rejection, aggregate locality, filter placement, work estimation,
`AnswerPlan`, and internal planned-F1QL materialization. Start with
single-source filter/aggregate/rank plans, then add the reviewed
classification-to-event-metadata join and a pre-aggregated multi-source
composition.

Definition of done: each admitted semantic query produces one frozen plan and
planned-F1QL hash; all equal-cost joins, unsafe grains, unsupported source
combinations, and over-budget plans fail before result-query execution.

### Work Package 5: Whole-Plan Proof And Authorization

Add independent candidate-set and semantic-plan verification plus
capability-profile policy. Bind catalog, candidate-set, plan, planned-F1QL,
Core, topology, and capability hashes into authorization and release artifacts.
Preserve exact-template authorization while both paths coexist.

Definition of done: single-field, pairwise, topology, source-interaction,
aggregation-order, and higher-order plan mutations fail. No provider object,
unverified plan, unapproved component combination, or Core-only object can
reach execution.

### Work Package 6: Generic Results

Add schema-driven formatting and coverage metadata for arbitrary proven output
shapes. Differentially compare generic output against existing family
formatters on all current answer cases.

Definition of done: current answers are byte-equivalent where contracts are
unchanged, and malformed, partial, duplicate, tied-without-policy, substituted,
or misordered results fail closed.

### Work Package 7: Compositional Regression Backbone

Build the reviewed corpus, discriminating database instances, plan mutations,
property generators, ambiguity sets, hidden holdouts, and worst-case legal plan
benchmarks. Extend production factual and authority evidence by capability.

Definition of done: all release thresholds in this roadmap are executable CI
or guarded evidence checks, not prose-only requirements. The hidden set
contains template-free held-out compositions, not only paraphrases of existing
templates.

### Work Package 8: Shadow Planner

Run provider-assisted semantic candidate proposal only in a new non-executing
shadow path. Existing `/program/translate` remains permanently unchanged and
non-executing. Bounded server-owned identity/event resolver queries are allowed;
planned result programs are never executed. Record sanitized candidate,
plan/proof, and dual-run outcomes against existing template programs.

Definition of done: retained shadow evidence passes semantic, ambiguity,
linking, safety, reliability, and performance gates with zero planned-result
executor calls. Resolver and fingerprint reads are separately counted and
cannot accept planner-authored statements.

### Work Package 9: Single-Source Production Canary

Issue a fresh signed release for the initial single-source profile over
certified standings and classification concepts. Deploy disabled stage zero,
verify the shadow invariant, execute exactly one authenticated internal canary,
restore stage zero, then repeat under a separate public attestation only after
review.

Definition of done: one template-free held-out semantic composition completes
through the internal planned-F1QL surface in both internal and separately
authorized public canaries, with complete signed evidence and verified
restoration after each.

### Work Package 10: Initial Capability Closure And Expansion

The initial Phase 11 closure must prove all three profile classes:

| Profile | Minimum promoted behavior |
|---|---|
| Single source | Select, filter, group, aggregate, rank, sort, and limit over certified standings or classification concepts |
| Safe dimension join | Join race or qualifying classification to event metadata through one catalog-declared many-to-one event key |
| Aggregate locality | Independently aggregate standings, race, and/or qualifying facts at their own grains before a bounded comparison/composition |

Each profile requires template-free hidden cases, complete interaction
mutations, factual evidence, principal audit, worst-case performance evidence,
attestation, internal canary, separately authorized public canary, and immediate
restoration. Later sources and topologies follow the same process one profile at
a time.

Definition of done: every plan in the bounded generated closure of each signed
profile is either proven executable or deterministically rejected, and users
can combine the promoted concepts without adding question-specific templates.

Delivery within this work package is family-based:

1. Driver standings single-source selection, filtering, grouping, aggregation,
   ranking, ordering, and bounded final/current scopes.
2. Race and qualifying classification single-source selection, filtering,
   grouping, aggregation, ranking, ordering, event, and season scopes.
3. Classification-to-event-metadata safe dimension joins.
4. Cross-source aggregate-local comparisons where each measure remains at its
   governed grain before composition.
5. Corpus migration and removal of question-hash capability bindings wherever
   the complete generated interaction family is proven and signed.

Local delivery note: final driver-standings points selection is complete across
all final seasons from 1950 through 2025 for zero to four drivers. The first
race-classification selection slice is also complete locally for one final
historical season, one explicit round or uniquely resolved named event, and one
to four drivers, returning only driver identity and nullable finishing
position. The matching qualifying-classification slice is complete over the
same season, event, and driver bounds, returning only driver identity and
nullable qualifying position. A one-event metadata slice is complete for one
final historical season from 1950 through 2025 and exactly one explicit round
or uniquely resolved named event, returning any nonempty subset of nullable
canonical race date, nullable raw event name, and nullable raw circuit
identifier. Outputs use canonical `date`, `event_name`, `circuit_id` order with
omitted fields removed; one row is required and ordering uses the first projected
field ascending with nulls last.
Circuit identifiers preserve exact nonblank source bytes and are not circuit,
venue, or Grand Prix names. Event names likewise preserve exact nonblank source
text and are not circuit or venue names. Caller limits, multi-event,
latest-recorded, interim, season-wide, additional metadata fields, and
non-race-session variants remain refused. The first selected-driver safe-dimension
join is implemented locally over race classification and event metadata through
the catalog-declared many-to-one race-event relationship. It accepts one final
historical season, one explicit round or uniquely resolved named event, and one
to four drivers. Every shape returns `driver_id` and nullable raw
`finishing_position` plus any nonempty subset of `date`, `event_name`, and
`circuit_id` in canonical metadata order. Singleton plans use an equality filter,
empty residual grain, and one requested row; multi-driver plans use an inclusion
filter, residual driver grain, the private 100-row collection bound, and exact
selected membership. All plans order by driver identity and require complete
event-key relationships, source-wide grain integrity, selected source presence,
and non-null requested metadata. Caller-limited, ranked, aggregate, no-metadata,
broader-output, season-wide, latest-recorded, interim, and five-plus-driver forms
remain refused. The existing unfiltered safe join remains a separate exact
interaction limited to driver identity, finishing position, event name, and
circuit identifier. The matching selected-driver qualifying safe join is also
implemented locally through a separate exact profile and the catalog-declared
`qualifying_event_metadata` relationship. It uses the same final-season,
one-event, one-to-four-driver, metadata-subset, canonical-order, row-bound,
driver-ordering, exact-membership, relationship-completeness, and source-integrity
contract while returning nullable raw `qualifying_position` instead of finishing
position. Joined `date` remains the event metadata race date, never a qualifying-
session date. Qualifying timing, grid position, sprint qualifying, status,
ranking, aggregation, caller-limited, no-metadata, broader-output, season-wide,
latest-recorded, interim, zero-driver, and five-plus-driver variants remain
refused. A
selected-driver standings-ranking slice is complete for one final historical
season from 1950 through 2025 and exactly two to four drivers, returning only
driver identity and recorded non-null championship position. It orders official
position then driver identity, never derives rank from points, and requires
complete requested membership plus source-wide grain, null, bound, and unique
position integrity. Singleton, five-driver, unfiltered, caller-limited,
latest-recorded, and interim standings-ranking requests remain refused. A
filtered standings-position selection slice is also complete for one final
historical season and one to four uniquely resolved canonical drivers. It
returns only `driver_id` and the nullable raw recorded `championship_position`,
uses `driver_id:eq` for a singleton and `driver_id:in` for two to four drivers,
and orders by driver identity rather than position. The singleton requests one
row; the multi-driver form uses the private 100-row collection bound and requires
exact selected membership. Source-wide driver-season grain and positive-position
integrity remain mandatory, while null and equal positions are preserved as raw
facts with the catalog null caveat rather than converted into rank. Positive
positions have no artificial upper bound. `Championship rank` remains a field
synonym unless a separate rank command is present. Caller limits are refused
before provider admission; ranking remains a separate stricter interaction, and
unfiltered, five-driver, all other broader-output, latest-recorded, and interim position
selections remain outside the executable complete interaction even when semantic
shadow can prove their candidate plans.
A separate selected-driver summary interaction is complete locally for one
through four uniquely resolved drivers and one final historical season. It returns
exactly `driver_id`, nullable raw `championship_position`, and nullable exact-decimal
championship `points`. A singleton uses `driver_id:eq`, empty output grain, and one
row; two through four drivers use `driver_id:in`, residual driver grain, the private
100-row collection bound, and exact selected membership. Participation,
source-presence, driver-season grain, positive-position integrity, and
driver-identity ordering requirements are unchanged. Null position and null points
remain unavailable recorded facts; neither is derived or defaulted. This mixed
projection does not acquire the points-only answer-envelope compatibility contract.
Unfiltered, five-or-more-driver, caller-limited, ranked, latest-recorded, and interim
mixed projections remain refused.
A
selected-driver race-ranking slice is also complete for exactly one final
historical event and two to four drivers. It returns only driver identity and
recorded nullable finishing position, orders position ascending with nulls last
then driver identity, preserves equal and null positions as source facts, and
requires exact requested membership plus source-wide grain and position-bound
integrity. It never derives rank from race points, status, laps, or source
display order. Singleton, five-driver, unfiltered, season-wide, caller-limited,
latest-recorded, interim, race-points, status, mixed-source, and broader-output
race rankings remain refused.
The matching selected-driver qualifying-ranking slice is complete for the same
one-event and two-to-four-driver bounds. It returns only driver identity and
recorded qualifying position, orders position then driver identity, and requires
exact selected membership plus source-wide grain, bounds, non-null positions,
and unique positions. It never derives rank from best time, grid position,
status, sprint qualifying, or driver identity. Singleton, five-driver,
unfiltered, season-wide, caller-limited, latest-recorded, interim, timing, grid,
sprint, status, mixed-source, and broader-output qualifying rankings remain
refused.
Ungrouped classification-position count slices are also complete for one final
historical season from 1950 through 2025. The race slice permits either no
driver filter or exactly one uniquely resolved canonical driver; the qualifying
slice permits the same two modes. They return exactly one
`count_finishing_position` or `count_qualifying_position` scalar using
`COUNT(finishing_position)` or `COUNT(qualifying_position)` over the respective
governed retained rows. Null positions are excluded; an integrity-clean
all-null source is factual zero, while absent source rows are integrity failure.
The race count does not mean starts, events, wins, classified finishes, or
complete schedule/entrant coverage. The qualifying count does not mean
appearances, events, poles, top-ten results, or complete schedule/entrant
coverage. A filtered classification count additionally requires selected-driver season
participation and selected source presence. Source-wide event-driver grain and
position bounds remain mandatory even outside the selected driver, but equal
positions are valid because no sporting rank is inferred. Multi-driver classification
filters, event, status, or position filters,
all other grouped or ranked counts, alternate aggregates, broader output,
latest-recorded scope, and caller limits remain refused.
One exact grouped qualifying-count ranking is implemented locally for one final
historical season from 1950 through 2025. It accepts zero entities and exactly
the caller-grounded `top 10` limit, groups qualifying classification by
`driver_id`, returns `driver_id` followed by `COUNT(qualifying_position)`, and
orders count descending then C-collated driver identity ascending. The count is
non-null recorded qualifying-position rows, not appearances, events, poles,
top-ten finishes, or complete participation. Integrity-clean all-null driver
rows produce zero; absent source evidence, duplicate event-driver grain, or
positions outside 1 through 30 fail closed. Equal counts are valid and driver
identity only stabilizes their presentation and the cutoff. Every other or
missing limit, contradictory return-all wording, selected-driver, race-source,
event/round-scoped, filtered, alternate-grouped, alternate-aggregate,
broader-output, comparison, latest-recorded, and interim variant remains
refused before provider invocation.
One unfiltered aggregate-locality composition is also implemented locally for one
final historical season. Race `COUNT(finishing_position)` and qualifying
`COUNT(qualifying_position)` are computed independently at their governed source
grains before one scalar composition; the result keeps source-qualified output
identities and does not compare, subtract, rank, normalize, or infer completeness
from the two counts. Each value counts only non-null recorded position rows. An
integrity-clean all-null source is factual zero, while absent source rows,
duplicate event-driver grain, or out-of-bounds positions fail integrity. Grouped,
per-driver, pooled multi-driver, event- or round-scoped, caller-limited, reordered,
alternate-aggregate, broader-output, latest-recorded, interim, comparison, and
delta forms remain refused.
Unfiltered event classification selection remains refused until the catalog can
provide event-complete membership witnesses. Season-wide filtered
selection, latest-recorded 2026 event metadata, user-supplied limits, event-metadata
fields outside the complete three-field projection lattice, broader event metadata,
non-race session dates, classification status,
qualifying timing, grid position, sprint qualifying, other grouping or aggregation,
unfiltered ranking, and comparison remain outside these slices and must be promoted
through separate complete-interaction and response-coverage contracts. No
production release or routing change is claimed by these local milestones.

### Work Package 11: Certified Retained-Data Onboarding

Add a repeatable source-certification path for eligible facts already retained
by F1Muse, beginning with career, constructor, and circuit analysis. Source
onboarding must update the catalog, serving view, database binding, typed
relationships, planner-visible concepts, operator allowlists, coverage matrix,
formatter metadata, principal audit, discriminating populations, mutation
suite, and capability profile together.

No schema crawler or model may automatically expose a database field. New
concepts are reviewed semantic contracts. Unsupported formulas and combinations
remain absent even if their input columns exist.

Definition of done: every newly exposed concept is queryable through all and
only its declared operators, generated valid combinations pass SQL/reference
parity, invalid combinations fail before result-query acquisition, and missing
historical or entity coverage produces a typed abstention rather than a partial
answer.

### Work Package 12: Official Historical Lap Analytics

Promote the sealed `official_timing` historical source separately from derived
pace. Add official lap timing to the semantic catalog with race-event, driver,
lap-number, inclusive lap-window, official deletion, explicit pit, and raw lap
time semantics. Expose the existing
`official_non_deleted_non_pit_window_median_v1` and
`official_non_deleted_non_pit_event_mean_v1` measures without inventing
clean-air, tyre, fuel, traffic, safety-car, or weather claims.

The first factual scope remains the hash-pinned Belgian 2022 dataset. The
existing closed compiler operations become regression anchors while the
semantic planner gains the equivalent catalog-bound topology. Complete window
coverage and at least two eligible laps per driver are mandatory. For example,
Verstappen versus Alonso over supported Belgian 2022 laps may answer, while an
Alonso versus Hamilton window must abstain because the retained dataset records
Hamilton with zero completed laps.

Definition of done: local migration, immutable dataset, security-barrier view,
catalog/database binding, planner/proof/capability/formatter path, missing-row
coverage behavior, SQL/reference parity, and internal/public canaries all pass.
No partial lap-window result is permitted.

### Work Package 13: Derived Pace Expansion

Onboard `f1ql.lap_pace` only after official historical laps are distinct in the
catalog and response contract. Bind every result to its methodology version and
observed season/event coverage. Clean-air, compound, tyre-age, stint, and other
filters are exposed only when their retained source fields and factual meaning
are certified for the requested scope.

Derived pace must never substitute for official raw lap timing, classification,
fastest lap, or the historical official-window measures. Unsupported events,
sessions, methodologies, and incomplete shared-driver windows abstain.

Definition of done: each promoted pace measure has independent source evidence,
eligibility and null semantics, discriminating SQL/reference fixtures, coverage
metadata, capability-scoped production evidence, and separate canaries.

## Migration And Compatibility

- Existing templates stay operational until their semantic-plan equivalents
  pass dual-run comparison and production canaries.
- Templates become regression fixtures and optional deterministic fast paths,
  not the semantic authority.
- Routing is deterministic and release-bound with three modes:
  `template_only`, `shadow_compare`, and `compositional_profiles`.
- In `shadow_compare`, existing contracted questions execute only through the
  current template proof while compositional planning remains non-executing.
- In `compositional_profiles`, a signed `migrated_template_ids` set decides
  overlap. Unmigrated contracted wording stays on the current deterministic
  template lane. Migrated template IDs and newly supported compositional
  questions use only the compositional candidate, proof, and authorization
  lane.
- Provider, linker, planner, proof, or runtime failure in the compositional lane
  clarifies, abstains, or returns unavailable according to its typed outcome;
  it never falls back to an exact template or another semantic interpretation.
- Provider availability cannot affect an unmigrated deterministic template
  question.
- There is no fallback from failed compositional proof to a looser SQL path.
- There is no fallback to the removed legacy QueryIntent architecture.
- Existing answer envelopes and safety metadata should remain stable unless a
  separately versioned API change is required.

## Principal Risks

| Risk | Mitigation |
|---|---|
| Valid but wrong semantic query | Literal-span grounding, independent candidate enumeration, catalog lexicon, whole-plan proof, mutation tests |
| Fanout inflates measures | Typed grains/cardinalities, aggregate locality, unsafe-join rejection |
| Catalog overfits evaluation questions | Structural fields over prose, hidden holdouts, review descriptions for reusable meaning |
| Same-result false positives | Multiple discriminating database instances and mutation-specific fixtures |
| Provider drift | Repeated observations, frozen model/config bindings, conservative abstention |
| Source incompleteness | Separate observed coverage from certified coverage; fail closed on unsupported scope |
| Expensive read-only plans | Static work admission, worst-case benchmarks, statement timeout, rows/bytes/concurrency caps |
| Capability expansion exceeds DB grants | Catalog-to-principal audit and signed deployed-view fingerprint |
| Planner bypasses shadow invariant | Separate import graph and injected throwing-executor tests |
| Broad language hides ambiguity | Retain all defensible plans and clarify unless exactly one survives |

## Phase 11 Definition Of Done

Phase 11 is complete only when:

- The production scheduler prerequisite is fixed and verified.
- A versioned semantic catalog is the sole planner-visible fact space.
- Provider output is limited to bounded strict semantic-query candidates with
  literal spans.
- Independent semantic evidence enumerates all defensible interpretations and
  admits exactly one before planning.
- A generalized internal planned-F1QL surface preserves parsing, validation,
  cost, participation, lowering, Core validation, compilation, and runtime
  safety; no Core-direct answer executor exists.
- Physical sources, joins, grain, integrity, planned F1QL, Core, and SQL are
  deterministic.
- Independent proof reproduces the candidate set and every executable plan.
- Authorization signs semantic capability profiles, legal interaction
  topologies, and catalog identity.
- Existing template answers pass unchanged as regression cases.
- The compositional hidden benchmark and all mutation, property, differential,
  ambiguity, factual, principal, and performance gates pass.
- Shadow evidence proves zero planned-result execution while separately
  accounting for fixed resolver/fingerprint reads.
- Template-free single-source, safe dimension-join, and aggregate-locality
  compositions pass the required internal and separately authorized public
  capability canaries.
- Production is restored to disabled, kill-switched, public-disabled stage zero.

## References

1. Scholak, Schucher, and Bahdanau. "PICARD: Parsing Incrementally for
   Constrained Auto-Regressive Decoding from Language Models." EMNLP 2021.
   https://arxiv.org/abs/2109.05093
2. Li et al. "Can LLM Already Serve as A Database Interface? A BIg Bench for
   Large-Scale Database Grounded Text-to-SQLs." NeurIPS 2023.
   https://arxiv.org/abs/2305.03111
3. Saparina and Lapata. "AMBROSIA: A Benchmark for Parsing Ambiguous Questions
   into Database Queries." NeurIPS 2024.
   https://arxiv.org/abs/2406.19073
4. Lei et al. "Spider 2.0: Evaluating Language Models on Real-World Enterprise
   Text-to-SQL Workflows." ICLR 2025.
   https://arxiv.org/abs/2411.07763
5. Kim, Khoeurn, and Yoon. "A Semantic-Layer-Mediated Agent for Natural
   Language to SQL over Heterogeneous Enterprise Databases." 2026.
   https://arxiv.org/abs/2606.31041
6. Block Engineering. "Building the Data Foundation for Automated Analytics."
   https://engineering.block.xyz/blog/building-the-data-foundation-for-automated-analytics
7. ktx documentation. "Semantic querying."
   https://docs.kaelio.com/ktx/docs/concepts/semantic-layer-internals
8. Atlas documentation. "SQL Validation Pipeline."
   https://docs.useatlas.dev/security/sql-validation/
