# Implementation Log

## 2026-07-18: Shadow F1QL Translation
- Decision: `/program/translate` is independently feature-gated by `F1QL_TRANSLATION_ENABLED`.
- Decision: the initial route is shadow-only and returns a validated program without calling `executeF1QL`.
- Decision: driver identities use the strict database-backed `DriverResolver`; no humanized or guessed fallback IDs are allowed.
- Decision: translation accepts only the constrained F1QL schema. Legacy intents and SQL fallbacks are prohibited.
- Fix: Anthropic translation now uses forced tool use (`emit_f1ql_program`) instead of prompt-only text JSON after a production shadow request returned non-JSON text.
- Decision: use Groq `openai/gpt-oss-20b` through the OpenAI-compatible adapter for low-cost shadow translation.
