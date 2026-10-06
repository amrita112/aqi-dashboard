"""
Scheduled ingest of recent measurements from the OpenAQ live API.

Runs every 6 hours via GitHub Actions (00:00, 06:00, 12:00, 18:00 UTC).
Fetches the last DEFAULT_FETCH_WINDOW_HOURS of measurements for each
target-city sensor listed in target_stations.json, converts every value to
canonical units, groups by (station, timestamp), and upserts into Supabase.

Why the window is much wider than the cadence:
It has to cover OpenAQ's PUBLICATION lag, not the gap between runs. That lag is
neither small nor stable -- measured 16.8h on 2026-09-17 and 109.7h (4.6 days)
on 2026-10-06, and it arrives in bulk publishes rather than continuously, so the
window must span the gap between batches. See DEFAULT_FETCH_WINDOW_HOURS for the
measurements. Asking for hours OpenAQ has not published yet returns nothing, and
a window narrower than the lag returns nothing AT ALL, which is what happened
for most of September.

Re-seen rows are a no-op thanks to the (monitor_id, source, recorded_at)
uniqueness constraint on readings, so the overlap is free. Keeping the 6-hourly
cadence despite the wide window is about catching a bulk publish soon after it
lands, not about the window.

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
    FETCH_WINDOW_HOURS=48       # how far back to ask for measurements
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
    canonical_ts,
    get_admin_user_id,
    make_client,
    upsert_measurements,
    upsert_readings,
)

# OpenAQ's live API does not publish in real time: measurements appear roughly
# 17-24 hours after the hour they describe. An 8-hour window (6h cadence + 2h
# overlap) therefore asked for a stretch of time OpenAQ had not published yet,
# and returned nothing on every scheduled run -- which is what looked from the
# outside like an OpenAQ outage for Indian stations from 2026-08-27 onward.
#
# OPENAQ'S PUBLICATION LAG IS NOT STABLE, AND 48h STOPPED REACHING IT.
#
# Measured 2026-09-17 against sensor 12234787 (R K Puram PM2.5): 8h -> 0 rows,
# 24h -> 0 rows, 48h -> 87 rows, freshest reading 16.8h old. 48h was correctly
# sized that day.
#
# Re-measured 2026-10-06 across 45 PM2.5 sensors in Delhi / Mumbai / Bengaluru.
# The same sensor now returns 0 rows at 48h, 0 at 72h, and 174 rows at 168h
# whose newest is 109.6h old. Across all 42 sensors that have any data:
#
#     median publish lag   109.7h  (4.6 days)
#     p90                  110.7h
#     max                  184.1h  (7.7 days)
#
#     window reaching them:  48h -> 7%    96h -> 7%   120h -> 95%
#                           168h -> 98%  192h -> 100%
#
# Note how tightly those cluster on 109.7h: nearly every station reports the
# SAME age, which means this is not per-station latency but one bulk publish
# that happened 4.6 days ago. The lag is bursty, not steady, so the window has
# to span the gap BETWEEN publishes rather than any single station's delay --
# and a 48h window only catches a batch if a run happens to land just after it.
# That is exactly the intermittency the landing-rate data showed: two good days
# (21 and 25 Sep, 65% fresh) in six weeks of otherwise backfill-only arrivals.
#
# 192h (8 days) reached 100% of live sensors when measured. It is deliberately
# past the 110h cluster rather than snug against it, because the thing that
# broke this was assuming a measured lag would stay put.
#
# The overlap costs nothing in storage: the uniqueness constraint on
# (monitor_id, source, recorded_at) makes re-seen rows a no-op. It costs nothing
# in runtime either -- runtime is one request per sensor plus throttle, and a
# wider window returns more rows per request, not more requests.
DEFAULT_FETCH_WINDOW_HOURS = 192

# Rows per PAGE, not per run -- fetch_sensor_recent follows pages, so this no
# longer has to be large enough to hold a whole window.
MEASUREMENT_PAGE_LIMIT = 1000

# Refuses to page forever. 192h of 1-minute data is 11,520 rows, so 20 pages of
# 1000 is far more headroom than any plausible sensor needs.
MAX_PAGES_PER_SENSOR = 20


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
) -> List[Dict[str, Any]] | None:
    """Every measurement for one sensor since `since_iso`, following pages.

    Returns None if the request FAILED, and [] if the sensor genuinely has
    nothing in the window. The caller must keep those apart: the old version
    returned [] for both and swallowed the exception, so a transient network
    error dropped a station's data for that run with nothing in the log to say
    so. That is not hypothetical -- probing 45 sensors by hand, 4 of them
    looked permanently dead and were simply failed requests.

    WHY PAGINATE. The API returns rows ASCENDING from datetime_from and
    truncates at `limit`, so a window holding more rows than the limit loses
    the NEWEST ones -- precisely the wrong end for this job, and silently. The
    previous code warned about the cap instead of handling it, and widening the
    window to 192h brings it closer: 192h at 15-minute resolution is 768 rows
    against a 1000 cap, and a 5-minute sensor would blow straight through it.
    Following pages removes the whole class of problem instead of re-sizing a
    constant each time the window changes.

    A repeated 429 still raises out of openaq.get() and stops the run, rather
    than continuing to hammer the API.
    """
    out: List[Dict[str, Any]] = []
    page = 1
    while True:
        try:
            r = openaq.get(
                f"/v3/sensors/{sensor_id}/measurements",
                params={
                    "datetime_from": since_iso,
                    "limit": MEASUREMENT_PAGE_LIMIT,
                    "page": page,
                },
            )
        except Exception as exc:
            # Let a 429-driven HTTPError stop the run; report anything else and
            # mark this sensor as failed rather than empty.
            print(f"  sensor {sensor_id}: request failed on page {page} "
                  f"({type(exc).__name__}: {exc})")
            return None
        if r.status_code != 200:
            print(f"  sensor {sensor_id}: HTTP {r.status_code} on page {page}")
            return None

        results = r.json().get("results", [])
        out.extend(results)
        if len(results) < MEASUREMENT_PAGE_LIMIT:
            return out
        page += 1
        if page > MAX_PAGES_PER_SENSOR:
            # A guard, not an expectation. One sensor should never need this
            # many pages; if it does, something is wrong with the window and
            # silently fetching forever would burn the rate limit.
            print(f"  WARNING sensor {sensor_id}: still paging after "
                  f"{MAX_PAGES_PER_SENSOR} pages ({len(out)} rows); stopping.")
            return out


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
            # Negative concentrations are physically impossible — usually a
            # sensor calibrating near zero. Drop rather than clamp: a bad
            # reading is not a zero reading, and compute_subindex refuses
            # negatives anyway (would crash the whole ingest run).
            if canonical < 0:
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
        ts_canonical = canonical_ts(ts)
        readings_rows.append({
            "user_id":     admin_user_id,
            "monitor_id":  station["monitor_id"],
            "aqi_value":   composite,
            "latitude":    station["latitude"],
            "longitude":   station["longitude"],
            "source":      "openaq",
            "recorded_at": ts_canonical,
        })
        for pollutant, value in by_pollutant.items():
            unit = "mg/m³" if pollutant == "co" else "µg/m³"
            measurements_placeholder.append({
                "_reading_key": f"{station['monitor_id']}:{ts_canonical}",
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
        f"{r['monitor_id']}:{canonical_ts(r['recorded_at'])}": r["id"]
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
    # workflow_dispatch passes an EMPTY STRING when the optional input is left
    # blank, and that is also what a scheduled run sends, so `or` rather than a
    # dict default -- int("") raises and would fail every scheduled run.
    window_hours = int(
        (os.environ.get("FETCH_WINDOW_HOURS") or "").strip() or DEFAULT_FETCH_WINDOW_HOURS
    )
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
    new_readings = 0
    new_measurements = 0
    failed_sensors = 0
    empty_sensors = 0

    for i, station in enumerate(stations):
        # Fetch every target sensor on this station. openaq.get() throttles
        # automatically — no explicit sleep needed between calls.
        sensor_ms: Dict[int, List[Dict[str, Any]]] = {}
        for sensor in station["sensors"]:
            if sensor["parameter"] not in TARGET_POLLUTANTS:
                continue
            got = fetch_sensor_recent(openaq, sensor["sensor_id"], since_iso)
            if got is None:
                # Failed, not empty. Counted so the run's summary can say how
                # much of the manifest it actually managed to ask about -- a run
                # that silently failed half its sensors otherwise looks like a
                # run that found no data, and those need different responses.
                failed_sensors += 1
                continue
            if not got:
                empty_sensors += 1
            sensor_ms[sensor["sensor_id"]] = got

        readings, meas_placeholder = build_rows(station, sensor_ms, admin_user_id)
        if not readings:
            continue

        if dry_run:
            total_readings += len(readings)
            total_measurements += len(meas_placeholder)
        else:
            r_inserted = upsert_readings(supabase, readings)
            all_readings = fetch_existing_reading_ids(supabase, [station["monitor_id"]], since_iso)
            linked = link_measurements(meas_placeholder, all_readings)
            m_inserted = upsert_measurements(supabase, linked)
            # Count attempts and actual inserts separately. The old log added
            # ATTEMPTED readings to INSERTED measurements, which made a healthy
            # run look broken: re-seen readings counted, re-seen measurements
            # did not, so a 48h window that had mostly been ingested already
            # printed things like "363 reading rows and 20 measurement rows".
            # Both numbers were right; comparing them was meaningless.
            total_readings += len(readings)
            total_measurements += len(linked)
            new_readings += len(r_inserted)
            new_measurements += len(m_inserted)

        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/{len(stations)} stations, "
                  f"{total_readings} readings ({new_readings} new), "
                  f"{total_measurements} measurements ({new_measurements} new)")

    verb = "would be" if dry_run else "were"
    ratio = (total_measurements / total_readings) if total_readings else 0
    print(
        f"\nDone. {total_readings:,} readings and {total_measurements:,} measurements "
        f"{verb} sent ({ratio:.2f} measurements per reading; 4 pollutants would be 4.0).\n"
        f"      Of those, {new_readings:,} readings and {new_measurements:,} measurements "
        f"were NEW -- the rest already existed, which is expected because the "
        f"{window_hours}h window overlaps previous runs."
    )
    print(
        f"      Sensors: {total_sensors} asked, {failed_sensors} FAILED, "
        f"{empty_sensors} returned nothing for the window."
    )
    # A run where many sensors failed is a different problem from a run where
    # OpenAQ had nothing, and the fix is different too, so say which happened.
    if failed_sensors:
        pct = 100 * failed_sensors / total_sensors if total_sensors else 0
        print(f"      WARNING {pct:.0f}% of sensors could not be reached this run; "
              f"this run's coverage is incomplete and not evidence about OpenAQ.")
    openaq.print_stats()


if __name__ == "__main__":
    main()
