#!/usr/bin/env bash
# =============================================================================
# sync-f1db.sh  —  F1DB auto-sync + full post-race ETL pipeline
#
# What it does:
#   1. Checks GitHub releases for the latest F1DB version
#   2. Compares it to the last imported version (tracked in DB via a metadata row)
#   3. If a newer release exists, downloads f1db-sql-postgresql.zip and imports it
#   4. Re-runs the downstream ETL chain:
#        race results twin  → teammate gap (race + qualifying)  → matchup matrix
#
# Run this after each race weekend to keep the full pipeline current.
#
# Usage:
#   npm run sync:f1db              # check + import if needed, re-run ETL
#   npm run sync:f1db -- --force   # force re-import even if version unchanged
#   npm run sync:f1db -- --etl-only  # skip F1DB check, just re-run ETL
#
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env
if [[ -z "${DATABASE_URL:-}" ]] && [[ -f "${ROOT_DIR}/.env" ]]; then
    set -a; source "${ROOT_DIR}/.env"; set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "✗ DATABASE_URL not set" >&2; exit 1
fi

FORCE=false
ETL_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --force)    FORCE=true ;;
        --etl-only) ETL_ONLY=true ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
db_query() { psql "${DATABASE_URL}" -t -A -c "$1" 2>/dev/null || echo ""; }

ensure_sync_table() {
    psql "${DATABASE_URL}" -q <<'SQL'
CREATE TABLE IF NOT EXISTS f1db_sync_state (
    id              SERIAL PRIMARY KEY,
    imported_version TEXT NOT NULL,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    release_url     TEXT
);
SQL
}

get_imported_version() {
    db_query "SELECT imported_version FROM f1db_sync_state ORDER BY imported_at DESC LIMIT 1"
}

set_imported_version() {
    local version="$1" url="$2"
    psql "${DATABASE_URL}" -q -c \
        "INSERT INTO f1db_sync_state (imported_version, release_url) VALUES ('${version}', '${url}')"
}

# ---------------------------------------------------------------------------
# Step 1 — Check GitHub for latest F1DB release
# ---------------------------------------------------------------------------
echo ""
echo "=== F1DB SYNC + ETL PIPELINE ==="
echo ""

ensure_sync_table

CURRENT_VERSION="$(get_imported_version)"
echo "→ Currently imported F1DB version: ${CURRENT_VERSION:-none}"

LATEST_RELEASE_JSON="$(curl -sf 'https://api.github.com/repos/f1db/f1db/releases/latest')"
LATEST_VERSION="$(echo "${LATEST_RELEASE_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")"
DOWNLOAD_URL="$(echo "${LATEST_RELEASE_JSON}" | python3 -c "
import sys, json
r = json.load(sys.stdin)
for a in r['assets']:
    if a['name'] == 'f1db-sql-postgresql.zip':
        print(a['browser_download_url'])
        break
")"

echo "→ Latest F1DB release:             ${LATEST_VERSION}"

# ---------------------------------------------------------------------------
# Step 2 — Download + import if newer (or forced)
# ---------------------------------------------------------------------------
if [[ "${ETL_ONLY}" == "true" ]]; then
    echo "→ --etl-only: skipping F1DB import"
elif [[ "${FORCE}" == "true" ]] || [[ "${LATEST_VERSION}" != "${CURRENT_VERSION}" ]]; then
    if [[ "${FORCE}" == "true" ]]; then
        echo "→ --force: re-importing ${LATEST_VERSION}"
    else
        echo "→ New version detected — importing ${LATEST_VERSION}"
    fi

    # Download
    DOWNLOAD_DIR="$(mktemp -d)"
    trap 'rm -rf "${DOWNLOAD_DIR}"' EXIT
    ZIP_PATH="${DOWNLOAD_DIR}/f1db-sql-postgresql.zip"

    echo "  Downloading ${DOWNLOAD_URL} ..."
    curl -sL "${DOWNLOAD_URL}" -o "${ZIP_PATH}"
    echo "  Extracting ..."
    unzip -o "${ZIP_PATH}" -d "${DOWNLOAD_DIR}" > /dev/null
    cp "${DOWNLOAD_DIR}/f1db-sql-postgresql.sql" "${ROOT_DIR}/f1db-import/f1db-sql-postgresql.sql"
    echo "  ✓ F1DB SQL updated ($(du -sh "${ROOT_DIR}/f1db-import/f1db-sql-postgresql.sql" | cut -f1))"

    # Import
    echo "  Running import-f1db-safe.sh ..."
    bash "${ROOT_DIR}/f1db-import/import-f1db-safe.sh"

    # Record version
    set_imported_version "${LATEST_VERSION}" "${DOWNLOAD_URL}"
    echo "  ✓ Recorded imported version: ${LATEST_VERSION}"
else
    echo "→ Already on latest version — skipping F1DB import"
fi

# ---------------------------------------------------------------------------
# Step 3 — Jolpica sync (calendar + results + qualifying + standings)
#           This is the primary F1DB substitute — zero lag, always current.
# ---------------------------------------------------------------------------
echo ""
echo "→ Running Jolpica ETL (calendar + results + qualifying + standings) ..."
PYTHON="${ROOT_DIR}/venv/bin/python"
if [[ ! -x "${PYTHON}" ]]; then PYTHON="python3"; fi

"${PYTHON}" "${ROOT_DIR}/src/etl/ingest-from-jolpica.py" --season 2026 --job all
echo "  ✓ Jolpica sync done"

# ---------------------------------------------------------------------------
# Step 4 — FastF1 race results twin (backfill any races Jolpica missed)
# ---------------------------------------------------------------------------
echo ""
echo "→ Running FastF1 race results twin (backfill) ..."
"${PYTHON}" "${ROOT_DIR}/src/etl/ingest-race-results.py" --season 2026
echo "  ✓ Race results twin done"

# ---------------------------------------------------------------------------
# Step 5 — Teammate gap (race pace + qualifying)
# ---------------------------------------------------------------------------
echo ""
echo "→ Running teammate gap (race) ..."
npx --prefix "${ROOT_DIR}" tsx -r dotenv/config \
    "${ROOT_DIR}/src/etl/teammate-gap/race.ts"
echo "  ✓ Teammate gap (race) done"

echo ""
echo "→ Running teammate gap (qualifying) ..."
npx --prefix "${ROOT_DIR}" tsx -r dotenv/config \
    "${ROOT_DIR}/src/etl/teammate-gap/qualifying.ts"
echo "  ✓ Teammate gap (qualifying) done"

# ---------------------------------------------------------------------------
# Step 6 — Matchup matrix
# ---------------------------------------------------------------------------
echo ""
echo "→ Running matchup matrix ..."
npx --prefix "${ROOT_DIR}" tsx -r dotenv/config \
    "${ROOT_DIR}/src/etl/matchup-matrix.ts"
echo "  ✓ Matchup matrix done"

# ---------------------------------------------------------------------------
echo ""
echo "=== SYNC COMPLETE ==="
echo "  F1DB version:    ${LATEST_VERSION}"
echo "  Finished at:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
