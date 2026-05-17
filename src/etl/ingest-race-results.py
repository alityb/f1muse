#!/usr/bin/env python3
"""
RACE RESULTS ETL - FastF1 → race_data (RACE_RESULT twin)

Populates race_data with RACE_RESULT rows sourced directly from FastF1,
mirroring what F1DB would eventually provide. This "twin" means the full
analytics pipeline (teammate gap, matchup matrix) works immediately after
each race without waiting for F1DB to publish an update.

Safety Rules:
- Manual execution only
- Fail-closed on any data quality issue
- Transactional (per race)
- Idempotent (skip already-loaded races via ON CONFLICT DO NOTHING)
- Auditable with execution_hash

Usage:
    python src/etl/ingest-race-results.py --season 2026
    python src/etl/ingest-race-results.py --season 2026 --round 4
"""

import sys
import os
import argparse
import hashlib
from datetime import datetime
from typing import Optional, Dict, Any
from dotenv import load_dotenv
import fastf1
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

load_dotenv()

TARGET_SEASON = 2026

CACHE_DIR = 'cache/fastf1'
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

# Season race counts (22 for 2026, Bahrain & Saudi Arabia cancelled)
SEASON_RACE_COUNTS = {
    2022: 22,
    2023: 22,
    2024: 24,
    2025: 24,
    2026: 22,
}

# FastF1 team name → F1DB constructor_id
TEAM_TO_CONSTRUCTOR: Dict[str, str] = {
    'McLaren':         'mclaren',
    'Ferrari':         'ferrari',
    'Red Bull Racing': 'red-bull',
    'Mercedes':        'mercedes',
    'Aston Martin':    'aston-martin',
    'Alpine':          'alpine',
    'Williams':        'williams',
    'Haas F1 Team':    'haas',
    'RB':              'racing-bulls',
    'Racing Bulls':    'racing-bulls',
    'Kick Sauber':     'audi',   # Became Audi in 2026
    'Audi':            'audi',
    'Cadillac':        'cadillac',
}

# F1DB constructor_id → engine_manufacturer_id for 2026
CONSTRUCTOR_TO_ENGINE: Dict[str, str] = {
    'mclaren':     'mercedes',
    'mercedes':    'mercedes',
    'williams':    'mercedes',
    'alpine':      'mercedes',
    'ferrari':     'ferrari',
    'haas':        'ferrari',
    'cadillac':    'ferrari',
    'red-bull':    'red-bull-ford',
    'racing-bulls':'red-bull-ford',
    'aston-martin':'honda',
    'audi':        'audi',
}


def compute_execution_hash(season: int, round_number: int, source_version: str) -> str:
    data = f"race_results:{season}:{round_number}:{source_version}"
    return hashlib.sha256(data.encode()).hexdigest()


def load_driver_identity_map(conn) -> Dict[str, str]:
    """Load abbreviation → f1db_driver_id from driver_identity_map."""
    mapping = {}
    with conn.cursor() as cur:
        cur.execute("SELECT ingestion_driver_id, f1db_driver_id FROM driver_identity_map")
        for abbr, f1db_id in cur.fetchall():
            mapping[abbr.upper()] = f1db_id
    return mapping


def load_engine_map_from_db(conn, season: int) -> Dict[str, str]:
    """Supplement CONSTRUCTOR_TO_ENGINE with season_entrant_driver data."""
    mapping = dict(CONSTRUCTOR_TO_ENGINE)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT constructor_id, engine_manufacturer_id
            FROM season_entrant_driver
            WHERE year = %s AND test_driver = false
        """, (season,))
        for constructor_id, engine_id in cur.fetchall():
            if constructor_id not in mapping and engine_id:
                mapping[constructor_id] = engine_id
    return mapping


def get_race_id(conn, season: int, round_number: int) -> Optional[int]:
    """Get F1DB race.id for a given season+round."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM race WHERE year = %s AND round = %s",
            (season, round_number)
        )
        row = cur.fetchone()
        return row[0] if row else None


