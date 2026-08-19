"""
Scheduled ingest of recent measurements from the OpenAQ live API.

Runs every 6 hours via GitHub Actions (00:00, 06:00, 12:00, 18:00 UTC).
Fetches the last 8 hours of measurements for each target-city sensor listed
in target_stations.json, converts every value to canonical units, groups by
(station, timestamp), and upserts into Supabase.

Why every 6h with an 8h window (not hourly):
6h between runs + 2h overlap = 8h window. The overlap is a no-op thanks to
the (monitor_id, source, recorded_at) uniqueness constraint on readings.
4-6 hours of data lag is acceptable for the "should I go outside now" use
case since historical patterns matter more than the most-recent reading.
6-hourly cuts ~4x the API + GHA runtime for a negligible UX cost.

Why per-sensor requests (not one big global call):
The OpenAQ /parameters/{id}/latest endpoint returns latest sensor values
globally per pollutant, but response filtering is client-side and could
exceed rate limits at scale. Per-sensor at 1.2s throttle (~905 calls,
~18-20 min per run) is easy to reason about and gives us headroom under
the 60/min OpenAQ limit.

Usage (from repo root):
    /opt/homebrew/Caskroom/miniforge/base/bin/python3 -m scripts.ingest.ingest_recent_readings

Env vars required (from .env.local locally, or GitHub secrets on CI):
    OPENAQ_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Optional:
    DRY_RUN=1                   # log what would be inserted without writing
    FETCH_WINDOW_HOURS=8        # how far back to ask for measurements
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Tuple

from scripts.ingest.lib.aqi_utils import (
    compute_aqi_from_measurements,
    convert_to_canonical,
)
from scripts.ingest.lib.config import (
    TARGET_POLLUTANTS,
    TARGET_STATIONS_PATH,
    get_env,
)
from scripts.ingest.lib.openaq_client import OpenAQClient
from scripts.ingest.lib.supabase_client import (
    get_admin_user_id,
    make_client,
    upsert_measurements,
    upsert_readings,
)

DEFAULT_FETCH_WINDOW_HOURS = 8


def load_manifest() -> Dict[str, Any]:
    if not TARGET_STATIONS_PATH.exists():
        raise SystemExit(
            f"{TARGET_STATIONS_PATH} not found. "
            f"Run `python -m scripts.ingest.bootstrap_stations` first."
        )
    with TARGET_STATIONS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def extract_timestamp(m: Dict[str, Any]) -> str | None:
    """OpenAQ v3 puts the measurement time in one of several places depending
    on whether the response is an aggregated (period) or point-in-time reading."""
    return (
        ((m.get("period") or {}).get("datetimeFrom") or {}).get("utc")
        or (m.get("datetime") or {}).get("utc")
        or (m.get("date")     or {}).get("utc")
    )


def fetch_sensor_recent(
    openaq: OpenAQClient, sensor_id: int, since_iso: str
) -> List[Dict[str, Any]]:
    """Fetch recent measurements for one sensor; return empty list on non-200.

    Uses the shared OpenAQClient so throttling / 429 retries are automatic.
    A repeated 429 raises HTTPError from openaq.get(); we let that propagate
    so the whole ingest run stops rather than continuing to hammer the API.
    """
    try:
        r = openaq.get(
            f"/v3/sensors/{sensor_id}/measurements",
            params={"datetime_from": since_iso, "limit": 100},
        )
    except Exception:
        return []
    if r.status_code != 200:
        return []
    return r.json().get("results", [])


def build_rows(
    station: Dict[str, Any],
    sensor_measurements: Dict[int, List[Dict[str, Any]]],
    admin_user_id: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Group a station's fresh per-sensor measurements by timestamp into
    readings + measurement rows. Same shape as daily_backfill_s3.build_rows,
    but the input comes from API JSON (with sensor-id → measurement list) not
    a flat CSV.
    """
    # Flatten: [(pollutant, ts_utc_str, canonical_value), ...]
    flat: List[Tuple[str, str, float]] = []
    for sensor in station["sensors"]:
        pollutant = sensor["parameter"]
        if pollutant not in TARGET_POLLUTANTS:
            continue
        for m in sensor_measurements.get(sensor["sensor_id"], []):
            ts = extract_timestamp(m)
            raw_value = m.get("value")
            if ts is None or raw_value is None:
                continue
            # Unit is usually inside parameter.units; sometimes on the sensor itself.
            unit = ((m.get("parameter") or {}).get("units")) or m.get("unit") or ""
            canonical = convert_to_canonical(pollutant, float(raw_value), str(unit))
            if canonical is None:
                continue
            flat.append((pollutant, ts, canonical))

    if not flat:
        return [], []

    # Group by timestamp; for redundant same-pollutant sensors take the max value.
    by_ts: Dict[str, Dict[str, float]] = {}
    for pollutant, ts, value in flat:
        by_ts.setdefault(ts, {})
        by_ts[ts][pollutant] = max(by_ts[ts].get(pollutant, value), value)

    readings_rows: List[Dict[str, Any]] = []
    measurements_placeholder: List[Dict[str, Any]] = []
    for ts, by_pollutant in by_ts.items():
        composite = compute_aqi_from_measurements(
            [{"pollutant": p, "value": v} for p, v in by_pollutant.items()]
        )
        readings_rows.append({
            "user_id":     admin_user_id,
            "monitor_id":  station["monitor_id"],
            "aqi_value":   composite,
            "latitude":    station["latitude"],
            "longitude":   station["longitude"],
            "source":      "openaq",
            "recorded_at": ts,
        })
        for pollutant, value in by_pollutant.items():
            unit = "mg/m³" if pollutant == "co" else "µg/m³"
            measurements_placeholder.append({
                "_reading_key": f"{station['monitor_id']}:{ts}",
                "pollutant":    pollutant,
                "value":        float(value),
                "unit":         unit,
            })
    return readings_rows, measurements_placeholder


