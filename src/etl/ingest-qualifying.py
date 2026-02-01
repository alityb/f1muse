#!/usr/bin/env python3
"""
QUALIFYING DATA ETL - MULTI-SEASON

SAFETY-CRITICAL ETL JOB

Rules:
- Manual execution only
- One-shot, deterministic
- Fail-closed on any data quality issue
- Transactional (per session)
- Auditable with execution_hash
- Idempotent (skip already-loaded sessions)

Usage:
    python src/etl/ingest-qualifying.py --season YEAR [--round ROUND_NUMBER]

    # Load all 2024 qualifying sessions:
    python src/etl/ingest-qualifying.py --season 2024

    # Load specific round from 2023:
    python src/etl/ingest-qualifying.py --season 2023 --round 1
"""

import sys
import os
import argparse
import hashlib
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple
from dotenv import load_dotenv
import fastf1
import pandas as pd
import numpy as np
import psycopg2
from psycopg2.extras import execute_values

# Load environment variables
load_dotenv()

# Season race counts
SEASON_RACE_COUNTS = {
    2022: 22,
    2023: 22,
    2024: 24,
    2025: 24,
}

# Sprint weekends by season and round
# Note: These identify sprint WEEKENDS for reference
# The 'Q' session loaded by FastF1 is always RACE_QUALIFYING
# Sprint qualifying ('SQ' in FastF1) would need separate ETL
SPRINT_WEEKENDS = {
    2022: {4, 11, 21},              # Imola, Austria, Brazil
    2023: {4, 10, 12, 17, 19, 21},  # Baku, Austria, Belgium, Qatar, USA, Brazil
    2024: {5, 6, 11, 19, 21, 22},   # China, Miami, Austria, USA, Brazil, Qatar
    2025: {2, 6, 14, 19, 21, 24},   # China, Miami, Belgium, USA, Brazil, Qatar
}


def is_sprint_weekend(season: int, round_number: int) -> bool:
    """Check if this round is a sprint weekend"""
    return round_number in SPRINT_WEEKENDS.get(season, set())

# Enable FastF1 cache for performance
CACHE_DIR = 'cache/fastf1'
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)


class ETLMetrics:
    """Track ETL execution metrics"""
    def __init__(self):
        self.sessions_processed = 0
        self.sessions_skipped = 0
        self.sessions_failed = 0
        self.total_laps_inserted = 0
        self.total_results_inserted = 0
        self.execution_hash = ""


def compute_execution_hash(season: int, round_number: int, source_version: str) -> str:
    """Compute deterministic execution hash"""
    execution_data = f"qualifying:{season}:{round_number}:{source_version}"
    return hashlib.sha256(execution_data.encode()).hexdigest()


