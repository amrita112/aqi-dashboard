"""
Pull the raw material for the forecast simulation out of Supabase, once, and
cache it locally as parquet.

READ ONLY. This script never writes to Supabase.

Why cache: the simulation replays ~35 nights and needs the same ~1M rows each
time. Re-fetching would take minutes per run. More importantly, prune_raw.py
deletes raw readings past 30 days, so the 17 Aug - 21 Sep window disappears
from Supabase in late October. The cache is the only durable copy.

Usage (from repo root):
    python3 -m scripts.analysis.fetch_simulation_data
    python3 -m scripts.analysis.fetch_simulation_data --force   # re-fetch

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read from .env.local).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
CACHE = REPO / "data" / "simulation-cache"

# The three cities the simulation covers. Note monitors.city stores
# 'Bangalore' while the rest of the codebase says Bengaluru.
CITIES = {"Delhi NCR": "Delhi", "Mumbai": "Mumbai", "Bangalore": "Bengaluru"}

PAGE = 1000  # PostgREST caps a page at 1000 rows regardless of what we ask for


def load_env() -> None:
    """Read .env.local by hand. Values may carry a trailing '# comment'."""
    env = REPO / ".env.local"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value.split("#")[0].strip().strip('"').strip("'"))


def fetch_all(client, table: str, columns: str, label: str) -> pd.DataFrame:
    """Page through an entire table. PostgREST gives at most 1000 rows a call."""
    rows, offset, t0 = [], 0, time.time()
    while True:
        page = client.table(table).select(columns).range(offset, offset + PAGE - 1).execute().data
        rows += page
        if len(page) < PAGE:
            break
        offset += PAGE
        if offset % 50000 == 0:
            print(f"    {label}: {offset:,} rows ({time.time() - t0:.0f}s)", flush=True)
    print(f"  {label}: {len(rows):,} rows in {time.time() - t0:.0f}s", flush=True)
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="re-fetch even if cached")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    if (CACHE / "measurements.parquet").exists() and not args.force:
        print(f"Cache already present at {CACHE}. Use --force to re-fetch.")
        return

    load_env()
    sys.path.insert(0, str(REPO))
    from scripts.ingest.lib.supabase_client import make_client

    client = make_client()
    print("Fetching (read only — nothing is written to Supabase)")

    monitors = fetch_all(client, "monitors", "id,name,city,latitude,longitude", "monitors")
    monitors = monitors[monitors["city"].isin(CITIES)].copy()
    monitors["city_label"] = monitors["city"].map(CITIES)
    print(f"  -> {len(monitors)} monitors in {sorted(set(monitors['city_label']))}")

    readings = fetch_all(
        client, "readings", "id,monitor_id,source,recorded_at,created_at", "readings")
    readings = readings[readings["monitor_id"].isin(set(monitors["id"]))].copy()
    print(f"  -> {len(readings):,} readings for those monitors")

    measurements = fetch_all(
        client, "measurements", "reading_id,pollutant,value,unit", "measurements")
    measurements = measurements[measurements["reading_id"].isin(set(readings["id"]))].copy()
    print(f"  -> {len(measurements):,} measurements for those readings")

    # Model inputs. These are refit monthly, so the simulation must pin the
    # versions it ran against or the test built on it breaks every month for
    # reasons that have nothing to do with the code under test.
    params = fetch_all(client, "forecast_params", "*", "forecast_params")
    params = params[params["monitor_id"].isin(set(monitors["id"]))].copy()
    diurnal = fetch_all(client, "diurnal_shape", "*", "diurnal_shape")
    modes = fetch_all(client, "forecast_modes", "*", "forecast_modes")

    for name, df in [("monitors", monitors), ("readings", readings),
                     ("measurements", measurements), ("forecast_params", params),
                     ("diurnal_shape", diurnal), ("forecast_modes", modes)]:
        path = CACHE / f"{name}.parquet"
        df.to_parquet(path, index=False)
        print(f"  wrote {path.relative_to(REPO)}  ({len(df):,} rows, "
              f"{path.stat().st_size / 1e6:.1f} MB)")

    (CACHE / "manifest.json").write_text(json.dumps({
        "fetched_at": pd.Timestamp.utcnow().isoformat(),
        "cities": CITIES,
        "counts": {"monitors": len(monitors), "readings": len(readings),
                   "measurements": len(measurements), "forecast_params": len(params),
                   "diurnal_shape": len(diurnal), "forecast_modes": len(modes)},
    }, indent=2))
    print("Done.")


if __name__ == "__main__":
    main()
