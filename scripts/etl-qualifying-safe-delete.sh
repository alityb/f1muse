#!/bin/bash
# Safe delete script for qualifying data
# Requires --force flag and automatically re-ingests after delete

set -e

SEASON=""
ROUND=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --season)
      SEASON="$2"
      shift 2
      ;;
    --round)
      ROUND="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -z "$SEASON" ] || [ -z "$ROUND" ]; then
  echo "Usage: $0 --season YEAR --round ROUND_NUMBER --force"
  echo ""
  echo "This script safely deletes and re-ingests qualifying data for a specific round."
  echo "The --force flag is REQUIRED to prevent accidental deletes."
  echo ""
  echo "Example: $0 --season 2024 --round 6 --force"
  exit 1
fi

if [ "$FORCE" != "true" ]; then
  echo "ERROR: --force flag is required to delete qualifying data"
  echo ""
  echo "This is a DESTRUCTIVE operation. Make sure you want to:"
  echo "  1. DELETE all qualifying data for $SEASON round $ROUND"
  echo "  2. RE-INGEST the data from FastF1"
  echo ""
  echo "To proceed, add --force to the command."
  exit 1
fi

# Load environment
source .env

echo "=== SAFE QUALIFYING DATA DELETE & RE-INGEST ==="
echo ""
echo "Season: $SEASON"
echo "Round: $ROUND"
echo ""

# Check current row count
echo "Step 1: Checking current data..."
CURRENT_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM qualifying_results WHERE season = $SEASON AND round = $ROUND;")
echo "  Current rows for season $SEASON round $ROUND: $CURRENT_COUNT"

if [ "$CURRENT_COUNT" -eq "0" ]; then
  echo "  No data to delete - proceeding with fresh ingest"
else
  echo ""
  echo "Step 2: Deleting existing data..."
  psql "$DATABASE_URL" -c "DELETE FROM qualifying_results WHERE season = $SEASON AND round = $ROUND;"
  echo "  Deleted $CURRENT_COUNT rows"
fi

echo ""
echo "Step 3: Re-ingesting from FastF1..."
source .venv/bin/activate
python3 src/etl/ingest-qualifying.py --season $SEASON --round $ROUND

echo ""
echo "Step 4: Verifying re-ingest..."
NEW_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM qualifying_results WHERE season = $SEASON AND round = $ROUND;")
echo "  New row count: $NEW_COUNT"

if [ "$NEW_COUNT" -gt "0" ]; then
  echo ""
  echo "=== SUCCESS ==="
  echo "Qualifying data for $SEASON round $ROUND has been safely re-ingested."
else
  echo ""
  echo "=== WARNING ==="
  echo "Re-ingest may have failed. Please check the ETL output above."
  exit 1
fi
