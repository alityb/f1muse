#!/bin/bash
# ============================================================================
# E2E Test Script - Tests all 14 QueryIntent kinds
# ============================================================================

set -e

API_URL="${API_URL:-http://localhost:3000}"
PASS=0
FAIL=0
RESULTS=()

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test function
test_query() {
  local name="$1"
  local kind="$2"
  local payload="$3"

  echo -n "Testing: $name... "

  response=$(curl -s -X POST "$API_URL/query" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)

  # Check for error in response
  error=$(echo "$response" | jq -r '.error // empty' 2>/dev/null)

  if [ -z "$error" ]; then
    echo -e "${GREEN}PASS${NC}"
    PASS=$((PASS + 1))
    RESULTS+=("PASS: $name ($kind)")
  else
    reason=$(echo "$response" | jq -r '.reason // "Unknown"' 2>/dev/null)
    echo -e "${RED}FAIL${NC} - $reason"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL: $name ($kind) - $reason")
  fi
}

echo "============================================"
echo "F1 Muse E2E Test Suite"
echo "API: $API_URL"
echo "============================================"
echo ""

# Note: Using 2025 season because lap telemetry is only loaded for 2025
SEASON=2025

# TIER 1 Queries
echo "--- TIER 1 Queries ---"

test_query "Race results summary" \
  "race_results_summary" \
  "{\"kind\": \"race_results_summary\", \"season\": $SEASON, \"track_id\": \"bahrain\"}"

test_query "Driver career summary" \
  "driver_career_summary" \
  '{"kind": "driver_career_summary", "driver_id": "hamilton"}'

test_query "Driver season summary" \
  "driver_season_summary" \
  "{\"kind\": \"driver_season_summary\", \"season\": $SEASON, \"driver_id\": \"verstappen\"}"

test_query "Season driver vs driver" \
  "season_driver_vs_driver" \
  "{\"kind\": \"season_driver_vs_driver\", \"season\": $SEASON, \"driver_a_id\": \"verstappen\", \"driver_b_id\": \"norris\", \"metric\": \"avg_true_pace\"}"

test_query "Cross-team track comparison" \
  "cross_team_track_scoped_driver_comparison" \
  "{\"kind\": \"cross_team_track_scoped_driver_comparison\", \"season\": $SEASON, \"track_id\": \"bahrain\", \"driver_a_id\": \"hamilton\", \"driver_b_id\": \"verstappen\", \"metric\": \"avg_true_pace\"}"

test_query "Track fastest drivers" \
  "track_fastest_drivers" \
  "{\"kind\": \"track_fastest_drivers\", \"season\": $SEASON, \"track_id\": \"bahrain\", \"metric\": \"avg_true_pace\", \"normalization\": \"none\"}"

test_query "Teammate gap summary" \
  "teammate_gap_summary_season" \
  "{\"kind\": \"teammate_gap_summary_season\", \"season\": $SEASON, \"driver_a_id\": \"norris\", \"driver_b_id\": \"piastri\"}"

test_query "Teammate gap dual comparison" \
  "teammate_gap_dual_comparison" \
  "{\"kind\": \"teammate_gap_dual_comparison\", \"season\": $SEASON, \"driver_a_id\": \"norris\", \"driver_b_id\": \"piastri\"}"

echo ""
echo "--- TIER 2 Queries ---"

test_query "Driver profile summary" \
  "driver_profile_summary" \
  "{\"kind\": \"driver_profile_summary\", \"driver_id\": \"leclerc\", \"season\": $SEASON}"

test_query "Driver trend summary" \
  "driver_trend_summary" \
  "{\"kind\": \"driver_trend_summary\", \"driver_id\": \"hamilton\", \"season\": $SEASON, \"start_season\": $SEASON, \"end_season\": $SEASON}"

echo ""
echo "--- ADVANCED Queries ---"

test_query "Driver head-to-head count" \
  "driver_head_to_head_count" \
  "{\"kind\": \"driver_head_to_head_count\", \"season\": $SEASON, \"driver_a_id\": \"norris\", \"driver_b_id\": \"piastri\", \"h2h_metric\": \"race_finish_position\", \"h2h_scope\": \"teammate\"}"

test_query "Driver performance vector" \
  "driver_performance_vector" \
  "{\"kind\": \"driver_performance_vector\", \"season\": $SEASON, \"driver_id\": \"verstappen\"}"

test_query "Driver multi comparison" \
  "driver_multi_comparison" \
  "{\"kind\": \"driver_multi_comparison\", \"season\": $SEASON, \"driver_ids\": [\"verstappen\", \"norris\", \"leclerc\"], \"comparison_metric\": \"avg_true_pace\"}"

test_query "Driver matchup lookup" \
  "driver_matchup_lookup" \
  "{\"kind\": \"driver_matchup_lookup\", \"season\": $SEASON, \"driver_a_id\": \"verstappen\", \"driver_b_id\": \"lawson\", \"h2h_metric\": \"qualifying_position\"}"

echo ""
echo "============================================"
echo "RESULTS SUMMARY"
echo "============================================"
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo "Total:  $((PASS + FAIL))"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "Failed tests:"
  for result in "${RESULTS[@]}"; do
    if [[ "$result" == FAIL* ]]; then
      echo "  - $result"
    fi
  done
  exit 1
fi

echo -e "${GREEN}All tests passed!${NC}"