def is_race_already_loaded(conn, race_id: int) -> bool:
    """Check if RACE_RESULT rows already exist for this race_id."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM race_data WHERE race_id = %s AND type = 'RACE_RESULT'",
            (race_id,)
        )
        return cur.fetchone()[0] > 0


def parse_time_millis(val) -> Optional[int]:
    """Convert a timedelta or string to milliseconds."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        if hasattr(val, 'total_seconds'):
            return int(val.total_seconds() * 1000)
        # String like "1:23:45.678" or "+1.234"
        s = str(val).lstrip('+')
        if ':' in s:
            parts = s.split(':')
            total = 0.0
            for p in parts:
                total = total * 60 + float(p)
        else:
            total = float(s)
        return int(total * 1000)
    except Exception:
        return None


def format_time_string(val) -> Optional[str]:
    """Format a timedelta/string as a human-readable time string."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        if hasattr(val, 'total_seconds'):
            total_s = val.total_seconds()
            h = int(total_s // 3600)
            m = int((total_s % 3600) // 60)
            s = total_s % 60
            if h > 0:
                return f"{h}:{m:02d}:{s:06.3f}"
            return f"{m}:{s:06.3f}"
        return str(val)
    except Exception:
        return None


def ingest_race(conn, season: int, round_number: int,
                driver_map: Dict[str, str], engine_map: Dict[str, str]) -> Dict[str, Any]:
    """Ingest race results for a single round."""
    print(f"\n→ Processing Round {round_number}...")

    try:
        session = fastf1.get_session(season, round_number, 'R')
        session.load(laps=False, telemetry=False, weather=False, messages=False)
        event_name = session.event['EventName']
        print(f"  ✓ Loaded: {event_name}")
    except Exception as e:
        print(f"  ✗ FAIL_CLOSED: Could not load session: {e}")
        return {'status': 'failed', 'rows': 0, 'error': str(e)}

    results = session.results
    if results is None or results.empty:
        print(f"  ✗ FAIL_CLOSED: No results available")
        return {'status': 'failed', 'rows': 0, 'error': 'No results'}

    race_id = get_race_id(conn, season, round_number)
    if race_id is None:
        print(f"  ✗ FAIL_CLOSED: race_id not found for {season} R{round_number} — run F1DB import first")
        return {'status': 'failed', 'rows': 0, 'error': 'race_id missing'}

    if is_race_already_loaded(conn, race_id):
        print(f"  ⊘ Already loaded — skipping")
        return {'status': 'skipped', 'rows': 0}

    rows = []
    for display_order, (_, r) in enumerate(results.iterrows(), start=1):
        abbr = str(r.get('Abbreviation', '')).upper()
        f1db_driver_id = driver_map.get(abbr)
        if not f1db_driver_id:
            # Fallback: build from first/last name (underscore format then convert)
            first = str(r.get('FirstName', '')).lower().replace(' ', '-')
            last  = str(r.get('LastName',  '')).lower().replace(' ', '-')
            f1db_driver_id = f"{first}-{last}" if first and last else abbr.lower()
            print(f"  ⚠ No identity map entry for {abbr}, derived: {f1db_driver_id}")

        team_name     = str(r.get('TeamName', ''))
        constructor_id = TEAM_TO_CONSTRUCTOR.get(team_name,
                          team_name.lower().replace(' ', '-'))
        engine_id     = engine_map.get(constructor_id, 'unknown')

        # Classified position
        classified = r.get('ClassifiedPosition', '')
        if pd.isna(classified):
            classified = ''
        classified = str(classified).strip()
        try:
            pos_number = int(float(classified))
        except (ValueError, TypeError):
            pos_number = None  # DNF, NC, DNS, DSQ

        # Race time / gap
        time_val = r.get('Time')
        gap_val  = r.get('Time')  # same field — leader has total time, others have gap
        if display_order == 1:
            time_ms = parse_time_millis(time_val)
            gap_ms  = None
            time_str = format_time_string(time_val)
            gap_str  = None
        else:
            time_ms  = None
            gap_ms   = parse_time_millis(gap_val)
            time_str = None
            gap_str  = format_time_string(gap_val)

        status = str(r.get('Status', '')).strip()
        reason_retired = None if status in ('', 'Finished') or status.startswith('+') else status

        # Points (may be float like 25.0 or 0.0)
        points_raw = r.get('Points', 0)
        try:
            points = float(points_raw) if pd.notna(points_raw) else 0.0
        except (TypeError, ValueError):
            points = 0.0

        rows.append({
            'race_id':                race_id,
            'type':                   'RACE_RESULT',
            'position_display_order': display_order,
            'position_number':        pos_number,
            'position_text':          classified if classified else status[:10],
            'driver_number':          str(r.get('DriverNumber', '')),
            'driver_id':              f1db_driver_id,
            'constructor_id':         constructor_id,
            'engine_manufacturer_id': engine_id,
            'tyre_manufacturer_id':   'pirelli',
            'race_time':              time_str,
            'race_time_millis':       time_ms,
            'race_gap':               gap_str,
            'race_gap_millis':        gap_ms,
            'race_points':            points,
            'race_reason_retired':    reason_retired,
        })

    if not rows:
        print(f"  ✗ FAIL_CLOSED: No rows to insert")
        return {'status': 'failed', 'rows': 0, 'error': 'Empty rows'}

    # Insert transactionally
    try:
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            insert_sql = """
                INSERT INTO race_data (
                    race_id, type, position_display_order, position_number, position_text,
                    driver_number, driver_id, constructor_id, engine_manufacturer_id,
                    tyre_manufacturer_id, race_time, race_time_millis,
                    race_gap, race_gap_millis, race_points, race_reason_retired
                ) VALUES %s
                ON CONFLICT (race_id, type, position_display_order) DO NOTHING
            """
            values = [
                (
                    r['race_id'], r['type'], r['position_display_order'],
                    r['position_number'], r['position_text'], r['driver_number'],
                    r['driver_id'], r['constructor_id'], r['engine_manufacturer_id'],
                    r['tyre_manufacturer_id'], r['race_time'], r['race_time_millis'],
                    r['race_gap'], r['race_gap_millis'], r['race_points'],
                    r['race_reason_retired']
                )
                for r in rows
            ]
            execute_values(cur, insert_sql, values)
            cur.execute("COMMIT")
        print(f"  ✓ Inserted {len(rows)} RACE_RESULT rows")
        return {'status': 'success', 'rows': len(rows)}
    except Exception as e:
        with conn.cursor() as cur:
            cur.execute("ROLLBACK")
        print(f"  ✗ FAIL_CLOSED: DB insert failed: {e}")
        return {'status': 'failed', 'rows': 0, 'error': str(e)}


def main():
    parser = argparse.ArgumentParser(description='FastF1 race results → race_data ETL')
    parser.add_argument('--season', type=int, default=TARGET_SEASON)
    parser.add_argument('--round',  type=int, help='Specific round (default: all)')
    args = parser.parse_args()

    season = args.season
    total_rounds = SEASON_RACE_COUNTS.get(season, 22)
    rounds = [args.round] if args.round else list(range(1, total_rounds + 1))

    print(f"\n=== RACE RESULTS ETL (FastF1 twin) — {season} ===\n")
    print(f"Rounds: {rounds if args.round else f'1-{total_rounds} (all)'}")
    started_at = datetime.now()
    print(f"Started: {started_at.isoformat()}\n")

    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("✗ DATABASE_URL not set")
        sys.exit(1)

    try:
        conn = psycopg2.connect(db_url)
        print("✓ Database connected")
    except Exception as e:
        print(f"✗ DB connection failed: {e}")
        sys.exit(1)

    driver_map = load_driver_identity_map(conn)
    engine_map = load_engine_map_from_db(conn, season)
    print(f"✓ Loaded {len(driver_map)} driver identity mappings")

    processed = skipped = failed = total_rows = 0

    for rnd in rounds:
        result = ingest_race(conn, season, rnd, driver_map, engine_map)
        if result['status'] == 'success':
            processed += 1
            total_rows += result['rows']
        elif result['status'] == 'skipped':
            skipped += 1
        else:
            failed += 1

    conn.close()
    finished_at = datetime.now()

    print(f"\n=== ETL COMPLETE ===\n")
    print(f"Races processed: {processed}")
    print(f"Races skipped:   {skipped}")
    print(f"Races failed:    {failed}")
    print(f"Total rows:      {total_rows}")
    print(f"Duration:        {finished_at - started_at}\n")

    sys.exit(1 if failed > 0 else 0)


if __name__ == '__main__':
    main()
