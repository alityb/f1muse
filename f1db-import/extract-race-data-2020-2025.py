#!/usr/bin/env python3
"""
Extract race_data inserts for 2020-2025 races from F1DB SQL.
Outputs INSERT statements with ON CONFLICT DO NOTHING.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SQL_PATH = Path(__file__).resolve().parent / "f1db-sql-postgresql.sql"

RACE_PATTERN = re.compile(r'^INSERT INTO "race" .*? VALUES \((\d+),\s*(\d+)')
RACE_DATA_PATTERN = re.compile(r'^INSERT INTO "race_data" .*? VALUES \((\d+),')


def main() -> int:
    if not SQL_PATH.exists():
        print(f"Missing SQL file: {SQL_PATH}", file=sys.stderr)
        return 1

    race_ids: set[int] = set()

    with SQL_PATH.open("r", encoding="utf-8") as infile:
        for line in infile:
            match = RACE_PATTERN.match(line)
            if not match:
                continue
            race_id = int(match.group(1))
            year = int(match.group(2))
            if 2020 <= year <= 2025:
                race_ids.add(race_id)

    if not race_ids:
        print("No race IDs found for 2020-2025", file=sys.stderr)
        return 1

    with SQL_PATH.open("r", encoding="utf-8") as infile:
        for line in infile:
            match = RACE_DATA_PATTERN.match(line)
            if not match:
                continue
            race_id = int(match.group(1))
            if race_id not in race_ids:
                continue
            statement = line.rstrip().rstrip(";")
            print(f"{statement} ON CONFLICT DO NOTHING;")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
