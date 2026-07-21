## Session start
At the start of every session: read `PROGRESS.md`, `ROADMAP.md`, `git log --oneline -15`, and `git status --short`; then run `npm run typecheck && npm run test:f1ql` to establish a green baseline before editing anything.

## Autonomy
- Never pause for approval. Resolve ambiguity with the most conservative option consistent with existing repo conventions, record the decision in `PROGRESS.md`, and continue.
- If an item cannot be completed in this environment (missing credentials, unavailable daemon, insufficient data history), implement everything up to that boundary using fixtures, mocks, or flags, mark it `PARTIAL` in `PROGRESS.md` with exact finishing instructions, and move on.

## Safety invariants (all phases)
- **Shadow translation never executes.** The translator may parse, translate, validate, and log — it must never run translated queries against any database. Keep the injected throwing-executor invariant test passing.
- **Database:** all access read-only; every generated statement runs under a statement timeout; no DDL/DML against shared databases; no new persistent tables or log sinks without explicit user instruction.
- **Tests that need Postgres run ONLY through the wrapped npm scripts** (`test:f1ql`, `test:api:inprocess`, `test:golden:db`, ...). Never invoke bare `vitest` on database-backed suites: production credentials exist in `.env`, and the localhost guard tripping counts as a failed run, not a pass.
- **Secrets:** never print, echo, log, or commit a secret. Keys are set by the user in the Railway dashboard. If a secret ever appears in terminal output or chat, stop immediately and tell the user to rotate it.

## Verification standards
- Never validate a script or feature against empty or absent input.
- Fixtures that represent emitted output must be generated from the real emitter and then committed — never written by hand.
- Production behavior is proven only by a production round-trip (deploy → request → fetch → verify), with the evidence recorded in `PROGRESS.md`.
- Deploy (`railway up`) only from a committed, fully green state; after every deploy, verify with one shadow request.
- A phase is complete only when typecheck, lint, and the relevant wrapped suites are green. Pre-existing unrelated failures: note them in `PROGRESS.md`, do not let them block, never introduce new ones.

## Communication
- Never end a turn on a status summary. Progress notes belong in `PROGRESS.md`, not chat.
- The only valid final messages are: (a) the phase-completion report after that phase's definition of done is verified, or (b) the single line `CONTINUE — budget reached`, used only after committing current work and writing exact next steps into `PROGRESS.md`. When the user replies "continue", resume from `PROGRESS.md` without recapping.
- Commits: small, per-milestone, format `phase-N: <what changed>`.
- Prefer extending existing patterns; no new dependencies except `fast-check`, which is pre-approved for Phase 5.
