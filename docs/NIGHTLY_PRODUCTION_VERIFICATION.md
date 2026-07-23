# Nightly Production Verification

`.github/workflows/f1ql-shadow-review.yml` runs nightly and by manual dispatch.
Its GitHub `production` environment provides the approval boundary, and its
concurrency group prevents overlapping production observations. It is the only
GitHub workflow that accesses production. Pull-request CI remains limited to
the Docker test database in `.github/workflows/test.yml`.

The workflow authenticates the Railway CLI with the repository `RAILWAY_TOKEN`
secret. It never prints the token or injects a database URL into GitHub workflow
configuration. Railway supplies `DATABASE_URL` only to the three guarded local
commands selected with `--no-local`.

Each run invokes the committed, dual-flagged production readers:

- `golden:f1ql:production`
- `audit:database-authority:production`
- `preflight:pace-v2:production`
- the 30-day Railway shadow-log report

The database readers enforce their own loopback refusal, one read-only
transaction, transaction-local five-second statement timeout, and rollback. The
shadow path fetches logs and aggregates them only; it does not call translation
or execute translated queries.

All readers are attempted even if an earlier reader fails. The job fails when
any reader or artifact preparation fails, but uploads sanitized artifacts with
UTC generation time and the triggering commit SHA. Raw Railway logs and raw
runner output are never uploaded. The artifact sanitizer removes URLs and
credential-shaped fields; authority URLs remain in committed documentation and
source manifests, not workflow artifacts.
