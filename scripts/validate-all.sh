#!/bin/bash
# =============================================================================
# F1 Muse Production Readiness Validation
# =============================================================================
#
# Runs all validation checks including:
#   1. TypeScript type checking
#   2. ESLint linting
#   3. Unit tests (no database required)
#   4. NL routing adversarial tests
#   5. Integration tests (requires database)
#   6. Cache correctness tests
#   7. Response contract tests
#
# Usage:
#   ./scripts/validate-all.sh           # Run all tests (skips DB tests if unavailable)
#   ./scripts/validate-all.sh --with-db # Start test DB container first
#   ./scripts/validate-all.sh --quick   # Quick validation (type check + unit tests only)
#
# Exit codes:
#   0 - All validations passed
#   1 - Validation failed
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
WITH_DB=false
QUICK=false

for arg in "$@"; do
  case $arg in
    --with-db)
      WITH_DB=true
      shift
      ;;
    --quick)
      QUICK=true
      shift
      ;;
  esac
done

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  F1 Muse Production Readiness Validation  ${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Track pass/fail status
PASSED=0
FAILED=0

run_check() {
  local name=$1
  local command=$2

  echo -e "${YELLOW}Running: ${name}${NC}"

  if eval "$command"; then
    echo -e "${GREEN}PASSED: ${name}${NC}"
    ((PASSED++))
  else
    echo -e "${RED}FAILED: ${name}${NC}"
    ((FAILED++))
    return 1
  fi

  echo ""
}

# Start test database if requested
if [ "$WITH_DB" = true ]; then
  echo -e "${YELLOW}Starting test database container...${NC}"
  npm run db:test:up || {
    echo -e "${RED}Failed to start test database${NC}"
    exit 1
  }
  export TEST_DATABASE_URL="postgres://f1muse_test:f1muse_test@localhost:5433/f1muse_integration_test"
  echo -e "${GREEN}Test database started${NC}"
  echo ""
fi

# Phase 1: Type checking
run_check "TypeScript Type Check" "npm run typecheck" || true

# Phase 2: Linting (skip for quick mode)
if [ "$QUICK" = false ]; then
  run_check "ESLint" "npm run lint -- --max-warnings 0" || true
fi

# Phase 3: Unit tests
run_check "Unit Tests" "npm run test:unit -- --run" || true

# Phase 4: NL routing tests
run_check "NL Routing Tests" "npm run test:nl -- --run" || true

# Phase 5: Integration tests (skip for quick mode)
if [ "$QUICK" = false ]; then
  # Check if database is available
  if [ -n "$TEST_DATABASE_URL" ] || [ -n "$DATABASE_URL_TEST" ]; then
    run_check "Contract Tests" "npm run test:contract -- --run" || true
    run_check "Cache Tests" "npm run test:cache -- --run" || true
    run_check "Integration Tests" "npm run test:integration -- --run" || true
  else
    echo -e "${YELLOW}Skipping database tests (TEST_DATABASE_URL not set)${NC}"
    echo -e "${YELLOW}To run database tests: ./scripts/validate-all.sh --with-db${NC}"
    echo ""
  fi
fi

# Cleanup test database if we started it
if [ "$WITH_DB" = true ]; then
  echo -e "${YELLOW}Stopping test database container...${NC}"
  npm run db:test:down
  echo ""
fi

# Summary
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}              Validation Summary           ${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

TOTAL=$((PASSED + FAILED))

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All ${TOTAL} checks passed!${NC}"
  exit 0
else
  echo -e "${GREEN}Passed: ${PASSED}${NC}"
  echo -e "${RED}Failed: ${FAILED}${NC}"
  echo ""
  echo -e "${RED}Validation failed. Please fix the issues above.${NC}"
  exit 1
fi
