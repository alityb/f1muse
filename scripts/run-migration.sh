#!/bin/bash
# ============================================================================
# Migration Runner Script
# ============================================================================
# Usage: ./scripts/run-migration.sh <migration-file>
# Example: ./scripts/run-migration.sh migrations/20260125_p0_performance_indexes.sql
# ============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if migration file provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: No migration file specified${NC}"
  echo "Usage: $0 <migration-file>"
  echo "Example: $0 migrations/20260125_p0_performance_indexes.sql"
  exit 1
fi

MIGRATION_FILE="$1"

# Check if file exists
if [ ! -f "$MIGRATION_FILE" ]; then
  echo -e "${RED}Error: Migration file not found: $MIGRATION_FILE${NC}"
  exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo -e "${YELLOW}DATABASE_URL not set. Loading from .env...${NC}"
  if [ -f .env ]; then
    # Properly parse .env, handling comments and spaces
    DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    export DATABASE_URL
  else
    echo -e "${RED}Error: .env file not found${NC}"
    exit 1
  fi
fi

if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}Error: DATABASE_URL not set in .env${NC}"
  exit 1
fi

echo -e "${GREEN}Running migration: $MIGRATION_FILE${NC}"
echo "Database: $(echo $DATABASE_URL | sed 's/postgresql:\/\/.*@/postgresql:\/\/***@/')"
echo ""

# Run migration
echo "Executing SQL..."
psql "$DATABASE_URL" -f "$MIGRATION_FILE"

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✓ Migration completed successfully${NC}"
else
  echo ""
  echo -e "${RED}✗ Migration failed with exit code $EXIT_CODE${NC}"
  exit $EXIT_CODE
fi
