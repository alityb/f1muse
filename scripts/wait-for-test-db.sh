#!/bin/sh
set -eu

attempt=1
while [ "$attempt" -le 30 ]; do
  if docker compose -f docker-compose.test.yml exec -T postgres \
    pg_isready -U postgres -d f1muse_test >/dev/null 2>&1; then
    exit 0
  fi

  sleep 1
  attempt=$((attempt + 1))
done

printf '%s\n' 'Test PostgreSQL did not become ready within 30 seconds.' >&2
exit 1
