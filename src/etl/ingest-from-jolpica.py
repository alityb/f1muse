#!/usr/bin/env python3
"""
JOLPICA ETL  —  F1DB substitute for current season data

Jolpica (api.jolpi.ca) is the community-maintained Ergast successor.
It has zero publishing lag — results are available within minutes of a
session ending. This script replaces F1DB for any data that needs to
stay current during the season.

Jobs (run independently or all together):
  --job calendar    Fix race.round numbers to match the actual season
                    (removes cancelled races, renumbers after gaps)
  --job results     Populate race_data with RACE_RESULT rows
  --job qualifying  Populate race_data with QUALIFYING_RESULT rows
  --job standings   Populate season_driver_standing + season_constructor_standing
  --job all         Run all jobs in order (default)

Usage:
    python src/etl/ingest-from-jolpica.py --season 2026
    python src/etl/ingest-from-jolpica.py --season 2026 --job results
    python src/etl/ingest-from-jolpica.py --season 2026 --round 4 --job results

Safety:
    - Idempotent (ON CONFLICT DO NOTHING / DO UPDATE)
    - Transactional per race
    - Fail-closed on HTTP errors or empty payloads
"""

import sys
import os
import argparse
import time
from typing import Optional, Dict, List, Any
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_values

try:
    import urllib.request as urlreq
    from urllib.parse import urlencode
    import json
except ImportError:
    pass

load_dotenv()

BASE_URL = "https://api.jolpi.ca/ergast/f1"

# ---------------------------------------------------------------------------
# Circuit ID mapping: Jolpica → F1DB
# ---------------------------------------------------------------------------
JOLPICA_TO_F1DB_CIRCUIT: Dict[str, str] = {
    "albert_park":   "melbourne",
    "shanghai":      "shanghai",
    "suzuka":        "suzuka",
    "miami":         "miami",
    "villeneuve":    "montreal",
    "monaco":        "monaco",
    "catalunya":     "catalunya",
    "red_bull_ring": "spielberg",
    "silverstone":   "silverstone",
    "spa":           "spa-francorchamps",
    "hungaroring":   "hungaroring",
    "zandvoort":     "zandvoort",
    "monza":         "monza",
    "madrid":        "madring",
    "baku":          "baku",
    "marina_bay":    "marina-bay",
    "americas":      "austin",
    "rodriguez":     "mexico-city",
    "interlagos":    "interlagos",
    "las_vegas":     "las-vegas",
    "vegas":         "las-vegas",   # Jolpica uses 'vegas' for Las Vegas
    "losail":        "lusail",
    "yas_marina":    "yas-marina",
    "bahrain":       "bahrain",
    "jeddah":        "jeddah",
    "imola":         "imola",
    "sochi":         "sochi",
    "portimao":      "portimao",
    "istanbul":      "istanbul-park",
    "nurburgring":   "nurburgring",
}

# ---------------------------------------------------------------------------
# Constructor ID mapping: Jolpica → F1DB
# ---------------------------------------------------------------------------
JOLPICA_TO_F1DB_CONSTRUCTOR: Dict[str, str] = {
    "mercedes":      "mercedes",
    "mclaren":       "mclaren",
    "red_bull":      "red-bull",
    "ferrari":       "ferrari",
    "aston_martin":  "aston-martin",
    "alpine":        "alpine",
    "williams":      "williams",
    "haas":          "haas",
    "rb":            "racing-bulls",
    "racing_bulls":  "racing-bulls",
    "kick_sauber":   "audi",       # Renamed to Audi in 2026
    "sauber":        "audi",
    "audi":          "audi",
    "cadillac":      "cadillac",
    "alphatauri":    "racing-bulls",
    "alfa":          "audi",
}

