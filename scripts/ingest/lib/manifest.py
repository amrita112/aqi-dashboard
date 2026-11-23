"""
The station/sensor list ("manifest") the ingest jobs work from.

WHAT IT IS. For every station we ingest: its OpenAQ location id, name,
coordinates, city, our monitor id, and the OpenAQ sensors (one per pollutant)
to ask for. Shape, unchanged from the old JSON file so callers need no edits:

    {
      "generated_at": "2026-11-22T04:31:02+00:00",
      "source": "openaq",
      "pollutants": ["no2", "pm10", "pm25", "so2"],
      "stations": [
        {"openaq_id": 15, "name": "IGI Airport", "latitude": 28.56,
         "longitude": 77.094, "city": "Delhi NCR",
         "sensors": [{"sensor_id": 28, "parameter": "no2"}, ...],
         "monitor_id": "b149be2e-..."},
        ...
      ],
      "loaded_from": "supabase" | "file",   # added here, for the log
    }

WHERE IT COMES FROM (since Nov 2026). The `monitor_sensors` table in Supabase
(database-setup/32-monitor-sensors.sql), joined to `monitors` for the
station-level fields. The weekly bootstrap writes that table. It used to write
scripts/ingest/target_stations.json and commit it to git, but main no longer
accepts direct pushes, so the committed file froze on 18 Oct 2026.

FALLBACK. If the table cannot be read (migration 32 not run yet, network
error, no credentials) or is empty (migration run, bootstrap not yet), this
falls back to the JSON file and prints a clear WARNING. That keeps the ingest
running exactly as before during the changeover, and keeps local runs without
Supabase credentials working.

Scripts that only run locally for analysis (scripts/forecast/*,
scripts/ingest/historical/*) still read the JSON file directly.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional

from scripts.ingest.lib.config import TARGET_POLLUTANTS, TARGET_STATIONS_PATH

# The table the bootstrap writes (migration 32).
SENSORS_TABLE = "monitor_sensors"

# Supabase returns at most 1000 rows per request (project setting "max rows"),
# so both tables are read in pages of this size.
PAGE_SIZE = 1000

# Where to read the list from, overridable with the env var MANIFEST_SOURCE:
#   "auto"  -- the Supabase table; the JSON file if the table is empty or
#              unreachable (default)
#   "file"  -- the JSON file only (e.g. to reproduce an old run exactly)
DEFAULT_MANIFEST_SOURCE = "auto"


def get_manifest_source() -> str:
    raw = (os.environ.get("MANIFEST_SOURCE") or "").strip().lower()
    source = raw or DEFAULT_MANIFEST_SOURCE
    if source not in ("auto", "file"):
        raise SystemExit(f"MANIFEST_SOURCE must be 'auto' or 'file', not {raw!r}")
    return source


# ─── Reading ─────────────────────────────────────────────────────────────────

def _read_all(client, table: str, columns: str, order_by: str) -> List[Dict[str, Any]]:
    """Every row of a table, page by page. Ordered so pages never overlap."""
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        batch = (client.table(table).select(columns).order(order_by)
                       .range(offset, offset + PAGE_SIZE - 1).execute().data) or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def manifest_from_rows(sensor_rows: List[Dict[str, Any]],
                       monitor_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Rebuild the manifest structure from table rows (pure: no database).

    sensor_rows: monitor_sensors rows (sensor_id, monitor_id, parameter,
                 openaq_location_id, updated_at).
    monitor_rows: monitors rows (id, name, latitude, longitude, city).

    One station per monitor that has at least one sensor. Stations are sorted
    by OpenAQ id and sensors by pollutant then id, so the output is the same
    from run to run. A sensor whose monitor row is missing is skipped (the
    foreign key should make that impossible).
    """
    monitors = {m["id"]: m for m in monitor_rows}
    stations: Dict[str, Dict[str, Any]] = {}
    for r in sensor_rows:
        mon = monitors.get(r["monitor_id"])
        if mon is None:
            continue
        st = stations.get(r["monitor_id"])
        if st is None:
            st = stations[r["monitor_id"]] = {
                "openaq_id":  int(r["openaq_location_id"]),
                "name":       mon.get("name") or "",
                "latitude":   mon.get("latitude"),
                "longitude":  mon.get("longitude"),
                "city":       mon.get("city"),
                "sensors":    [],
                "monitor_id": r["monitor_id"],
            }
        st["sensors"].append({"sensor_id": int(r["sensor_id"]),
                              "parameter": r["parameter"]})

    for st in stations.values():
        st["sensors"].sort(key=lambda s: (s["parameter"], s["sensor_id"]))
    stamps = [r["updated_at"] for r in sensor_rows if r.get("updated_at")]
    return {
        "generated_at": max(stamps) if stamps else None,
        "source": "openaq",
        "pollutants": sorted(TARGET_POLLUTANTS),
        "stations": sorted(stations.values(), key=lambda s: s["openaq_id"]),
    }


def load_from_file(path=TARGET_STATIONS_PATH) -> Dict[str, Any]:
    """The JSON file the bootstrap also writes locally (and git still holds)."""
    if not path.exists():
        raise SystemExit(
            f"No station list: the {SENSORS_TABLE} table gave nothing and {path} "
            f"does not exist. Run `python -m scripts.ingest.bootstrap_stations`.")
    with path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["loaded_from"] = "file"
    return manifest


def load_target_stations(client=None, *, path=TARGET_STATIONS_PATH,
                         log: Callable[[str], None] = print) -> Dict[str, Any]:
    """The manifest: from Supabase if possible, else the JSON file (warned).

    `client` is a Supabase client; with None, one is made from the service-key
    env vars if they are set (reading is harmless, so dry runs do this too).
    """
    if get_manifest_source() == "file":
        log(f"Station list: reading {path.name} (MANIFEST_SOURCE=file)")
        return load_from_file(path)

    reason: Optional[str] = None
    if client is None:
        try:
            from scripts.ingest.lib.supabase_client import make_client
            client = make_client()
        except (SystemExit, Exception) as e:   # get_env raises SystemExit
            reason = f"no Supabase client ({e})"

    if client is not None:
        try:
            sensors = _read_all(client, SENSORS_TABLE,
                                "sensor_id, monitor_id, parameter, openaq_location_id, updated_at",
                                "sensor_id")
            if not sensors:
                reason = f"the {SENSORS_TABLE} table is empty (bootstrap not run since migration 32?)"
            else:
                monitors = _read_all(client, "monitors",
                                     "id, name, latitude, longitude, city", "id")
                manifest = manifest_from_rows(sensors, monitors)
                manifest["loaded_from"] = "supabase"
                log(f"Station list: {SENSORS_TABLE} table, generated {manifest['generated_at']}")
                return manifest
        except Exception as e:
            reason = f"could not read {SENSORS_TABLE} ({e})"

    log(f"WARNING: station list falling back to {path.name}: {reason}. "
        f"The file may be out of date.")
    return load_from_file(path)