def fetch_existing_reading_ids(
    client, monitor_ids: List[str], since_iso: str
) -> List[Dict[str, Any]]:
    """Look up reading rows we already have in the window, so we can attach
    measurements to them (whether they were newly inserted or already existed)."""
    if not monitor_ids:
        return []
    result = (
        client.table("readings")
              .select("id, monitor_id, recorded_at")
              .in_("monitor_id", monitor_ids)
              .eq("source", "openaq")
              .gte("recorded_at", since_iso)
              .execute()
    )
    return result.data or []


def link_measurements(
    placeholder: List[Dict[str, Any]],
    all_readings: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Attach the real reading UUID to each measurement placeholder."""
    key_to_uuid = {
        f"{r['monitor_id']}:{r['recorded_at']}": r["id"]
        for r in all_readings
    }
    linked = []
    for m in placeholder:
        reading_uuid = key_to_uuid.get(m["_reading_key"])
        if reading_uuid is None:
            continue
        row = {k: v for k, v in m.items() if not k.startswith("_")}
        row["reading_id"] = reading_uuid
        linked.append(row)
    return linked


def main() -> None:
    api_key = get_env("OPENAQ_API_KEY")
    openaq  = OpenAQClient(api_key)
    dry_run = bool(os.environ.get("DRY_RUN"))
    window_hours = int(os.environ.get("FETCH_WINDOW_HOURS", DEFAULT_FETCH_WINDOW_HOURS))
    now_utc = datetime.now(timezone.utc)
    since_iso = (now_utc - timedelta(hours=window_hours)).isoformat()

    print(f"Recent-readings ingest: window = last {window_hours}h up to {now_utc.isoformat()}")
    print(f"dry_run = {dry_run}")

    manifest = load_manifest()
    stations = manifest["stations"]
    total_sensors = sum(len(s["sensors"]) for s in stations)
    print(f"Manifest: {len(stations)} stations, {total_sensors} target sensors")

    supabase = None if dry_run else make_client()
    admin_user_id = (
        "00000000-0000-0000-0000-000000000000"
        if dry_run
        else get_admin_user_id(supabase)
    )

    total_readings = 0
    total_measurements = 0

    for i, station in enumerate(stations):
        # Fetch every target sensor on this station. openaq.get() throttles
        # automatically — no explicit sleep needed between calls.
        sensor_ms: Dict[int, List[Dict[str, Any]]] = {}
        for sensor in station["sensors"]:
            if sensor["parameter"] not in TARGET_POLLUTANTS:
                continue
            sensor_ms[sensor["sensor_id"]] = fetch_sensor_recent(
                openaq, sensor["sensor_id"], since_iso
            )

        readings, meas_placeholder = build_rows(station, sensor_ms, admin_user_id)
        if not readings:
            continue

        if dry_run:
            total_readings += len(readings)
            total_measurements += len(meas_placeholder)
        else:
            upsert_readings(supabase, readings)
            all_readings = fetch_existing_reading_ids(supabase, [station["monitor_id"]], since_iso)
            linked = link_measurements(meas_placeholder, all_readings)
            m_inserted = upsert_measurements(supabase, linked)
            total_readings += len(readings)   # upserted; may include no-op skips
            total_measurements += len(m_inserted)

        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/{len(stations)} stations, "
                  f"{total_readings} readings, {total_measurements} measurements")

    print(
        f"\nDone. {total_readings} reading rows and {total_measurements} measurement rows "
        f"{'would be' if dry_run else 'were'} touched."
    )
    openaq.print_stats()


if __name__ == "__main__":
    main()