# ---------------------------------------------------------------------------
# Driver ID mapping: Jolpica → F1DB (hyphen format used in race_data)
# ---------------------------------------------------------------------------
JOLPICA_TO_F1DB_DRIVER: Dict[str, str] = {
    # 2026 grid
    "antonelli":      "kimi-antonelli",
    "russell":        "george-russell",
    "norris":         "lando-norris",
    "piastri":        "oscar-piastri",
    "leclerc":        "charles-leclerc",
    "hamilton":       "lewis-hamilton",
    "max_verstappen": "max-verstappen",
    "hadjar":         "isack-hadjar",
    "albon":          "alexander-albon",
    "sainz":          "carlos-sainz-jr",
    "bortoleto":      "gabriel-bortoleto",
    "hulkenberg":     "nico-hulkenberg",
    "bearman":        "oliver-bearman",
    "ocon":           "esteban-ocon",
    "gasly":          "pierre-gasly",
    "colapinto":      "franco-colapinto",
    "alonso":         "fernando-alonso",
    "stroll":         "lance-stroll",
    "perez":          "sergio-perez",
    "bottas":         "valtteri-bottas",
    "lawson":         "liam-lawson",
    "lindblad":       "arvid-lindblad",
    # 2025 grid (for historical backfill)
    "doohan":         "jack-doohan",
    "tsunoda":        "yuki-tsunoda",
    "zhou":           "guanyu-zhou",
    "ricciardo":      "daniel-ricciardo",
    "magnussen":      "kevin-magnussen",
    "sargeant":       "logan-sargeant",
    "de_vries":       "nyck-de-vries",
    "latifi":         "nicholas-latifi",
    "mick_schumacher":"mick-schumacher",
    "vettel":         "sebastian-vettel",
    # Generic fallback handled in code
}

