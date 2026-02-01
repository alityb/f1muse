#!/usr/bin/env python3
"""
F1 Muse ETL Pipeline
Populates PostgreSQL database with F1 data using FastF1 library

Usage:
    python populate_database.py [--season YEAR] [--event EVENT_NAME]

Examples:
    python populate_database.py --season 2024
    python populate_database.py --season 2024 --event "Bahrain Grand Prix"
"""

import os
import sys
import argparse
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime

try:
    import fastf1
    import psycopg2
    from psycopg2.extras import execute_batch
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(f"❌ Missing dependency: {e}")
    print("\n📦 Install required packages:")
    print("   pip install fastf1 psycopg2-binary pandas numpy")
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# FastF1 configuration
# Create cache directory if it doesn't exist
cache_dir = os.path.join(os.path.dirname(__file__), '.fastf1_cache')
os.makedirs(cache_dir, exist_ok=True)
fastf1.Cache.enable_cache(cache_dir)  # Cache data locally


class F1MuseETL:
    """ETL pipeline for F1 Muse database population"""

    def __init__(self, database_url: str):
        """Initialize ETL with database connection"""
        self.database_url = database_url
        self.conn = None
        self.cursor = None

    def connect(self):
        """Connect to PostgreSQL database"""
        try:
            self.conn = psycopg2.connect(self.database_url)
            self.cursor = self.conn.cursor()
            logger.info("✅ Connected to database")
        except Exception as e:
            logger.error(f"❌ Database connection failed: {e}")
            raise

    def close(self):
        """Close database connection"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("🔌 Database connection closed")

    def populate_drivers(self, season: int):
        """Populate drivers and driver_aliases tables"""
        logger.info(f"📝 Populating drivers for {season}...")

        # Get season schedule
        schedule = fastf1.get_event_schedule(season)

        # Track unique drivers
        drivers_map = {}

        # Iterate through events to collect all drivers
        for _, event in schedule.iterrows():
            try:
                # Load race session to get driver list
                session = fastf1.get_session(season, event['EventName'], 'R')
                session.load(telemetry=False, weather=False, messages=False)

                for _, driver in session.results.iterrows():
                    driver_id = driver['Abbreviation']
                    if driver_id not in drivers_map:
                        drivers_map[driver_id] = {
                            'first_name': driver['FirstName'],
                            'last_name': driver['LastName'],
                            'full_name': driver['FullName'],
                            'code': driver_id
                        }
            except Exception as e:
                logger.warning(f"⚠️  Could not load drivers from {event['EventName']}: {e}")
                continue

        # Insert drivers
        for driver_id, info in drivers_map.items():
            try:
                self.cursor.execute("""
                    INSERT INTO drivers (driver_id, code, first_name, last_name, full_name)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (driver_id) DO UPDATE SET
                        first_name = EXCLUDED.first_name,
                        last_name = EXCLUDED.last_name,
                        full_name = EXCLUDED.full_name
                """, (
                    driver_id,
                    info['code'],
                    info['first_name'],
                    info['last_name'],
                    info['full_name']
                ))

                # Create aliases
                aliases = [
                    (info['first_name'], driver_id, False),  # First name
                    (info['last_name'], driver_id, False),   # Last name
                    (info['full_name'], driver_id, True),    # Full name (primary)
                    (driver_id, driver_id, False),           # Code/Abbreviation
                ]

                for alias, did, is_primary in aliases:
                    self.cursor.execute("""
                        INSERT INTO driver_aliases (alias, driver_id, is_primary)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (alias) DO NOTHING
                    """, (alias, did, is_primary))

            except Exception as e:
                logger.error(f"❌ Failed to insert driver {driver_id}: {e}")

        self.conn.commit()
        logger.info(f"✅ Populated {len(drivers_map)} drivers")

    def populate_tracks(self, season: int):
        """Populate tracks and track_aliases tables"""
        logger.info(f"📍 Populating tracks for {season}...")

        schedule = fastf1.get_event_schedule(season)
        tracks_map = {}

        for _, event in schedule.iterrows():
            # Use event location as track_id (lowercase, no spaces)
            track_id = event['Location'].lower().replace(' ', '_')

            if track_id not in tracks_map:
                tracks_map[track_id] = {
                    'track_name': event['OfficialEventName'],
                    'country': event['Country']
                }

                # Insert track
                try:
                    self.cursor.execute("""
                        INSERT INTO tracks (track_id, track_name, country)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (track_id) DO UPDATE SET
                            track_name = EXCLUDED.track_name,
                            country = EXCLUDED.country
                    """, (track_id, tracks_map[track_id]['track_name'], tracks_map[track_id]['country']))

                    # Create aliases
                    aliases = [
                        (event['Location'], track_id, False),           # Location
                        (event['Country'], track_id, False),            # Country
                        (event['OfficialEventName'], track_id, True),   # Official name (primary)
                        (event['EventName'], track_id, False),          # Short name
                    ]

                    for alias, tid, is_primary in aliases:
                        self.cursor.execute("""
                            INSERT INTO track_aliases (alias, track_id, is_primary)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (alias) DO NOTHING
                        """, (alias, tid, is_primary))

                except Exception as e:
                    logger.error(f"❌ Failed to insert track {track_id}: {e}")

        self.conn.commit()
        logger.info(f"✅ Populated {len(tracks_map)} tracks")

    def populate_driver_season_entries(self, season: int):
        """Populate driver_season_entries (team memberships)"""
        logger.info(f"🏁 Populating driver-team entries for {season}...")

        schedule = fastf1.get_event_schedule(season)
        driver_teams = {}

        # Get first race to determine team memberships
        first_event = schedule.iloc[0]
        try:
            session = fastf1.get_session(season, first_event['EventName'], 'R')
            session.load(telemetry=False, weather=False, messages=False)

            for _, driver in session.results.iterrows():
                driver_id = driver['Abbreviation']
                team_name = driver['TeamName']
                # Create team_id from team name (uppercase initials)
                team_id = ''.join([word[0] for word in team_name.split()]).upper()[:3]

                driver_teams[driver_id] = team_id

                # Insert entry
                try:
                    self.cursor.execute("""
                        INSERT INTO driver_season_entries (season, driver_id, team_id)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (season, driver_id) DO UPDATE SET
                            team_id = EXCLUDED.team_id
                    """, (season, driver_id, team_id))
                except Exception as e:
                    logger.error(f"❌ Failed to insert driver-team entry: {e}")

            self.conn.commit()
            logger.info(f"✅ Populated {len(driver_teams)} driver-team entries")

        except Exception as e:
            logger.error(f"❌ Could not load driver-team data: {e}")

    def compute_pace_metrics(self, laps_df: pd.DataFrame, driver_id: str) -> Dict[str, Any]:
        """Compute pace metrics for a driver from lap data"""

        # Filter valid laps (no pit laps, no outliers)
        valid_laps = laps_df[
            (laps_df['PitOutTime'].isna()) &
            (laps_df['PitInTime'].isna()) &
            (laps_df['LapTime'].notna())
        ].copy()

        if len(valid_laps) == 0:
            return None

        # Convert LapTime to seconds
        valid_laps['LapTimeSeconds'] = valid_laps['LapTime'].dt.total_seconds()

        # Remove outliers (> 3 std dev from mean)
        mean_lap = valid_laps['LapTimeSeconds'].mean()
        std_lap = valid_laps['LapTimeSeconds'].std()
        valid_laps = valid_laps[
            abs(valid_laps['LapTimeSeconds'] - mean_lap) <= 3 * std_lap
        ]

        if len(valid_laps) == 0:
            return None

        # Compute average true pace
        avg_pace = valid_laps['LapTimeSeconds'].mean()
        laps_considered = len(valid_laps)

        return {
            'avg_true_pace': avg_pace,
            'laps_considered': laps_considered
        }

    def populate_track_metrics(self, season: int, event_name: Optional[str] = None):
        """Populate pace_metric_summary_driver_track table"""
        logger.info(f"📊 Populating track metrics for {season}...")

        schedule = fastf1.get_event_schedule(season)

        # Filter to specific event if requested
        if event_name:
            schedule = schedule[schedule['EventName'] == event_name]

        for _, event in schedule.iterrows():
            logger.info(f"  Processing: {event['EventName']}")
            track_id = event['Location'].lower().replace(' ', '_')

            # Process race session
            try:
                session = fastf1.get_session(season, event['EventName'], 'R')
                session.load(telemetry=False, weather=False, messages=False)

                # Get laps for each driver
                for driver_id in session.results['Abbreviation']:
                    driver_laps = session.laps.pick_driver(driver_id)

                    if driver_laps.empty:
                        continue

                    metrics = self.compute_pace_metrics(driver_laps, driver_id)

                    if metrics is None:
                        continue

                    # Insert track metric
                    try:
                        self.cursor.execute("""
                            INSERT INTO pace_metric_summary_driver_track
                            (season, track_id, driver_id, metric_name, metric_value,
                             normalization, laps_considered, clean_air_only,
                             compound_context, session_scope)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (season, track_id, driver_id, metric_name,
                                       normalization, compound_context, clean_air_only, session_scope)
                            DO UPDATE SET
                                metric_value = EXCLUDED.metric_value,
                                laps_considered = EXCLUDED.laps_considered
                        """, (
                            season,
                            track_id,
                            driver_id,
                            'avg_true_pace',
                            float(metrics['avg_true_pace']),
                            'none',
                            int(metrics['laps_considered']),
                            False,  # clean_air_only
                            'mixed',  # compound_context
                            'race'  # session_scope
                        ))
                    except Exception as e:
                        logger.error(f"❌ Failed to insert track metric: {e}")

                self.conn.commit()

            except Exception as e:
                logger.warning(f"⚠️  Could not process {event['EventName']}: {e}")
                continue

        logger.info(f"✅ Track metrics populated for {season}")

    def populate_season_metrics(self, season: int):
        """Populate pace_metric_summary_driver_season table"""
        logger.info(f"📈 Populating season metrics for {season}...")

        # This is a simplified version - you'd compute these by aggregating
        # all track metrics for each driver across the season

        # For now, we'll aggregate from track metrics
        try:
            self.cursor.execute("""
                INSERT INTO pace_metric_summary_driver_season
                (season, driver_id, metric_name, metric_value, normalization,
                 laps_considered, clean_air_only, compound_context, session_scope)
                SELECT
                    season,
                    driver_id,
                    'avg_true_pace' as metric_name,
                    AVG(metric_value) as metric_value,
                    'none' as normalization,
                    SUM(laps_considered) as laps_considered,
                    false as clean_air_only,
                    'mixed' as compound_context,
                    'all' as session_scope
                FROM pace_metric_summary_driver_track
                WHERE season = %s
                  AND metric_name = 'avg_true_pace'
                  AND session_scope = 'race'
                GROUP BY season, driver_id
                ON CONFLICT (season, driver_id, metric_name, normalization,
                           compound_context, clean_air_only, session_scope)
                DO UPDATE SET
                    metric_value = EXCLUDED.metric_value,
                    laps_considered = EXCLUDED.laps_considered
            """, (season,))

            self.conn.commit()
            logger.info(f"✅ Season metrics populated for {season}")

        except Exception as e:
            logger.error(f"❌ Failed to populate season metrics: {e}")

    def run(self, season: int, event_name: Optional[str] = None):
        """Run the full ETL pipeline"""
        logger.info(f"🚀 Starting F1 Muse ETL for season {season}")

        try:
            self.connect()

            # Step 1: Populate reference data
            self.populate_drivers(season)
            self.populate_tracks(season)
            self.populate_driver_season_entries(season)

            # Step 2: Populate metrics
            self.populate_track_metrics(season, event_name)

            # Step 3: Aggregate to season metrics
            if not event_name:  # Only aggregate if processing full season
                self.populate_season_metrics(season)

            logger.info("🎉 ETL pipeline completed successfully!")

        except Exception as e:
            logger.error(f"❌ ETL pipeline failed: {e}")
            if self.conn:
                self.conn.rollback()
            raise
        finally:
            self.close()


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='F1 Muse ETL Pipeline')
    parser.add_argument('--season', type=int, default=2024,
                       help='F1 season year (default: 2024)')
    parser.add_argument('--event', type=str, default=None,
                       help='Specific event name (optional)')
    parser.add_argument('--database-url', type=str,
                       default=os.getenv('DATABASE_URL'),
                       help='PostgreSQL connection string')

    args = parser.parse_args()

    if not args.database_url:
        logger.error("❌ DATABASE_URL not set. Use --database-url or set DATABASE_URL environment variable")
        sys.exit(1)

    # Run ETL
    etl = F1MuseETL(args.database_url)
    etl.run(args.season, args.event)


if __name__ == '__main__':
    main()
