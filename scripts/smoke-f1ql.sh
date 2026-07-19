#!/bin/bash
set -euo pipefail

BASE_URL="${1:?Usage: $0 <base-url>}"

curl --fail-with-body --silent --show-error --request POST "${BASE_URL%/}/program" \
  --header "Content-Type: application/json" \
  --data '{"version":1,"root":{"op":"aggregate","input":{"op":"filter","input":{"op":"source","source":"standings"},"where":{"season":2025}},"group_by":["driver_id"],"measures":[{"as":"total_points","function":"sum","field":"points"}]}}' \
  | grep -q '"core_program"'