ENGINE_MANUFACTURER_BY_CONSTRUCTOR: Dict[str, str] = {
    "mercedes":    "mercedes",
    "mclaren":     "mercedes",
    "williams":    "mercedes",
    "alpine":      "mercedes",
    "ferrari":     "ferrari",
    "haas":        "ferrari",
    "cadillac":    "ferrari",
    "red-bull":    "red-bull-ford",
    "racing-bulls":"red-bull-ford",
    "aston-martin":"honda",
    "audi":        "audi",
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def fetch_json(url: str, retries: int = 3) -> Dict:
    for attempt in range(retries):
        try:
            req = urlreq.Request(url, headers={"User-Agent": "f1muse-etl/1.0"})
            with urlreq.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise RuntimeError(f"HTTP error fetching {url}: {e}") from e
    return {}


def merge_race_page(target: List[Dict[str, Any]], page_races: List[Dict[str, Any]]) -> None:
    by_race = {(race.get("season"), race.get("round")): race for race in target}

    for race in page_races:
        key = (race.get("season"), race.get("round"))
        existing = by_race.get(key)
        if existing is None:
            target.append(race)
            by_race[key] = race
            continue

        for field in ("Results", "QualifyingResults", "SprintResults", "SprintQualifyingResults"):
            if isinstance(race.get(field), list):
                existing.setdefault(field, []).extend(race[field])


def jolpica(path: str, **params) -> Dict:
    offset = 0
    limit = 100
    merged = None
    merged_races: List[Dict[str, Any]] = []

    while True:
        query = {"format": "json", "limit": limit, "offset": offset, **params}
        url = f"{BASE_URL}{path}?{urlencode(query)}"
        data = fetch_json(url).get("MRData", {})
        page_races = data.get("RaceTable", {}).get("Races")

        if not isinstance(page_races, list):
            return data

        if merged is None:
            merged = data
            merged["RaceTable"]["Races"] = merged_races

        merge_race_page(merged_races, page_races)

        total = int(data.get("total") or 0)
        page_limit = int(data.get("limit") or limit)
        offset += page_limit

        if not total or offset >= total:
            return merged


# ---------------------------------------------------------------------------
# Mapping helpers
# ---------------------------------------------------------------------------
def map_circuit(jolpica_id: str) -> str:
    return JOLPICA_TO_F1DB_CIRCUIT.get(jolpica_id, jolpica_id.replace("_", "-"))

def map_constructor(jolpica_id: str) -> str:
    return JOLPICA_TO_F1DB_CONSTRUCTOR.get(jolpica_id, jolpica_id.replace("_", "-"))

def map_driver(jolpica_id: str) -> str:
    if jolpica_id in JOLPICA_TO_F1DB_DRIVER:
        return JOLPICA_TO_F1DB_DRIVER[jolpica_id]
    # Generic: "first_last" → "first-last"
    return jolpica_id.replace("_", "-")

def parse_lap_time_ms(t: Optional[str]) -> Optional[int]:
    if not t:
        return None
    try:
        parts = t.split(":")
        if len(parts) == 2:
            mins, rest = parts
            secs = float(rest)
            return int((int(mins) * 60 + secs) * 1000)
        return int(float(t) * 1000)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Job 1: Fix race calendar (round numbers)
# ---------------------------------------------------------------------------
def sync_calendar(conn, season: int) -> int:
    print(f"\n→ [calendar] Syncing {season} race calendar from Jolpica...")

    mrdata = jolpica(f"/{season}/races/")
    races = mrdata.get("RaceTable", {}).get("Races", [])
    if not races:
        raise RuntimeError("FAIL_CLOSED: No races returned from Jolpica")

    updated = 0
    cancelled_circuits = set()

    # Collect the circuit IDs that Jolpica says are in the actual season
    actual_circuits = {map_circuit(r["Circuit"]["circuitId"]) for r in races}

    with conn.cursor() as cur:
        # Find circuits in our race table for this year that Jolpica doesn't have
        # (these are the cancelled races)
        cur.execute(
            "SELECT id, round, circuit_id FROM race WHERE year = %s ORDER BY round",
            (season,)
        )
        db_races = cur.fetchall()
        for race_id, rnd, circuit_id in db_races:
            if circuit_id not in actual_circuits:
                cancelled_circuits.add(circuit_id)
                print(f"  ✗ Cancelled: round {rnd} ({circuit_id}) — removing race_data + race")
                cur.execute("DELETE FROM race_data WHERE race_id = %s", (race_id,))
                cur.execute("DELETE FROM race WHERE id = %s", (race_id,))
                updated += 1

        # Now update round numbers to match Jolpica
        for race in races:
            jolpica_round = int(race["round"])
            f1db_circuit  = map_circuit(race["Circuit"]["circuitId"])

            cur.execute(
                "UPDATE race SET round = %s WHERE year = %s AND circuit_id = %s",
                (jolpica_round, season, f1db_circuit)
            )
            if cur.rowcount:
                updated += 1

    conn.commit()
    print(f"  ✓ Calendar synced: {len(races)} races, {len(cancelled_circuits)} cancelled removed")
    return updated


# ---------------------------------------------------------------------------
# Job 2: Race results → race_data RACE_RESULT
# ---------------------------------------------------------------------------
def sync_results(conn, season: int, only_round: Optional[int] = None) -> int:
    print(f"\n→ [results] Syncing {season} race results from Jolpica...")

    path = f"/{season}/results/"
    if only_round:
        path = f"/{season}/{only_round}/results/"
    mrdata = jolpica(path)
    races = mrdata.get("RaceTable", {}).get("Races", [])

    if not races:
        print("  ⊘ No race results available yet")
        return 0

    total_rows = 0
    with conn.cursor() as cur:
        for race in races:
            rnd = int(race["round"])
            circuit_id = map_circuit(race["Circuit"]["circuitId"])

            # Get our race_id
            cur.execute(
                "SELECT id FROM race WHERE year = %s AND round = %s",
                (season, rnd)
            )
            row = cur.fetchone()
            if not row:
                print(f"  ⚠ No race row for {season} round {rnd} — run calendar sync first")
                continue
            race_id = row[0]

            # Clear existing RACE_RESULT rows for this race (full refresh)
            cur.execute(
                "DELETE FROM race_data WHERE race_id = %s AND type = 'RACE_RESULT'",
                (race_id,)
            )

            rows = []
            for res in race["Results"]:
                pos_text = res.get("positionText", "")

                # Only set pos_num for classified finishers (numeric positionText).
                # DNS (W), DSQ (D), Excluded (E) etc. get NULL position_number.
                pos_num = None
                try:
                    pos_num = int(pos_text)
                except (ValueError, TypeError):
                    pass

                classified = pos_text
                driver_id      = map_driver(res["Driver"]["driverId"])
                constructor_id = map_constructor(res["Constructor"]["constructorId"])
                engine_id      = ENGINE_MANUFACTURER_BY_CONSTRUCTOR.get(constructor_id, "unknown")
                status         = res.get("status", "")

                # Non-retirement statuses: Finished, lapped ("+1 Lap" etc.), or
                # any value that starts with "+" or is exactly "Lapped".
                FINISHED_STATUSES = {"Finished", "Lapped"}
                reason = (
                    None
                    if status in FINISHED_STATUSES or status.startswith("+")
                    else status or None
                )

                time_data = res.get("Time", {})
                time_str  = time_data.get("time") if time_data else None
                time_ms   = parse_lap_time_ms(time_str)

                # Winner gets race_time (total duration).
                # Everyone else gets race_gap (gap/laps behind leader).
                if pos_num == 1:
                    race_time_val    = time_str
                    race_time_ms_val = time_ms
                    race_gap_val     = None
                    race_gap_ms_val  = None
                else:
                    race_time_val    = None
                    race_time_ms_val = None
                    race_gap_val     = time_str   # "+5.515", "+1 Lap", etc.
                    race_gap_ms_val  = time_ms

                points = 0.0
                try:
                    points = float(res.get("points", 0))
                except (ValueError, TypeError):
                    pass

                rows.append((
                    race_id, "RACE_RESULT",
                    int(res.get("number", res.get("position", 99))),  # display_order = car number
                    pos_num,
                    classified[:20],
                    str(res["Driver"].get("permanentNumber", "")),
                    driver_id,
                    constructor_id,
                    engine_id,
                    "pirelli",
                    race_time_val,
                    race_time_ms_val,
                    race_gap_val,
                    race_gap_ms_val,
                    points,
                    reason,
                ))

            execute_values(cur, """
                INSERT INTO race_data (
                    race_id, type, position_display_order, position_number, position_text,
                    driver_number, driver_id, constructor_id, engine_manufacturer_id,
                    tyre_manufacturer_id, race_time, race_time_millis,
                    race_gap, race_gap_millis, race_points, race_reason_retired
                ) VALUES %s
                ON CONFLICT (race_id, type, position_display_order) DO UPDATE SET
                    position_number = EXCLUDED.position_number,
                    position_text   = EXCLUDED.position_text,
                    driver_id       = EXCLUDED.driver_id,
                    constructor_id  = EXCLUDED.constructor_id,
                    race_points     = EXCLUDED.race_points,
                    race_reason_retired = EXCLUDED.race_reason_retired
            """, rows)

            total_rows += len(rows)
            print(f"  ✓ Round {rnd} ({circuit_id}): {len(rows)} results")

    conn.commit()
    print(f"  ✓ Total: {total_rows} RACE_RESULT rows")
    return total_rows


# ---------------------------------------------------------------------------
# Job 3: Qualifying → race_data QUALIFYING_RESULT
# ---------------------------------------------------------------------------
def sync_qualifying(conn, season: int, only_round: Optional[int] = None) -> int:
    print(f"\n→ [qualifying] Syncing {season} qualifying from Jolpica...")

    path = f"/{season}/qualifying/"
    if only_round:
        path = f"/{season}/{only_round}/qualifying/"
    mrdata = jolpica(path)
    races = mrdata.get("RaceTable", {}).get("Races", [])

    if not races:
        print("  ⊘ No qualifying data available yet")
        return 0

    total_rows = 0
    with conn.cursor() as cur:
        for race in races:
            rnd = int(race["round"])
            circuit_id = map_circuit(race["Circuit"]["circuitId"])

            cur.execute(
                "SELECT id FROM race WHERE year = %s AND round = %s",
                (season, rnd)
            )
            row = cur.fetchone()
            if not row:
                print(f"  ⚠ No race row for {season} round {rnd} — run calendar sync first")
                continue
            race_id = row[0]

            # Clear and refresh QUALIFYING_RESULT rows
            cur.execute(
                "DELETE FROM race_data WHERE race_id = %s AND type = 'QUALIFYING_RESULT'",
                (race_id,)
            )

            rows = []
            for res in race.get("QualifyingResults", []):
                pos_num = None
                try:
                    pos_num = int(res["position"])
                except (ValueError, TypeError):
                    pass

                driver_id      = map_driver(res["Driver"]["driverId"])
                constructor_id = map_constructor(res["Constructor"]["constructorId"])
                engine_id      = ENGINE_MANUFACTURER_BY_CONSTRUCTOR.get(constructor_id, "unknown")

                rows.append((
                    race_id, "QUALIFYING_RESULT",
                    pos_num or 99,   # position_display_order
                    pos_num,
                    str(res.get("position", "")),
                    str(res["Driver"].get("permanentNumber", "")),
                    driver_id,
                    constructor_id,
                    engine_id,
                    "pirelli",
                    parse_lap_time_ms(res.get("Q1")),
                    parse_lap_time_ms(res.get("Q2")),
                    parse_lap_time_ms(res.get("Q3")),
                ))

            execute_values(cur, """
                INSERT INTO race_data (
                    race_id, type, position_display_order, position_number, position_text,
                    driver_number, driver_id, constructor_id, engine_manufacturer_id,
                    tyre_manufacturer_id,
                    qualifying_q1_millis, qualifying_q2_millis, qualifying_q3_millis
                ) VALUES %s
                ON CONFLICT (race_id, type, position_display_order) DO UPDATE SET
                    position_number = EXCLUDED.position_number,
                    driver_id       = EXCLUDED.driver_id,
                    constructor_id  = EXCLUDED.constructor_id,
                    qualifying_q1_millis = EXCLUDED.qualifying_q1_millis,
                    qualifying_q2_millis = EXCLUDED.qualifying_q2_millis,
                    qualifying_q3_millis = EXCLUDED.qualifying_q3_millis
            """, rows)

            total_rows += len(rows)
            print(f"  ✓ Round {rnd} ({circuit_id}): {len(rows)} qualifying results")

    conn.commit()
    print(f"  ✓ Total: {total_rows} QUALIFYING_RESULT rows")
    return total_rows


# ---------------------------------------------------------------------------
# Job 4: Standings → season_driver_standing + season_constructor_standing
# ---------------------------------------------------------------------------
def sync_standings(conn, season: int) -> int:
    print(f"\n→ [standings] Syncing {season} championship standings from Jolpica...")

    # Driver standings
    mrdata  = jolpica(f"/{season}/driverstandings/")
    s_list  = mrdata.get("StandingsTable", {}).get("StandingsLists", [])
    total   = 0

    with conn.cursor() as cur:
        if s_list:
            standings = s_list[0].get("DriverStandings", [])
            cur.execute("DELETE FROM season_driver_standing WHERE year = %s", (season,))
            rows = []
            for s in standings:
                driver_id = map_driver(s["Driver"]["driverId"])
                pos = int(s["position"])
                rows.append((
                    season,
                    pos,          # position_display_order
                    pos,          # position_number
                    str(pos),     # position_text
                    driver_id,
                    float(s.get("points", 0)),
                    False,        # championship_won — updated at season end
                ))
            if rows:
                execute_values(cur, """
                    INSERT INTO season_driver_standing
                        (year, position_display_order, position_number, position_text,
                         driver_id, points, championship_won)
                    VALUES %s
                    ON CONFLICT (year, position_display_order) DO UPDATE SET
                        position_number = EXCLUDED.position_number,
                        position_text   = EXCLUDED.position_text,
                        driver_id       = EXCLUDED.driver_id,
                        points          = EXCLUDED.points
                """, rows)
                total += len(rows)
                print(f"  ✓ Driver standings: {len(rows)} entries")

        # Constructor standings
        mrdata2 = jolpica(f"/{season}/constructorstandings/")
        s_list2 = mrdata2.get("StandingsTable", {}).get("StandingsLists", [])
        if s_list2:
            standings2 = s_list2[0].get("ConstructorStandings", [])
            cur.execute("DELETE FROM season_constructor_standing WHERE year = %s", (season,))
            rows2 = []
            for s in standings2:
                constructor_id = map_constructor(s["Constructor"]["constructorId"])
                engine_id = ENGINE_MANUFACTURER_BY_CONSTRUCTOR.get(constructor_id, "unknown")
                pos = int(s["position"])
                rows2.append((
                    season,
                    pos,          # position_display_order
                    pos,          # position_number
                    str(pos),     # position_text
                    constructor_id,
                    engine_id,
                    float(s.get("points", 0)),
                    False,        # championship_won
                ))
            if rows2:
                execute_values(cur, """
                    INSERT INTO season_constructor_standing
                        (year, position_display_order, position_number, position_text,
                         constructor_id, engine_manufacturer_id, points, championship_won)
                    VALUES %s
                    ON CONFLICT (year, position_display_order) DO UPDATE SET
                        position_number    = EXCLUDED.position_number,
                        constructor_id     = EXCLUDED.constructor_id,
                        points             = EXCLUDED.points
                """, rows2)
                total += len(rows2)
                print(f"  ✓ Constructor standings: {len(rows2)} entries")

    conn.commit()
    return total


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Jolpica F1DB substitute ETL")
    parser.add_argument("--season", type=int, default=TARGET_SEASON if "TARGET_SEASON" in dir() else 2026)
    parser.add_argument("--round",  type=int, help="Specific round only")
    parser.add_argument("--job",    default="all",
                        choices=["all", "calendar", "results", "qualifying", "standings"])
    args = parser.parse_args()

    print(f"\n=== JOLPICA ETL — {args.season} ===")
    if args.round:
        print(f"Round: {args.round}")
    print(f"Job:   {args.job}\n")

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("✗ DATABASE_URL not set"); sys.exit(1)

    try:
        conn = psycopg2.connect(db_url)
        print("✓ Database connected")
    except Exception as e:
        print(f"✗ DB connection failed: {e}"); sys.exit(1)

    try:
        if args.job in ("all", "calendar"):
            sync_calendar(conn, args.season)

        if args.job in ("all", "results"):
            sync_results(conn, args.season, args.round)

        if args.job in ("all", "qualifying"):
            sync_qualifying(conn, args.season, args.round)

        if args.job in ("all", "standings"):
            sync_standings(conn, args.season)

    except Exception as e:
        print(f"\n✗ ETL failed: {e}")
        conn.rollback()
        conn.close()
        sys.exit(1)

    conn.close()
    print(f"\n=== JOLPICA ETL COMPLETE ===\n")


if __name__ == "__main__":
    main()
