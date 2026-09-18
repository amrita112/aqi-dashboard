"""
One-time (or occasional) bootstrap: build the target-stations manifest that
the ingest scripts read.

What it does:
  1. Fetch all OpenAQ locations in India via /v3/locations.
  2. Filter to stations whose coordinates fall inside a TARGET_CITIES bbox.
  3. Keep only the sensors for TARGET_POLLUTANTS.
  4. Ensure each surviving station exists in the Supabase `monitors` table,
     with `serial_number = "openaq:{openaq_id}"` as the stable external key.
  5. Write scripts/ingest/target_stations.json with the mapping the ingest
     scripts need (openaq_id, sensor_id → pollutant, monitor_id, city, coords).

Run from the repo root (module mode — the script uses absolute imports
like `from scripts.ingest.lib.config import ...`, so a plain
`python3 scripts/ingest/bootstrap_stations.py` invocation would fail
with ModuleNotFoundError):

    /opt/homebrew/Caskroom/miniforge/base/bin/python3 -m scripts.ingest.bootstrap_stations

Env vars required (from .env.local locally, or GitHub secrets on CI):
  OPENAQ_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Re-run whenever OpenAQ adds new stations in the target cities (roughly monthly).
Idempotent — safe to run repeatedly.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

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


def sync_monitors_table(client, stations: List[Dict[str, Any]]) -> Dict[int, str]:
    """Ensure a row exists in `monitors` for each station.

    Returns a mapping openaq_id → monitor.id (UUID) that the ingest scripts
    use to attach readings to the right monitor row.
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

    count = upsert_monitors(client, rows_to_upsert)
    print(f"  upserted {count} monitor rows")
    return openaq_to_monitor


def write_manifest(
    stations: List[Dict[str, Any]], openaq_to_monitor: Dict[int, str]
) -> None:
    """Persist the mapping the ingest scripts need."""
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
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


def main() -> None:
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

    print("Syncing monitors table in Supabase...")
    openaq_to_monitor = sync_monitors_table(supabase, stations)

    print("Writing target_stations.json...")
    write_manifest(stations, openaq_to_monitor)

    openaq.print_stats()
    print("Done.")


if __name__ == "__main__":
    main()