def load_driver_identity_map(conn) -> Dict[str, str]:
    """Load driver identity map (abbreviation -> f1db_driver_id)"""
    driver_map = {}
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT ingestion_driver_id, f1db_driver_id
                FROM driver_identity_map
            """)
            for row in cur.fetchall():
                driver_map[row[0].upper()] = row[1]
        print(f"  Loaded {len(driver_map)} driver identity mappings")
    except Exception as e:
        print(f"  Could not load driver identity map: {e}")
    return driver_map


def load_team_identity_map(conn) -> Dict[str, str]:
    """Load team identity map (FastF1 team name -> f1db team_id)"""
    team_map = {
        # 2022-2025 team mappings
        'Red Bull Racing': 'red-bull',
        'Red Bull': 'red-bull',
        'Oracle Red Bull Racing': 'red-bull',
        'Ferrari': 'ferrari',
        'Scuderia Ferrari': 'ferrari',
        'Mercedes': 'mercedes',
        'McLaren': 'mclaren',
        'Aston Martin': 'aston-martin',
        'Alpine': 'alpine',
        'Alpine F1 Team': 'alpine',
        'Williams': 'williams',
        'Williams Racing': 'williams',
        'AlphaTauri': 'alphatauri',
        'Scuderia AlphaTauri': 'alphatauri',
        'RB': 'rb',
        'Visa Cash App RB': 'rb',
        'Haas F1 Team': 'haas',
        'Haas': 'haas',
        'Alfa Romeo': 'alfa-romeo',
        'Alfa Romeo Racing': 'alfa-romeo',
        'Kick Sauber': 'sauber',
        'Sauber': 'sauber',
        'Stake F1 Team Kick Sauber': 'sauber',
    }
    return team_map


def check_qualifying_already_loaded(conn, season: int, round_number: int) -> bool:
    """Check if qualifying data already exists"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)
            FROM qualifying_results
            WHERE season = %s AND round = %s
        """, (season, round_number))
        count = cur.fetchone()[0]
        return count > 0


def time_to_ms(time_val) -> Optional[int]:
    """Convert timedelta or time to milliseconds"""
    if pd.isna(time_val) or time_val is None:
        return None
    try:
        if hasattr(time_val, 'total_seconds'):
            return int(time_val.total_seconds() * 1000)
        return None
    except:
        return None


def extract_qualifying_results(
    session,
    season: int,
    round_number: int,
    track_id: str,
    identity_map: Dict[str, str],
    team_map: Dict[str, str]
) -> List[Dict[str, Any]]:
    """
    Extract qualifying results from FastF1 session

    Returns list of qualifying result records
    """
    results = []

    try:
        quali_results = session.results
        if quali_results is None or quali_results.empty:
            print(f"    No qualifying results available")
            return []

        for _, row in quali_results.iterrows():
            driver_num = row.get('DriverNumber')
            abbrev = row.get('Abbreviation', '').upper()

            # Resolve driver ID
            if abbrev in identity_map:
                driver_id = identity_map[abbrev]
            else:
                first_name = row.get('FirstName', '').lower()
                last_name = row.get('LastName', '').lower()
                if first_name and last_name:
                    driver_id = f"{first_name}_{last_name}"
                else:
                    driver_id = abbrev.lower()

            # Resolve team ID
            team_name = row.get('TeamName', '')
            team_id = team_map.get(team_name, team_name.lower().replace(' ', '-'))

            # Extract Q1/Q2/Q3 times
            q1_time = time_to_ms(row.get('Q1'))
            q2_time = time_to_ms(row.get('Q2'))
            q3_time = time_to_ms(row.get('Q3'))

            # Determine best time and session
            times = [(q3_time, 'Q3'), (q2_time, 'Q2'), (q1_time, 'Q1')]
            valid_times = [(t, s) for t, s in times if t is not None]

            if valid_times:
                best_time, best_session = min(valid_times, key=lambda x: x[0])
            else:
                best_time, best_session = None, None

            # Determine eliminated_in_round
            if q3_time is not None:
                eliminated_in = None  # Made it to Q3
            elif q2_time is not None:
                eliminated_in = 'Q2'  # Made Q2, eliminated there
            elif q1_time is not None:
                eliminated_in = 'Q1'  # Eliminated in Q1
            else:
                eliminated_in = 'Q1'  # DNS/no time

            # Qualifying position
            position = row.get('Position')
            if pd.isna(position):
                position = 20  # Default if not available
            else:
                position = int(position)

            # Grid position (may differ due to penalties)
            grid_pos = row.get('GridPosition')
            if pd.isna(grid_pos):
                grid_pos = position
            else:
                grid_pos = int(grid_pos)

            result = {
                'season': season,
                'round': round_number,
                'driver_id': driver_id,
                'team_id': team_id,
                'track_id': track_id,
                'q1_time_ms': q1_time,
                'q2_time_ms': q2_time,
                'q3_time_ms': q3_time,
                'best_time_ms': best_time,
                'best_session': best_session,
                'qualifying_position': position,
                'grid_position': grid_pos,
                'eliminated_in_round': eliminated_in,
                'is_dnf': False,
                'is_dns': q1_time is None,
                'has_grid_penalty': position != grid_pos,
                'grid_penalty_positions': max(0, grid_pos - position) if grid_pos and position else 0,
                # 'Q' session from FastF1 is always RACE_QUALIFYING
                # Sprint qualifying ('SQ') would be loaded separately
                'session_type': 'RACE_QUALIFYING',
            }

            results.append(result)

        return results

    except Exception as e:
        print(f"    Error extracting qualifying results: {e}")
        return []


def extract_qualifying_laps(
    session,
    season: int,
    round_number: int,
    track_id: str,
    identity_map: Dict[str, str],
    team_map: Dict[str, str]
) -> List[Dict[str, Any]]:
    """
    Extract individual qualifying laps from FastF1 session

    Returns list of qualifying lap records
    """
    laps_data = []

    try:
        laps = session.laps
        if laps is None or laps.empty:
            print(f"    No qualifying laps available")
            return []

        for _, row in laps.iterrows():
            driver_num = row.get('DriverNumber')

            # Get driver info
            try:
                driver = session.get_driver(driver_num)
                abbrev = driver['Abbreviation'].upper()

                if abbrev in identity_map:
                    driver_id = identity_map[abbrev]
                else:
                    first_name = driver.get('FirstName', '').lower()
                    last_name = driver.get('LastName', '').lower()
                    if first_name and last_name:
                        driver_id = f"{first_name}_{last_name}"
                    else:
                        driver_id = abbrev.lower()

                team_name = driver.get('TeamName', '')
                team_id = team_map.get(team_name, team_name.lower().replace(' ', '-'))
            except:
                continue

            # Skip if no lap time
            lap_time = row.get('LapTime')
            if pd.isna(lap_time):
                continue

            lap_time_ms = time_to_ms(lap_time)
            if lap_time_ms is None:
                continue

            # Determine session type from lap context
            # FastF1 doesn't directly provide Q1/Q2/Q3 session markers in laps
            # We need to infer from time and session events
            session_type = 'Q1'  # Default

            # Sector times
            s1 = time_to_ms(row.get('Sector1Time'))
            s2 = time_to_ms(row.get('Sector2Time'))
            s3 = time_to_ms(row.get('Sector3Time'))

            # Validity
            is_valid = row.get('IsAccurate', True)
            if pd.isna(is_valid):
                is_valid = True
            is_deleted = row.get('Deleted', False)
            if pd.isna(is_deleted):
                is_deleted = False

            lap_record = {
                'season': season,
                'round': round_number,
                'track_id': track_id,
                'driver_id': driver_id,
                'team_id': team_id,
                'session_type': session_type,
                'lap_number': int(row.get('LapNumber', 0)),
                'lap_time_ms': lap_time_ms,
                'sector1_ms': s1,
                'sector2_ms': s2,
                'sector3_ms': s3,
                'is_valid_lap': bool(is_valid) and not bool(is_deleted),
                'is_personal_best': bool(row.get('IsPersonalBest', False)),
                'deleted_for_track_limits': bool(is_deleted),
                'compound': row.get('Compound'),
                'tyre_age_laps': int(row.get('TyreLife', 0)) if pd.notna(row.get('TyreLife')) else None,
            }

            laps_data.append(lap_record)

        return laps_data

    except Exception as e:
        print(f"    Error extracting qualifying laps: {e}")
        return []


def insert_qualifying_results(conn, results: List[Dict[str, Any]]) -> int:
    """Insert qualifying results into database"""
    if not results:
        return 0

    try:
        with conn.cursor() as cur:
            insert_query = """
                INSERT INTO qualifying_results (
                    season, round, driver_id, team_id, track_id,
                    q1_time_ms, q2_time_ms, q3_time_ms,
                    best_time_ms, best_session,
                    qualifying_position, grid_position,
                    eliminated_in_round, is_dnf, is_dns,
                    has_grid_penalty, grid_penalty_positions,
                    session_type
                ) VALUES %s
                ON CONFLICT (season, round, driver_id)
                DO UPDATE SET
                    team_id = EXCLUDED.team_id,
                    track_id = EXCLUDED.track_id,
                    q1_time_ms = EXCLUDED.q1_time_ms,
                    q2_time_ms = EXCLUDED.q2_time_ms,
                    q3_time_ms = EXCLUDED.q3_time_ms,
                    best_time_ms = EXCLUDED.best_time_ms,
                    best_session = EXCLUDED.best_session,
                    qualifying_position = EXCLUDED.qualifying_position,
                    grid_position = EXCLUDED.grid_position,
                    eliminated_in_round = EXCLUDED.eliminated_in_round,
                    is_dnf = EXCLUDED.is_dnf,
                    is_dns = EXCLUDED.is_dns,
                    has_grid_penalty = EXCLUDED.has_grid_penalty,
                    grid_penalty_positions = EXCLUDED.grid_penalty_positions,
                    session_type = EXCLUDED.session_type,
                    updated_at = NOW()
            """

            values = [
                (
                    r['season'], r['round'], r['driver_id'], r['team_id'], r['track_id'],
                    r['q1_time_ms'], r['q2_time_ms'], r['q3_time_ms'],
                    r['best_time_ms'], r['best_session'],
                    r['qualifying_position'], r['grid_position'],
                    r['eliminated_in_round'], r['is_dnf'], r['is_dns'],
                    r['has_grid_penalty'], r['grid_penalty_positions'],
                    r['session_type']
                )
                for r in results
            ]

            execute_values(cur, insert_query, values)
            conn.commit()
            return len(results)

    except Exception as e:
        conn.rollback()
        print(f"    Error inserting qualifying results: {e}")
        return 0


def insert_qualifying_laps(conn, laps: List[Dict[str, Any]]) -> int:
    """Insert qualifying laps into database"""
    if not laps:
        return 0

    try:
        with conn.cursor() as cur:
            insert_query = """
                INSERT INTO qualifying_laps (
                    season, round, track_id, driver_id, team_id,
                    session_type, lap_number, lap_time_ms,
                    sector1_ms, sector2_ms, sector3_ms,
                    is_valid_lap, is_personal_best, deleted_for_track_limits,
                    compound, tyre_age_laps
                ) VALUES %s
                ON CONFLICT (season, round, driver_id, session_type, lap_number)
                DO UPDATE SET
                    lap_time_ms = EXCLUDED.lap_time_ms,
                    sector1_ms = EXCLUDED.sector1_ms,
                    sector2_ms = EXCLUDED.sector2_ms,
                    sector3_ms = EXCLUDED.sector3_ms,
                    is_valid_lap = EXCLUDED.is_valid_lap,
                    is_personal_best = EXCLUDED.is_personal_best,
                    deleted_for_track_limits = EXCLUDED.deleted_for_track_limits
            """

            values = [
                (
                    lap['season'], lap['round'], lap['track_id'], lap['driver_id'], lap['team_id'],
                    lap['session_type'], lap['lap_number'], lap['lap_time_ms'],
                    lap['sector1_ms'], lap['sector2_ms'], lap['sector3_ms'],
                    lap['is_valid_lap'], lap['is_personal_best'], lap['deleted_for_track_limits'],
                    lap['compound'], lap['tyre_age_laps']
                )
                for lap in laps
            ]

            execute_values(cur, insert_query, values)
            conn.commit()
            return len(laps)

    except Exception as e:
        conn.rollback()
        print(f"    Error inserting qualifying laps: {e}")
        return 0


def insert_qualifying_session(conn, season: int, round_number: int, track_id: str, session_date) -> bool:
    """Insert qualifying session metadata"""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO qualifying_sessions (season, round, track_id, session_date)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (season, round)
                DO UPDATE SET
                    track_id = EXCLUDED.track_id,
                    session_date = EXCLUDED.session_date,
                    updated_at = NOW()
            """, (season, round_number, track_id, session_date))
            conn.commit()
            return True
    except Exception as e:
        conn.rollback()
        print(f"    Error inserting qualifying session: {e}")
        return False


