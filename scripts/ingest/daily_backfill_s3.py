"""
Daily catchup ingest from the OpenAQ S3 archive.

Runs once a day (typically ~04:00 UTC via GitHub Actions). Pulls yesterday's
per-station CSV files from `openaq-data-archive` and writes rows to the
Supabase `readings` + `measurements` tables.

Why S3 rather than the live API for the daily job:
  - No API key required, no rate limits, no auth.
  - Files are complete for a day once posted (~1–2 days after the date).
  - Survives short OpenAQ API outages / key suspensions.

The 6-hourly cron (ingest_recent_readings.py) handles freshness; this daily
job handles completeness — fills any hour the recent-readings cron missed
and gives us a canonical snapshot of the target day.

Usage (from repo root):
    /opt/homebrew/Caskroom/miniforge/base/bin/python3 scripts/ingest/daily_backfill_s3.py

Env vars required:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Optional:
    BACKFILL_DATE=2026-08-13   # override which date to fetch (default: yesterday UTC)
    DRY_RUN=1                  # print what would be inserted without writing
"""

from __future__ import annotations

import io
import json
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Tuple

import pandas as pd
import requests

from scripts.ingest.lib.aqi_utils import (
    compute_aqi_from_measurements,
    convert_to_canonical,
)
from scripts.ingest.lib.config import (
    OPENAQ_S3_BASE,
    TARGET_POLLUTANTS,
    TARGET_STATIONS_PATH,
    get_env,
)
from scripts.ingest.lib.supabase_client import (
    get_admin_user_id,
    make_client,
    upsert_measurements,
    upsert_readings,
)


def load_target_manifest() -> Dict[str, Any]:
    """Read scripts/ingest/target_stations.json (produced by bootstrap_stations.py)."""
    if not TARGET_STATIONS_PATH.exists():
        raise SystemExit(
            f"{TARGET_STATIONS_PATH} not found. "
            f"Run scripts/ingest/bootstrap_stations.py first."
        )
    with TARGET_STATIONS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def s3_url(location_id: int, day: date) -> str:
    return (
        f"{OPENAQ_S3_BASE}/records/csv.gz/"
        f"locationid={location_id}/year={day.year}/month={day.month:02d}/"
        f"location-{location_id}-{day.strftime('%Y%m%d')}.csv.gz"
    )


def fetch_station_day(location_id: int, day: date) -> pd.DataFrame:
    """Download one station's day-CSV; return empty DataFrame on 404 or empty file."""
    r = requests.get(s3_url(location_id, day), timeout=30)
    if r.status_code == 404 or not r.content:
        return pd.DataFrame()
    r.raise_for_status()
    return pd.read_csv(io.BytesIO(r.content), compression="gzip")


