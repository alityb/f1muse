# Implementation Log

## 2026-07-18: Shadow F1QL Translation
- Decision: `/program/translate` is independently feature-gated by `F1QL_TRANSLATION_ENABLED`.
- Decision: the initial route is shadow-only and returns a validated program without calling `executeF1QL`.
- Decision: driver identities use the strict database-backed `DriverResolver`; no humanized or guessed fallback IDs are allowed.
- Decision: translation accepts only the constrained F1QL schema. Legacy intents and SQL fallbacks are prohibited.