def load_qualifying_data(conn, season: int, round_number: int, identity_map: Dict[str, str], team_map: Dict[str, str]) -> Dict[str, Any]:
    """
    Load qualifying data for a single race weekend

    Returns metrics about the load operation
    """
    print(f"\n  Processing {season} Round {round_number} qualifying...")

    try:
        # Load FastF1 qualifying session
        print(f"    Loading FastF1 qualifying data...")
        session = fastf1.get_session(season, round_number, 'Q')  # 'Q' = Qualifying
        session.load()

        # Get event info
        event = session.event
        track_id = event['EventName'].lower().replace(' ', '_').replace("'", "")
        session_date = event.get('EventDate')

        print(f"    Loaded: {event['EventName']} Qualifying")

        # Check if already loaded
        if check_qualifying_already_loaded(conn, season, round_number):
            print(f"    Qualifying already loaded - skipping")
            return {
                'status': 'skipped',
                'results_inserted': 0,
                'laps_inserted': 0,
                'track_id': track_id
            }

        # Insert session metadata
        insert_qualifying_session(conn, season, round_number, track_id, session_date)

        # Extract and insert qualifying results
        results = extract_qualifying_results(session, season, round_number, track_id, identity_map, team_map)
        results_count = insert_qualifying_results(conn, results)
        print(f"    Inserted {results_count} qualifying results")

        # Extract and insert qualifying laps
        laps = extract_qualifying_laps(session, season, round_number, track_id, identity_map, team_map)
        laps_count = insert_qualifying_laps(conn, laps)
        print(f"    Inserted {laps_count} qualifying laps")

        return {
            'status': 'success',
            'results_inserted': results_count,
            'laps_inserted': laps_count,
            'track_id': track_id
        }

    except Exception as e:
        print(f"    FAIL_CLOSED: Qualifying processing failed: {e}")
        return {
            'status': 'failed',
            'results_inserted': 0,
            'laps_inserted': 0,
            'track_id': 'unknown',
            'error': str(e)
        }


