# F1QL Test Plan

Status: living release plan

## Purpose

F1QL correctness has five independent dimensions. A green unit suite proves only a subset of them.

1. Language safety: untrusted input cannot escape the closed algebra.
2. Compiler correctness: the same validated program produces the same deterministic result through every implementation.
3. Data correctness: canonical database facts match cited authorities.
4. Methodology correctness: derived metrics, especially pace, have reproducible source evidence and eligibility rules.
5. Operations correctness: deployments, schemas, performance, and observability remain healthy in production.

Every test or audit must declare which dimension it proves. Fixture agreement is never presented as an external factual proof.

## Test Layers

| Layer | Runs where | Proves | Does not prove |
|---|---|---|---|
| Typecheck/lint | PR, local | static contracts and style | runtime behavior |
| Schema/parser tests | PR, local | closed F1QL grammar | source facts |
| Unit tests | PR, local | isolated rules and mappings | database integration |
| Docker F1QL tests | PR, local | validation, compiler, executor, fixture behavior | production data |
| Goldens | PR, local | stable lowering/result contracts | real-world facts unless cited |
| Properties/metamorphic tests | PR, local | bounded algebra laws | source completeness |
| Differential tests | PR, local | SQL/reference parity on fixtures | independent data truth |
| Production corpus | nightly/manual | production schema/source availability | broad historical correctness |
| Authority audit | nightly/manual | selected production facts against FIA/official sources | every database row |
| Pace artifact audit | manual/nightly after artifacts | timing provenance and eligibility evidence | unsupported timing fields |
| Performance audit | nightly/manual | observed latency/query plans | semantic correctness |

## Phase Gates

### Translation and Shadow

- Test all feature-gate combinations: route unmounted, mounted/shadow-disabled, and enabled.
- Assert every successful shadow request returns a validated program and never invokes an executor.
- Assert malformed JSON, schema-invalid output, identity misses, provider failures, and every validation code use stable typed outcomes.
- Assert logs, JSON metrics, Prometheus metrics, and report parser use the same outcome/reason taxonomy.
- Production gate: one shadow request after every deploy, then retained-log report evidence.

### Validation and Execution

- Every gate has accepted and rejected fixtures: schema, signatures, definitions version, participation, coverage, complexity, statement timeout, and core IR validation.
- Participation tests cover every driver-bearing surface program, including excluded test drivers and partial entity sets.
- Executor tests prove read-only transaction, local timeout, rollback after errors, and no timeout leakage.
- Generated SQL must be parameterized, read-only, source-constrained, and bounded.
- Production gate: schema contract and guarded corpus use the read-only role only.

### Core IR

- Regenerate lowering snapshots only through the real parser/lowerer.
- Require review for every intentional snapshot diff.
- Assert surface macros lower into approved core nodes.
- Differential tests compare compiler SQL results with the reference interpreter on every fixture-supported source.
- Property generators stay inside node/depth/round budgets and assert validation plus compilation.
- Metamorphic laws are source-specific: empty filter no-op, filter reordering, sort inversion with unique order keys, and small-limit prefix.

### Data Sources

For each source, maintain a source contract containing authority, coverage, fields, null rules, identity normalization, and production evidence.

| Source | Authority | Required checks |
|---|---|---|
| standings | `season_driver_standing` | final standings facts, zero points, scoring-era transitions |
| race classification | `race_data` through canonical view | P1/P2/P3, DNF, DNS, DSQ, points, classification order |
| qualifying classification | `qualifying_results` through canonical view | pole, non-pole, DNS/DNF, grid versus qualifying distinction |
| event metadata | `race`/`grand_prix` | event name, date, circuit, session scope |
| lap pace | `laps_normalized_v2` | v2 coverage, race-session isolation, methodology, timing artifacts |

### Historical Scoring

- Maintain a cited, season-bounded scoring registry.
- Test all transition boundaries: 1950-era scoring, dropped-score eras, 2014 double-points finale, 2019 fastest-lap return, 2021/2022 sprint changes, and 2025 fastest-lap removal.
- Never derive championship totals from race points. Final totals always query standings authority.
- Every cited production scoring golden names its FIA/official source.

### Pace

Pace claims require three distinct proofs.

1. Source proof: preserved official timing artifact with URL, retrieval time, SHA-256, and driver identity map.
2. Eligibility proof: every included/excluded v2 lap has documented validity, pit, in/out, session, and methodology treatment.
3. Derived proof: independent median-per-event and mean-of-medians computation matches F1QL.

- Do not infer clean-air, pit, in/out, or timing facts from final classification.
- A round with incomplete official timing, missing starters, or unsupported eligibility fields remains `coverage_only`, not factual.
- V2 ingestion must be manifest-driven, per-round audited, session-scoped, fingerprinted, and fail closed.
- Original facts and correction evidence remain immutable; replacements require explicit manifests and append-only audits.

## Production Protocols

### Read-only Evidence

- All production evidence scripts require explicit enable and production-target flags.
- Refuse localhost.
- Use one connection, `BEGIN READ ONLY`, local timeout, rollback, bounded queries, and JSON stdout only.
- Store artifacts outside the database; record artifact hash, deployed commit, manifest hash, source URL, and result in `PROGRESS.md`.

### Write Protocols

- Production writes require explicit user authorization and a primary-capable connection.
- Apply forward migrations transactionally.
- Never overwrite pace facts or audit rows. Use append-only replacement/rebuild relations and immutable evidence.
- Run read-only verification before and after every write.
- Process approved pace manifests one round at a time and stop at the first failed quality/fingerprint/identity condition.

### Deployment

- Deploy only from committed, locally green state.
- Confirm Railway region and IPv4-capable Supabase Session Pooler before deployment.
- Verify `/health`, one shadow request, and retained `[F1QLTranslation]` log after each deployment.

## CI and Nightly

### Pull Requests

- Typecheck and lint.
- Docker-backed unit, golden, integration, schema, API, and F1QL suites.
- 100-case corpus, property, metamorphic, and differential tests.
- No production credentials, database, or web artifacts.

### Nightly

- Read-only production corpus and authority audit.
- Shadow translation smoke and retained-log report.
- Pace v2 preflight and artifact integrity report.
- Sanitized query-plan and p50/p95 execution evidence.
- Alert on new authority mismatch, source coverage regression, audit/fingerprint mismatch, or shadow rejection increase.

## Promotion Checklist

Before moving from shadow-only execution experiments:

- PR CI is green and stable across multiple runs.
- Production schema snapshot matches the active migration ledger.
- Every supported source has cited factual checks and explicit unsupported boundaries.
- Pace either has all three factual proofs for the requested scope or fails closed.
- Production corpus, authority audit, and pace preflight are green.
- Shadow logs have sufficient retained volume and stable typed rejection taxonomy.
- Performance evidence exists for compile, SQL, API, and frontend latency.
- Database correction layers and legacy-consumer retirement plan are reviewed.

## Current Priorities

1. Finish the v2 pace replacement/rebuild flow and obtain a ready preflight without loosening evidence requirements.
2. Promote only timing-artifact-compatible pace events to factual golden checks.
3. Add nightly operational workflows while keeping PR CI production-free.
4. Reconcile database migration ledger, correction-layer sizes, and legacy consumer dependencies before cleanup.
