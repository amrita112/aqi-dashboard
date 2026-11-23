"""
One-time (or occasional) bootstrap: build the target-stations manifest that
the ingest scripts read.

What it does:
  1. Fetch all OpenAQ locations in India via /v3/locations.
  2. Filter to stations whose coordinates fall inside a TARGET_CITIES bbox.
  3. Keep only the sensors for TARGET_POLLUTANTS.
  4. Ensure each surviving station exists in the Supabase `monitors` table,
     with `serial_number = "openaq:{openaq_id}"` as the stable external key.
  5. Write the sensor list to the Supabase table `monitor_sensors`
     (migration 32), which the ingest jobs read: upsert every sensor found,
     delete the ones OpenAQ no longer lists. Refuses to touch anything if the
     new list is suspiciously small (see DEFAULT_MIN_SHARE_OF_EXISTING).
  6. Also write scripts/ingest/target_stations.json locally, the same list as
     a file: the ingest falls back to it if the table cannot be read, and the
     local analysis scripts read it. The weekly workflow no longer commits it
     (main refuses direct pushes), so the copy in git is not kept current.

Run from the repo root (module mode — the script uses absolute imports
like `from scripts.ingest.lib.config import ...`, so a plain
`python3 scripts/ingest/bootstrap_stations.py` invocation would fail
with ModuleNotFoundError):

    /opt/homebrew/Caskroom/miniforge/base/bin/python3 -m scripts.ingest.bootstrap_stations

Add --dry-run (or set DRY_RUN=1) to do every OpenAQ call and Supabase READ but
no writes at all -- not to Supabase, not to the JSON file -- and print how the
new list differs from the JSON file and from the table. ~180 OpenAQ requests at
1 per second, so about 3-4 minutes.

Env vars required (from .env.local locally, or GitHub secrets on CI):
  OPENAQ_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Re-run whenever OpenAQ adds new stations in the target cities (roughly monthly).
Idempotent — safe to run repeatedly.
"""

from __future__ import annotations

import argparse
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

from scripts.ingest.lib.config import (
    get_sensor_max_age_days,
    OPENAQ_COUNTRY_ID_INDIA,
    TARGET_CITIES,
    TARGET_POLLUTANTS,
    TARGET_STATIONS_PATH,
    get_env,
    which_city,
)
from scripts.ingest.lib.openaq_client import OpenAQClient
from scripts.ingest.lib.supabase_client import make_client, upsert_monitors


