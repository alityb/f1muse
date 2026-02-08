#!/usr/bin/env python3
"""
LAPS NORMALIZED ETL - MULTI-SEASON

SAFETY-CRITICAL ETL JOB

Rules:
- Manual execution only
- One-shot, deterministic
- Fail-closed on any data quality issue
- Transactional (per race)
- Auditable with execution_hash
- Idempotent (skip already-loaded races)

Usage:
    python src/etl/ingest-laps.py --season YEAR [--round ROUND_NUMBER]

    # Load all 2024 races:
    python src/etl/ingest-laps.py --season 2024

    # Load specific round from 2023:
    python src/etl/ingest-laps.py --season 2023 --round 1
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
CLEAN_AIR_GAP_THRESHOLD = 2.0  # seconds - gap to car ahead to be considered "clean air"

# Season race counts
SEASON_RACE_COUNTS = {
    2018: 21,
    2019: 21,
    2020: 17,  # COVID shortened season
    2021: 22,
    2022: 22,
    2023: 22,
    2024: 24,
    2025: 24,
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
                # Map abbreviation (uppercase) to f1db_driver_id
                driver_map[row[0].upper()] = row[1]
        print(f"✓ Loaded {len(driver_map)} driver identity mappings")
    except Exception as e:
        print(f"⚠ Could not load driver identity map: {e}")
    return driver_map


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


def detect_stints_and_pit_laps(laps_df: pd.DataFrame) -> pd.DataFrame:
    """
    Detect stint boundaries and pit laps using deterministic logic

    A new stint begins when:
    - Driver changes compound
    - Driver makes a pit stop (PitInTime or PitOutTime present)
    - Start of race (lap 1)

    Pit lap detection (deterministic):
    - In-lap: PitInTime is present (driver enters pit at end of lap)
    - Out-lap: PitOutTime is present (driver exits pit at start of lap)
    - A lap is a pit lap ONLY if it's an in-lap OR out-lap

    Target: ~6-7% pit lap rate (typical F1 race)
    """
    laps_df = laps_df.sort_values(['DriverNumber', 'LapNumber']).copy()

    # Initialize stint tracking
    laps_df['stint_id'] = 0
    laps_df['stint_lap_index'] = 0
    laps_df['is_in_lap_detected'] = False
    laps_df['is_out_lap_detected'] = False
    laps_df['is_pit_lap_detected'] = False

    for driver in laps_df['DriverNumber'].unique():
        driver_mask = laps_df['DriverNumber'] == driver
        driver_laps = laps_df[driver_mask].copy()

        current_stint = 1
        stint_lap = 1
        prev_compound = None
        prev_had_pit_in = False

        stint_ids = []
        stint_indices = []
        in_laps = []
        out_laps = []
        pit_laps = []

        for idx, row in driver_laps.iterrows():
            # Detect in-lap (enters pit at end of this lap)
            has_pit_in = pd.notna(row.get('PitInTime'))

            # Detect out-lap (exits pit at start of this lap)
            has_pit_out = pd.notna(row.get('PitOutTime'))

            # Determine if this is a pit lap
            is_in_lap = has_pit_in
            is_out_lap = has_pit_out

            # A lap is a pit lap if it's an in-lap or out-lap
            is_pit_lap = is_in_lap or is_out_lap

            # New stint detection
            compound_changed = (prev_compound is not None and row['Compound'] != prev_compound)
            pit_stop_occurred = prev_had_pit_in or has_pit_out

            if prev_compound is not None and (compound_changed or pit_stop_occurred):
                current_stint += 1
                stint_lap = 1

            stint_ids.append(current_stint)
            stint_indices.append(stint_lap)
            in_laps.append(is_in_lap)
            out_laps.append(is_out_lap)
            pit_laps.append(is_pit_lap)

            prev_compound = row['Compound']
            prev_had_pit_in = has_pit_in
            stint_lap += 1

        laps_df.loc[driver_mask, 'stint_id'] = stint_ids
        laps_df.loc[driver_mask, 'stint_lap_index'] = stint_indices
        laps_df.loc[driver_mask, 'is_in_lap_detected'] = in_laps
        laps_df.loc[driver_mask, 'is_out_lap_detected'] = out_laps
        laps_df.loc[driver_mask, 'is_pit_lap_detected'] = pit_laps

    return laps_df


def detect_clean_air(laps_df: pd.DataFrame, threshold: float = CLEAN_AIR_GAP_THRESHOLD) -> pd.DataFrame:
    """
    Detect clean air laps based on gap to car ahead

    A lap is "clean air" if:
    - Gap to car ahead > threshold (2.0 seconds)
    - OR driver is in P1 (no car ahead)
    - AND not in traffic situation

    Uses GapToLeader if available (2022+), otherwise calculates from cumulative lap times.
    """
    laps_df = laps_df.copy()

    # Default to True (clean air)
    laps_df['clean_air_flag'] = True

    # Check if GapToLeader is available and has data
    has_gap_to_leader = (
        'GapToLeader' in laps_df.columns and
        laps_df['GapToLeader'].notna().sum() > len(laps_df) * 0.5  # At least 50% have gap data
    )

    if has_gap_to_leader:
        # Use GapToLeader method (2022+ seasons)
        _detect_clean_air_from_gap(laps_df, threshold)
    else:
        # Calculate gaps from cumulative lap times (pre-2022 seasons)
        _detect_clean_air_from_cumulative(laps_df, threshold)

    return laps_df


def _detect_clean_air_from_gap(laps_df: pd.DataFrame, threshold: float) -> None:
    """Detect clean air using GapToLeader data (mutates laps_df in place)"""
    for lap_num in laps_df['LapNumber'].unique():
        lap_mask = laps_df['LapNumber'] == lap_num
        lap_data = laps_df[lap_mask].copy()

        if 'Position' in lap_data.columns:
            lap_data = lap_data.sort_values('Position')

            for idx, row in lap_data.iterrows():
                position = row.get('Position')

                # P1 always has clean air
                if position == 1:
                    continue

                if pd.notna(row.get('GapToLeader')):
                    ahead_position = position - 1
                    car_ahead = lap_data[lap_data['Position'] == ahead_position]

                    if not car_ahead.empty and pd.notna(car_ahead.iloc[0]['GapToLeader']):
                        gap_to_ahead = row['GapToLeader'] - car_ahead.iloc[0]['GapToLeader']

                        if gap_to_ahead < threshold:
                            laps_df.loc[idx, 'clean_air_flag'] = False


def _detect_clean_air_from_cumulative(laps_df: pd.DataFrame, threshold: float) -> None:
    """
    Detect clean air by calculating gaps from cumulative lap times (mutates laps_df in place).

    For each lap:
    1. Calculate cumulative race time for each driver
    2. Sort by cumulative time to get on-track order
    3. Gap to car ahead = my_cumulative - car_ahead_cumulative
    4. If gap < threshold, mark as dirty air
    """
    # First, compute cumulative lap time for each driver
    laps_df['_lap_time_sec'] = laps_df['LapTime'].apply(
        lambda x: x.total_seconds() if pd.notna(x) else None
    )

    # Sort in place by driver and lap number for cumsum to work correctly
    laps_df.sort_values(['DriverNumber', 'LapNumber'], inplace=True)

    # Calculate cumulative time per driver
    laps_df['_cumulative_time'] = laps_df.groupby('DriverNumber')['_lap_time_sec'].cumsum()

    # Now process each lap to detect clean air
    for lap_num in laps_df['LapNumber'].unique():
        lap_mask = laps_df['LapNumber'] == lap_num

        # Get indices and cumulative times for this lap
        lap_indices = laps_df.index[lap_mask].tolist()
        lap_cumtimes = laps_df.loc[lap_indices, '_cumulative_time'].values

        # Filter to valid cumulative times
        valid_mask = ~pd.isna(lap_cumtimes)
        valid_indices = [idx for idx, valid in zip(lap_indices, valid_mask) if valid]
        valid_cumtimes = lap_cumtimes[valid_mask]

        if len(valid_indices) < 2:
            continue

        # Sort by cumulative time (on-track order)
        sorted_order = valid_cumtimes.argsort()
        sorted_indices = [valid_indices[i] for i in sorted_order]
        sorted_cumtimes = valid_cumtimes[sorted_order]

        # Calculate gap to car ahead and mark dirty air
        for i in range(1, len(sorted_indices)):  # Skip leader (i=0)
            gap_to_ahead = sorted_cumtimes[i] - sorted_cumtimes[i - 1]

            if gap_to_ahead < threshold:
                laps_df.loc[sorted_indices[i], 'clean_air_flag'] = False

    # Clean up temporary columns
    laps_df.drop(columns=['_lap_time_sec', '_cumulative_time'], inplace=True, errors='ignore')


def transform_lap_data(laps_df: pd.DataFrame, session, season: int, round_number: int, track_id: str, identity_map: Dict[str, str]) -> List[Dict[str, Any]]:
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

    # Detect stints and pit laps (only on valid laps)
    laps_df = detect_stints_and_pit_laps(laps_df)

    # Detect clean air (only on valid laps)
    laps_df = detect_clean_air(laps_df)

    # Get driver identifiers - map FastF1 abbreviations to f1db_driver_id via identity map
    driver_map = {}
    for driver_num in laps_df['DriverNumber'].unique():
        try:
            driver = session.get_driver(driver_num)
            abbrev = driver['Abbreviation'].upper()

            # Look up in identity map
            if abbrev in identity_map:
                driver_map[driver_num] = identity_map[abbrev]
            else:
                # Fallback: construct from first/last name
                first_name = driver.get('FirstName', '').lower()
                last_name = driver.get('LastName', '').lower()
                if first_name and last_name:
                    driver_map[driver_num] = f"{first_name}_{last_name}"
                    print(f"  ⚠ Driver {abbrev} not in identity map, using: {driver_map[driver_num]}")
                else:
                    driver_map[driver_num] = abbrev.lower()
                    print(f"  ✗ WARNING: Could not resolve driver {abbrev}")
        except Exception as e:
            print(f"  ✗ WARNING: Could not get info for driver {driver_num}: {e}")
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

        # Use deterministically detected pit lap flags
        is_pit_lap = bool(row.get('is_pit_lap_detected', False))
        is_out_lap = bool(row.get('is_out_lap_detected', False))
        is_in_lap = bool(row.get('is_in_lap_detected', False))

        # Driver ID
        driver_id = driver_map.get(row['DriverNumber'], f"d{row['DriverNumber']}".lower())

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


def load_race_data(conn, season: int, round_number: int, identity_map: Dict[str, str]) -> Dict[str, Any]:
    """
    Load a single race worth of lap data

    Returns metrics about the load operation
    """
    print(f"\n→ Processing {season} Round {round_number}...")

    try:
        # Load FastF1 session
        print(f"  → Loading FastF1 data...")
        session = fastf1.get_session(season, round_number, 'R')  # 'R' = Race
        session.load()

        # Get event info
        event = session.event
        track_id = event['EventName'].lower().replace(' ', '_').replace("'", "")

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
        transformed_laps = transform_lap_data(laps, session, season, round_number, track_id, identity_map)

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
    parser.add_argument('--season', type=int, required=True, help='Season year (e.g., 2022, 2023, 2024, 2025)')
    parser.add_argument('--round', type=int, help='Specific round to load')
    args = parser.parse_args()

    season = args.season

    if season not in SEASON_RACE_COUNTS:
        print(f"✗ FAIL_CLOSED: Season {season} not supported. Supported: {list(SEASON_RACE_COUNTS.keys())}")
        sys.exit(1)

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

    # Load driver identity map
    identity_map = load_driver_identity_map(conn)
    if not identity_map:
        print("⚠ Warning: No driver identity map found, will construct driver IDs from names")

    # Determine rounds to process
    if args.round:
        rounds_to_process = [args.round]
        print(f"\n→ Processing single round: {args.round}\n")
    else:
        race_count = SEASON_RACE_COUNTS[season]
        rounds_to_process = list(range(1, race_count + 1))
        print(f"\n→ Processing all {len(rounds_to_process)} rounds\n")

    # Process races
    metrics = ETLMetrics()

    for round_num in rounds_to_process:
        result = load_race_data(conn, season, round_num, identity_map)

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
    print(f"Season: {season}")
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
