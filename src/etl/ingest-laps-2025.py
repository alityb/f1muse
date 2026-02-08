#!/usr/bin/env python3
"""
LAPS NORMALIZED ETL - 2025 SEASON

SAFETY-CRITICAL ETL JOB

Rules:
- Manual execution only
- One-shot, deterministic
- Fail-closed on any data quality issue
- Transactional (per race)
- Auditable with execution_hash
- Idempotent (skip already-loaded races)

Usage:
    python src/etl/ingest-laps-2025.py [--round ROUND_NUMBER]

    # Load all 2025 races:
    python src/etl/ingest-laps-2025.py

    # Load specific round:
    python src/etl/ingest-laps-2025.py --round 1
"""

import sys
import os
import argparse
import hashlib
from datetime import datetime
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv
import fastf1
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# Load environment variables
load_dotenv()

# Configuration
TARGET_SEASON = 2025
CLEAN_AIR_GAP_THRESHOLD = 1.5  # seconds - gap to car ahead to be considered "clean air"

# Driver ID mapping: FastF1 generates IDs from first_name_last_name, but some differ from F1DB canonical IDs
# This maps FastF1-generated IDs to canonical F1DB IDs
FASTF1_TO_F1DB_DRIVER_MAP = {
    'carlos_sainz': 'carlos_sainz_jr',  # FastF1 uses "Carlos Sainz", F1DB uses carlos_sainz_jr for Jr.
    'andrea_kimi_antonelli': 'kimi_antonelli',  # FastF1 uses full name, F1DB uses just "Kimi"
}

# Enable FastF1 cache for performance
CACHE_DIR = 'cache/fastf1'
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)


class ETLMetrics:
    """Track ETL execution metrics"""
    def __init__(self):
        self.races_processed = 0
        self.races_skipped = 0
        self.races_failed = 0
        self.total_laps_inserted = 0
        self.total_laps_skipped = 0
        self.execution_hash = ""


def compute_execution_hash(season: int, round_number: int, source_version: str) -> str:
    """Compute deterministic execution hash"""
    execution_data = f"{season}:{round_number}:{source_version}"
    return hashlib.sha256(execution_data.encode()).hexdigest()