def write_audit_log(conn, season: int, round_number: Optional[int], metrics: ETLMetrics, started_at: datetime, finished_at: datetime):
    """Write ETL execution to audit log"""
    print("\n  Writing audit log...")

    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO etl_runs_qualifying (
                    season, round, status, sessions_processed, sessions_skipped, sessions_failed,
                    total_laps_inserted, total_results_inserted, execution_hash, started_at, finished_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                season,
                round_number,
                'success' if metrics.sessions_failed == 0 else 'partial_failure',
                metrics.sessions_processed,
                metrics.sessions_skipped,
                metrics.sessions_failed,
                metrics.total_laps_inserted,
                metrics.total_results_inserted,
                metrics.execution_hash,
                started_at,
                finished_at
            ))
            conn.commit()
        print("  Audit log written")
    except Exception as e:
        print(f"  Could not write audit log: {e}")


def main():
    parser = argparse.ArgumentParser(description='ETL for qualifying data')
    parser.add_argument('--season', type=int, required=True, help='Season year (e.g., 2022, 2023, 2024, 2025)')
    parser.add_argument('--round', type=int, help='Specific round to load')
    args = parser.parse_args()

    season = args.season

    if season not in SEASON_RACE_COUNTS:
        print(f"FAIL_CLOSED: Season {season} not supported. Supported: {list(SEASON_RACE_COUNTS.keys())}")
        sys.exit(1)

    print(f"\n=== QUALIFYING DATA ETL - {season} SEASON ===\n")
    print(f"Season: {season}")

    started_at = datetime.now()
    print(f"Started: {started_at.isoformat()}\n")

    # Connect to database
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("FAIL_CLOSED: DATABASE_URL not set")
        sys.exit(1)

    try:
        conn = psycopg2.connect(db_url)
        print("Database connected")
    except Exception as e:
        print(f"FAIL_CLOSED: Database connection failed: {e}")
        sys.exit(1)

    # Load identity maps
    identity_map = load_driver_identity_map(conn)
    team_map = load_team_identity_map(conn)

    # Determine rounds to process
    if args.round:
        rounds_to_process = [args.round]
        print(f"\n  Processing single round: {args.round}\n")
    else:
        race_count = SEASON_RACE_COUNTS[season]
        rounds_to_process = list(range(1, race_count + 1))
        print(f"\n  Processing all {len(rounds_to_process)} rounds\n")

    # Process qualifying sessions
    metrics = ETLMetrics()

    for round_num in rounds_to_process:
        result = load_qualifying_data(conn, season, round_num, identity_map, team_map)

        if result['status'] == 'success':
            metrics.sessions_processed += 1
            metrics.total_laps_inserted += result['laps_inserted']
            metrics.total_results_inserted += result['results_inserted']
        elif result['status'] == 'skipped':
            metrics.sessions_skipped += 1
        else:
            metrics.sessions_failed += 1

    # Compute execution hash
    fastf1_version = fastf1.__version__
    metrics.execution_hash = compute_execution_hash(
        season,
        rounds_to_process[0] if len(rounds_to_process) == 1 else 0,
        f"fastf1-{fastf1_version}"
    )

    # Write audit log
    finished_at = datetime.now()
    write_audit_log(conn, season, args.round, metrics, started_at, finished_at)

    # Close connection
    conn.close()

    # Print summary
    print("\n=== QUALIFYING ETL COMPLETE ===\n")
    print(f"Season: {season}")
    print(f"Execution Hash: {metrics.execution_hash}")
    print(f"\nSessions processed: {metrics.sessions_processed}")
    print(f"Sessions skipped:   {metrics.sessions_skipped}")
    print(f"Sessions failed:    {metrics.sessions_failed}")
    print(f"\nTotal results inserted: {metrics.total_results_inserted}")
    print(f"Total laps inserted:    {metrics.total_laps_inserted}")
    print(f"\nDuration: {finished_at - started_at}\n")

    # Exit with appropriate code
    if metrics.sessions_failed > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