def rows_to_ingest(
    csv_df: pd.DataFrame, monitor_id: str, admin_user_id: str
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Turn a day-CSV into a set of readings + measurements rows.

    Groups the flat CSV by timestamp. For each timestamp we emit one
    `readings` row (with composite AQI computed from that timestamp's
    canonical values) and N `measurements` rows (one per pollutant).

    Skips rows whose pollutant isn't in TARGET_POLLUTANTS or whose unit
    can't be converted (convert_to_canonical returns None).
    """
    if csv_df.empty:
        return [], []

    # Normalize + filter
    csv_df = csv_df.copy()
    csv_df["pollutant"] = csv_df["parameter"].str.lower().replace({"pm2.5": "pm25"})
    csv_df = csv_df[csv_df.pollutant.isin(TARGET_POLLUTANTS)]
    if csv_df.empty:
        return [], []

    # Convert every value to canonical units up front; drop rows we can't convert.
    csv_df["value_canonical"] = csv_df.apply(
        lambda r: convert_to_canonical(r.pollutant, r.value, r.units), axis=1
    )
    csv_df = csv_df.dropna(subset=["value_canonical"])
    if csv_df.empty:
        return [], []

    # Timestamps come in local TZ per file; normalize to UTC.
    csv_df["ts_utc"] = pd.to_datetime(csv_df["datetime"], utc=True, errors="coerce")
    csv_df = csv_df.dropna(subset=["ts_utc"])

    # Preserve the station's lat/lng (constant per file) for readings rows.
    latitude  = float(csv_df.iloc[0]["lat"])
    longitude = float(csv_df.iloc[0]["lon"])

    readings_rows: List[Dict[str, Any]] = []
    measurements_rows: List[Dict[str, Any]] = []

    # One reading per unique timestamp on this station this day.
    for ts, ts_group in csv_df.groupby("ts_utc"):
        # If a station has multiple sensors for the same pollutant, take the
        # max value — conservative, avoids under-reporting a spike.
        canonical_by_pollutant: Dict[str, float] = (
            ts_group.groupby("pollutant")["value_canonical"].max().to_dict()
        )
        measurements_for_ts = [
            {"pollutant": p, "value": v} for p, v in canonical_by_pollutant.items()
        ]
        composite = compute_aqi_from_measurements(measurements_for_ts)

        reading_id = f"{monitor_id}:{ts.isoformat()}"   # deterministic string used only for FK
        readings_rows.append({
            # We rely on the DB to assign the UUID (default gen_random_uuid()),
            # so we omit `id` here and let the upsert response return it.
            "user_id":     admin_user_id,
            "monitor_id":  monitor_id,
            "aqi_value":   composite,
            "latitude":    latitude,
            "longitude":   longitude,
            "source":      "openaq",
            "recorded_at": ts.isoformat(),
        })
        # Placeholder — we'll attach the actual reading_id after upsert returns.
        for pollutant, value in canonical_by_pollutant.items():
            # POLLUTANT_UNITS canonical values only
            unit = "mg/m³" if pollutant == "co" else "µg/m³"
            measurements_rows.append({
                "_reading_key": reading_id,   # temp field, stripped before insert
                "pollutant":    pollutant,
                "value":        float(value),
                "unit":         unit,
            })

    return readings_rows, measurements_rows


def link_measurements_to_readings(
    measurements_placeholder: List[Dict[str, Any]],
    inserted_readings: List[Dict[str, Any]],
    existing_readings: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Attach the real reading UUIDs to measurement rows before insert.

    `_reading_key` was `{monitor_id}:{timestamp}` — matches the natural key
    on the reading row. Look up the UUID by that composite key.
    """
    key_to_uuid: Dict[str, str] = {}
    for r in inserted_readings + existing_readings:
        k = f"{r['monitor_id']}:{r['recorded_at']}"
        key_to_uuid[k] = r["id"]
    linked = []
    for m in measurements_placeholder:
        rid = key_to_uuid.get(m["_reading_key"])
        if rid is None:
            continue   # shouldn't happen but be defensive
        row = {k: v for k, v in m.items() if not k.startswith("_")}
        row["reading_id"] = rid
        linked.append(row)
    return linked


def fetch_existing_readings_for_lookup(
    client, monitor_ids: List[str], day: date
) -> List[Dict[str, Any]]:
    """Query readings we already have for these monitors on this day.

    Needed because upsert(ignore_duplicates=True) returns only the newly
    inserted rows — we still need reading_ids for the pre-existing readings
    so we can attach measurements to them.
    """
    if not monitor_ids:
        return []
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)
    result = (
        client.table("readings")
              .select("id, monitor_id, recorded_at")
              .in_("monitor_id", monitor_ids)
              .eq("source", "openaq")
              .gte("recorded_at", day_start.isoformat())
              .lt("recorded_at", day_end.isoformat())
              .execute()
    )
    return result.data or []


def parse_backfill_date() -> date:
    override = os.environ.get("BACKFILL_DATE", "").strip()
    if override:
        return datetime.strptime(override, "%Y-%m-%d").date()
    # Default: 2 days ago UTC. S3 files land 1-2 days after the measurement
    # date; yesterday is often published but sometimes not yet. 2 days ago is
    # reliably available. Confirmed on 2026-08-18: yesterday's files (for
    # 2026-08-17) returned 0 rows across all 177 stations, while a run for
    # 2026-08-15 returned data for most. Costs us 24h of freshness on the
    # daily job, but the 6-hourly cron already covers freshness — this job
    # exists for completeness.
    return (datetime.now(timezone.utc) - timedelta(days=2)).date()


def main() -> None:
    dry_run = bool(os.environ.get("DRY_RUN"))
    target_day = parse_backfill_date()
    print(f"Backfilling {target_day} (dry_run={dry_run})")

    manifest = load_target_manifest()
    stations = manifest["stations"]
    print(f"Manifest has {len(stations)} target stations")

    client = None if dry_run else make_client()
    admin_user_id = "00000000-0000-0000-0000-000000000000" if dry_run else get_admin_user_id(client)

    total_readings = 0
    total_measurements = 0
    stations_with_data = 0

    for i, station in enumerate(stations):
        try:
            csv_df = fetch_station_day(station["openaq_id"], target_day)
        except Exception as e:
            print(f"  station {station['openaq_id']}: fetch failed ({e}); skipping")
            continue
        if csv_df.empty:
            continue

        readings, meas_placeholder = rows_to_ingest(
            csv_df, station["monitor_id"], admin_user_id
        )
        if not readings:
            continue
        stations_with_data += 1

        if dry_run:
            total_readings += len(readings)
            total_measurements += len(meas_placeholder)
        else:
            newly_inserted = upsert_readings(client, readings)
            # Get UUIDs for pre-existing readings too so we can link measurements
            existing_all = fetch_existing_readings_for_lookup(
                client, [station["monitor_id"]], target_day
            )
            linked = link_measurements_to_readings(meas_placeholder, newly_inserted, existing_all)
            m_inserted = upsert_measurements(client, linked)
            total_readings += len(newly_inserted)
            total_measurements += len(m_inserted)

        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/{len(stations)} stations, "
                  f"{stations_with_data} with data, "
                  f"{total_readings} readings, {total_measurements} measurements so far")

    print(
        f"\nDone. {stations_with_data}/{len(stations)} stations had data. "
        f"{total_readings} reading rows, {total_measurements} measurement rows "
        f"{'would be' if dry_run else 'were'} written."
    )


if __name__ == "__main__":
    main()