def validate_database_schema(conn) -> bool:
    """Validate laps_normalized table exists with correct schema"""
    print("→ Validating database schema...")

    required_columns = {
        'season': 'integer',
        'round': 'integer',
        'track_id': 'text',
        'driver_id': 'text',
        'lap_number': 'integer',
        'stint_id': 'integer',
        'stint_lap_index': 'integer',
        'lap_time_seconds': 'numeric',
        'is_valid_lap': 'boolean',
        'is_pit_lap': 'boolean',
        'is_out_lap': 'boolean',
        'is_in_lap': 'boolean',
        'clean_air_flag': 'boolean'
    }

    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'laps_normalized'
                ORDER BY column_name
            """)

            actual_columns = {row[0]: row[1] for row in cur.fetchall()}

            if not actual_columns:
                print("✗ FAIL_CLOSED: Table 'laps_normalized' not found")
                return False

            for col_name, expected_type in required_columns.items():
                if col_name not in actual_columns:
                    print(f"✗ FAIL_CLOSED: Required column '{col_name}' missing")
                    return False

        print("✓ Database schema validated")
        return True

    except Exception as e:
        print(f"✗ FAIL_CLOSED: Schema validation error: {e}")
        return False


def check_race_already_loaded(conn, season: int, round_number: int) -> bool:
    """Check if race data already exists"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)
            FROM laps_normalized
            WHERE season = %s AND round = %s
        """, (season, round_number))

        count = cur.fetchone()[0]
        return count > 0


def detect_stints(laps_df: pd.DataFrame) -> pd.DataFrame:
    """
    Detect stint boundaries based on tire changes

    A new stint begins when:
    - Driver changes compound
    - Driver makes a pit stop
    - Start of race (lap 1)
    """
    laps_df = laps_df.sort_values(['DriverNumber', 'LapNumber']).copy()

    # Initialize stint tracking
    laps_df['stint_id'] = 0
    laps_df['stint_lap_index'] = 0

    for driver in laps_df['DriverNumber'].unique():
        driver_mask = laps_df['DriverNumber'] == driver
        driver_laps = laps_df[driver_mask].copy()

        current_stint = 1
        stint_lap = 1
        prev_compound = None

        stint_ids = []
        stint_indices = []

        for idx, row in driver_laps.iterrows():
            # New stint if compound changes or pit stop
            if prev_compound is not None:
                if (row['Compound'] != prev_compound) or pd.notna(row['PitInTime']):
                    current_stint += 1
                    stint_lap = 1

            stint_ids.append(current_stint)
            stint_indices.append(stint_lap)

            prev_compound = row['Compound']
            stint_lap += 1

        laps_df.loc[driver_mask, 'stint_id'] = stint_ids
        laps_df.loc[driver_mask, 'stint_lap_index'] = stint_indices

    return laps_df


def detect_clean_air(laps_df: pd.DataFrame, threshold: float = CLEAN_AIR_GAP_THRESHOLD) -> pd.DataFrame:
    """
    Detect clean air laps based on gap to car immediately ahead.

    A lap is "clean air" (clean_air_flag = True) if:
    - Gap to car immediately ahead >= threshold (1.5 seconds)
    - OR driver is race leader on that lap (no car ahead)
    - AND not a pit in/out lap
    - AND not under Safety Car or VSC conditions

    Industry-standard heuristic: ~1.5-2.0s gap to avoid aero wake effects.

    Algorithm:
    1. Compute cumulative race time for each driver
    2. For each lap, rank drivers by cumulative time (actual race order)
    3. Compute gap to car immediately ahead
    4. Mark as dirty air if gap < threshold
    """
    laps_df = laps_df.copy()

    # Default to False (dirty air) - fail-closed approach
    laps_df['clean_air_flag'] = False

    # Track statistics
    stats = {'total': 0, 'clean': 0, 'dirty_gap': 0, 'dirty_pit': 0, 'dirty_sc': 0, 'dirty_invalid': 0}

    # Step 1: Compute cumulative race time for each driver
    # We need to track running race time across all laps
    drivers = laps_df['Driver'].unique() if 'Driver' in laps_df.columns else laps_df['DriverNumber'].unique()
    driver_col = 'Driver' if 'Driver' in laps_df.columns else 'DriverNumber'

    # Initialize cumulative times
    cumulative_times = {d: 0.0 for d in drivers}

    # Sort laps by lap number for sequential processing
    sorted_laps = laps_df.sort_values(['LapNumber', driver_col]).copy()

    # Compute cumulative race time for each row
    cum_time_list = []
    for idx, row in sorted_laps.iterrows():
        driver = row[driver_col]
        lap_time = row['LapTime']

        if pd.notna(lap_time):
            try:
                lap_seconds = lap_time.total_seconds()
                cumulative_times[driver] += lap_seconds
            except:
                pass

        cum_time_list.append(cumulative_times[driver])

    sorted_laps['cumulative_time'] = cum_time_list

    # Step 2: For each lap, compute gaps and detect clean air
    for lap_num in sorted_laps['LapNumber'].unique():
        lap_mask = sorted_laps['LapNumber'] == lap_num
        lap_data = sorted_laps[lap_mask].copy()

        # Sort by cumulative race time (actual race order, not position column)
        # Lower cumulative time = further ahead in the race
        lap_data = lap_data.sort_values('cumulative_time')

        drivers_in_lap = lap_data[driver_col].tolist()
        cum_times = lap_data['cumulative_time'].tolist()
        indices = lap_data.index.tolist()

        for i, (driver, cum_time, idx) in enumerate(zip(drivers_in_lap, cum_times, indices)):
            row = sorted_laps.loc[idx]
            stats['total'] += 1

            # Check exclusion conditions first (these are always dirty air)

            # 1. Pit in/out laps - always dirty
            is_pit_in = pd.notna(row.get('PitInTime'))
            is_pit_out = pd.notna(row.get('PitOutTime'))
            if is_pit_in or is_pit_out:
                stats['dirty_pit'] += 1
                continue  # Leave as False (dirty)

            # 2. Safety Car / VSC laps - always dirty
            # FastF1 marks these with TrackStatus
            track_status = row.get('TrackStatus', '')
            if pd.notna(track_status):
                track_status_str = str(track_status)
                # Status codes: 1=Green, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSC Ending
                if '4' in track_status_str or '6' in track_status_str or '7' in track_status_str:
                    stats['dirty_sc'] += 1
                    continue  # Leave as False (dirty)

            # 3. Invalid laps - always dirty
            is_accurate = row.get('IsAccurate', True)
            if is_accurate == False:
                stats['dirty_invalid'] += 1
                continue  # Leave as False (dirty)

            # Step 3: Compute gap to car ahead
            if i == 0:
                # Race leader - always clean air (no car ahead)
                sorted_laps.loc[idx, 'clean_air_flag'] = True
                stats['clean'] += 1
            else:
                # Gap to car ahead = my cumulative time - car ahead's cumulative time
                car_ahead_cum_time = cum_times[i - 1]
                gap_to_ahead = cum_time - car_ahead_cum_time

                if gap_to_ahead >= threshold:
                    # Sufficient gap - clean air
                    sorted_laps.loc[idx, 'clean_air_flag'] = True
                    stats['clean'] += 1
                else:
                    # In traffic - dirty air
                    stats['dirty_gap'] += 1
                    # Leave as False (dirty)

    # Copy clean_air_flag back to original dataframe
    laps_df['clean_air_flag'] = sorted_laps['clean_air_flag']

    # Log statistics
    if stats['total'] > 0:
        clean_pct = (stats['clean'] / stats['total']) * 100
        print(f"  → Clean air detection: {stats['clean']}/{stats['total']} laps ({clean_pct:.1f}%) are clean air")
        print(f"    - Dirty (gap < {threshold}s): {stats['dirty_gap']}")
        print(f"    - Dirty (pit laps): {stats['dirty_pit']}")
        print(f"    - Dirty (SC/VSC): {stats['dirty_sc']}")
        print(f"    - Dirty (invalid): {stats['dirty_invalid']}")

    return laps_df


def transform_lap_data(laps_df: pd.DataFrame, session, season: int, round_number: int, track_id: str) -> List[Dict[str, Any]]:
    """
    Transform FastF1 lap data into laps_normalized schema

    FAIL-CLOSED: Rejects laps with missing critical data
    """
    print(f"  → Transforming {len(laps_df)} laps...")

    # FAIL-CLOSED: Filter out laps with missing critical data BEFORE stint detection
    # This ensures stint IDs are sequential and only assigned to valid laps
    initial_count = len(laps_df)
    laps_df = laps_df[pd.notna(laps_df['LapTime']) & pd.notna(laps_df['DriverNumber'])].copy()
    skipped_before = initial_count - len(laps_df)

    if skipped_before > 0:
        print(f"  ⚠ Filtered {skipped_before} laps with missing critical data before analysis")

    # Detect stints (only on valid laps)
    laps_df = detect_stints(laps_df)

    # Detect clean air (only on valid laps)
    laps_df = detect_clean_air(laps_df)

    # Get driver identifiers (f1db_driver_id format: first_name_last_name)
    driver_map = {}
    for driver_num in laps_df['DriverNumber'].unique():
        try:
            driver = session.get_driver(driver_num)
            first_name = driver.get('FirstName', '').lower().replace(' ', '_')
            last_name = driver.get('LastName', '').lower().replace(' ', '_')
            if first_name and last_name:
                raw_id = f"{first_name}_{last_name}"
                # Apply canonical F1DB ID mapping
                driver_map[driver_num] = FASTF1_TO_F1DB_DRIVER_MAP.get(raw_id, raw_id)
            else:
                driver_map[driver_num] = driver['Abbreviation'].lower()
        except:
            print(f"  ✗ WARNING: Could not get driver info for {driver_num}")
            driver_map[driver_num] = f"driver_{driver_num}"

    transformed_laps = []
    skipped_count = 0

    for idx, row in laps_df.iterrows():
        # Extract lap time in seconds (already filtered for non-null LapTime)
        try:
            lap_time_seconds = row['LapTime'].total_seconds()
        except:
            skipped_count += 1
            continue

        # Validity flags
        is_valid_lap = not row.get('IsAccurate', True) == False  # FastF1 marks invalid laps
        is_pit_lap = pd.notna(row.get('PitInTime')) or pd.notna(row.get('PitOutTime'))

        # Out lap: first lap after pit out
        is_out_lap = pd.notna(row.get('PitOutTime'))

        # In lap: lap ending in pit
        is_in_lap = pd.notna(row.get('PitInTime'))

        # Driver ID
        driver_id = driver_map.get(row['DriverNumber'], f"D{row['DriverNumber']}")

        lap_record = {
            'season': season,
            'round': round_number,
            'track_id': track_id,
            'driver_id': driver_id,
            'session_type': 'R',  # Race session
            'lap_number': int(row['LapNumber']),
            'stint_id': int(row['stint_id']),
            'stint_lap_index': int(row['stint_lap_index']),
            'lap_time_seconds': round(lap_time_seconds, 3),
            'is_valid_lap': is_valid_lap,
            'is_pit_lap': is_pit_lap,
            'is_out_lap': is_out_lap,
            'is_in_lap': is_in_lap,
            'clean_air_flag': bool(row['clean_air_flag']),
            'compound': row.get('Compound', None),
            'tyre_age_laps': int(row['TyreLife']) if pd.notna(row.get('TyreLife')) else None
        }

        transformed_laps.append(lap_record)

    if skipped_count > 0:
        print(f"  ⚠ Skipped {skipped_count} laps due to missing data")

    print(f"  ✓ Transformed {len(transformed_laps)} valid laps")
    return transformed_laps


def load_race_data(conn, season: int, round_number: int) -> Dict[str, Any]:
    """
    Load a single race worth of lap data

    Returns metrics about the load operation
    """
    print(f"\n→ Processing Round {round_number}...")

    try:
        # Load FastF1 session
        print(f"  → Loading FastF1 data...")
        session = fastf1.get_session(season, round_number, 'R')  # 'R' = Race
        session.load()

        # Get event info
        event = session.event
        track_id = event['EventName'].lower().replace(' ', '_')

        print(f"  ✓ Loaded: {event['EventName']} (Round {round_number})")

        # Check if already loaded
        if check_race_already_loaded(conn, season, round_number):
            print(f"  ⊘ Race already loaded - skipping")
            return {
                'status': 'skipped',
                'laps_inserted': 0,
                'track_id': track_id
            }

        # Get all laps
        laps = session.laps

        if laps.empty:
            print(f"  ✗ FAIL_CLOSED: No lap data available")
            return {
                'status': 'failed',
                'laps_inserted': 0,
                'track_id': track_id,
                'error': 'No lap data'
            }

        # Transform data
        transformed_laps = transform_lap_data(laps, session, season, round_number, track_id)

        if not transformed_laps:
            print(f"  ✗ FAIL_CLOSED: No valid laps after transformation")
            return {
                'status': 'failed',
                'laps_inserted': 0,
                'track_id': track_id,
                'error': 'No valid laps'
            }

        # Load into database (transactional)
        print(f"  → Inserting {len(transformed_laps)} laps into database...")

        with conn.cursor() as cur:
            # Begin transaction
            cur.execute("BEGIN")

            try:
                # Prepare insert values
                insert_query = """
                    INSERT INTO laps_normalized (
                        season, round, track_id, driver_id, session_type, lap_number,
                        stint_id, stint_lap_index, lap_time_seconds,
                        is_valid_lap, is_pit_lap, is_out_lap, is_in_lap,
                        clean_air_flag, compound, tyre_age_laps
                    ) VALUES %s
                    ON CONFLICT (season, round, track_id, driver_id, lap_number)
                    DO UPDATE SET
                        session_type = EXCLUDED.session_type,
                        stint_id = EXCLUDED.stint_id,
                        stint_lap_index = EXCLUDED.stint_lap_index,
                        is_pit_lap = EXCLUDED.is_pit_lap,
                        is_out_lap = EXCLUDED.is_out_lap,
                        is_in_lap = EXCLUDED.is_in_lap
                """

                values = [
                    (
                        lap['season'], lap['round'], lap['track_id'], lap['driver_id'],
                        lap['session_type'], lap['lap_number'], lap['stint_id'], lap['stint_lap_index'],
                        lap['lap_time_seconds'], lap['is_valid_lap'], lap['is_pit_lap'],
                        lap['is_out_lap'], lap['is_in_lap'], lap['clean_air_flag'],
                        lap['compound'], lap['tyre_age_laps']
                    )
                    for lap in transformed_laps
                ]

                execute_values(cur, insert_query, values)

                # Commit transaction
                cur.execute("COMMIT")

                print(f"  ✓ Inserted {len(transformed_laps)} laps")

                return {
                    'status': 'success',
                    'laps_inserted': len(transformed_laps),
                    'track_id': track_id
                }

            except Exception as e:
                cur.execute("ROLLBACK")
                print(f"  ✗ FAIL_CLOSED: Database insert failed: {e}")
                return {
                    'status': 'failed',
                    'laps_inserted': 0,
                    'track_id': track_id,
                    'error': str(e)
                }

    except Exception as e:
        print(f"  ✗ FAIL_CLOSED: Race processing failed: {e}")
        return {
            'status': 'failed',
            'laps_inserted': 0,
            'track_id': 'unknown',
            'error': str(e)
        }


def write_audit_log(conn, season: int, metrics: ETLMetrics, started_at: datetime, finished_at: datetime):
    """Write ETL execution to audit log"""
    print("\n→ Writing audit log...")

    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS etl_runs_laps_normalized (
                    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    season INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    races_processed INTEGER NOT NULL,
                    races_skipped INTEGER NOT NULL,
                    races_failed INTEGER NOT NULL,
                    total_laps_inserted INTEGER NOT NULL,
                    execution_hash TEXT NOT NULL,
                    started_at TIMESTAMPTZ NOT NULL,
                    finished_at TIMESTAMPTZ NOT NULL
                )
            """)

            cur.execute("""
                INSERT INTO etl_runs_laps_normalized (
                    season, status, races_processed, races_skipped, races_failed,
                    total_laps_inserted, execution_hash, started_at, finished_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                season,
                'success' if metrics.races_failed == 0 else 'partial_failure',
                metrics.races_processed,
                metrics.races_skipped,
                metrics.races_failed,
                metrics.total_laps_inserted,
                metrics.execution_hash,
                started_at,
                finished_at
            ))

            conn.commit()

        print("✓ Audit log written")

    except Exception as e:
        print(f"⚠ Could not write audit log: {e}")


def main():
    parser = argparse.ArgumentParser(description='ETL for laps_normalized table')
    parser.add_argument('--round', type=int, help='Specific round to load (1-24)')
    parser.add_argument('--season', type=int, default=TARGET_SEASON, help='Season to process (default: 2025)')
    args = parser.parse_args()

    season = args.season
    print(f"\n=== LAPS NORMALIZED ETL - {season} SEASON ===\n")
    print(f"Season: {season}")

    started_at = datetime.now()
    print(f"Started: {started_at.isoformat()}\n")

    # Connect to database
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("✗ FAIL_CLOSED: DATABASE_URL not set")
        sys.exit(1)

    try:
        conn = psycopg2.connect(db_url)
        print("✓ Database connected")
    except Exception as e:
        print(f"✗ FAIL_CLOSED: Database connection failed: {e}")
        sys.exit(1)

    # Validate schema
    if not validate_database_schema(conn):
        conn.close()
        sys.exit(1)

    # Determine rounds to process
    if args.round:
        rounds_to_process = [args.round]
        print(f"\n→ Processing single round: {args.round}\n")
    else:
        # F1 season typically has 20-24 races
        rounds_to_process = list(range(1, 25))
        print(f"\n→ Processing all {len(rounds_to_process)} rounds\n")

    # Process races
    metrics = ETLMetrics()

    for round_num in rounds_to_process:
        result = load_race_data(conn, season, round_num)

        if result['status'] == 'success':
            metrics.races_processed += 1
            metrics.total_laps_inserted += result['laps_inserted']
        elif result['status'] == 'skipped':
            metrics.races_skipped += 1
        else:
            metrics.races_failed += 1

    # Compute execution hash
    fastf1_version = fastf1.__version__
    metrics.execution_hash = compute_execution_hash(
        season,
        rounds_to_process[0] if len(rounds_to_process) == 1 else 0,
        f"fastf1-{fastf1_version}"
    )

    # Write audit log
    finished_at = datetime.now()
    write_audit_log(conn, season, metrics, started_at, finished_at)

    # Close connection
    conn.close()

    # Print summary
    print("\n=== ETL COMPLETE ===\n")
    print(f"Execution Hash: {metrics.execution_hash}")
    print(f"\nRaces processed: {metrics.races_processed}")
    print(f"Races skipped:   {metrics.races_skipped}")
    print(f"Races failed:    {metrics.races_failed}")
    print(f"\nTotal laps inserted: {metrics.total_laps_inserted}")
    print(f"\nDuration: {finished_at - started_at}\n")

    # Exit with appropriate code
    if metrics.races_failed > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
