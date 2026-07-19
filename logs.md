# Implementation Log

## Autonomous Roadmap Progress

### Phase 0: COMPLETE
- Translation entry: `src/api/routes/program-translate.ts` is feature-gated, shadow-only, and does not call `executeF1QL`.
- Translation adapters: `src/f1ql/translator.ts` supports Anthropic and OpenAI-compatible tool calls; production uses Groq.
- Surface schema/lowering: `src/f1ql/ast.ts`, `schema.ts`, `lower.ts`.
- Core/compiler/interpreters: `src/f1ql/core.ts`, `compiler.ts`, `interpreter.ts`, `executor.ts`.
- Existing budgets: `src/f1ql/limits.ts`; API route handles program metrics/logging.
- Tests: `tests/f1ql/*`, `tests/api/in-process-routes.test.ts`; local PostgreSQL is bootstrapped by `src/test/setup.ts`.
- CI: `.github/workflows/test.yml` runs typecheck, lint, unit, golden, integration, schema, and in-process API gates.
- Property testing: no library is installed. `fast-check` is the appropriate TypeScript dependency for Phase 5, but will be introduced only with bounded generators.

### Phase Status
- Phase 1: IN PROGRESS. Shadow route exists; typed outcome metrics, report automation, nightly CI, and corpus smoke are not yet complete.
- Phase 2: NOT STARTED. Existing schema and round/result budgets are partial validation only.
- Phase 3: PARTIAL. Current core IR still has specialized pace and classification nodes. Preserve behavior before refactoring.
- Phase 4: PARTIAL. Standings, pace, and race classification exist; qualifying/event metadata/retirement sampling remain incomplete.
- Phase 5: PARTIAL. Targeted goldens and differential tests exist; 100-question corpus, property, metamorphic, and nightly suites do not.

### Phase 1 Metrics Fixture
- Local shadow route test observed: succeeded=1, invalid=2, unavailable=1, identity_miss=1, unsupported=1.

## 2026-07-18: Shadow F1QL Translation
- Decision: `/program/translate` is independently feature-gated by `F1QL_TRANSLATION_ENABLED`.
- Decision: the initial route is shadow-only and returns a validated program without calling `executeF1QL`.
- Decision: driver identities use the strict database-backed `DriverResolver`; no humanized or guessed fallback IDs are allowed.
- Decision: translation accepts only the constrained F1QL schema. Legacy intents and SQL fallbacks are prohibited.
- Fix: Anthropic translation now uses forced tool use (`emit_f1ql_program`) instead of prompt-only text JSON after a production shadow request returned non-JSON text.
- Decision: use Groq `openai/gpt-oss-20b` through the OpenAI-compatible adapter for low-cost shadow translation.