def fetch_openaq_india_locations(client: OpenAQClient) -> List[Dict[str, Any]]:
    """Fetch every OpenAQ location in India (paginates until exhausted).

    Rate-limiting is handled by the shared OpenAQClient; no explicit sleeps
    are needed here.
    """
    all_locations: List[Dict[str, Any]] = []
    page = 1
    while True:
        r = client.get(
            "/v3/locations",
            params={"countries_id": OPENAQ_COUNTRY_ID_INDIA, "limit": 1000, "page": page},
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            break
        all_locations.extend(results)
        if len(results) < 1000:
            break
        page += 1
    return all_locations


def drop_stale_sensors(client, stations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove sensors that stopped reporting, keeping the manifest to live ones.

    OpenAQ periodically re-registers a station's sensors under new ids and
    leaves the old ones listed forever, returning nothing. The location list
    used by filter_to_target() does not carry per-sensor recency, so this makes
    one extra call per station to /v3/locations/{id}/sensors, which does.

    Costs ~178 requests on a weekly job; saves roughly half of every 6-hourly
    ingest run. A station left with no live sensor is dropped entirely.

    Sensors whose age cannot be determined are KEPT: an API hiccup should not
    silently shrink the manifest, and a live sensor wrongly dropped would be
    invisible until someone noticed missing data.
    """
    max_age = get_sensor_max_age_days()
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age)
    print(f"Checking sensor freshness (keeping sensors seen in the last {max_age} days) ...")

    kept_stations: List[Dict[str, Any]] = []
    n_before = sum(len(st["sensors"]) for st in stations)
    n_undetermined = 0

    for i, st in enumerate(stations, start=1):
        try:
            r = client.get(f"/v3/locations/{st['openaq_id']}/sensors")
            r.raise_for_status()
            results = r.json().get("results", [])
        except Exception as e:
            print(f"  station {st['openaq_id']}: freshness check failed ({e}); keeping as-is")
            kept_stations.append(st)
            continue

        last_seen: Dict[int, Any] = {}
        for sensor in results:
            stamp = (sensor.get("datetimeLast") or {}).get("utc")
            if not stamp:
                continue
            try:
                last_seen[sensor["id"]] = datetime.fromisoformat(
                    stamp.replace("Z", "+00:00")
                )
            except ValueError:
                continue

        live = []
        for sensor in st["sensors"]:
            seen = last_seen.get(sensor["sensor_id"])
            if seen is None:
                n_undetermined += 1
                live.append(sensor)          # keep: unknown is not the same as dead
            elif seen >= cutoff:
                live.append(sensor)

        if live:
            kept_stations.append({**st, "sensors": live})

        if i % 50 == 0:
            print(f"  ... {i}/{len(stations)} stations checked")

    n_after = sum(len(st["sensors"]) for st in kept_stations)
    print(
        f"Sensor prune: {n_before} -> {n_after} sensors "
        f"({n_before - n_after} stale dropped, {n_undetermined} kept as undetermined); "
        f"{len(stations)} -> {len(kept_stations)} stations"
    )
    return kept_stations


def filter_to_target(locations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep only stations in target cities, with at least one target-pollutant sensor."""
    kept = []
    for loc in locations:
        coords = loc.get("coordinates") or {}
        lat, lng = coords.get("latitude"), coords.get("longitude")
        if lat is None or lng is None:
            continue
        city = which_city(lat, lng)
        if city is None:
            continue
        sensors = [
            {
                "sensor_id": s["id"],
                "parameter": (s.get("parameter") or {}).get("name", "").lower().replace("pm2.5", "pm25"),
            }
            for s in (loc.get("sensors") or [])
        ]
        sensors = [s for s in sensors if s["parameter"] in TARGET_POLLUTANTS]
        if not sensors:
            continue
        kept.append({
            "openaq_id": loc["id"],
            "name":      loc.get("name") or "",
            "latitude":  lat,
            "longitude": lng,
            "city":      city,
            "sensors":   sensors,
        })
    return kept


def backfill_monitor_locations(client, stations: List[Dict[str, Any]]) -> int:
    """Write each station's name, coordinates and city onto its monitors row.

    monitors carried no position until migration 13; coordinates only existed
    on individual readings. That made a station's location unfindable exactly
    when it mattered most -- a station with no recent readings still has to
    appear on the map, greyed out, rather than vanishing.

    Runs on every bootstrap so a relocated or renamed station stays correct.
    """
    updated = 0
    for st in stations:
        try:
            client.table("monitors").update({
                "name":      st["name"],
                "latitude":  st["latitude"],
                "longitude": st["longitude"],
                "city":      st["city"],
            }).eq("serial_number", f"openaq:{st['openaq_id']}").execute()
            updated += 1
        except Exception as e:
            print(f"  monitor {st['openaq_id']}: location update failed ({e})")
    return updated


def sync_monitors_table(client, stations: List[Dict[str, Any]],
                        dry_run: bool = False) -> Dict[int, str]:
    """Ensure a row exists in `monitors` for each station.

    Returns a mapping openaq_id → monitor.id (UUID) that the ingest scripts
    use to attach readings to the right monitor row. With dry_run, only looks
    the existing rows up; new stations get a freshly minted id that is never
    written anywhere.
    """
    # First, look up any existing monitors by their serial_number
    serials = [f"openaq:{s['openaq_id']}" for s in stations]
    existing = (
        client.table("monitors")
              .select("id, serial_number")
              .in_("serial_number", serials)
              .execute()
              .data
        or []
    )
    existing_by_serial = {row["serial_number"]: row["id"] for row in existing}

    # Assemble the full set of rows (existing ids preserved, new ones minted).
    rows_to_upsert = []
    openaq_to_monitor: Dict[int, str] = {}
    for s in stations:
        serial = f"openaq:{s['openaq_id']}"
        monitor_id = existing_by_serial.get(serial) or str(uuid.uuid4())
        openaq_to_monitor[s["openaq_id"]] = monitor_id
        rows_to_upsert.append({
            "id":            monitor_id,
            "serial_number": serial,
            "manufacturer":  "OpenAQ",
            "model":         s["name"][:100] if s["name"] else None,
            "notes":         f"OpenAQ location {s['openaq_id']} in {s['city']}",
        })

    n_new = sum(1 for s in stations if f"openaq:{s['openaq_id']}" not in existing_by_serial)
    if dry_run:
        print(f"  DRY RUN: would upsert {len(rows_to_upsert)} monitor rows ({n_new} new)")
        return openaq_to_monitor
    count = upsert_monitors(client, rows_to_upsert)
    print(f"  upserted {count} monitor rows ({n_new} new)")
    return openaq_to_monitor


# ─── The sensor table (migration 32) ────────────────────────────────────────

SENSORS_TABLE = "monitor_sensors"

# SAFETY: refuse to write the sensor table if this run found fewer than this
# share of the sensors it already holds. Real changes are small (a station or
# two added or retired moves the count by a few percent); a broken or partial
# OpenAQ download moves it by far more, and writing that would delete most of
# the list and silently stop the ingest for those stations. Same rule and
# number as scripts/climate/build_station_climate.py. Override per run with
# --min-share (e.g. --min-share 0 after a deliberate, large change).
DEFAULT_MIN_SHARE_OF_EXISTING = 0.8

# Rows per upsert request, and sensor ids per delete request (the ids go in
# the URL, so keep it short).
SENSOR_UPSERT_BATCH = 500
SENSOR_DELETE_BATCH = 200


def read_existing_sensor_ids(client) -> Optional[Set[int]]:
    """Sensor ids now in the table, or None if the table does not exist yet."""
    ids: Set[int] = set()
    offset = 0
    try:
        while True:
            batch = (client.table(SENSORS_TABLE).select("sensor_id").order("sensor_id")
                           .range(offset, offset + 999).execute().data) or []
            ids.update(int(r["sensor_id"]) for r in batch)
            if len(batch) < 1000:
                return ids
            offset += 1000
    except Exception as e:
        msg = str(e)
        if "does not exist" in msg or "PGRST205" in msg or "42P01" in msg:
            return None
        raise


def check_not_shrinking(n_new: int, n_existing: int,
                        min_share: float = DEFAULT_MIN_SHARE_OF_EXISTING) -> None:
    """Stop the run, before anything is written, if the list shrank too much.

    A baseline of 0 (nothing to compare with) always passes.
    """
    if n_existing and n_new < min_share * n_existing:
        raise SystemExit(
            f"REFUSING TO WRITE: this run found {n_new} sensors but the stored "
            f"list ({SENSORS_TABLE}, or the JSON file while that is empty) holds "
            f"{n_existing} (below {min_share:.0%}). "
            f"That usually means the OpenAQ download failed part-way. Nothing "
            f"was changed. If the drop is real, re-run with --min-share 0.")


def sensor_rows(stations: List[Dict[str, Any]], openaq_to_monitor: Dict[int, str],
                run_time: str) -> List[Dict[str, Any]]:
    """One monitor_sensors row per sensor, all stamped with this run's time."""
    return [
        {
            "sensor_id":          int(sensor["sensor_id"]),
            "monitor_id":         openaq_to_monitor[st["openaq_id"]],
            "parameter":          sensor["parameter"],
            "openaq_location_id": int(st["openaq_id"]),
            "updated_at":         run_time,
        }
        for st in stations
        for sensor in st["sensors"]
    ]


def write_sensor_table(client, rows: List[Dict[str, Any]], existing: Set[int]) -> None:
    """Upsert every sensor, then delete the ones this run no longer lists.

    The caller has already run check_not_shrinking. Upsert first, delete
    second: if the run dies in between, the table has extra rows (harmless,
    the next run removes them) rather than missing ones.
    """
    for i in range(0, len(rows), SENSOR_UPSERT_BATCH):
        client.table(SENSORS_TABLE).upsert(
            rows[i:i + SENSOR_UPSERT_BATCH], on_conflict="sensor_id").execute()
    print(f"  upserted {len(rows)} sensor rows")

    stale = sorted(existing - {r["sensor_id"] for r in rows})
    for i in range(0, len(stale), SENSOR_DELETE_BATCH):
        client.table(SENSORS_TABLE).delete().in_(
            "sensor_id", stale[i:i + SENSOR_DELETE_BATCH]).execute()
    print(f"  deleted {len(stale)} sensor rows no longer listed")


def describe_changes(label: str, old_stations: List[Dict[str, Any]],
                     new_stations: List[Dict[str, Any]]) -> None:
    """Print which stations and sensors were added or removed vs `label`."""
    old = {s["openaq_id"]: s for s in old_stations}
    new = {s["openaq_id"]: s for s in new_stations}
    old_sensors = {x["sensor_id"] for s in old_stations for x in s["sensors"]}
    new_sensors = {x["sensor_id"] for s in new_stations for x in s["sensors"]}
    print(f"Changes vs {label}: stations {len(old)} -> {len(new)}, "
          f"sensors {len(old_sensors)} -> {len(new_sensors)} "
          f"(+{len(new_sensors - old_sensors)} / -{len(old_sensors - new_sensors)})")
    for oid in sorted(new.keys() - old.keys()):
        print(f"  + station {oid}  {new[oid]['name']} ({new[oid]['city']})")
    for oid in sorted(old.keys() - new.keys()):
        print(f"  - station {oid}  {old[oid]['name']} ({old[oid]['city']})")


def write_manifest(
    stations: List[Dict[str, Any]], openaq_to_monitor: Dict[int, str], run_time: str
) -> None:
    """Write the same list as a local JSON file (fallback + local analysis)."""
    manifest = {
        "generated_at": run_time,
        "source": "openaq",
        "pollutants": sorted(TARGET_POLLUTANTS),
        "stations": [
            {
                **s,
                "monitor_id": openaq_to_monitor[s["openaq_id"]],
            }
            for s in stations
        ],
    }
    TARGET_STATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with TARGET_STATIONS_PATH.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"  wrote {TARGET_STATIONS_PATH}")


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true",
                    default=bool(os.environ.get("DRY_RUN")),
                    help="read OpenAQ and Supabase, write nothing, print the changes")
    ap.add_argument("--min-share", type=float, default=DEFAULT_MIN_SHARE_OF_EXISTING,
                    help="refuse to write if the new sensor list is below this share "
                         f"of the stored one (default {DEFAULT_MIN_SHARE_OF_EXISTING})")
    return ap.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    dry_run = args.dry_run
    run_time = datetime.now(timezone.utc).isoformat()
    print(f"dry_run = {dry_run}")

    api_key = get_env("OPENAQ_API_KEY")
    openaq = OpenAQClient(api_key)
    supabase = make_client()

    print("Fetching OpenAQ India locations...")
    all_locations = fetch_openaq_india_locations(openaq)
    print(f"  {len(all_locations)} total India stations")

    print("Filtering to target cities + pollutants...")
    stations = filter_to_target(all_locations)
    # Drop sensors OpenAQ has stopped updating, before anything downstream
    # inherits them (see drop_stale_sensors for why this matters).
    stations = drop_stale_sensors(openaq, stations)
    per_city: Dict[str, int] = {}
    for s in stations:
        per_city[s["city"]] = per_city.get(s["city"], 0) + 1
    for city, n in per_city.items():
        print(f"  {city:12}: {n} stations kept")
    total_sensors = sum(len(s["sensors"]) for s in stations)
    print(f"  {len(stations)} stations, {total_sensors} target-pollutant sensors")

    # The JSON file as it was before this run, to report what changed.
    old_file = (json.loads(TARGET_STATIONS_PATH.read_text())["stations"]
                if TARGET_STATIONS_PATH.exists() else [])

    # What the sensor table holds now -- read BEFORE any write, so a
    # suspiciously short list stops the run with nothing changed at all.
    # While the table is still empty (the first run after migration 32), the
    # JSON file is the yardstick instead.
    existing = read_existing_sensor_ids(supabase)
    if existing is None:
        print(f"WARNING: table {SENSORS_TABLE} does not exist yet -- run "
              f"database-setup/32-monitor-sensors.sql. Monitors and the JSON file "
              f"are still updated; the run will then exit with an error.")
    baseline = len(existing) if existing else sum(len(st["sensors"]) for st in old_file)
    check_not_shrinking(total_sensors, baseline, args.min_share)

    print("Syncing monitors table in Supabase...")
    openaq_to_monitor = sync_monitors_table(supabase, stations, dry_run=dry_run)
    if dry_run:
        print("  DRY RUN: skipping name + coordinates + city update")
    else:
        n_loc = backfill_monitor_locations(supabase, stations)
        print(f"  wrote name + coordinates + city onto {n_loc} monitor rows")

    rows = sensor_rows(stations, openaq_to_monitor, run_time)
    if existing is not None:
        new_ids = {r["sensor_id"] for r in rows}
        print(f"Sensor table: {len(existing)} now -> {len(new_ids)} "
              f"(+{len(new_ids - existing)} / -{len(existing - new_ids)})")
        if dry_run:
            print(f"  DRY RUN: not writing {SENSORS_TABLE}")
        else:
            print(f"Writing {SENSORS_TABLE}...")
            write_sensor_table(supabase, rows, existing)

    describe_changes(TARGET_STATIONS_PATH.name, old_file, stations)
    if dry_run:
        print(f"DRY RUN: not writing {TARGET_STATIONS_PATH.name}")
    else:
        print("Writing target_stations.json...")
        write_manifest(stations, openaq_to_monitor, run_time)

    openaq.print_stats()
    if existing is None and not dry_run:
        raise SystemExit(f"Table {SENSORS_TABLE} missing: run migration 32, then re-run.")
    print("Done.")


if __name__ == "__main__":
    main()
